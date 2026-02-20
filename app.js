/**
 * IsiVolt Pro · Legionella — app.js v2.0
 * Mejoras: multi-cronómetro, modal propio, hotel/ubicación, toast, mobile UX
 */
import {
  dbPutOT, dbGetOTByTechDate, dbDeleteOTByTechDate, dbDeleteOTKey,
  dbAddHistory, dbGetHistoryByTech,
  dbExportAll, dbImportAll,
  dbPutMonthly, dbGetMonthlyByTechMonth, dbDeleteMonthlyByTechMonth,
  dbPutMonthlyFile, dbGetMonthlyFile,
  dbPutMonthlyHeader, dbGetMonthlyHeader
} from "./db.js";

const $ = (id) => document.getElementById(id);

// ════════════════════════════════════════════════════════════
//  ESTADO GLOBAL
// ════════════════════════════════════════════════════════════
const screens = {
  profile: $("screenProfile"),
  home:    $("screenHome"),
  scan:    $("screenScan"),
  point:   $("screenPoint"),
  timer:   $("screenTimer"),
  history: $("screenHistory"),
  monthly: $("screenMonthly"),
  guide:   $("screenGuide"),
};

const state = {
  tech: localStorage.getItem("isivolt.tech") || "",
  currentCode: "",
  stream: null,
  detector: null,
  scanMode: "ot", // "ot" | "monthlyHot" | "monthlyCold"
  showEmptyMonthly: false,

  // ── Multi-timer ──
  // Map<code, { code, hotelName, running, paused, startTs, accMs, durationMs, elapsedMs, targetMinutes, liters, doseMl, note }>
  timers: new Map(),
  focusedTimerCode: null,
  masterRaf: 0,
};

// ════════════════════════════════════════════════════════════
//  CONSTANTES
// ════════════════════════════════════════════════════════════
const SETTINGS_KEY    = "isivolt.settings";
const GUIDE_KEY       = "isivolt.guideText";
const DEFAULT_SETTINGS = { bleachPct:5, targetPpm:50, baseMin:10, factorPerL:0.00 };
const DEFAULT_GUIDE = `Bienvenido a IsiVolt Pro · Legionella.

OT diaria
1) Crea tu lista en el taller: escanea QR o escribe el código.
2) En cada punto: introduce hotel/ubicación, calcula dosis y tiempo, anota observación y pulsa Iniciar.
3) El cronómetro llena el depósito. Puedes minimizarlo e ir a otro punto.
4) Si hay problemas, pulsa Incidencia.

Mensual (muestras)
1) Rellena cabecera (fecha muestreo y técnico asignado).
2) Crea la ruta por plantas (-1, Baja, 1ª–8ª).
3) Marca cada punto como Hecho / Incidencia / No aplica.

Recuerda: dosis y tiempos están prefijados hasta confirmar protocolo exacto del centro.`;

// ════════════════════════════════════════════════════════════
//  UTILIDADES
// ════════════════════════════════════════════════════════════
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function monthStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
function normalizeCode(input){
  const s = String(input || "").trim();
  if (!s) return "";
  const clean = s.replace(/[^a-zA-Z0-9]/g,"");
  if (clean.length <= 5) return clean.toUpperCase();
  return clean.slice(-5).toUpperCase();
}
function fmtTime(ms){
  const t = Math.max(0, Math.ceil(ms/1000));
  return `${String(Math.floor(t/60)).padStart(2,"0")}:${String(t%60).padStart(2,"0")}`;
}
function mgPerMlFromPct(pct){ return Number(pct) * 100; }
function calcDoseMl(liters, settings){
  const L = Number(liters);
  if (!isFinite(L) || L <= 0) return null;
  const mgTotal = Number(settings.targetPpm) * L;
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
function getSettings(){
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// ════════════════════════════════════════════════════════════
//  TOAST (no bloqueante)
// ════════════════════════════════════════════════════════════
let toastTimer = null;
function toast(msg){
  try{ navigator.vibrate?.(18); }catch{}
  const el = $("uiToast");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{
    el.classList.remove("show");
    setTimeout(()=>el.classList.add("hidden"), 220);
  }, 2800);
}

// ════════════════════════════════════════════════════════════
//  MODAL PERSONALIZADO (reemplaza alert / confirm / prompt)
// ════════════════════════════════════════════════════════════
let _modalResolve = null;

function _openModal({ title="", body="", hasInput=false, inputDefault="", inputPlaceholder="", okLabel="Aceptar", cancelLabel=null }){
  return new Promise(resolve => {
    _modalResolve = resolve;
    $("uiModalTitle").textContent = title;
    $("uiModalBody").textContent  = body;
    $("uiModalOk").textContent    = okLabel;

    const inp = $("uiModalInput");
    if (hasInput){
      inp.classList.remove("hidden");
      inp.value = inputDefault || "";
      inp.placeholder = inputPlaceholder || "";
    } else {
      inp.classList.add("hidden");
    }

    const cancel = $("uiModalCancel");
    if (cancelLabel){
      cancel.classList.remove("hidden");
      cancel.textContent = cancelLabel;
    } else {
      cancel.classList.add("hidden");
    }

    $("uiModal").classList.remove("hidden");
    if (hasInput) setTimeout(()=>{ inp.focus(); inp.select(); }, 80);
  });
}

function uiAlert(msg, title="Aviso"){
  return _openModal({ title, body:msg, okLabel:"Cerrar" });
}
function uiConfirm(msg, title="Confirmar"){
  return _openModal({ title, body:msg, okLabel:"Confirmar", cancelLabel:"Cancelar" });
}
function uiPrompt(msg, defaultVal="", title="Introduce un valor"){
  return _openModal({ title, body:msg, hasInput:true, inputDefault:defaultVal, okLabel:"Aceptar", cancelLabel:"Cancelar" });
}

function _resolveModal(value){
  $("uiModal").classList.add("hidden");
  if (_modalResolve){ _modalResolve(value); _modalResolve = null; }
}

// ════════════════════════════════════════════════════════════
//  NAVEGACIÓN
// ════════════════════════════════════════════════════════════
function show(screenName){
  for (const k of Object.keys(screens)){
    screens[k].classList.toggle("hidden", k !== screenName);
  }
  // Actualizar barra flotante al cambiar de pantalla
  renderFloatBar();
}

function bindNav(){
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const to = btn.getAttribute("data-nav");
      if (to === "home"){ show("home"); refreshOT(); }
    });
  });
}

// ════════════════════════════════════════════════════════════
//  OT
// ════════════════════════════════════════════════════════════
async function refreshOT(){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);

  const done  = items.filter(i => i.status === "ok").length;
  $("kpiTech").textContent  = tech || "—";
  $("kpiToday").textContent = `${done} / ${items.length}`;

  const list = $("otList");
  list.innerHTML = "";
  $("otEmpty").classList.toggle("hidden", items.length !== 0);

  for (const it of items.sort((a,b)=>(a.order||0)-(b.order||0))){
    const el = document.createElement("div");
    el.className = "item";
    const badgeClass = it.status==="ok" ? "ok" : it.status==="issue" ? "issue" : "todo";
    const badgeText  = it.status==="ok" ? "✅ Hecho" : it.status==="issue" ? "⚠ Incid." : "⏳ Pend.";
    const note = it.note ? ` · ${it.note}` : "";
    const hotel = it.hotel ? `<div class="meta" style="font-weight:600">${it.hotel}</div>` : "";

    // Si tiene cronómetro activo
    const tObj = state.timers.get(it.code);
    const timerBadge = tObj
      ? `<span class="timer-indicator">⏱ ${fmtTime(Math.max(0, tObj.durationMs - tObj.elapsedMs))}</span>`
      : "";

    el.innerHTML = `
      <div class="left">
        <div class="code">${it.code}</div>
        ${hotel}
        <div class="meta">${it.updatedAt ? new Date(it.updatedAt).toLocaleTimeString() : "—"}${note}</div>
      </div>
      <div class="item-right">
        ${timerBadge}
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="btn btn-ghost btn-sm" data-open="${it.code}">Abrir</button>
        <button class="btn btn-ghost btn-icon" data-edit="${it.code}" title="Editar código" style="font-size:14px;min-width:36px;min-height:36px;padding:6px">✏️</button>
      </div>
    `;
    el.querySelector("[data-open]").addEventListener("click", ()=> openPoint(it.code));
    el.querySelector("[data-edit]").addEventListener("click", ()=> editOTCode(it.code));
    list.appendChild(el);
  }
}

async function addOTCode(code){
  const c = normalizeCode(code);
  if (!c) return uiAlert("Introduce un código válido (se usan los 5 últimos).");

  const tech = state.tech;
  const date = todayStr();
  const existing = await dbGetOTByTechDate(tech, date);
  if (existing.some(x => x.code === c)){ return openPoint(c); }

  const hotel = await uiPrompt("Hotel o ubicación (opcional):", "", "Nuevo punto: " + c);
  // si cancela, hotel === null → usamos ""
  const item = {
    key: `${tech}|${date}|${c}`,
    tech, date, code:c,
    hotel: (hotel ?? "").trim().slice(0,60),
    status:"todo",
    order: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    defaultLiters:60,
    note:""
  };
  await dbPutOT(item);
  await refreshOT();
  openPoint(c);
}

async function saveOTNote(code, note, hotel){
  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === code);
  if (!it) return;
  it.note = String(note||"").trim().slice(0,120);
  if (hotel !== undefined) it.hotel = String(hotel||"").trim().slice(0,60);
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await refreshOT();
}

async function editOTCode(oldCode){
  const oldC = normalizeCode(oldCode);
  if (!oldC) return;
  const newRaw = await uiPrompt("Introduce el código correcto (usará los 5 últimos):", oldC, `Editar código (${oldC})`);
  if (newRaw == null) return;
  const newC = normalizeCode(newRaw);
  if (!newC) return uiAlert("Código inválido.");
  if (newC === oldC) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === oldC);
  if (!it) return;
  if (items.some(x => x.code === newC)) return uiAlert("Ese código ya existe en la OT de hoy.");

  const oldKey = it.key;
  it.code = newC;
  it.key = `${tech}|${date}|${newC}`;
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await dbDeleteOTKey(oldKey);

  if (state.currentCode === oldC){
    state.currentCode = newC;
    $("pointCode").textContent = newC;
    $("timerCode").textContent = newC;
  }
  // Si hay timer activo con el código viejo, actualizarlo
  if (state.timers.has(oldC)){
    const t = state.timers.get(oldC);
    t.code = newC;
    state.timers.set(newC, t);
    state.timers.delete(oldC);
    if (state.focusedTimerCode === oldC) state.focusedTimerCode = newC;
  }
  await refreshOT();
}

// ════════════════════════════════════════════════════════════
//  PUNTO
// ════════════════════════════════════════════════════════════
async function openPoint(code){
  state.currentCode = normalizeCode(code);
  if (!state.currentCode) return;

  const tech = state.tech;
  const date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x => x.code === state.currentCode);

  $("pointCode").textContent = state.currentCode;
  $("pointHotelDisplay").textContent = it?.hotel || "";

  const settings = getSettings();
  const liters = it?.defaultLiters ?? 60;
  $("liters").value = liters;
  $("hotelName").value = it?.hotel || "";
  $("targetMinutes").value = calcAutoMinutes(liters, settings);
  $("pointNote").value = it?.note ?? "";

  $("chkConnect").checked = false;
  $("chkReturn").checked  = false;
  $("chkDose").checked    = false;
  $("chkStart").checked   = false;

  updateDoseUI();
  show("point");
}

function updateDoseUI(){
  const settings = getSettings();
  const ml = calcDoseMl($("liters").value, settings);
  $("doseMl").textContent = ml == null ? "—" : `${Math.round(ml)} ml`;
}

// ════════════════════════════════════════════════════════════
//  MULTI-TIMER (núcleo)
// ════════════════════════════════════════════════════════════

/** Arranca/reanuda el RAF maestro que actualiza todos los timers */
function startMasterRaf(){
  if (state.masterRaf) return;
  function tick(){
    const now = performance.now();
    const toFinish = [];

    for (const [code, t] of state.timers){
      if (t.running && !t.paused){
        t.elapsedMs = (now - t.startTs) + t.accMs;
        if (t.elapsedMs >= t.durationMs){
          t.elapsedMs = t.durationMs;
          toFinish.push(code);
        }
      }
    }

    // Actualizar pantalla timer si está visible
    const timerScreen = screens.timer;
    if (state.focusedTimerCode && !timerScreen.classList.contains("hidden")){
      _updateTimerDisplay(state.focusedTimerCode);
    }

    // Actualizar barra flotante
    renderFloatBar();

    // Refrescar lista OT si está visible (indicador de timer)
    if (!screens.home.classList.contains("hidden")){
      _updateOTTimerIndicators();
    }

    // Auto-finalizar los que terminaron
    for (const code of toFinish){
      _autoFinishTimer(code);
    }

    const hasActive = [...state.timers.values()].some(t => t.running && !t.paused);
    if (hasActive){
      state.masterRaf = requestAnimationFrame(tick);
    } else {
      state.masterRaf = 0;
    }
  }
  state.masterRaf = requestAnimationFrame(tick);
}

function _updateTimerDisplay(code){
  const t = state.timers.get(code);
  if (!t) return;
  const left = Math.max(0, t.durationMs - t.elapsedMs);
  $("timerLeft").textContent = fmtTime(left);
  const pct = Math.min(1, t.elapsedMs / t.durationMs);
  $("waterFill").style.height = `${Math.round(pct * 100)}%`;
}

/** Solo actualiza los badges de tiempo en la lista OT sin re-renderizar todo */
function _updateOTTimerIndicators(){
  document.querySelectorAll(".timer-indicator").forEach(el=>{
    const item = el.closest(".item");
    if (!item) return;
    const openBtn = item.querySelector("[data-open]");
    if (!openBtn) return;
    const code = openBtn.getAttribute("data-open");
    const t = state.timers.get(code);
    if (t){
      const left = Math.max(0, t.durationMs - t.elapsedMs);
      el.textContent = `⏱ ${fmtTime(left)}`;
    }
  });
}

/** Inicia un nuevo cronómetro para el código actual */
function startTimerForCurrent(){
  const code = state.currentCode;
  if (!code) return;

  const mins = Number($("targetMinutes").value);
  if (!isFinite(mins) || mins <= 0){ uiAlert("Tiempo objetivo inválido."); return; }

  const liters = Number($("liters").value) || null;
  const settings = getSettings();
  const doseMl = liters ? Math.round(calcDoseMl(liters, settings) ?? 0) : null;
  const note = String($("pointNote").value || "").trim().slice(0,120);
  const hotelName = String($("hotelName").value || "").trim().slice(0,60);

  // Guardar hotel en la OT
  saveOTNote(code, note, hotelName);

  const t = {
    code, hotelName,
    running: true, paused: false,
    startTs: performance.now(),
    accMs: 0,
    durationMs: mins * 60 * 1000,
    elapsedMs: 0,
    targetMinutes: mins,
    liters, doseMl, note,
  };
  state.timers.set(code, t);
  state.focusedTimerCode = code;

  _showTimerScreen(code);
  startMasterRaf();
}

function _showTimerScreen(code){
  const t = state.timers.get(code);
  if (!t) return;
  state.focusedTimerCode = code;

  $("timerCode").textContent  = code;
  $("timerHotel").textContent = t.hotelName || "";
  $("timerTarget").textContent = `Objetivo: ${t.targetMinutes} min`;
  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.add("hidden");

  if (t.paused){
    $("btnPause").classList.add("hidden");
    $("btnResume").classList.remove("hidden");
  } else {
    $("btnPause").classList.remove("hidden");
    $("btnResume").classList.add("hidden");
  }
  _updateTimerDisplay(code);
  show("timer");
}

function pauseTimer(){
  const t = state.timers.get(state.focusedTimerCode);
  if (!t || !t.running || t.paused) return;
  t.accMs = t.elapsedMs; // acumular
  t.paused = true;
  $("btnPause").classList.add("hidden");
  $("btnResume").classList.remove("hidden");
}

function resumeTimer(){
  const t = state.timers.get(state.focusedTimerCode);
  if (!t || !t.running || !t.paused) return;
  t.paused = false;
  t.startTs = performance.now(); // reiniciar punto de referencia
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");
  startMasterRaf();
}

async function finishTimer(auto=false){
  const code = state.focusedTimerCode;
  if (!code) return;
  await _doFinishTimer(code, auto, false);
  show("home");
  await refreshOT();
}

async function _autoFinishTimer(code){
  await _doFinishTimer(code, true, false);
  // Si la pantalla timer está mostrando este código, mostrar sello
  if (state.focusedTimerCode === code && !screens.timer.classList.contains("hidden")){
    $("sealDone").classList.remove("hidden");
  }
  toast(`✅ ${code} – Tratamiento completado`);
  try{ navigator.vibrate?.([120,60,120]); }catch{}
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880; gain.gain.value = 0.06;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); setTimeout(()=>{ osc.stop(); ctx.close(); }, 200);
  }catch{}
  await refreshOT();
}

async function _doFinishTimer(code, auto, isIssue){
  const t = state.timers.get(code);
  if (!t) return;
  state.timers.delete(code);
  if (state.focusedTimerCode === code) state.focusedTimerCode = null;

  await dbAddHistory({
    tech: state.tech, date: todayStr(), code,
    ts: Date.now(),
    liters: t.liters, doseMl: t.doseMl, minutes: t.targetMinutes,
    result: isIssue ? "issue" : "ok",
    note: t.note || undefined,
    hotel: t.hotelName || undefined,
  });
  if (t.note) await saveOTNote(code, t.note, t.hotelName);
  await markOTStatus(code, isIssue ? "issue" : "ok");

  renderFloatBar();
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

async function markIssue(){
  const code = state.currentCode;
  if (!code) return;

  const reason = await uiPrompt(
    "Incidencia:\n- No accesible\n- Bomba no arranca\n- Sin retorno\n- Fuga\n\nEscribe una frase corta:",
    "", "⚠ Incidencia"
  );
  if (reason == null) return;

  const note = String($("pointNote").value || "").trim().slice(0,120);
  const finalReason = (reason.trim().slice(0,120) || "Incidencia");
  const hotelName = String($("hotelName").value || "").trim().slice(0,60);

  // Si hay cronómetro activo para este código, lo finalizamos como incidencia
  if (state.timers.has(code)){
    const t = state.timers.get(code);
    t.note = note ? `${finalReason} · ${note}` : finalReason;
    state.focusedTimerCode = code;
    await _doFinishTimer(code, false, true);
    $("sealWarn").classList.remove("hidden");
    show("timer");
  } else {
    await dbAddHistory({
      tech: state.tech, date: todayStr(), code,
      ts: Date.now(),
      liters: Number($("liters").value)||null,
      doseMl: null, minutes: Number($("targetMinutes").value)||null,
      result:"issue",
      note: note ? `${finalReason} · ${note}` : finalReason,
      hotel: hotelName || undefined,
    });
    await saveOTNote(code, note || finalReason, hotelName);
    await markOTStatus(code, "issue");
    toast("⚠ Incidencia registrada");
    show("home");
    await refreshOT();
  }
  try{ navigator.vibrate?.([80,40,80]); }catch{}
}

// ════════════════════════════════════════════════════════════
//  BARRA FLOTANTE DE CRONÓMETROS
// ════════════════════════════════════════════════════════════
function renderFloatBar(){
  const bar = $("floatTimers");
  if (state.timers.size === 0){
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = "";

  // Título de la barra
  const label = document.createElement("div");
  label.style.cssText = "writing-mode:vertical-rl;font-size:10px;color:var(--muted);align-self:center;flex-shrink:0;opacity:.7;margin-right:2px;letter-spacing:.5px;text-transform:uppercase";
  label.textContent = "Timers";
  bar.appendChild(label);

  for (const [code, t] of state.timers){
    const left = Math.max(0, t.durationMs - t.elapsedMs);
    const pct  = Math.min(100, Math.round((t.elapsedMs / t.durationMs)*100));
    const chip = document.createElement("div");
    chip.className = `timer-chip${t.paused ? " paused" : ""}`;
    chip.innerHTML = `
      <div class="chip-code">${code}</div>
      ${t.hotelName ? `<div class="chip-hotel">${t.hotelName}</div>` : ""}
      <div class="chip-time">${fmtTime(left)}</div>
      <div class="chip-status">${t.paused ? "⏸ Pausado" : `▶ ${pct}%`}</div>
      <div class="chip-actions">
        <button class="chip-btn" data-open>🔍 Ver</button>
        <button class="chip-btn finish-btn" data-finish>✅</button>
      </div>
    `;
    chip.querySelector("[data-open]").addEventListener("click", (e)=>{
      e.stopPropagation();
      _showTimerScreen(code);
    });
    chip.querySelector("[data-finish]").addEventListener("click", async (e)=>{
      e.stopPropagation();
      const ok = await uiConfirm(`¿Finalizar el tratamiento de ${code}?`, "Finalizar");
      if (!ok) return;
      state.focusedTimerCode = code;
      await _doFinishTimer(code, false, false);
      toast(`✅ ${code} – Finalizado`);
      await refreshOT();
    });
    bar.appendChild(chip);
  }
}

// ════════════════════════════════════════════════════════════
//  QR SCAN
// ════════════════════════════════════════════════════════════
async function startScan(){
  if (!("mediaDevices" in navigator)){
    uiAlert("Este navegador no soporta cámara. Usa 'Añadir punto'.");
    return;
  }
  const video = $("qrVideo");
  try{
    state.stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"environment" }, audio:false });
    video.srcObject = state.stream;
    await video.play();
    if ("BarcodeDetector" in window){
      state.detector = new BarcodeDetector({ formats:["qr_code"] });
      scanLoop();
    } else {
      uiAlert("Este móvil no soporta BarcodeDetector. Usa el campo de código manual.");
    }
  }catch{
    uiAlert("No se pudo abrir la cámara. Revisa los permisos.");
  }
}
async function scanLoop(){
  const video = $("qrVideo");
  if (!state.detector || !state.stream) return;
  try{
    const barcodes = await state.detector.detect(video);
    if (barcodes?.length){
      const c = normalizeCode(barcodes[0].rawValue || "");
      if (c){
        stopScan();
        await _handleScanResult(c);
        return;
      }
    }
  }catch{}
  requestAnimationFrame(scanLoop);
}
function stopScan(){
  const video = $("qrVideo");
  if (state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; }
  video.srcObject = null;
  state.detector = null;
}
async function _handleScanResult(c){
  if (state.scanMode === "monthlyHot"){
    await addMonthlyQuick(c,"ACS"); await openMonthly();
  } else if (state.scanMode === "monthlyCold"){
    await addMonthlyQuick(c,"AFCH"); await openMonthly();
  } else {
    await addOTCode(c); show("home");
  }
}
function setScanMode(mode){
  state.scanMode = mode;
  const title = $("scanTitle");
  const hint  = $("scanHint");
  if (mode==="monthlyHot"){
    title.textContent="Escanear · 🔥 ACS (Caliente)";
    hint.textContent="Escanea el QR del punto ACS.";
  } else if (mode==="monthlyCold"){
    title.textContent="Escanear · ❄️ AFCH (Fría)";
    hint.textContent="Escanea el QR del punto AFCH.";
  } else {
    title.textContent="Escanear QR";
    hint.textContent="Si tu móvil no soporta escaneo nativo, usa el campo inferior.";
  }
}

// ════════════════════════════════════════════════════════════
//  HISTORIAL
// ════════════════════════════════════════════════════════════
async function openHistory(){
  const items = await dbGetHistoryByTech(state.tech, 300);
  const list  = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length !== 0);
  for (const h of items){
    const el = document.createElement("div");
    el.className = "item";
    const dt = new Date(h.ts || Date.now());
    const badgeClass = h.result==="ok" ? "ok" : "issue";
    const badgeText  = h.result==="ok" ? "✅ OK" : "⚠ Incid.";
    const note = h.note ? ` · ${h.note}` : "";
    const hotel = h.hotel ? `<div class="meta" style="font-weight:600">${h.hotel}</div>` : "";
    el.innerHTML = `
      <div class="left">
        <div class="code">${h.code}</div>
        ${hotel}
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
  const payload = { app:"IsiVolt Pro v2 Legionella", exportedAt:Date.now(), tech:state.tech, data:dump };
  const blob = new Blob([JSON.stringify(payload,null,2)],{ type:"application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `isivolt_export_${state.tech}_${todayStr()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
async function importData(file){
  const text = await file.text();
  let payload;
  try{ payload = JSON.parse(text); }catch{ return uiAlert("Archivo inválido."); }
  if (!payload?.data) return uiAlert("No contiene datos válidos.");
  await dbImportAll(payload.data);
  toast("Importación completada ✅");
  await refreshOT();
}

// ════════════════════════════════════════════════════════════
//  MENSUAL PRO
// ════════════════════════════════════════════════════════════
const MONTH_PLANTS = ["-1","Baja","1ª","2ª","3ª","4ª","5ª","6ª","7ª","8ª","Otros"];
function monthKey(){ return monthStr(); }
function getDefaultPlant(){ return $("monthlyPlantDefault")?.value || "Baja"; }

async function loadMonthlyHeader(){
  const h = await dbGetMonthlyHeader(state.tech, monthKey());
  $("monthSampleDate").value   = h?.sampleDate || "";
  $("monthAssignedTech").value = h?.assignedTech || "";
  $("monthHeaderNote").value   = h?.note || "";
}

async function saveMonthlyHeader(){
  await dbPutMonthlyHeader(state.tech, monthKey(), {
    sampleDate:  $("monthSampleDate").value || "",
    assignedTech:($("monthAssignedTech").value||"").trim().slice(0,18),
    note:        ($("monthHeaderNote").value||"").trim().slice(0,180),
  });
  toast("Cabecera guardada ✅");
}

async function openMonthly(){
  const tech  = state.tech;
  const month = monthKey();
  $("kpiMonth").textContent = month;
  await loadMonthlyHeader();

  const items = await dbGetMonthlyByTechMonth(tech, month);
  const done  = items.filter(i=>i.status==="ok").length;
  $("kpiMonthDone").textContent = `${done} / ${items.length}`;
  $("monthlyEmpty").classList.toggle("hidden", items.length !== 0);

  const accRoot = $("monthlyAccordions");
  accRoot.innerHTML = "";

  const grouped = new Map();
  for (const p of MONTH_PLANTS) grouped.set(p,[]);
  for (const it of items){
    const plant = it.plant && MONTH_PLANTS.includes(it.plant) ? it.plant : "Otros";
    grouped.get(plant).push(it);
  }

  for (const plant of MONTH_PLANTS){
    const arr = grouped.get(plant) || [];
    if (!state.showEmptyMonthly && arr.length===0) continue;

    const pDone = arr.filter(x=>x.status==="ok").length;
    const pct   = arr.length ? Math.round((pDone/arr.length)*100) : 0;

    const acc = document.createElement("div");
    acc.className = "accordion";
    acc.innerHTML = `
      <div class="acc-head">
        <div>
          <div class="acc-title">Planta ${plant}</div>
          <div class="acc-sub">${pDone} / ${arr.length} · ${pct}%</div>
        </div>
        <div class="row" style="gap:10px">
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="acc-arrow">▾</div>
        </div>
      </div>
      <div class="acc-body">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <div class="muted tiny">Acciones rápidas</div>
          <button class="btn btn-ghost btn-sm" data-naall="1">🚫 No aplica (planta)</button>
        </div>
        <div class="list" data-list="1"></div>
        <div class="muted tiny" data-empty="1" style="padding:10px 6px;display:none">Sin puntos en esta planta.</div>
      </div>
    `;
    const head = acc.querySelector(".acc-head");
    head.addEventListener("click",()=>{
      acc.classList.toggle("open");
      acc.querySelector(".acc-arrow").textContent = acc.classList.contains("open") ? "▴" : "▾";
    });

    if (!state.showEmptyMonthly && arr.length && accRoot.children.length===0){
      acc.classList.add("open");
      acc.querySelector(".acc-arrow").textContent = "▴";
    }

    const list  = acc.querySelector('[data-list="1"]');
    const empty = acc.querySelector('[data-empty="1"]');
    empty.style.display = arr.length===0 ? "block":"none";

    acc.querySelector('[data-naall="1"]').addEventListener("click", async (e)=>{
      e.stopPropagation();
      if (arr.length===0) return uiAlert("No hay puntos en esta planta.");
      const ok = await uiConfirm(`¿Marcar TODA la Planta ${plant} como NO APLICA?`);
      if (!ok) return;
      const reason = await uiPrompt("Motivo rápido:", "Parking sin tomas", "No aplica (planta)");
      const r = (reason || "No aplica").trim().slice(0,80);
      for (const it of arr){ it.status="na"; it.updatedAt=Date.now(); it.note=r; await dbPutMonthly(it); }
      await openMonthly();
    });

    for (const it of arr.sort((a,b)=>(a.order||0)-(b.order||0))){
      const el  = document.createElement("div");
      el.className = "item";
      const dt   = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : "—";
      const badgeClass = it.status==="ok"?"ok":it.status==="issue"?"issue":it.status==="na"?"na":"todo";
      const badgeText  = it.status==="ok"?"✅ Hecho":it.status==="issue"?"⚠ Incid.":it.status==="na"?"🚫 No aplica":"⏳ Pend.";
      const water = it.water==="ACS"?"🔥 ACS":it.water==="AFCH"?"❄️ AFCH":"—";
      const icon  = it.element==="Ducha"?"🚿":it.element==="Grifo"?"🚰":it.element==="Lavabo"?"🚰":it.element==="Fregadero"?"🍽️":"📍";
      const desc  = it.desc ? ` · ${it.desc}` : "";
      const note  = it.note ? ` · ${it.note}` : "";
      el.innerHTML = `
        <div class="left">
          <div class="code">${icon} ${it.code}</div>
          <div class="meta">${water}${desc}</div>
          <div class="meta">${dt}${note}</div>
        </div>
        <div class="item-actions">
          <span class="badge ${badgeClass}">${badgeText}</span>
          <button class="smallbtn ok" data-ok>✅</button>
          <button class="smallbtn issue" data-issue>⚠</button>
          <button class="smallbtn na" data-na>🚫</button>
        </div>
      `;
      el.querySelector("[data-ok]").addEventListener("click", async()=>{
        it.status="ok"; it.updatedAt=Date.now(); it.note=""; await dbPutMonthly(it); await openMonthly();
      });
      el.querySelector("[data-issue]").addEventListener("click", async()=>{
        const r = await uiPrompt("Incidencia:", it.note||"", "⚠ Incidencia");
        if (r==null) return;
        it.status="issue"; it.updatedAt=Date.now(); it.note=r.trim().slice(0,120); await dbPutMonthly(it); await openMonthly();
      });
      el.querySelector("[data-na]").addEventListener("click", async()=>{
        const r = await uiPrompt("No aplica (motivo):", it.note||"Exterior (otra empresa)", "🚫 No aplica");
        if (r==null) return;
        it.status="na"; it.updatedAt=Date.now(); it.note=r.trim().slice(0,120); await dbPutMonthly(it); await openMonthly();
      });
      list.appendChild(el);
    }
    accRoot.appendChild(acc);
  }
  show("monthly");
}

async function addMonthlyQuick(code, water){
  const c = normalizeCode(code);
  if (!c) return uiAlert("Código inválido.");
  const plant    = getDefaultPlant() || "Baja";
  const existing = await dbGetMonthlyByTechMonth(state.tech, monthKey());
  if (existing.some(x=>x.code===c&&x.water===water&&x.plant===plant)){
    toast("Ya existe este punto en esa planta/agua."); return;
  }
  const elRaw   = await uiPrompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  const element = _parseElement(elRaw||"DUCHA");
  const desc    = await uiPrompt("Descripción corta (opcional):", "", "Descripción");
  await dbPutMonthly({
    key:`${state.tech}|${monthKey()}|${plant}|${water}|${c}`,
    tech:state.tech, month:monthKey(), plant, water, element, code:c,
    desc:(desc||"").trim().slice(0,120), status:"todo", order:Date.now(), updatedAt:Date.now(), note:""
  });
}

async function addMonthlyManual(){
  const waterRaw = await uiPrompt("Tipo de agua: ACS (caliente) o AFCH (fría)", "ACS");
  if (waterRaw==null) return;
  const water = String(waterRaw).toUpperCase().startsWith("A") ? "ACS" : "AFCH";

  const plantRaw = await uiPrompt("Planta (ej: Baja, 2ª, 6ª, -1, Otros)", getDefaultPlant());
  if (plantRaw==null) return;
  const plant = MONTH_PLANTS.includes(plantRaw) ? plantRaw : (plantRaw.trim()||"Otros");

  const codeRaw = await uiPrompt("Código del punto (usará los 5 últimos):", "");
  if (codeRaw==null) return;
  const c = normalizeCode(codeRaw);
  if (!c){ uiAlert("Código inválido."); return; }

  const elRaw   = await uiPrompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO", "DUCHA");
  if (elRaw==null) return;
  const element = _parseElement(elRaw||"DUCHA");
  const desc    = await uiPrompt("Descripción (opcional):", "") ?? "";

  const existing = await dbGetMonthlyByTechMonth(state.tech, monthKey());
  if (existing.some(x=>x.code===c&&x.water===water&&x.plant===plant)){
    uiAlert("Ya existe este punto en esa planta/agua."); return;
  }
  await dbPutMonthly({
    key:`${state.tech}|${monthKey()}|${plant}|${water}|${c}`,
    tech:state.tech, month:monthKey(), plant, water, element, code:c,
    desc:desc.trim().slice(0,160), status:"todo", order:Date.now(), updatedAt:Date.now(), note:""
  });
}

function _parseElement(raw){
  const u = String(raw||"").toUpperCase();
  if (u.startsWith("G")) return "Grifo";
  if (u.startsWith("LAV")) return "Lavabo";
  if (u.startsWith("FRE")) return "Fregadero";
  if (u.startsWith("O")) return "Otro";
  return "Ducha";
}

async function attachMonthlyFile(file){
  const dataUrl = await fileToDataUrl(file);
  await dbPutMonthlyFile(state.tech, monthKey(), { filename:file.name, mime:file.type, dataUrl });
  toast("Adjunto guardado ✅");
}
async function openMonthlyFile(){
  const f = await dbGetMonthlyFile(state.tech, monthKey());
  if (!f?.dataUrl) return uiAlert("Aún no has adjuntado archivo para este mes.");
  window.open(f.dataUrl, "_blank");
}
function fileToDataUrl(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(file); });
}
async function exportMonthly(){
  const header = await dbGetMonthlyHeader(state.tech, monthKey());
  const items  = await dbGetMonthlyByTechMonth(state.tech, monthKey());
  const payload = { app:"IsiVolt Pro v2 Legionella", kind:"monthly", exportedAt:Date.now(), tech:state.tech, month:monthKey(), header, items };
  const blob = new Blob([JSON.stringify(payload,null,2)],{ type:"application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`isivolt_mensual_${state.tech}_${monthKey()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// ════════════════════════════════════════════════════════════
//  GUÍA (voz)
// ════════════════════════════════════════════════════════════
function openGuide(){
  $("guideText").value = localStorage.getItem(GUIDE_KEY) || DEFAULT_GUIDE;
  show("guide");
}
function speakGuide(){
  localStorage.setItem(GUIDE_KEY, $("guideText").value);
  if (!("speechSynthesis" in window)) return uiAlert("Este dispositivo no soporta síntesis de voz.");
  const u = new SpeechSynthesisUtterance($("guideText").value);
  u.lang = "es-ES";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function stopSpeak(){ if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }

// ════════════════════════════════════════════════════════════
//  AJUSTES
// ════════════════════════════════════════════════════════════
function openSettings(){
  const s = getSettings();
  $("bleachPct").value  = s.bleachPct;
  $("targetPpm").value  = s.targetPpm;
  $("baseMin").value    = s.baseMin;
  $("factorPerL").value = s.factorPerL;
  $("modalSettings").classList.remove("hidden");
}
function closeSettings(){ $("modalSettings").classList.add("hidden"); }
function saveSettingsFromUI(){
  const s = {
    bleachPct:  Number($("bleachPct").value)  || DEFAULT_SETTINGS.bleachPct,
    targetPpm:  Number($("targetPpm").value)  || DEFAULT_SETTINGS.targetPpm,
    baseMin:    Number($("baseMin").value)    || DEFAULT_SETTINGS.baseMin,
    factorPerL: Number($("factorPerL").value) || DEFAULT_SETTINGS.factorPerL,
  };
  saveSettings(s);
  closeSettings();
  updateDoseUI();
  $("targetMinutes").value = calcAutoMinutes($("liters").value, s);
}
function resetSettings(){ saveSettings({ ...DEFAULT_SETTINGS }); openSettings(); }

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
function init(){
  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }

  bindNav();

  // ── Modal events ──
  $("uiModalOk").addEventListener("click", ()=>{
    const inp = $("uiModalInput");
    const isPrompt = !inp.classList.contains("hidden");
    if (isPrompt) _resolveModal(inp.value);
    else {
      const hasCancel = !$("uiModalCancel").classList.contains("hidden");
      _resolveModal(hasCancel ? true : undefined);
    }
  });
  $("uiModalCancel").addEventListener("click", ()=>{
    const inp = $("uiModalInput");
    const isPrompt = !inp.classList.contains("hidden");
    _resolveModal(isPrompt ? null : false);
  });
  $("uiModalInput").addEventListener("keydown", (e)=>{
    if (e.key==="Enter") $("uiModalOk").click();
    if (e.key==="Escape") $("uiModalCancel").click();
  });

  // ── Online indicator ──
  const pill = $("pillOffline");
  function updateOnline(){
    const on = navigator.onLine;
    pill.textContent = on ? "Online" : "Offline OK";
    pill.style.opacity = on ? ".95" : ".8";
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // ── Profile / login ──
  if (!state.tech){ show("profile"); }
  else { show("home"); refreshOT(); }

  $("techName").addEventListener("keydown", (e)=>{ if(e.key==="Enter") $("btnSetTech").click(); });
  $("btnSetTech").addEventListener("click", async()=>{
    const name = String($("techName").value||"").trim();
    if (!name) return uiAlert("Escribe el nombre del técnico.", "Nombre requerido");
    state.tech = name;
    localStorage.setItem("isivolt.tech", name);
    show("home");
    await refreshOT();
  });
  $("btnSwitchTech").addEventListener("click", ()=>{
    localStorage.removeItem("isivolt.tech");
    state.tech=""; $("techName").value=""; show("profile");
  });
  $("btnLogout").addEventListener("click", async()=>{
    const ok = await uiConfirm("¿Cerrar sesión en este dispositivo?", "Cerrar sesión");
    if (!ok) return;
    localStorage.removeItem("isivolt.tech");
    state.tech=""; $("techName").value=""; show("profile");
  });

  // ── Home ──
  $("btnAddCode").addEventListener("click", async()=>{
    const code = await uiPrompt("Introduce el código (se usarán los 5 últimos):", "", "Añadir punto");
    if (code==null) return;
    await addOTCode(code);
  });
  $("btnScan").addEventListener("click",()=>{ setScanMode("ot"); show("scan"); });
  $("btnHistory").addEventListener("click",()=> openHistory());
  $("btnMonthly").addEventListener("click",()=> openMonthly());
  $("btnExplainOT").addEventListener("click",()=>{
    uiAlert("OT de hoy = la lista de puntos que vas a hacer hoy.\n\nCrea puntos con QR o código. Al completar un punto queda ✅ y se guarda en el historial.", "¿Qué es OT de hoy?");
  });
  $("btnClearOT").addEventListener("click", async()=>{
    const ok = await uiConfirm("¿Vaciar toda la OT de hoy? (solo en este dispositivo)", "Vaciar OT");
    if (!ok) return;
    await dbDeleteOTByTechDate(state.tech, todayStr());
    await refreshOT();
  });

  // ── Scan ──
  $("btnStartScan").addEventListener("click", startScan);
  $("btnStopScan").addEventListener("click", stopScan);
  $("btnManualGo").addEventListener("click", async()=>{
    const c = normalizeCode($("manualCodeFromScan").value);
    if (!c){ uiAlert("Código inválido."); return; }
    stopScan();
    await _handleScanResult(c);
    show("home");
  });

  // ── Punto ──
  $("liters").addEventListener("input",()=> updateDoseUI());
  $("hotelName").addEventListener("change",()=>{
    $("pointHotelDisplay").textContent = $("hotelName").value;
  });
  $("btnUseDefaultLiters").addEventListener("click",()=>{
    $("liters").value = 60;
    updateDoseUI();
    $("targetMinutes").value = calcAutoMinutes(60, getSettings());
  });
  $("btnTimeAuto").addEventListener("click",()=>{
    $("targetMinutes").value = calcAutoMinutes($("liters").value, getSettings());
  });
  $("btnSaveNote").addEventListener("click", async()=>{
    await saveOTNote(state.currentCode, $("pointNote").value, $("hotelName").value);
    toast("Nota guardada ✅");
  });
  $("btnStartTimer").addEventListener("click",()=> startTimerForCurrent());
  $("btnMarkIssue").addEventListener("click", markIssue);
  $("btnEditCode").addEventListener("click",()=> editOTCode(state.currentCode));

  // ── Timer ──
  $("btnPause").addEventListener("click", pauseTimer);
  $("btnResume").addEventListener("click", resumeTimer);
  $("btnFinish").addEventListener("click",()=> finishTimer(false));
  $("btnMinimizeTimer").addEventListener("click",()=>{
    // Minimizar: volver a home dejando el timer corriendo en la barra flotante
    show("home");
    refreshOT();
  });
  $("btnExitTimer").addEventListener("click",()=>{
    // Ir a home sin finalizar (el timer sigue)
    show("home");
    refreshOT();
  });

  // ── Historial ──
  $("btnExport").addEventListener("click", exportData);
  $("btnImport").addEventListener("click",()=> $("fileImport").click());
  $("fileImport").addEventListener("change", async(e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await importData(file);
    e.target.value = "";
  });

  // ── Mensual ──
  $("btnMonthlyAdd").addEventListener("click", async()=>{ await addMonthlyManual(); await openMonthly(); });
  $("btnMonthlyClear").addEventListener("click", async()=>{
    const ok = await uiConfirm("¿Vaciar checklist mensual del mes actual?", "Vaciar mensual");
    if (!ok) return;
    await dbDeleteMonthlyByTechMonth(state.tech, monthKey());
    await openMonthly();
  });
  $("btnMonthlyAttach").addEventListener("click",()=> $("monthlyFile").click());
  $("monthlyFile").addEventListener("change", async(e)=>{
    const file = e.target.files?.[0];
    if (!file) return;
    await attachMonthlyFile(file);
    e.target.value="";
  });
  $("btnMonthlyOpen").addEventListener("click", openMonthlyFile);
  $("btnMonthlyScanHot").addEventListener("click",()=>{ setScanMode("monthlyHot"); show("scan"); });
  $("btnMonthlyScanCold").addEventListener("click",()=>{ setScanMode("monthlyCold"); show("scan"); });
  $("btnMonthlyShowEmpty").addEventListener("click", async()=>{
    state.showEmptyMonthly = !state.showEmptyMonthly;
    $("btnMonthlyShowEmpty").textContent = `👁️ Vacías: ${state.showEmptyMonthly?"ON":"OFF"}`;
    await openMonthly();
  });
  $("btnSaveMonthlyHeader").addEventListener("click", saveMonthlyHeader);
  $("btnMonthlyExport").addEventListener("click", exportMonthly);

  // ── Ajustes ──
  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettingsFromUI);
  $("btnResetSettings").addEventListener("click", resetSettings);
  // Cerrar ajustes clicando fuera
  $("modalSettings").addEventListener("click", (e)=>{ if (e.target===$("modalSettings")) closeSettings(); });

  // ── Guía ──
  $("btnGuide").addEventListener("click", openGuide);
  $("btnSpeak").addEventListener("click", speakGuide);
  $("btnStopSpeak").addEventListener("click", stopSpeak);
}

init();
