
// ---- V1.9 Servicio Catalogo (Lista cerrada)
const SERVICE_CATALOG_V19 = [
  {id:"URGENCIAS", nombre:"UGC Urgencias"},
  {id:"RADIO", nombre:"UGC Radiodiagnóstico"},
  {id:"REHAB", nombre:"UGC Rehabilitación"},
  {id:"LAB", nombre:"UGC Laboratorios / Extracciones"},
  {id:"BANCO", nombre:"Banco de sangre / Hemoterapia"},
  {id:"MICRO", nombre:"Microbiología / Infecciosas"},
  {id:"ANAPAT", nombre:"Anatomía Patológica"},
  {id:"HEMO", nombre:"Hemodiálisis"},
  {id:"BLOQUE", nombre:"Bloque Quirúrgico"},
  {id:"CMA", nombre:"CMA"},
  {id:"HOSP_DIA", nombre:"Hospital de Día"},
  {id:"CONS_EXT", nombre:"Consultas Externas"},
  {id:"SALUD_MENTAL", nombre:"Salud Mental"},
  {id:"CARDIO", nombre:"Cardiología"},
  {id:"NEURO", nombre:"Neurología / Ictus"},
  {id:"URO", nombre:"Urología"},
  {id:"OFTALMO", nombre:"Oftalmología"},
  {id:"CIRUGIA_GEN", nombre:"Cirugía General"},
  {id:"TRAUMA", nombre:"Traumatología"},
  {id:"ORL", nombre:"Otorrino"},
  {id:"MAXILO", nombre:"Maxilofacial"},
  {id:"ONCO", nombre:"Oncohematología"},
  {id:"GASES", nombre:"Gases Medicinales"},
  {id:"PCI", nombre:"Protección Contra Incendios"},
  {id:"RITI", nombre:"RITI / Telecomunicaciones"},
  {id:"FARMACIA", nombre:"Farmacia"},
  {id:"ESTERIL", nombre:"Esterilización"},
  {id:"MED_NUC", nombre:"Medicina Nuclear"},
  {id:"ARCHIVO", nombre:"Archivo / Documentación Clínica"},
  {id:"HELIPUERTO", nombre:"Helipuerto / Planta Técnica"},
  {id:"UTA", nombre:"UTAs / Cubierta Técnica"}
];

import {
  dbPutOT, dbGetOTByTechDate, dbDeleteOTByTechDate, dbDeleteOTKey,
  dbAddHistory, dbGetHistoryByTech,
  dbExportAll, dbImportAll,
  dbPutMonthly, dbGetMonthlyByTechMonth, dbDeleteMonthlyByTechMonth,
  dbPutMonthlyFile, dbGetMonthlyFile,
  dbPutMonthlyHeader, dbGetMonthlyHeader
} from "./db.js";

const $ = (id) => document.getElementById(id);

const screens = {
  profile: $("screenProfile"),
  home: $("screenHome"),
  scan: $("screenScan"),
  point: $("screenPoint"),
  timer: $("screenTimer"),
  history: $("screenHistory"),
  monthly: $("screenMonthly"),
  guide: $("screenGuide"),
};

function storageGet(key, fallback = ""){
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function storageSet(key, value){
  try { localStorage.setItem(key, value); } catch {}
}
function storageRemove(key){
  try { localStorage.removeItem(key); } catch {}
}

const state = {
  tech: storageGet("isivolt.tech", ""),
  currentCode: "",
  currentOTKey: "",
  stream: null,
  detector: null,
  scanMode: "ot", // "ot" | "monthlyHot" | "monthlyCold"
  showEmptyMonthly: false,
  timer: { running:false, paused:false, startTs:0, durationMs:0, elapsedMs:0, raf:0 }
};

const SETTINGS_KEY = "isivolt.settings";
const DEFAULT_SETTINGS = { bleachPct: 5, targetPpm: 50, baseMin: 10, factorPerL: 0.00 };
const GUIDE_KEY = "isivolt.guideText";
const DEFAULT_GUIDE = `Bienvenido a IsiVolt Pro V1 Legionella.

OT diaria
1) Crea tu lista en el taller: escanea QR o escribe el código (usamos siempre los 5 últimos).
2) En cada punto: calcula dosis y tiempo, anota observación si hace falta, y pulsa Iniciar.
3) El cronómetro llena el depósito de agua hasta completar el tiempo. Al finalizar vibra y queda registrado con fecha y hora.
4) Si hay problemas, pulsa Incidencia y escribe una causa corta.

Mensual (muestras)
1) Rellena cabecera (fecha muestreo y técnico asignado).
2) Crea la ruta por plantas (-1, Baja, 1ª–8ª).
3) Marca cada punto como Hecho / Incidencia / No aplica.

Recuerda: dosis y tiempos están prefijados hasta confirmar protocolo exacto del centro.`;

function todayStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}
function monthStr(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  return `${y}-${m}`;
}

function show(screenName){
  for (const k of Object.keys(screens)){
    screens[k].classList.toggle("hidden", k !== screenName);
  }
}

function getSettings(){
  const raw = storageGet(SETTINGS_KEY, "");
  if (!raw) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s){ storageSet(SETTINGS_KEY, JSON.stringify(s)); }

function normalizeCode(input){
  const s = String(input || "").trim();
  if (!s) return "";
  const clean = s.replace(/[^a-zA-Z0-9]/g, "");
  if (clean.length <= 5) return clean.toUpperCase();
  return clean.slice(-5).toUpperCase();
}
function fmtTime(ms){
  const t = Math.max(0, Math.ceil(ms/1000));
  const mm = String(Math.floor(t/60)).padStart(2,"0");
  const ss = String(t%60).padStart(2,"0");
  return `${mm}:${ss}`;
}
// Aproximación: mg de cloro por ml de lejía ≈ % * 100
function mgPerMlFromPct(pct){ return Number(pct) * 100; }
function calcDoseMl(liters, settings){
  const L = Number(liters);
  if (!isFinite(L) || L <= 0) return null;
  const ppm = Number(settings.targetPpm);
  const mgTotal = ppm * L;
  const mgPerMl = mgPerMlFromPct(settings.bleachPct);
  if (mgPerMl <= 0) return null;
  return Math.max(0, mgTotal / mgPerMl);
}
function calcAutoMinutes(liters, settings){
  const L = Number(liters);
  const base = Number(settings.baseMin);
  const f = Number(settings.factorPerL);
  if (!isFinite(L) || L <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base + (L * f)));
}
function toast(msg, type="info", title=""){
  try { navigator.vibrate?.(18); } catch {}
  const root = $("toastRoot");
  if (!root) { alert(msg); return; }

  const t = document.createElement("div");
  t.className = `toast ${type==="ok"?"ok":type==="warn"?"warn":""}`;
  t.innerHTML = `
    <div style="min-width:0;">
      <div class="t-title">${title || (type==="ok"?"Hecho":"") || "Aviso"}</div>
      <div class="t-msg">${String(msg)}</div>
    </div>
    <div class="t-actions">
      <button class="x" aria-label="Cerrar">✖</button>
    </div>
  `;
  const close = ()=>{ t.remove(); };
  t.querySelector(".x").addEventListener("click", close);

  root.prepend(t);
  setTimeout(()=>{ t.style.opacity = "0"; t.style.transform = "translateY(8px)"; }, 4200);
  setTimeout(close, 4600);
}

// ---------------- OT ----------------
async function refreshOT(){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);

  const done = items.filter(i => i.status === "ok").length;
  const total = items.length;

  $("kpiTech").textContent = tech || "—";
  $("kpiToday").textContent = `${done} / ${total}`;

  const list = $("otList");
  list.innerHTML = "";
  $("otEmpty").classList.toggle("hidden", total !== 0);

  for (const it of items.sort((a,b)=> (a.order||0)-(b.order||0))){
    const el = document.createElement("div");
    el.className = "item";
    const badgeClass = it.status === "ok" ? "ok" : it.status === "issue" ? "issue" : "todo";
    const badgeText = it.status === "ok" ? "✅ Hecho" : it.status === "issue" ? "⚠ Incid." : "⏳ Pend.";
    const note = it.note ? ` · ${it.note}` : "";
    el.innerHTML = `
      <div class="left">
        <div class="code">${it.code}</div>
        <div class="meta">${it.updatedAt ? new Date(it.updatedAt).toLocaleTimeString() : "—"}${note}</div>
      </div>
      <div class="row">
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="smallbtn ok" data-quickok="1" title="Marcar Hecho">✅</button>
        <button class="smallbtn issue" data-quickissue="1" title="Incidencia rápida">⚠</button>
        <button class="btn btn-ghost" data-open="${it.code}">Abrir</button>
        <button class="btn btn-ghost" data-edit="${it.code}" title="Editar código">✏️</button>
      </div>
    `;
    el.querySelector("[data-open]").addEventListener("click", () => openPoint(it.code));
    el.querySelector("[data-edit]").addEventListener("click", () => editOTCode(it.code));
    // Quick actions + swipe
    el.querySelector('[data-quickok="1"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      const note = prompt("OK rápido (opcional):", it.note || "") ?? "";
      await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(), tech: state.tech, date: todayStr(), code: it.code, ts: Date.now(), liters:null, doseMl:null, minutes:null, result:"ok", note: (note.trim().slice(0,120) || "Marcado rápido") }));
      await markOTStatus(it.code, "ok");
      if (note) await saveOTNote(it.code, note);
      toast(`Marcado ✅ ${it.code}`, "ok", "OT");
    });
    el.querySelector('[data-quickissue="1"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      const reason = prompt("Incidencia rápida:", it.note || "");
      if (reason == null) return;
      await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(), tech: state.tech, date: todayStr(), code: it.code, ts: Date.now(), liters:null, doseMl:null, minutes:null, result:"issue", note: (reason.trim().slice(0,120) || "Incidencia") }));
      await markOTStatus(it.code, "issue");
      await saveOTNote(it.code, reason);
      toast(`Marcado ⚠ ${it.code}`, "warn", "OT");
    });
    bindSwipe(el, {
      onRight: async ()=>{
        const note = prompt("✅ OK (opcional):", it.note || "") ?? "";
        await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(), tech: state.tech, date: todayStr(), code: it.code, ts: Date.now(), liters:null, doseMl:null, minutes:null, result:"ok", note: (note.trim().slice(0,120) || "Swipe OK") }));
        await markOTStatus(it.code, "ok");
        if (note) await saveOTNote(it.code, note);
        toast(`Swipe ✅ ${it.code}`, "ok", "OT");
      },
      onLeft: async ()=>{
        const reason = prompt("⚠ Incidencia:", it.note || "");
        if (reason == null) return;
        await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(), tech: state.tech, date: todayStr(), code: it.code, ts: Date.now(), liters:null, doseMl:null, minutes:null, result:"issue", note: (reason.trim().slice(0,120) || "Swipe Incidencia") }));
        await markOTStatus(it.code, "issue");
        await saveOTNote(it.code, reason);
        toast(`Swipe ⚠ ${it.code}`, "warn", "OT");
      }
    });
    list.appendChild(el);
  }
}

async function addOTCode(code){
  const c = normalizeCode(code);
  if (!c) return toast("Introduce un código válido (se usan los 5 últimos).");

  const tech = state.tech;
  const date = todayStr();

  const existing = await dbGetOTByTechDate(tech, date);
  if (existing.some(x => x.code === c)){
    return openPoint(c);
  }

  const note = prompt("Observación rápida (opcional) para este punto:", "") ?? "";
  const item = {
    key: `${tech}|${date}|${c}`,
    tech, date, code: c,
    status: "todo",
    order: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultLiters: 60,
    note: note.trim().slice(0, 80)
  };
  await dbPutOT(item);
  await refreshOT();
  openPoint(c);
}

async function saveOTNote(code, note){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;
  it.note = String(note||"").trim().slice(0, 120);
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await refreshOT();
}

async function editOTCode(oldCode){
  const oldC = normalizeCode(oldCode);
  if (!oldC) return;
  const newRaw = prompt(`Editar código (${oldC})

Introduce el código correcto (usará los 5 últimos):`, oldC);
  if (newRaw == null) return;
  const newC = normalizeCode(newRaw);
  if (!newC) return toast("Código inválido.");
  if (newC === oldC) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);

  const it = items.find(x => x.code === oldC);
  if (!it) return;

  if (items.some(x => x.code === newC)) {
    return toast("Ese código ya existe en la OT de hoy.");
  }

  const oldKey = it.key;
  it.code = newC;
  it.key = `${tech}|${date}|${newC}`;
  it.updatedAt = Date.now();

  await dbPutOT(it);
  await dbDeleteOTKey(oldKey);

  if (state.currentCode === oldC){
    state.currentCode = newC;
    state.currentOTKey = it.key;
    $("pointCode").textContent = newC;
    $("timerCode").textContent = newC;
  }
  await refreshOT();
}

// ---------------- Punto ----------------
async function openPoint(code){
  state.currentCode = normalizeCode(code);
  if (!state.currentCode) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === state.currentCode);

  state.currentOTKey = it?.key || "";

  $("pointCode").textContent = state.currentCode;

  const settings = getSettings();
  const liters = it?.defaultLiters ?? 60;
  $("liters").value = liters;
  $("targetMinutes").value = calcAutoMinutes(liters, settings);

  $("pointNote").value = it?.note ?? "";

  $("chkConnect").checked = false;
  $("chkReturn").checked = false;
  $("chkDose").checked = false;
  $("chkStart").checked = false;

  updateDoseUI();
  show("point");
}

function updateDoseUI(){
  const settings = getSettings();
  const liters = $("liters").value;
  const ml = calcDoseMl(liters, settings);
  $("doseMl").textContent = ml == null ? "—" : `${Math.round(ml)} ml`;
}

// ---------------- Timer (water fill) ----------------
function stopRaf(){ if (state.timer.raf) cancelAnimationFrame(state.timer.raf); state.timer.raf = 0; }

function setRingProgress(pct){
  const p = Math.max(0, Math.min(1, pct));
  const deg = Math.round(p * 360);
  const ring = $("ring");
  if (!ring) return;
  ring.style.background = `conic-gradient(rgba(0,212,255,.55) ${deg}deg, rgba(46,196,182,.45) ${deg}deg, rgba(255,255,255,.10) 0deg)`;
}
function initBubbles(){
  const root = $("bubbles");
  if (!root || root.dataset.ready === "1") return;
  root.dataset.ready = "1";
  for (let i=0;i<10;i++){
    const b = document.createElement("div");
    b.className = "bubble";
    b.style.left = `${Math.round(8 + Math.random()*84)}%`;
    b.style.animationDuration = `${4 + Math.random()*3.5}s`;
    b.style.animationDelay = `${Math.random()*2.5}s`;
    const s = 6 + Math.random()*10;
    b.style.width = `${s}px`; b.style.height = `${s}px`;
    b.style.opacity = `${0.25 + Math.random()*0.35}`;
    root.appendChild(b);
  }
}

function setWaterProgress(pct){

  const p = Math.max(0, Math.min(1, pct));
  $("waterFill").style.height = `${Math.round(p*100)}%`;
}
function timerTick(){
  const t = state.timer;
  if (!t.running || t.paused) return;

  const now = performance.now();
  t.elapsedMs = now - t.startTs;
  const left = Math.max(0, t.durationMs - t.elapsedMs);

  $("timerLeft").textContent = fmtTime(left);
  setWaterProgress(t.elapsedMs / t.durationMs);
  setRingProgress(t.elapsedMs / t.durationMs);

  if (left <= 0){
    finishTimer(true);
    return;
  }
  t.raf = requestAnimationFrame(timerTick);
}

function startTimerForCurrent(){
  const code = state.currentCode;
  if (!code) return;

  const mins = Number($("targetMinutes").value);
  if (!isFinite(mins) || mins <= 0) return toast("Tiempo objetivo inválido.");

  $("timerCode").textContent = code;
  $("timerTarget").textContent = `Objetivo: ${mins} min`;

  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.add("hidden");
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");

  const t = state.timer;
  t.running = true; t.paused = false;
  t.durationMs = mins * 60 * 1000;
  t.elapsedMs = 0;
  t.startTs = performance.now();

  $("timerLeft").textContent = fmtTime(t.durationMs);
  setWaterProgress(0);
  setRingProgress(0);

  show("timer");
  initBubbles();
  stopRaf();
  t.raf = requestAnimationFrame(timerTick);
}

async function markOTStatus(code, status){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;

  it.status = status;
  it.updatedAt = Date.now();
  it.defaultLiters = Number($("liters").value) || it.defaultLiters || 60;
  await dbPutOT(it);
  await refreshOT();
}

async function finishTimer(auto=false){
  const t = state.timer;
  t.running = false;
  stopRaf();

  try { navigator.vibrate?.([120, 60, 120]); } catch {}
  if (auto) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(()=>{ osc.stop(); ctx.close(); }, 180);
    } catch {}
  }

  $("sealDone").classList.remove("hidden");

  const liters = Number($("liters").value) || null;
  const settings = getSettings();
  const dose = liters ? Math.round(calcDoseMl(liters, settings) ?? 0) : null;
  const mins = Number($("targetMinutes").value) || null;
  const note = String($("pointNote").value || "").trim().slice(0,120);

  await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(),
    tech: state.tech,
    date: todayStr(),
    code: state.currentCode,
    ts: Date.now(),
    liters,
    doseMl: dose,
    minutes: mins,
    result: "ok",
    note: note || undefined
  }));
  if (note) await saveOTNote(state.currentCode, note);
  await markOTStatus(state.currentCode, "ok");
}

function pauseTimer(){
  const t = state.timer;
  if (!t.running || t.paused) return;
  t.paused = true;
  stopRaf();
  $("btnPause").classList.add("hidden");
  $("btnResume").classList.remove("hidden");
}
function resumeTimer(){
  const t = state.timer;
  if (!t.running || !t.paused) return;
  t.paused = false;
  t.startTs = performance.now() - t.elapsedMs;
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");
  t.raf = requestAnimationFrame(timerTick);
}

async function markIssue(){
  const code = state.currentCode;
  if (!code) return;

  const reason = prompt(`Incidencia (rápido):
- No accesible
- Bomba no arranca
- Sin retorno
- Fuga

Escribe una frase corta:`);
  if (reason == null) return;

  $("timerCode").textContent = code;
  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.remove("hidden");

  const note = String($("pointNote").value || "").trim().slice(0,120);
  const finalReason = (reason.trim().slice(0,120) || "Incidencia");

  await dbAddHistory(enrichWithHospitalFields({ servicio:getSelectedService(),
    tech: state.tech,
    date: todayStr(),
    code,
    ts: Date.now(),
    liters: Number($("liters").value) || null,
    doseMl: null,
    minutes: Number($("targetMinutes").value) || null,
    result: "issue",
    note: note ? `${finalReason} · ${note}` : finalReason
  }));
  await saveOTNote(code, note || finalReason);
  await markOTStatus(code, "issue");
  show("timer");
  initBubbles();
  try { navigator.vibrate?.([80,40,80]); } catch {}
}

// ---------------- QR Scan ----------------
async function startScan(){
  if (!("mediaDevices" in navigator)) {
    toast("Este navegador no soporta cámara. Usa 'Añadir punto'.");
    return;
  }
  const video = $("qrVideo");
  try{
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio:false });
    video.srcObject = state.stream;
    await video.play();

    if ("BarcodeDetector" in window){
      state.detector = new BarcodeDetector({ formats: ["qr_code"] });
      scanLoop();
    } else {
      toast("Este móvil no soporta BarcodeDetector. Usa 'Añadir punto'.");
    }
  }catch(e){
    toast("No se pudo abrir la cámara. Revisa permisos.");
  }
}

async function scanLoop(){
  const video = $("qrVideo");
  if (!state.detector || !state.stream) return;

  try{
    const barcodes = await state.detector.detect(video);
    if (barcodes && barcodes.length){
      const raw = barcodes[0].rawValue || "";
      const c = normalizeCode(raw);
      if (c){
        stopScan();
        if (state.scanMode === "monthlyHot"){
          await addMonthlyQuick(c, "ACS");
          await openMonthly();
        } else if (state.scanMode === "monthlyCold") {
          await addMonthlyQuick(c, "AFCH");
          await openMonthly();
        } else {
          await addOTCode(c);
          show("home");
        }
        return;
      }
    }
  }catch{}
  requestAnimationFrame(scanLoop);
}

function stopScan(){
  const video = $("qrVideo");
  if (state.stream){
    state.stream.getTracks().forEach(t=>t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  state.detector = null;
}

// ---------------- Historial ----------------
async function openHistory(){
  const tech = state.tech;
  const items = await dbGetHistoryByTech(tech, 300);
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length !== 0);

  for (const h of items){
    const el = document.createElement("div");
    el.className = "item";
    const dt = new Date(h.ts || Date.now());
    const badgeClass = h.result === "ok" ? "ok" : "issue";
    const badgeText = h.result === "ok" ? "✅ OK" : "⚠ Incid.";
    const note = h.note ? ` · ${h.note}` : "";
    el.innerHTML = `
      <div class="left">
        <div class="code">${h.code}</div>
        <div class="meta">${dt.toLocaleString()} · ${h.liters ?? "—"} L · ${h.minutes ?? "—"} min${note}</div>
      </div>
      <span class="badge ${badgeClass}">${badgeText}</span>
    `;
    list.appendChild(el);
  }
  show("history");
}

async function exportData(){
  const dump = await dbExportAll();
  const payload = { app:"IsiVolt Pro V1.3 Legionella", exportedAt:Date.now(), tech:state.tech, data:dump };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isivolt_export_${state.tech}_${todayStr()}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

async function importData(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); }catch{ return toast("Archivo inválido."); }
  if (!payload?.data) return toast("No contiene datos.");
  await dbImportAll(payload.data);
  toast("Importación completada ✅");
  await refreshOT();
}

// ---------------- Mensual PRO ----------------
const MONTH_PLANTS = ["-1","Baja","1ª","2ª","3ª","4ª","5ª","6ª","7ª","8ª","Otros"];
function monthKey(){ return monthStr(); }

function getDefaultPlant(){
  return $("monthlyPlantDefault")?.value || "Baja";
}

async function loadMonthlyHeader(){
  const tech = state.tech;
  const month = monthKey();
  const h = await dbGetMonthlyHeader(tech, month);

  $("monthSampleDate").value = h?.sampleDate || "";
  $("monthAssignedTech").value = h?.assignedTech || "";
  $("monthHeaderNote").value = h?.note || "";
}

async function saveMonthlyHeader(){
  const month = monthKey();
  const header = {
    sampleDate: $("monthSampleDate").value || "",
    assignedTech: ($("monthAssignedTech").value || "").trim().slice(0,18),
    note: ($("monthHeaderNote").value || "").trim().slice(0,180),
  };
  await dbPutMonthlyHeader(state.tech, month, header);
  toast("Cabecera guardada ✅");
}

async function openMonthly(){
  const tech = state.tech;
  const month = monthKey();

  $("kpiMonth").textContent = month;

  await loadMonthlyHeader();

  const items = await dbGetMonthlyByTechMonth(tech, month);
  const total = items.length;
  const done = items.filter(i=>i.status==="ok").length;
  $("kpiMonthDone").textContent = `${done} / ${total}`;

  $("monthlyEmpty").classList.toggle("hidden", total !== 0);

  const accRoot = $("monthlyAccordions");
  accRoot.innerHTML = "";

  const grouped = new Map();
  for (const p of MONTH_PLANTS) grouped.set(p, []);
  for (const it of items){
    const plant = it.plant && MONTH_PLANTS.includes(it.plant) ? it.plant : "Otros";
    grouped.get(plant).push(it);
  }

  for (const plant of MONTH_PLANTS){
    const arr = grouped.get(plant) || [];
    if (!state.showEmptyMonthly && arr.length === 0) continue;

    const pDone = arr.filter(x=>x.status==="ok").length;
    const pTotal = arr.length;
    const pct = pTotal ? Math.round((pDone/pTotal)*100) : 0;

    const acc = document.createElement("div");
    acc.className = "accordion";
    acc.innerHTML = `
      <div class="acc-head">
        <div>
          <div class="acc-title">Planta ${plant}</div>
          <div class="acc-sub">${pDone} / ${pTotal} · ${pct}%</div>
        </div>
        <div class="row" style="gap:10px;">
          <div class="progress"><div style="width:${pct}%;"></div></div>
          <div class="acc-arrow">▾</div>
        </div>
      </div>
      <div class="acc-body">
        <div class="row" style="justify-content:space-between; margin-bottom:10px;">
          <div class="muted tiny">Acciones rápidas</div>
          <button class="btn btn-ghost" data-naall="1">🚫 No aplica (planta)</button>
        </div>
        <div class="list" data-list="1"></div>
        <div class="muted tiny" data-empty="1" style="padding:10px 6px; display:none;">Sin puntos en esta planta.</div>
      </div>
    `;
    const head = acc.querySelector(".acc-head");
    head.addEventListener("click", ()=>{
      acc.classList.toggle("open");
      acc.querySelector(".acc-arrow").textContent = acc.classList.contains("open") ? "▴" : "▾";
    });

    if (!state.showEmptyMonthly && arr.length && accRoot.children.length===0){
      acc.classList.add("open");
      acc.querySelector(".acc-arrow").textContent = "▴";
    }

    const list = acc.querySelector('[data-list="1"]');
    const empty = acc.querySelector('[data-empty="1"]');
    empty.style.display = (arr.length===0) ? "block" : "none";

    acc.querySelector('[data-naall="1"]').addEventListener("click", async (e)=>{
      e.stopPropagation();
      if (arr.length===0) return toast("No hay puntos en esta planta.");
      const ok = confirm(`¿Marcar TODA la Planta ${plant} como NO APLICA?`);
      if (!ok) return;
      const reason = prompt("Motivo rápido (ej: Exterior/otra empresa, Parking sin tomas, No corresponde):", "Parking sin tomas");
      const r = (reason || "No aplica").trim().slice(0,80);
      for (const it of arr){
        it.status = "na";
        it.updatedAt = Date.now();
        it.note = r;
        await dbPutMonthly(it);
      }
      await openMonthly();
    });

    for (const it of arr.sort((a,b)=> (a.order||0)-(b.order||0))){
      const el = document.createElement("div");
      el.className = "item";
      const dt = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : "—";
      const badgeClass = it.status === "ok" ? "ok" : it.status === "issue" ? "issue" : it.status === "na" ? "na" : "todo";
      const badgeText = it.status === "ok" ? "✅ Hecho" : it.status === "issue" ? "⚠ Incid." : it.status === "na" ? "🚫 No aplica" : "⏳ Pend.";
      const water = it.water === "ACS" ? "🔥 ACS" : it.water === "AFCH" ? "❄️ AFCH" : "—";
      const icon = it.element === "Ducha" ? "🚿" : it.element === "Grifo" ? "🚰" : it.element === "Lavabo" ? "🚰" : it.element === "Fregadero" ? "🍽️" : "📍";
      const desc = it.desc ? ` · ${it.desc}` : "";
      const note = it.note ? ` · ${it.note}` : "";
      el.innerHTML = `
        <div class="left">
          <div class="code">${icon} ${it.code}</div>
          <div class="meta">${water}${desc}</div>
          <div class="meta">${dt}${note}</div>
        </div>
        <div class="item-actions">
          <span class="badge ${badgeClass}">${badgeText}</span>
          <button class="smallbtn ok" data-ok="1">✅</button>
          <button class="smallbtn issue" data-issue="1">⚠</button>
          <button class="smallbtn na" data-na="1">🚫</button>
        </div>
      `;
      el.querySelector('[data-ok="1"]').addEventListener("click", async ()=>{
        it.status = "ok";
        it.updatedAt = Date.now();
        it.note = "";
        await dbPutMonthly(it);
        await openMonthly();
      });
      el.querySelector('[data-issue="1"]').addEventListener("click", async ()=>{
        const r = prompt("Incidencia (rápido):", it.note || "");
        if (r == null) return;
        it.status = "issue";
        it.updatedAt = Date.now();
        it.note = r.trim().slice(0,120);
        await dbPutMonthly(it);
        await openMonthly();
      });
      el.querySelector('[data-na="1"]').addEventListener("click", async ()=>{
        const r = prompt(`No aplica (motivo):
- Exterior (otra empresa)
- Parking sin tomas
- No corresponde este mes`, it.note || "Exterior (otra empresa)");
        if (r == null) return;
        it.status = "na";
        it.updatedAt = Date.now();
        it.note = r.trim().slice(0,120);
        await dbPutMonthly(it);
        await openMonthly();
      });

      // Swipe mensual: derecha OK, izquierda elegir Incidencia/No aplica
      bindSwipe(el, {
        onRight: async ()=>{
          it.status = "ok";
          it.updatedAt = Date.now();
          it.note = "";
          await dbPutMonthly(it);
          toast(`✅ ${it.code}`, "ok", "Mensual");
          await openMonthly();
        },
        onLeft: async ()=>{
          const choice = prompt("Izquierda = acción rápida:\n1 = Incidencia\n2 = No aplica", "1");
          if (choice == null) return;
          if (String(choice).trim() === "2"){
            const r = prompt("No aplica (motivo):", it.note || "Exterior (otra empresa)");
            if (r == null) return;
            it.status = "na";
            it.note = r.trim().slice(0,120);
          } else {
            const r = prompt("Incidencia:", it.note || "");
            if (r == null) return;
            it.status = "issue";
            it.note = r.trim().slice(0,120);
          }
          it.updatedAt = Date.now();
          await dbPutMonthly(it);
          toast(`Actualizado ${it.code}`, "info", "Mensual");
          await openMonthly();
        }
      });

      list.appendChild(el);
    }

    accRoot.appendChild(acc);
  }

  show("monthly");
}

async function addMonthlyQuick(code, water){
  const c = normalizeCode(code);
  if (!c) return toast("Código inválido.");

  const tech = state.tech;
  const month = monthKey();

  const plant = getDefaultPlant() || "Baja";

  const existing = await dbGetMonthlyByTechMonth(tech, month);
  if (existing.some(x=>x.code===c && x.water===water && x.plant===plant)) {
    toast("Ya existe este punto en esa planta/agua.");
    return;
  }

  const el = prompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  const element = String(el||"DUCHA").toUpperCase().startsWith("G") ? "Grifo"
                : String(el||"").toUpperCase().startsWith("LAV") ? "Lavabo"
                : String(el||"").toUpperCase().startsWith("FRE") ? "Fregadero"
                : String(el||"").toUpperCase().startsWith("O") ? "Otro"
                : "Ducha";
  const desc = prompt(`Descripción corta (opcional):
Ej: 2ª Planta · Hab 21024 · Aseo`, "") ?? "";

  await dbPutMonthly({
    key: `${tech}|${month}|${plant}|${water}|${c}`,
    tech, month,
    plant,
    water,
    element,
    code:c,
    desc: desc.trim().slice(0,120),
    status:"todo",
    order: Date.now(),
    updatedAt: Date.now(),
    note: ""
  });
}

async function addMonthlyManual(){
  const waterRaw = prompt("Tipo de agua: ACS (caliente) o AFCH (fría)", "ACS");
  if (waterRaw == null) return;
  const water = String(waterRaw).toUpperCase().startsWith("A") ? "ACS" : "AFCH";

  const plant = prompt("Planta (ej: Baja, 2ª, 6ª, -1, Otros)", getDefaultPlant());
  if (plant == null) return;
  const p = MONTH_PLANTS.includes(plant) ? plant : plant.trim() || "Otros";

  const code = prompt("Código del punto (usará los 5 últimos):");
  if (code == null) return;
  const c = normalizeCode(code);
  if (!c) return toast("Código inválido.");

  const elementRaw = prompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  if (elementRaw == null) return;
  const element = String(elementRaw||"DUCHA").toUpperCase().startsWith("G") ? "Grifo"
                : String(elementRaw||"").toUpperCase().startsWith("LAV") ? "Lavabo"
                : String(elementRaw||"").toUpperCase().startsWith("FRE") ? "Fregadero"
                : String(elementRaw||"").toUpperCase().startsWith("O") ? "Otro"
                : "Ducha";
  const desc = prompt("Descripción (opcional)", "") ?? "";

  const tech = state.tech;
  const month = monthKey();
  const existing = await dbGetMonthlyByTechMonth(tech, month);
  if (existing.some(x=>x.code===c && x.water===water && x.plant===p)) {
    return toast("Ya existe este punto en esa planta/agua.");
  }

  await dbPutMonthly({
    key: `${tech}|${month}|${p}|${water}|${c}`,
    tech, month,
    plant:p,
    water,
    element,
    code:c,
    desc: desc.trim().slice(0,160),
    status:"todo",
    order: Date.now(),
    updatedAt: Date.now(),
    note:""
  });
}

async function attachMonthlyFile(file){
  const tech = state.tech;
  const month = monthKey();
  const dataUrl = await fileToDataUrl(file);
  await dbPutMonthlyFile(tech, month, { filename: file.name, mime: file.type, dataUrl });
  toast("Adjunto guardado en este móvil ✅");
}
async function openMonthlyFile(){
  const tech = state.tech;
  const month = monthKey();
  const f = await dbGetMonthlyFile(tech, month);
  if (!f?.dataUrl) return toast("Aún no has adjuntado archivo para este mes.");
  window.open(f.dataUrl, "_blank");
}
function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.readAsDataURL(file);
  });
}
async function exportMonthly(){
  const tech = state.tech;
  const month = monthKey();
  const header = await dbGetMonthlyHeader(tech, month);
  const items = await dbGetMonthlyByTechMonth(tech, month);
  const payload = {
    app: "IsiVolt Pro V1.3 Legionella",
    kind: "monthly",
    exportedAt: Date.now(),
    tech,
    month,
    header,
    items
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `isivolt_mensual_${tech}_${month}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// ---------------- Guide (speech synthesis) ----------------
function openGuide(){
  const t = storageGet(GUIDE_KEY, DEFAULT_GUIDE) || DEFAULT_GUIDE;
  $("guideText").value = t;
  show("guide");
}
function saveGuideText(){
  storageSet(GUIDE_KEY, $("guideText").value);
}
function speakGuide(){
  saveGuideText();
  if (!("speechSynthesis" in window)) return toast("Este móvil no soporta voz.");
  const u = new SpeechSynthesisUtterance($("guideText").value);
  u.lang = "es-ES";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function stopSpeak(){ if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }

// ---------------- Settings modal ----------------
function openSettings(){
  const s = getSettings();
  $("bleachPct").value = s.bleachPct;
  $("targetPpm").value = s.targetPpm;
  $("baseMin").value = s.baseMin;
  $("factorPerL").value = s.factorPerL;
  $("modalSettings").classList.remove("hidden");
}
function closeSettings(){ $("modalSettings").classList.add("hidden"); }
function saveSettingsFromUI(){
  const s = {
    bleachPct: Number($("bleachPct").value) || DEFAULT_SETTINGS.bleachPct,
    targetPpm: Number($("targetPpm").value) || DEFAULT_SETTINGS.targetPpm,
    baseMin: Number($("baseMin").value) || DEFAULT_SETTINGS.baseMin,
    factorPerL: Number($("factorPerL").value) || DEFAULT_SETTINGS.factorPerL,
  };
  saveSettings(s);
  closeSettings();
  updateDoseUI();
  $("targetMinutes").value = calcAutoMinutes($("liters").value, s);
}
function resetSettings(){ saveSettings({ ...DEFAULT_SETTINGS }); openSettings(); }

// ---------------- Navigation & Events ----------------
function bindNav(){
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const to = btn.getAttribute("data-nav");
      if (to === "home") { show("home"); refreshOT(); }
    });
  });
}
function setScanMode(mode){
  state.scanMode = mode;
  const title = $("scanTitle");
  const hint = $("scanHint");
  if (mode === "monthlyHot"){
    title.textContent = "Escanear · 🔥 ACS (Caliente)";
    hint.textContent = "Escanea el QR/código del punto (ACS). Se guardará en la planta por defecto.";
  } else if (mode === "monthlyCold"){
    title.textContent = "Escanear · ❄️ AFCH (Fría)";
    hint.textContent = "Escanea el QR/código del punto (AFCH). Se guardará en la planta por defecto.";
  } else {
    title.textContent = "Escanear QR";
    hint.textContent = "Si tu móvil no soporta escaneo nativo, usa “Añadir punto”.";
  }
}


function bindSwipe(el, {onRight, onLeft}){
  let startX = 0, startY = 0, dx = 0, dy = 0, active = false;
  const threshold = 80;

  el.addEventListener("touchstart", (e)=>{
    const t = e.touches?.[0];
    if (!t) return;
    startX = t.clientX; startY = t.clientY;
    dx = 0; dy = 0; active = true;
    el.classList.remove("swipe-ok","swipe-issue");
  }, {passive:true});

  el.addEventListener("touchmove", (e)=>{
    if (!active) return;
    const t = e.touches?.[0];
    if (!t) return;
    dx = t.clientX - startX;
    dy = t.clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 18){
      el.classList.add("swiping");
      el.style.transform = `translateX(${Math.max(-110, Math.min(110, dx))}px)`;
      if (dx > 0) { el.classList.add("swipe-ok"); el.classList.remove("swipe-issue"); }
      else { el.classList.add("swipe-issue"); el.classList.remove("swipe-ok"); }
    }
  }, {passive:true});

  el.addEventListener("touchend", async ()=>{
    if (!active) return;
    active = false;
    el.classList.remove("swiping");
    el.style.transition = "transform .18s ease";
    el.style.transform = "translateX(0px)";
    setTimeout(()=>{ el.style.transition = ""; }, 220);

    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy)){
      if (dx > 0) { await onRight?.(); }
      else { await onLeft?.(); }
    }
    el.classList.remove("swipe-ok","swipe-issue");
  }, {passive:true});
}


// ---- Podcast: persist position + mini player + rope waveform + wake lock
const PODCAST_KEY = "isivolt_podcast_v1";
let wakeLock = null;
let ropeAnimId = null;

function loadPodcastState(){
  try { return JSON.parse(storageGet(PODCAST_KEY, "{}") || "{}"); } catch { return {}; }
}
function savePodcastState(data){
  storageSet(PODCAST_KEY, JSON.stringify(data));
}
function fmtClock(sec){
  if (!isFinite(sec) || sec < 0) return "00:00";
  sec = Math.floor(sec);
  const m = Math.floor(sec/60);
  const s = sec % 60;
  return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
}

async function requestWakeLock(){
  try{
    if (!("wakeLock" in navigator)) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", ()=>{ /* released */ });
  } catch {}
}
async function releaseWakeLock(){
  try{ await wakeLock?.release(); } catch {}
  wakeLock = null;
}

function startRopeWave(){
  const c = $("ropeWave");
  if (!c) return;
  const ctx = c.getContext("2d");
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = c.getBoundingClientRect();
  c.width = Math.floor(rect.width * dpr);
  c.height = Math.floor(rect.height * dpr);
  ctx.scale(dpr, dpr);

  const lines = [
    { amp: 10, freq: 1.2, speed: 0.9, off: 0, a: 0.60 },
    { amp: 14, freq: 0.9, speed: 0.7, off: 1.4, a: 0.55 },
    { amp: 8,  freq: 1.6, speed: 1.0, off: 2.2, a: 0.35 },
  ];

  const draw = (t)=>{
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0,0,w,h);

    // subtle background glow
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(0,0,w,h);

    // draw lines (rope)
    for (let i=0;i<lines.length;i++){
      const L = lines[i];
      ctx.beginPath();
      for (let x=0; x<=w; x+=6){
        const y = h/2 + Math.sin((x/w)*Math.PI*2*L.freq + t*0.002*L.speed + L.off) * L.amp;
        if (x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.lineWidth = i===0 ? 3 : 2;
      ctx.strokeStyle = i===0 ? "rgba(46,196,182,0.85)" : i===1 ? "rgba(0,212,255,0.70)" : "rgba(255,255,255,0.30)";
      ctx.shadowColor = "rgba(46,196,182,0.25)";
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ropeAnimId = requestAnimationFrame(draw);
  };
  cancelAnimationFrame(ropeAnimId);
  ropeAnimId = requestAnimationFrame(draw);
}

function stopRopeWave(){
  if (ropeAnimId) cancelAnimationFrame(ropeAnimId);
  ropeAnimId = null;
}

function initPodcastUI(){
  const audio = $("podcastPlayer");
  if (!audio) return;

  const st = loadPodcastState();
  if (st.time && st.src){
    // only restore if same track
    audio.currentTime = Math.max(0, Number(st.time) || 0);
  }

  const updateText = ()=>{
    const cur = fmtClock(audio.currentTime || 0);
    const dur = fmtClock(audio.duration || 0);
    const rate = audio.playbackRate || 1;
    const prog = $("podcastProgress");
    if (prog) prog.textContent = `${cur} / ${dur} · ${rate}×`;
    const miniTime = $("miniTime");
    if (miniTime) miniTime.textContent = `${cur} / ${dur}`;
    const fill = $("miniBarFill");
    if (fill && isFinite(audio.duration) && audio.duration>0){
      fill.style.width = `${Math.min(100, (audio.currentTime/audio.duration)*100)}%`;
    }
  };

  audio.addEventListener("timeupdate", ()=>{
    updateText();
    savePodcastState({ src: audio.currentSrc || "podcast", time: audio.currentTime || 0 });
  });
  audio.addEventListener("loadedmetadata", updateText);
  audio.addEventListener("ratechange", updateText);

  // Buttons
  $("btnPodcastPlay")?.addEventListener("click", async ()=>{
    await audio.play().catch(()=>{});
  });
  $("btnPodcastPause")?.addEventListener("click", ()=>{ audio.pause(); });
  $("btnPodcastRestart")?.addEventListener("click", ()=>{
    audio.currentTime = 0;
    savePodcastState({ src: audio.currentSrc || "podcast", time: 0 });
    updateText();
  });

  // Mini player controls
  $("miniRew")?.addEventListener("click", ()=>{
    audio.currentTime = Math.max(0, (audio.currentTime||0) - 10);
  });
  $("miniFwd")?.addEventListener("click", ()=>{
    audio.currentTime = Math.min(audio.duration || Infinity, (audio.currentTime||0) + 10);
  });
  $("miniPlay")?.addEventListener("click", async ()=>{
    if (audio.paused) await audio.play().catch(()=>{});
    else audio.pause();
  });

  const mini = $("miniPlayer");
  const miniPlay = $("miniPlay");

  const syncMini = ()=>{
    if (!mini || !miniPlay) return;
    // show mini player whenever audio has started or is playing
    const started = (audio.currentTime || 0) > 0 || !audio.paused;
    if (started) mini.classList.remove("hidden");
    miniPlay.textContent = audio.paused ? "▶" : "⏸";
  };

  audio.addEventListener("play", async ()=>{
    syncMini();
    startRopeWave();
    await requestWakeLock();
  });
  audio.addEventListener("pause", ()=>{
    syncMini();
    // keep wave running lightly? we'll stop to save battery
    stopRopeWave();
    releaseWakeLock();
  });
  audio.addEventListener("ended", ()=>{
    syncMini();
    stopRopeWave();
    releaseWakeLock();
  });

  // when returning to app, if playing keep wake lock
  document.addEventListener("visibilitychange", ()=>{
    if (document.visibilityState === "visible" && !audio.paused){
      requestWakeLock();
    } else if (document.visibilityState !== "visible"){
      releaseWakeLock();
    }
  });

  // Resize redraw
  window.addEventListener("resize", ()=>{
    if (!audio.paused) startRopeWave();
  });

  // initial
  updateText();
  syncMini();
  if (!audio.paused) startRopeWave();
}


// ---- Hospital Mode (V1.8): Parser de códigos PTS/San Cecilio
const HOSPITAL_RULES = {
  lettersByFloor: {
    "-1": ["A","B","C","D","E","F","H"],
    "0":  ["A","B","C","D","E","H"],
    "1":  ["A","B","C"],
    "2":  ["B","C","D","E","H"],
    "3":  ["B","D","H"],
    "4":  ["B","D","H"],
    "5":  ["B","D","H"],
    "6":  ["B","D","H"],
    "7":  ["B","D","H"],
    "8":  ["D","H"],
    "9":  ["D","H"],
  },
  numericMacroByFloor: {
    "0":  [1,2,3],          // 01xxx/02xxx/03xxx
    "1":  [1,4,5],          // 11xxx/14xxx/15xxx
    "2":  [1,2,3,4,5],      // 21..25
    "3":  [1,2,3,4,5],
    "4":  [1,2,3,4,5],
    "5":  [1,2,3,4,5],
    "6":  [1,2,3,4,5],
    "7":  [1,2,3,4,5],
  }
};

function normalizeHospitalCode(raw){
  return String(raw||"")
    .trim()
    .replace(/\s+/g,"")
    .replace(/-/g,"")
    .toUpperCase();
}

function parseHospitalCode(raw){
  const code = normalizeHospitalCode(raw);
  if (!code) return { ok:false, error:"Código vacío" };

  // Sótano -1: SA001 / SD042 / SH003 + sufijo opcional (a/b/...)
  let m = code.match(/^S([A-Z])(\d{3})([A-Z])?$/);
  if (m){
    const z = m[1], loc = m[2], suf = (m[3]||"").toLowerCase();
    const allowed = HOSPITAL_RULES.lettersByFloor["-1"] || [];
    if (!allowed.includes(z)) return { ok:false, error:`Zona no válida en sótano: ${z}` };
    return { ok:true, data:{ codigoHospital: code, planta:-1, macroZona:"S"+z, zona:z, local:loc, sufijo:suf||"" } };
  }

  // Sótano técnico: S1001 + sufijo opcional
  m = code.match(/^S([1-9])(\d{3})([A-Z])?$/);
  if (m){
    const d = m[1], loc = m[2], suf = (m[3]||"").toLowerCase();
    return { ok:true, data:{ codigoHospital: code, planta:-1, macroZona:"S"+d, zona:"T"+d, local:loc, sufijo:suf||"" } };
  }

  // Formato con letra en plantas 0-9: 7D001 / 0E024A
  m = code.match(/^([0-9])([A-Z])(\d{3})([A-Z])?$/);
  if (m){
    const p = Number(m[1]), z = m[2], loc = m[3], suf = (m[4]||"").toLowerCase();
    const allowed = HOSPITAL_RULES.lettersByFloor[String(p)] || [];
    if (!allowed.includes(z)) return { ok:false, error:`Zona ${z} no válida en planta ${p}` };
    return { ok:true, data:{ codigoHospital: code, planta:p, macroZona:String(p)+z, zona:z, local:loc, sufijo:suf||"" } };
  }

  // Formato lineal numérico (5 dígitos): 01001 / 21001 / 72001
  m = code.match(/^([0-9])([0-9])(\d{3})([A-Z])?$/);
  if (m){
    const p = Number(m[1]), macro = Number(m[2]), loc = m[3], suf = (m[4]||"").toLowerCase();
    const allowedMacros = HOSPITAL_RULES.numericMacroByFloor[String(p)];
    if (allowedMacros && !allowedMacros.includes(macro)) return { ok:false, error:`Macrozona ${p}${macro} no válida en planta ${p}` };
    return { ok:true, data:{ codigoHospital: code, planta:p, macroZona:String(p)+String(macro), zona:"Z"+String(macro), local:loc, sufijo:suf||"" } };
  }

  return { ok:false, error:"Formato inválido. Ej: 7D001 / 21001 / SA001" };
}

function updateCodePreview(raw){
  const el = $("codePreview");
  if (!el) return;
  if (!raw){
    el.classList.add("hidden"); el.innerHTML = ""; return;
  }
  const r = parseHospitalCode(raw);
  el.classList.remove("hidden");
  if (!r.ok){
    el.innerHTML = `⚠ <b>${escHtml(r.error)}</b><div class="muted tiny">Ej: 7D001 · 21001 · SA001 · 0E024a</div>`;
    return;
  }
  const d = r.data;
  el.innerHTML = `🏥 <b>${escHtml(d.codigoHospital)}</b> → Planta <b>${escHtml(d.planta)}</b> · MacroZona <b>${escHtml(d.macroZona)}</b> · Zona <b>${escHtml(d.zona)}</b> · Local <b>${escHtml(d.local)}</b>${d.sufijo?` · Sufijo <b>${escHtml(d.sufijo)}</b>`:""}`;
}


function getValidatedHospitalCode(raw){
  const parsed = parseHospitalCode(raw);
  if (!parsed.ok){
    toast(parsed.error, "warn", "Código");
    return null;
  }
  return parsed.data;
}

function enrichWithHospitalFields(obj){
  try{
    if (!obj || !obj.code) return obj;
    if (obj.planta !== undefined && obj.macroZona) return obj;
    const p = parseHospitalCode(obj.code);
    if (!p.ok) return obj;
    return { ...obj, ...p.data };
  } catch { return obj; }
}



function getSelectedService(){
  const sel = document.getElementById("serviceSelect");
  return sel?.value || "";
}

function populateServiceSelect(){
  const sel = document.getElementById("serviceSelect");
  if(!sel) return;
  sel.innerHTML = "<option value=''>-- Servicio (opcional) --</option>";
  SERVICE_CATALOG_V19.forEach(s=>{
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.nombre;
    sel.appendChild(opt);
  });
}

function init(){
  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").then((reg)=>{
  reg.addEventListener("updatefound", ()=>{
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener("statechange", ()=>{
      if (nw.state === "installed" && navigator.serviceWorker.controller){
        const banner = $("updateBanner");
        banner?.classList.remove("hidden");
        $("btnUpdateNow")?.addEventListener("click", ()=>{ window.location.reload(); });
        $("btnUpdateLater")?.addEventListener("click", ()=>{ banner?.classList.add("hidden"); });
        toast("Hay una nueva versión lista. Pulsa Actualizar.", "info", "Actualización");
      }
    });
  });
}).catch(()=>{});
  }
  bindNav();

  const pill = $("pillOffline");
  function updateOnline(){
    const on = navigator.onLine;
    pill.textContent = on ? "Online" : "Offline OK";
    pill.style.opacity = on ? "0.95" : "0.8";
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  if (!state.tech){
    show("profile");
  } else {
    show("home");
    refreshOT();
  }

  $("btnSetTech").addEventListener("click", async ()=>{
    const name = String($("techName").value || "").trim();
    if (!name) return toast("Escribe el nombre del técnico.");
    state.tech = name;
    storageSet("isivolt.tech", name);
    show("home");
    await refreshOT();
  });

  $("techName").addEventListener("keydown", async (e)=>{
    if (e.key !== "Enter") return;
    e.preventDefault();
    $("btnSetTech").click();
  });

  $("btnSwitchTech").addEventListener("click", ()=>{
    storageRemove("isivolt.tech");
    state.tech = "";
    $("techName").value = "";
    show("profile");
  });

  $("btnLogout").addEventListener("click", ()=>{
    if (!confirm("¿Cerrar sesión en este móvil?")) return;
    storageRemove("isivolt.tech");
    state.tech = "";
    $("techName").value = "";
    show("profile");
  });

  $("btnAddCode").addEventListener("click", async ()=>{
    const code = prompt("Introduce el código (se usarán los 5 últimos):");
    if (code == null) return;
    await addOTCode(code);
  });

  $("btnScan").addEventListener("click", ()=>{
    setScanMode("ot");
    show("scan");
  });

  $("btnHistory").addEventListener("click", ()=> openHistory());
  $("btnMonthly").addEventListener("click", ()=> openMonthly());

  $("btnExplainOT").addEventListener("click", ()=>{
    alert(`OT de hoy = la lista de puntos que vas a hacer hoy.

Se crea añadiendo puntos (QR o código).
Cuando completas un punto, queda ✅ y se guarda en el historial.`);
  });

  $("btnClearOT").addEventListener("click", async ()=>{
    if (!confirm("¿Vaciar OT de hoy? (solo en este móvil)")) return;
    await dbDeleteOTByTechDate(state.tech, todayStr());
    await refreshOT();
  });

  $("btnStartScan").addEventListener("click", startScan);
  $("btnStopScan").addEventListener("click", stopScan);
  $("btnManualGo").addEventListener("click", async ()=>{
    const c = normalizeCode($("manualCodeFromScan").value);
    if (!c) return toast("Código inválido.");
    stopScan();
    if (state.scanMode === "monthlyHot"){
      await addMonthlyQuick(c, "ACS");
      await openMonthly();
    } else if (state.scanMode === "monthlyCold"){
      await addMonthlyQuick(c, "AFCH");
      await openMonthly();
    } else {
      await addOTCode(c);
      show("home");
    }
  });

  $("liters").addEventListener("input", ()=> updateDoseUI());
  $("btnUseDefaultLiters").addEventListener("click", ()=>{
    $("liters").value = 60;
    updateDoseUI();
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });
  $("btnTimeAuto").addEventListener("click", ()=>{
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });
  $("btnSaveNote").addEventListener("click", async ()=>{
    await saveOTNote(state.currentCode, $("pointNote").value);
    toast("Nota guardada ✅");
  });
  $("btnStartTimer").addEventListener("click", ()=> startTimerForCurrent());
  $("btnMarkIssue").addEventListener("click", markIssue);
  $("btnEditCode").addEventListener("click", ()=> editOTCode(state.currentCode));

  $("btnPause").addEventListener("click", pauseTimer);
  $("btnResume").addEventListener("click", resumeTimer);
  $("btnFinish").addEventListener("click", ()=> finishTimer(false));
  $("btnExitTimer").addEventListener("click", ()=>{
    state.timer.running = false;
    stopRaf();
    show("home");
  });

  $("btnExport").addEventListener("click", exportData);
  $("btnImport").addEventListener("click", ()=> $("fileImport").click());
  $("fileImport").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  $("btnMonthlyAdd").addEventListener("click", async ()=>{
    await addMonthlyManual();
    await openMonthly();
  });
  $("btnMonthlyClear").addEventListener("click", async ()=>{
    if (!confirm("¿Vaciar checklist mensual del mes actual?")) return;
    await dbDeleteMonthlyByTechMonth(state.tech, monthKey());
    await openMonthly();
  });
  $("btnMonthlyAttach").addEventListener("click", ()=> $("monthlyFile").click());
  $("monthlyFile").addEventListener("change", async (e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await attachMonthlyFile(file);
    e.target.value = "";
  });
  $("btnMonthlyOpen").addEventListener("click", openMonthlyFile);

  $("btnMonthlyScanHot").addEventListener("click", ()=>{
    setScanMode("monthlyHot");
    show("scan");
  });
  $("btnMonthlyScanCold").addEventListener("click", ()=>{
    setScanMode("monthlyCold");
    show("scan");
  });
  $("btnMonthlyShowEmpty").addEventListener("click", async ()=>{
    state.showEmptyMonthly = !state.showEmptyMonthly;
    $("btnMonthlyShowEmpty").textContent = `👁️ Mostrar vacías: ${state.showEmptyMonthly ? "ON" : "OFF"}`;
    await openMonthly();
  });
  $("btnSaveMonthlyHeader").addEventListener("click", saveMonthlyHeader);
  $("btnMonthlyExport").addEventListener("click", exportMonthly);

  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettingsFromUI);
  $("btnResetSettings").addEventListener("click", resetSettings);

  $("btnGuide").addEventListener("click", openGuide);
  $("btnSpeak").addEventListener("click", speakGuide);
  $("btnStopSpeak").addEventListener("click", stopSpeak);
}

init();



function escHtml(s){
  return String(s ?? "").replace(/[&<>"]/g, (c)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}
function fmtDateTime(ts){
  const d = new Date(ts);
  const date = d.toLocaleDateString("es-ES");
  const time = d.toLocaleTimeString("es-ES", {hour:"2-digit", minute:"2-digit", second:"2-digit"});
  return {date, time};
}
async function exportHistoryExcel(){
  const items = await dbGetHistoryAll();
  if (!items || items.length === 0){
    toast("No hay registros en el historial.", "info", "Historial");
    return;
  }
  items.sort((a,b)=>(b.ts||0)-(a.ts||0));

  const rows = items.map((it)=>{
    const {date, time} = fmtDateTime(it.ts || Date.now());
    return {
      Fecha: date,
      Hora: time,
      Tecnico: it.tech || "",
      Codigo: it.code || "",
      Resultado: it.result || "",
      Litros: it.liters ?? "",
      Dosis_ml: it.doseMl ?? "",
      Minutos: it.minutes ?? "",
      Nota: it.note || ""
    };
  });

  const header = Object.keys(rows[0]);
  let html = '';
  html += '<html><head><meta charset="utf-8"></head><body>';
  html += '<table border="1" cellspacing="0" cellpadding="4">';
  html += '<tr>' + header.map(h=>`<th>${escHtml(h)}</th>`).join('') + '</tr>';
  for (const r of rows){
    html += '<tr>' + header.map(h=>`<td>${escHtml(r[h])}</td>`).join('') + '</tr>';
  }
  html += '</table></body></html>';

  const blob = new Blob([html], {type: "application/vnd.ms-excel;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0,10);
  a.href = url;
  a.download = `historial_legionella_${stamp}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
  toast("Excel descargado (compatible con Excel).", "ok", "Historial");
}
