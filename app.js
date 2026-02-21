/**
 * IsiVolt Pro · Legionella — app.js v2.1
 * + Contraseña, sonido inicio, notificaciones push, calc PPM, chorro agua, visualizador audio
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
//  ESTADO
// ════════════════════════════════════════════════════════════
const screens = {
  password: $("screenPassword"),
  profile:  $("screenProfile"),
  home:     $("screenHome"),
  scan:     $("screenScan"),
  point:    $("screenPoint"),
  timer:    $("screenTimer"),
  history:  $("screenHistory"),
  monthly:  $("screenMonthly"),
  guide:    $("screenGuide"),
};

const state = {
  tech: localStorage.getItem("isivolt.tech") || "",
  currentCode: "",
  stream: null,
  detector: null,
  scanMode: "ot",
  showEmptyMonthly: false,
  timers: new Map(),
  focusedTimerCode: null,
  masterRaf: 0,
  speakingGuide: false,
};

// ════════════════════════════════════════════════════════════
//  CONSTANTES
// ════════════════════════════════════════════════════════════
const SETTINGS_KEY     = "isivolt.settings";
const PASS_KEY         = "isivolt.pass";
const GUIDE_KEY        = "isivolt.guideText";
const DEFAULT_PASS     = "isivolt";
const DEFAULT_SETTINGS = { bleachPct:5, targetPpm:50, baseMin:10, factorPerL:0.00 };
const DEFAULT_GUIDE    = `Bienvenido a IsiVolt Pro — Protocolo Legionella.

¿Qué es la Legionella?
La Legionella pneumophila es una bacteria que prolifera en sistemas de agua a temperaturas entre 20 y 45 grados centígrados. Puede causar la enfermedad del Legionario, una neumonía grave que se contagia por inhalación de aerosoles contaminados.

Zonas de riesgo en hoteles y edificios:
Torres de refrigeración, sistemas de agua caliente sanitaria, piscinas, spa, duchas y grifos. Cualquier punto donde el agua quede estancada o la temperatura sea inadecuada.

Protocolo de tratamiento con cloro:
Primero, calcular la dosis según los litros del sistema y el objetivo en PPM. Normalmente entre 2 y 3 miligramos por litro para tratamiento de choque. Segundo, añadir el producto y conectar la recirculación. Tercero, dejar circular un mínimo de 30 minutos. Cuarto, verificar el cloro residual con un test. Quinto, registrar la operación con fecha, técnico y resultado.

Control de temperatura:
El agua caliente sanitaria debe mantenerse por encima de 60 grados en acumuladores. El agua fría, por debajo de 20 grados. Revisar los puntos más alejados de la red.

Normativa:
Real Decreto 487 barra 2022 establece los criterios técnicos para la prevención y control de la legionelosis. Es obligatorio registrar cada operación de mantenimiento y conservar los registros al menos 5 años.

Recuerda: ante cualquier incidencia, márcala en la aplicación y notifica al responsable del edificio.`;

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
  const s = String(input||"").trim();
  if (!s) return "";
  const clean = s.replace(/[^a-zA-Z0-9]/g,"");
  if (clean.length <= 5) return clean.toUpperCase();
  return clean.slice(-5).toUpperCase();
}
function fmtTime(ms){
  const t = Math.max(0, Math.ceil(ms/1000));
  return `${String(Math.floor(t/60)).padStart(2,"0")}:${String(t%60).padStart(2,"0")}`;
}
function calcDoseMl(liters, settings){
  const L = Number(liters);
  if (!isFinite(L) || L <= 0) return null;
  const mgTotal = Number(settings.targetPpm) * L;
  const mgPerMl = Number(settings.bleachPct) * 100;
  if (mgPerMl <= 0) return null;
  return Math.max(0, mgTotal / mgPerMl);
}
function calcAutoMinutes(liters, settings){
  const L = Number(liters);
  const base = Number(settings.baseMin);
  const f = Number(settings.factorPerL);
  if (!isFinite(L) || L <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base + L * f));
}
function getSettings(){
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}") }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// ── Contraseña ──
function getPass(){ return localStorage.getItem(PASS_KEY) || DEFAULT_PASS; }
function setPass(p){ localStorage.setItem(PASS_KEY, p); }
function checkPass(p){ return p === getPass(); }

// ════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════
let _toastTimer = null;
function toast(msg){
  try{ navigator.vibrate?.(18); }catch{}
  const el = $("uiToast");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>{
    el.classList.remove("show");
    setTimeout(()=>el.classList.add("hidden"), 220);
  }, 2800);
}

// ════════════════════════════════════════════════════════════
//  MODAL PERSONALIZADO
// ════════════════════════════════════════════════════════════
let _modalResolve = null;
function _openModal({ title="", body="", hasInput=false, inputDefault="", inputPlaceholder="", okLabel="Aceptar", cancelLabel=null }){
  return new Promise(resolve => {
    _modalResolve = resolve;
    $("uiModalTitle").textContent = title;
    $("uiModalBody").textContent  = body;
    $("uiModalOk").textContent    = okLabel;
    const inp = $("uiModalInput");
    if (hasInput){ inp.classList.remove("hidden"); inp.value=inputDefault||""; inp.placeholder=inputPlaceholder||""; }
    else inp.classList.add("hidden");
    const cancel = $("uiModalCancel");
    if (cancelLabel){ cancel.classList.remove("hidden"); cancel.textContent=cancelLabel; }
    else cancel.classList.add("hidden");
    $("uiModal").classList.remove("hidden");
    if (hasInput) setTimeout(()=>{ inp.focus(); inp.select(); },80);
  });
}
function uiAlert(msg, title="Aviso"){ return _openModal({ title, body:msg, okLabel:"Cerrar" }); }
function uiConfirm(msg, title="Confirmar"){ return _openModal({ title, body:msg, okLabel:"Confirmar", cancelLabel:"Cancelar" }); }
function uiPrompt(msg, defaultVal="", title="Introduce un valor"){ return _openModal({ title, body:msg, hasInput:true, inputDefault:defaultVal, okLabel:"Aceptar", cancelLabel:"Cancelar" }); }
function _resolveModal(value){
  $("uiModal").classList.add("hidden");
  if (_modalResolve){ _modalResolve(value); _modalResolve=null; }
}

// ════════════════════════════════════════════════════════════
//  NOTIFICACIONES WEB
// ════════════════════════════════════════════════════════════
async function requestNotifPermission(){
  if (!("Notification" in window)) return;
  if (Notification.permission === "default"){
    await Notification.requestPermission();
  }
}
function sendNotification(title, body){
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try{
    new Notification(title, {
      body,
      icon:"icons/icon-192.png",
      badge:"icons/icon-192.png",
      tag:"isivolt-timer",
    });
  }catch{}
}

// ════════════════════════════════════════════════════════════
//  SONIDOS (Web Audio API)
// ════════════════════════════════════════════════════════════
function _getAudioCtx(){
  try{ return new (window.AudioContext||window.webkitAudioContext)(); }catch{ return null; }
}

/** Sonido de inicio de cronómetro: pitido ascendente suave */
function playStartSound(){
  const ctx = _getAudioCtx(); if (!ctx) return;
  const times = [[0,.1,520,.06],[.12,.2,660,.05],[.28,.1,880,.04]];
  for (const [t, dur, freq, vol] of times){
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime + t);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + 0.04);
    gain.gain.linearRampToValueAtTime(0,   ctx.currentTime + t + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + dur + 0.05);
  }
  setTimeout(()=>{ try{ ctx.close(); }catch{} }, 800);
}

/** Sonido de finalización: campanada + fade */
function playFinishSound(){
  const ctx = _getAudioCtx(); if (!ctx) return;
  const notes = [[0,.05,880,.08],[.18,.05,1046,.07],[.36,.06,1318,.06],[.55,.4,1046,.05]];
  for (const [t, att, freq, vol] of notes){
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, ctx.currentTime + t);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + t + att);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + att + .6);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + att + .7);
  }
  setTimeout(()=>{ try{ ctx.close(); }catch{} }, 1800);
}

// ════════════════════════════════════════════════════════════
//  CHORRO DE AGUA — posición dinámica
// ════════════════════════════════════════════════════════════
function updateWaterStream(pct){
  const tank      = document.querySelector(".timer-tank");
  const stream    = $("waterStream");
  const splash    = $("splashZone");
  const waterFill = $("waterFill");
  if (!tank || !stream || !splash) return;

  const tankH = tank.offsetHeight;
  const waterH = tankH * Math.min(pct, 1);

  // Posicionar salpicaduras en la superficie del agua
  const splashBottom = waterH;
  splash.style.bottom  = `${splashBottom}px`;
  splash.style.display = pct > 0 && pct < 1 ? "flex" : "none";

  // Altura del chorro = desde el top hasta la superficie del agua
  const streamBodyH = Math.max(6, tankH - waterH - 16); // 16 = altura del tubo
  const streamBody  = stream.querySelector(".stream-body");
  if (streamBody) streamBody.style.height = `${streamBodyH}px`;

  // Ocultar chorro si ya está lleno
  stream.style.display = pct >= 1 ? "none" : "flex";
}

// ════════════════════════════════════════════════════════════
//  NAVEGACIÓN
// ════════════════════════════════════════════════════════════
function show(screenName){
  for (const k of Object.keys(screens)){
    screens[k].classList.toggle("hidden", k !== screenName);
  }
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
  const tech  = state.tech;
  const date  = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const done  = items.filter(i=>i.status==="ok").length;
  $("kpiTech").textContent  = tech || "—";
  $("kpiToday").textContent = `${done} / ${items.length}`;

  const list = $("otList");
  list.innerHTML = "";
  $("otEmpty").classList.toggle("hidden", items.length !== 0);

  for (const it of items.sort((a,b)=>(a.order||0)-(b.order||0))){
    const el = document.createElement("div");
    el.className = "item";
    const badgeClass = it.status==="ok"?"ok":it.status==="issue"?"issue":"todo";
    const badgeText  = it.status==="ok"?"✅ Hecho":it.status==="issue"?"⚠ Incid.":"⏳ Pend.";
    const note   = it.note  ? ` · ${it.note}`  : "";
    const zona   = it.hotel ? `<div class="meta" style="font-weight:600;color:rgba(238,242,255,.85)">${it.hotel}</div>` : "";
    const tObj   = state.timers.get(it.code);
    const timerBadge = tObj
      ? `<span class="timer-indicator">⏱ ${fmtTime(Math.max(0,tObj.durationMs-tObj.elapsedMs))}</span>` : "";

    el.innerHTML = `
      <div class="left">
        <div class="code">${it.code}</div>
        ${zona}
        <div class="meta">${it.updatedAt?new Date(it.updatedAt).toLocaleTimeString():"—"}${note}</div>
      </div>
      <div class="item-right">
        ${timerBadge}
        <span class="badge ${badgeClass}">${badgeText}</span>
        <button class="btn btn-ghost btn-sm" data-open="${it.code}">Abrir</button>
        <button class="btn btn-icon" data-edit="${it.code}" title="Editar código" style="font-size:14px;min-width:36px;min-height:36px;padding:6px">✏️</button>
      </div>
    `;
    el.querySelector("[data-open]").addEventListener("click", ()=>openPoint(it.code));
    el.querySelector("[data-edit]").addEventListener("click", ()=>editOTCode(it.code));
    list.appendChild(el);
  }
}

async function addOTCode(code){
  const c = normalizeCode(code);
  if (!c){ uiAlert("Código inválido (se usan los 5 últimos caracteres)."); return; }
  const tech = state.tech, date = todayStr();
  const existing = await dbGetOTByTechDate(tech, date);
  if (existing.some(x=>x.code===c)){ return openPoint(c); }

  const zona = await uiPrompt("Zona / Observaciones (opcional):", "", `Nuevo punto: ${c}`);
  const item = {
    key:`${tech}|${date}|${c}`, tech, date, code:c,
    hotel:(zona||"").trim().slice(0,80),
    status:"todo", order:Date.now(), createdAt:Date.now(), updatedAt:Date.now(),
    defaultLiters:60, note:""
  };
  await dbPutOT(item);
  await refreshOT();
  openPoint(c);
}

async function saveOTNote(code, note, hotel){
  const tech = state.tech, date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x=>x.code===code);
  if (!it) return;
  it.note = String(note||"").trim().slice(0,120);
  if (hotel !== undefined) it.hotel = String(hotel||"").trim().slice(0,80);
  it.updatedAt = Date.now();
  await dbPutOT(it);
  await refreshOT();
}

async function editOTCode(oldCode){
  const oldC = normalizeCode(oldCode);
  if (!oldC) return;
  const newRaw = await uiPrompt("Código correcto (usará los 5 últimos):", oldC, `Editar código (${oldC})`);
  if (newRaw == null) return;
  const newC = normalizeCode(newRaw);
  if (!newC){ uiAlert("Código inválido."); return; }
  if (newC === oldC) return;

  const tech = state.tech, date = todayStr();
  const items = await dbGetOTByTechDate(tech, date);
  const it = items.find(x=>x.code===oldC);
  if (!it) return;
  if (items.some(x=>x.code===newC)){ uiAlert("Ese código ya existe en la OT de hoy."); return; }

  const oldKey = it.key;
  it.code = newC; it.key = `${tech}|${date}|${newC}`; it.updatedAt = Date.now();
  await dbPutOT(it);
  await dbDeleteOTKey(oldKey);

  if (state.currentCode === oldC){ state.currentCode = newC; $("pointCode").textContent = newC; }
  if (state.timers.has(oldC)){
    const t = state.timers.get(oldC); t.code = newC;
    state.timers.set(newC, t); state.timers.delete(oldC);
    if (state.focusedTimerCode===oldC) state.focusedTimerCode = newC;
  }
  await refreshOT();
}

// ════════════════════════════════════════════════════════════
//  PUNTO
// ════════════════════════════════════════════════════════════
async function openPoint(code){
  state.currentCode = normalizeCode(code);
  if (!state.currentCode) return;
  const items = await dbGetOTByTechDate(state.tech, todayStr());
  const it = items.find(x=>x.code===state.currentCode);
  $("pointCode").textContent = state.currentCode;
  $("pointHotelDisplay").textContent = it?.hotel || "";
  const settings = getSettings();
  const liters = it?.defaultLiters ?? 60;
  $("liters").value = liters;
  $("hotelName").value = it?.hotel || "";
  $("targetMinutes").value = calcAutoMinutes(liters, settings);
  $("pointNote").value = it?.note ?? "";
  $("chkConnect").checked = $("chkReturn").checked = $("chkDose").checked = $("chkStart").checked = false;
  updateDoseUI();
  show("point");
}
function updateDoseUI(){
  const ml = calcDoseMl($("liters").value, getSettings());
  $("doseMl").textContent = ml==null?"—":`${Math.round(ml)} ml`;
}

// ════════════════════════════════════════════════════════════
//  MULTI-TIMER
// ════════════════════════════════════════════════════════════
function startMasterRaf(){
  if (state.masterRaf) return;
  function tick(){
    const now = performance.now();
    const toFinish = [];
    for (const [code,t] of state.timers){
      if (t.running && !t.paused){
        t.elapsedMs = (now - t.startTs) + t.accMs;
        if (t.elapsedMs >= t.durationMs){ t.elapsedMs = t.durationMs; toFinish.push(code); }
      }
    }
    // Actualizar pantalla timer
    if (state.focusedTimerCode && !screens.timer.classList.contains("hidden")){
      _updateTimerDisplay(state.focusedTimerCode);
    }
    renderFloatBar();
    // OT indicadores
    if (!screens.home.classList.contains("hidden")) _updateOTTimerIndicators();

    for (const code of toFinish) _autoFinishTimer(code);

    const hasActive = [...state.timers.values()].some(t=>t.running && !t.paused);
    state.masterRaf = hasActive ? requestAnimationFrame(tick) : 0;
  }
  state.masterRaf = requestAnimationFrame(tick);
}

function _updateTimerDisplay(code){
  const t = state.timers.get(code); if (!t) return;
  const left = Math.max(0, t.durationMs - t.elapsedMs);
  $("timerLeft").textContent = fmtTime(left);
  const pct = Math.min(1, t.elapsedMs / t.durationMs);
  $("waterFill").style.height = `${Math.round(pct*100)}%`;
  updateWaterStream(pct);
}

function _updateOTTimerIndicators(){
  document.querySelectorAll(".timer-indicator").forEach(el=>{
    const btn = el.closest(".item")?.querySelector("[data-open]");
    if (!btn) return;
    const t = state.timers.get(btn.getAttribute("data-open"));
    if (t) el.textContent = `⏱ ${fmtTime(Math.max(0,t.durationMs-t.elapsedMs))}`;
  });
}

function startTimerForCurrent(){
  const code = state.currentCode; if (!code) return;
  const mins = Number($("targetMinutes").value);
  if (!isFinite(mins) || mins<=0){ uiAlert("Tiempo objetivo inválido."); return; }

  const liters    = Number($("liters").value) || null;
  const doseMl    = liters ? Math.round(calcDoseMl(liters,getSettings())??0) : null;
  const note      = String($("pointNote").value||"").trim().slice(0,120);
  const hotelName = String($("hotelName").value||"").trim().slice(0,80);

  saveOTNote(code, note, hotelName);

  const t = {
    code, hotelName, running:true, paused:false,
    startTs:performance.now(), accMs:0,
    durationMs:mins*60*1000, elapsedMs:0,
    targetMinutes:mins, liters, doseMl, note,
  };
  state.timers.set(code, t);
  state.focusedTimerCode = code;

  // 🔔 Sonido al iniciar
  playStartSound();
  // 🔔 Pedir permiso notificaciones
  requestNotifPermission();

  _showTimerScreen(code);
  startMasterRaf();
}

function _showTimerScreen(code){
  const t = state.timers.get(code); if (!t) return;
  state.focusedTimerCode = code;
  $("timerCode").textContent   = code;
  $("timerHotel").textContent  = t.hotelName || "";
  $("timerTarget").textContent = `Objetivo: ${t.targetMinutes} min`;
  $("sealDone").classList.add("hidden");
  $("sealWarn").classList.add("hidden");
  $("btnPause").classList.toggle("hidden", t.paused);
  $("btnResume").classList.toggle("hidden", !t.paused);
  _updateTimerDisplay(code);
  show("timer");
}

function pauseTimer(){
  const t = state.timers.get(state.focusedTimerCode); if (!t||!t.running||t.paused) return;
  t.accMs = t.elapsedMs; t.paused = true;
  $("btnPause").classList.add("hidden");
  $("btnResume").classList.remove("hidden");
}
function resumeTimer(){
  const t = state.timers.get(state.focusedTimerCode); if (!t||!t.running||!t.paused) return;
  t.paused = false; t.startTs = performance.now();
  $("btnPause").classList.remove("hidden");
  $("btnResume").classList.add("hidden");
  startMasterRaf();
}

async function finishTimer(){
  const code = state.focusedTimerCode; if (!code) return;
  await _doFinishTimer(code, false, false);
  show("home"); await refreshOT();
}

async function _autoFinishTimer(code){
  await _doFinishTimer(code, true, false);
  // 🔔 Notificación push + sonido al completar
  playFinishSound();
  sendNotification(`✅ Tratamiento completado — ${code}`, "El tiempo de recirculación ha finalizado. Verifica el cloro residual.");
  try{ navigator.vibrate?.([150,80,150,80,200]); }catch{}
  toast(`✅ ${code} – Tratamiento completado`);
  if (state.focusedTimerCode===code && !screens.timer.classList.contains("hidden")){
    $("sealDone").classList.remove("hidden");
    updateWaterStream(1);
  }
  await refreshOT();
}

async function _doFinishTimer(code, auto, isIssue){
  const t = state.timers.get(code); if (!t) return;
  state.timers.delete(code);
  if (state.focusedTimerCode===code) state.focusedTimerCode=null;
  await dbAddHistory({
    tech:state.tech, date:todayStr(), code,
    ts:Date.now(), liters:t.liters, doseMl:t.doseMl,
    minutes:t.targetMinutes, result:isIssue?"issue":"ok",
    note:t.note||undefined, hotel:t.hotelName||undefined,
  });
  if (t.note) await saveOTNote(code, t.note, t.hotelName);
  await markOTStatus(code, isIssue?"issue":"ok");
  renderFloatBar();
}

async function markOTStatus(code, status){
  const items = await dbGetOTByTechDate(state.tech, todayStr());
  const it = items.find(x=>x.code===code); if (!it) return;
  it.status = status; it.updatedAt = Date.now();
  it.defaultLiters = Number($("liters").value)||it.defaultLiters||60;
  await dbPutOT(it);
  await refreshOT();
}

async function markIssue(){
  const code = state.currentCode; if (!code) return;
  const reason = await uiPrompt("Incidencia:\n- No accesible\n- Bomba no arranca\n- Sin retorno\n- Fuga\n\nEscribe una frase corta:", "", "⚠ Incidencia");
  if (reason==null) return;
  const note       = String($("pointNote").value||"").trim().slice(0,120);
  const hotelName  = String($("hotelName").value||"").trim().slice(0,80);
  const finalReason= (reason.trim().slice(0,120)||"Incidencia");

  if (state.timers.has(code)){
    const t = state.timers.get(code);
    t.note = note?`${finalReason} · ${note}`:finalReason;
    state.focusedTimerCode = code;
    await _doFinishTimer(code, false, true);
    $("sealWarn").classList.remove("hidden");
    show("timer");
  } else {
    await dbAddHistory({
      tech:state.tech, date:todayStr(), code, ts:Date.now(),
      liters:Number($("liters").value)||null, doseMl:null,
      minutes:Number($("targetMinutes").value)||null, result:"issue",
      note:note?`${finalReason} · ${note}`:finalReason,
      hotel:hotelName||undefined,
    });
    await saveOTNote(code, note||finalReason, hotelName);
    await markOTStatus(code,"issue");
    toast("⚠ Incidencia registrada");
    show("home"); await refreshOT();
  }
  try{ navigator.vibrate?.([80,40,80]); }catch{}
}

// ════════════════════════════════════════════════════════════
//  BARRA FLOTANTE
// ════════════════════════════════════════════════════════════
function renderFloatBar(){
  const bar = $("floatTimers");
  if (state.timers.size===0){ bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = "";

  const lbl = document.createElement("div");
  lbl.style.cssText="writing-mode:vertical-rl;font-size:10px;color:var(--muted);align-self:center;flex-shrink:0;opacity:.7;margin-right:2px;letter-spacing:.5px;text-transform:uppercase";
  lbl.textContent="Timers"; bar.appendChild(lbl);

  for (const [code,t] of state.timers){
    const left = Math.max(0, t.durationMs - t.elapsedMs);
    const pct  = Math.min(100, Math.round((t.elapsedMs/t.durationMs)*100));
    const chip = document.createElement("div");
    chip.className = `timer-chip${t.paused?" paused":""}`;
    chip.innerHTML=`
      <div class="chip-code">${code}</div>
      ${t.hotelName?`<div class="chip-hotel">${t.hotelName}</div>`:""}
      <div class="chip-time">${fmtTime(left)}</div>
      <div class="chip-status">${t.paused?"⏸ Pausado":`▶ ${pct}%`}</div>
      <div class="chip-actions">
        <button class="chip-btn" data-open>🔍</button>
        <button class="chip-btn finish-btn" data-finish>✅</button>
      </div>
    `;
    chip.querySelector("[data-open]").addEventListener("click",(e)=>{ e.stopPropagation(); _showTimerScreen(code); });
    chip.querySelector("[data-finish]").addEventListener("click", async(e)=>{
      e.stopPropagation();
      const ok = await uiConfirm(`¿Finalizar tratamiento de ${code}?`);
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
//  SCAN
// ════════════════════════════════════════════════════════════
async function startScan(){
  if (!("mediaDevices" in navigator)){ uiAlert("Este navegador no soporta cámara. Usa 'Añadir punto'."); return; }
  try{
    state.stream = await navigator.mediaDevices.getUserMedia({ video:{facingMode:"environment"}, audio:false });
    $("qrVideo").srcObject = state.stream;
    await $("qrVideo").play();
    if ("BarcodeDetector" in window){
      state.detector = new BarcodeDetector({ formats:["qr_code"] });
      scanLoop();
    } else {
      uiAlert("Este móvil no soporta BarcodeDetector. Usa el campo de código manual.");
    }
  }catch{ uiAlert("No se pudo abrir la cámara. Revisa los permisos."); }
}
async function scanLoop(){
  if (!state.detector||!state.stream) return;
  try{
    const barcodes = await state.detector.detect($("qrVideo"));
    if (barcodes?.length){
      const c = normalizeCode(barcodes[0].rawValue||"");
      if (c){ stopScan(); await _handleScanResult(c); return; }
    }
  }catch{}
  requestAnimationFrame(scanLoop);
}
function stopScan(){
  if (state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; }
  $("qrVideo").srcObject = null; state.detector = null;
}
async function _handleScanResult(c){
  if (state.scanMode==="monthlyHot"){ await addMonthlyQuick(c,"ACS"); await openMonthly(); }
  else if (state.scanMode==="monthlyCold"){ await addMonthlyQuick(c,"AFCH"); await openMonthly(); }
  else { await addOTCode(c); show("home"); }
}
function setScanMode(mode){
  state.scanMode = mode;
  const titles = { ot:"Escanear QR", monthlyHot:"Escanear · 🔥 ACS", monthlyCold:"Escanear · ❄️ AFCH" };
  $("scanTitle").textContent = titles[mode]||"Escanear QR";
}

// ════════════════════════════════════════════════════════════
//  HISTORIAL
// ════════════════════════════════════════════════════════════
async function openHistory(){
  const items = await dbGetHistoryByTech(state.tech, 300);
  const list  = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").classList.toggle("hidden", items.length!==0);
  for (const h of items){
    const el = document.createElement("div"); el.className="item";
    const dt = new Date(h.ts||Date.now());
    const bc = h.result==="ok"?"ok":"issue";
    const bt = h.result==="ok"?"✅ OK":"⚠ Incid.";
    const note  = h.note  ? ` · ${h.note}`  : "";
    const hotel = h.hotel ? `<div class="meta" style="font-weight:600">${h.hotel}</div>` : "";
    el.innerHTML=`
      <div class="left">
        <div class="code">${h.code}</div>
        ${hotel}
        <div class="meta">${dt.toLocaleString()} · ${h.liters??"—"} L · ${h.minutes??"—"} min${note}</div>
      </div>
      <span class="badge ${bc}">${bt}</span>
    `;
    list.appendChild(el);
  }
  show("history");
}
async function exportData(){
  const dump = await dbExportAll();
  const blob = new Blob([JSON.stringify({app:"IsiVolt Pro v2.1",exportedAt:Date.now(),tech:state.tech,data:dump},null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`isivolt_${state.tech}_${todayStr()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function importData(file){
  let payload; try{ payload=JSON.parse(await file.text()); }catch{ return uiAlert("Archivo inválido."); }
  if (!payload?.data) return uiAlert("No contiene datos válidos.");
  await dbImportAll(payload.data);
  toast("Importación completada ✅"); await refreshOT();
}

// ════════════════════════════════════════════════════════════
//  MENSUAL
// ════════════════════════════════════════════════════════════
const MONTH_PLANTS = ["-1","Baja","1ª","2ª","3ª","4ª","5ª","6ª","7ª","8ª","Otros"];
function monthKey(){ return monthStr(); }
function getDefaultPlant(){ return $("monthlyPlantDefault")?.value||"Baja"; }

async function loadMonthlyHeader(){
  const h = await dbGetMonthlyHeader(state.tech, monthKey());
  $("monthSampleDate").value   = h?.sampleDate  || "";
  $("monthAssignedTech").value = h?.assignedTech || "";
  $("monthHeaderNote").value   = h?.note         || "";
}
async function saveMonthlyHeader(){
  await dbPutMonthlyHeader(state.tech, monthKey(), {
    sampleDate:  $("monthSampleDate").value||"",
    assignedTech:($("monthAssignedTech").value||"").trim().slice(0,18),
    note:        ($("monthHeaderNote").value||"").trim().slice(0,180),
  });
  toast("Cabecera guardada ✅");
}
async function openMonthly(){
  const tech=state.tech, month=monthKey();
  $("kpiMonth").textContent = month;
  await loadMonthlyHeader();
  const items = await dbGetMonthlyByTechMonth(tech,month);
  const done  = items.filter(i=>i.status==="ok").length;
  $("kpiMonthDone").textContent = `${done} / ${items.length}`;
  $("monthlyEmpty").classList.toggle("hidden", items.length!==0);
  const accRoot = $("monthlyAccordions"); accRoot.innerHTML="";
  const grouped = new Map();
  for (const p of MONTH_PLANTS) grouped.set(p,[]);
  for (const it of items){ const pl=MONTH_PLANTS.includes(it.plant)?it.plant:"Otros"; grouped.get(pl).push(it); }
  for (const plant of MONTH_PLANTS){
    const arr = grouped.get(plant)||[];
    if (!state.showEmptyMonthly && arr.length===0) continue;
    const pDone=arr.filter(x=>x.status==="ok").length;
    const pct=arr.length?Math.round((pDone/arr.length)*100):0;
    const acc=document.createElement("div"); acc.className="accordion";
    acc.innerHTML=`
      <div class="acc-head">
        <div><div class="acc-title">Planta ${plant}</div><div class="acc-sub">${pDone} / ${arr.length} · ${pct}%</div></div>
        <div class="row" style="gap:10px">
          <div class="progress"><div style="width:${pct}%"></div></div>
          <div class="acc-arrow">▾</div>
        </div>
      </div>
      <div class="acc-body">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <div class="muted tiny">Acciones rápidas</div>
          <button class="btn btn-ghost btn-sm" data-naall>🚫 No aplica (planta)</button>
        </div>
        <div class="list" data-list></div>
        <div class="muted tiny" data-empty style="padding:10px 6px;display:none">Sin puntos en esta planta.</div>
      </div>
    `;
    acc.querySelector(".acc-head").addEventListener("click",()=>{
      acc.classList.toggle("open");
      acc.querySelector(".acc-arrow").textContent=acc.classList.contains("open")?"▴":"▾";
    });
    if (!state.showEmptyMonthly&&arr.length&&accRoot.children.length===0){
      acc.classList.add("open"); acc.querySelector(".acc-arrow").textContent="▴";
    }
    const list=acc.querySelector("[data-list]"); const empty=acc.querySelector("[data-empty]");
    empty.style.display=arr.length===0?"block":"none";
    acc.querySelector("[data-naall]").addEventListener("click",async(e)=>{
      e.stopPropagation();
      if (arr.length===0){ uiAlert("No hay puntos en esta planta."); return; }
      const ok=await uiConfirm(`¿Marcar TODA la Planta ${plant} como NO APLICA?`); if (!ok) return;
      const r=await uiPrompt("Motivo rápido:","Parking sin tomas","No aplica (planta)");
      const reason=(r||"No aplica").trim().slice(0,80);
      for (const it of arr){ it.status="na"; it.updatedAt=Date.now(); it.note=reason; await dbPutMonthly(it); }
      await openMonthly();
    });
    for (const it of arr.sort((a,b)=>(a.order||0)-(b.order||0))){
      const el=document.createElement("div"); el.className="item";
      const dt=it.updatedAt?new Date(it.updatedAt).toLocaleString():"—";
      const bc=it.status==="ok"?"ok":it.status==="issue"?"issue":it.status==="na"?"na":"todo";
      const bt=it.status==="ok"?"✅ Hecho":it.status==="issue"?"⚠ Incid.":it.status==="na"?"🚫 No aplica":"⏳ Pend.";
      const water=it.water==="ACS"?"🔥 ACS":it.water==="AFCH"?"❄️ AFCH":"—";
      const icon=it.element==="Ducha"?"🚿":it.element==="Grifo"?"🚰":it.element==="Fregadero"?"🍽️":"📍";
      el.innerHTML=`
        <div class="left">
          <div class="code">${icon} ${it.code}</div>
          <div class="meta">${water}${it.desc?` · ${it.desc}`:""}</div>
          <div class="meta">${dt}${it.note?` · ${it.note}`:""}</div>
        </div>
        <div class="item-actions">
          <span class="badge ${bc}">${bt}</span>
          <button class="smallbtn ok" data-ok>✅</button>
          <button class="smallbtn issue" data-issue>⚠</button>
          <button class="smallbtn na" data-na>🚫</button>
        </div>
      `;
      el.querySelector("[data-ok]").addEventListener("click",async()=>{ it.status="ok"; it.updatedAt=Date.now(); it.note=""; await dbPutMonthly(it); await openMonthly(); });
      el.querySelector("[data-issue]").addEventListener("click",async()=>{
        const r=await uiPrompt("Incidencia:",it.note||"","⚠ Incidencia"); if (r==null) return;
        it.status="issue"; it.updatedAt=Date.now(); it.note=r.trim().slice(0,120); await dbPutMonthly(it); await openMonthly();
      });
      el.querySelector("[data-na]").addEventListener("click",async()=>{
        const r=await uiPrompt("No aplica (motivo):",it.note||"Exterior (otra empresa)","🚫 No aplica"); if (r==null) return;
        it.status="na"; it.updatedAt=Date.now(); it.note=r.trim().slice(0,120); await dbPutMonthly(it); await openMonthly();
      });
      list.appendChild(el);
    }
    accRoot.appendChild(acc);
  }
  show("monthly");
}
async function addMonthlyQuick(code, water){
  const c=normalizeCode(code); if (!c){ uiAlert("Código inválido."); return; }
  const plant=getDefaultPlant()||"Baja";
  const existing=await dbGetMonthlyByTechMonth(state.tech,monthKey());
  if (existing.some(x=>x.code===c&&x.water===water&&x.plant===plant)){ toast("Ya existe este punto."); return; }
  const elRaw=await uiPrompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO","DUCHA");
  const element=_parseElement(elRaw||"DUCHA");
  const desc=await uiPrompt("Descripción corta (opcional):","","Descripción");
  await dbPutMonthly({
    key:`${state.tech}|${monthKey()}|${plant}|${water}|${c}`,
    tech:state.tech,month:monthKey(),plant,water,element,code:c,
    desc:(desc||"").trim().slice(0,120),status:"todo",order:Date.now(),updatedAt:Date.now(),note:""
  });
}
async function addMonthlyManual(){
  const waterRaw=await uiPrompt("Tipo de agua: ACS (caliente) o AFCH (fría)","ACS"); if (waterRaw==null) return;
  const water=String(waterRaw).toUpperCase().startsWith("A")?"ACS":"AFCH";
  const plantRaw=await uiPrompt("Planta (ej: Baja, 2ª, 6ª, -1, Otros)",getDefaultPlant()); if (plantRaw==null) return;
  const plant=MONTH_PLANTS.includes(plantRaw)?plantRaw:(plantRaw.trim()||"Otros");
  const codeRaw=await uiPrompt("Código del punto:",""); if (codeRaw==null) return;
  const c=normalizeCode(codeRaw); if (!c){ uiAlert("Código inválido."); return; }
  const elRaw=await uiPrompt("Elemento: DUCHA / GRIFO / LAVABO / FREGADERO / OTRO","DUCHA"); if (elRaw==null) return;
  const element=_parseElement(elRaw);
  const desc=await uiPrompt("Descripción:","")??"";;
  const existing=await dbGetMonthlyByTechMonth(state.tech,monthKey());
  if (existing.some(x=>x.code===c&&x.water===water&&x.plant===plant)){ uiAlert("Ya existe."); return; }
  await dbPutMonthly({
    key:`${state.tech}|${monthKey()}|${plant}|${water}|${c}`,
    tech:state.tech,month:monthKey(),plant,water,element,code:c,
    desc:desc.trim().slice(0,160),status:"todo",order:Date.now(),updatedAt:Date.now(),note:""
  });
}
function _parseElement(raw){
  const u=String(raw||"").toUpperCase();
  if (u.startsWith("G")) return "Grifo";
  if (u.startsWith("LAV")) return "Lavabo";
  if (u.startsWith("FRE")) return "Fregadero";
  if (u.startsWith("O")) return "Otro";
  return "Ducha";
}
async function attachMonthlyFile(file){
  const r=new FileReader();
  const dataUrl=await new Promise((res,rej)=>{ r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(file); });
  await dbPutMonthlyFile(state.tech,monthKey(),{filename:file.name,mime:file.type,dataUrl});
  toast("Adjunto guardado ✅");
}
async function openMonthlyFile(){
  const f=await dbGetMonthlyFile(state.tech,monthKey());
  if (!f?.dataUrl){ uiAlert("Aún no has adjuntado archivo para este mes."); return; }
  window.open(f.dataUrl,"_blank");
}
async function exportMonthly(){
  const header=await dbGetMonthlyHeader(state.tech,monthKey());
  const items=await dbGetMonthlyByTechMonth(state.tech,monthKey());
  const blob=new Blob([JSON.stringify({app:"IsiVolt Pro v2.1",kind:"monthly",exportedAt:Date.now(),tech:state.tech,month:monthKey(),header,items},null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`isivolt_mensual_${state.tech}_${monthKey()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// ════════════════════════════════════════════════════════════
//  GUÍA AUDIO + VISUALIZADOR
// ════════════════════════════════════════════════════════════
let _avInterval = null;
function _startVisualizer(){
  const bars = document.querySelectorAll(".av-bar");
  const label = $("avLabel");
  if (label) label.textContent = "Reproduciendo…";
  bars.forEach(b=>b.classList.add("speaking"));
  // Simular amplitudes aleatorias
  _avInterval = setInterval(()=>{
    bars.forEach(b=>{
      const h = 12 + Math.random() * 70;
      b.style.height = `${h}px`;
    });
  }, 120);
}
function _stopVisualizer(){
  if (_avInterval){ clearInterval(_avInterval); _avInterval=null; }
  const bars = document.querySelectorAll(".av-bar");
  bars.forEach(b=>{ b.classList.remove("speaking"); b.style.height=""; });
  const label = $("avLabel");
  if (label) label.textContent = "Pulsa Reproducir";
}
function openGuide(){
  $("guideText").value = localStorage.getItem(GUIDE_KEY)||DEFAULT_GUIDE;
  show("guide");
}
function speakGuide(){
  localStorage.setItem(GUIDE_KEY, $("guideText").value);
  if (!("speechSynthesis" in window)){ uiAlert("Este dispositivo no soporta síntesis de voz."); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance($("guideText").value);
  u.lang = "es-ES"; u.rate = 0.9; u.pitch = 1.0;
  u.onstart  = ()=> _startVisualizer();
  u.onend    = ()=> { _stopVisualizer(); state.speakingGuide=false; };
  u.onerror  = ()=> { _stopVisualizer(); state.speakingGuide=false; };
  window.speechSynthesis.speak(u);
  state.speakingGuide = true;
}
function stopSpeak(){
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  _stopVisualizer();
  state.speakingGuide = false;
}

// ════════════════════════════════════════════════════════════
//  CALCULADORA PPM
// ════════════════════════════════════════════════════════════
function calcPPM(){
  const L    = Number($("calcLiters").value);
  const ppm  = Number($("calcPpm").value);
  const conc = Number($("calcConc").value);
  if (!isFinite(L)||L<=0||!isFinite(ppm)||ppm<=0||!isFinite(conc)||conc<=0){
    $("ppmResultMl").textContent = "—";
    $("ppmResultG").textContent  = "—";
    $("ppmResultDetail").textContent = "Introduce todos los valores";
    return;
  }
  // ml = (L × ppm) / (conc × 10)  [ya que 1% = 10 g/L = 10000 mg/L]
  const ml = (L * ppm) / (conc * 10);
  const g  = ml * (conc / 100); // aproximación densidad ~1
  $("ppmResultMl").textContent     = `${ml.toFixed(1)}`;
  $("ppmResultG").textContent      = `${g.toFixed(1)}`;
  $("ppmResultDetail").textContent = `Para ${L} L, ${ppm} ppm con ${conc}% de cloro activo`;
}

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
  toast("Ajustes guardados ✅");
}
function resetSettings(){ saveSettings({...DEFAULT_SETTINGS}); openSettings(); }

async function changePassword(){
  const old  = $("passOld").value;
  const nw   = $("passNew").value;
  const nw2  = $("passNew2").value;
  if (!checkPass(old)){ uiAlert("La contraseña actual es incorrecta.","Error"); return; }
  if (nw.length < 4){ uiAlert("La nueva contraseña debe tener al menos 4 caracteres."); return; }
  if (nw !== nw2){ uiAlert("Las contraseñas no coinciden."); return; }
  setPass(nw);
  $("passOld").value = $("passNew").value = $("passNew2").value = "";
  toast("Contraseña cambiada ✅");
}

// ════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════
function init(){
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
  bindNav();

  // ── Modal events ──
  $("uiModalOk").addEventListener("click",()=>{
    const inp = $("uiModalInput");
    const isPrompt = !inp.classList.contains("hidden");
    if (isPrompt) _resolveModal(inp.value);
    else _resolveModal(!$("uiModalCancel").classList.contains("hidden") ? true : undefined);
  });
  $("uiModalCancel").addEventListener("click",()=>{
    _resolveModal(!$("uiModalInput").classList.contains("hidden") ? null : false);
  });
  $("uiModalInput").addEventListener("keydown",(e)=>{
    if (e.key==="Enter") $("uiModalOk").click();
    if (e.key==="Escape") $("uiModalCancel").click();
  });

  // ── Pantalla de contraseña ──
  const isVerified = sessionStorage.getItem("isivolt.verified")==="1";
  if (!isVerified){
    // Mostrar siempre contraseña al abrir
    Object.values(screens).forEach(s=>s.classList.add("hidden"));
    screens.password.classList.remove("hidden");
  } else if (!state.tech){
    show("profile");
  } else {
    show("home"); refreshOT();
  }

  function enterPassword(){
    const val = $("passInput").value;
    if (checkPass(val)){
      $("passError").classList.add("hidden");
      sessionStorage.setItem("isivolt.verified","1");
      $("passInput").value = "";
      if (!state.tech) show("profile");
      else { show("home"); refreshOT(); }
    } else {
      $("passError").classList.remove("hidden");
      $("passInput").value = "";
      $("passInput").focus();
      try{ navigator.vibrate?.([100,50,100]); }catch{}
    }
  }
  $("btnPassEnter").addEventListener("click", enterPassword);
  $("passInput").addEventListener("keydown",(e)=>{ if(e.key==="Enter") enterPassword(); });

  // ── Online indicator ──
  const pill = $("pillOffline");
  function updateOnline(){
    pill.textContent = navigator.onLine ? "Online" : "Offline OK";
    pill.style.opacity = navigator.onLine ? ".95" : ".8";
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // ── Perfil ──
  $("techName").addEventListener("keydown",(e)=>{ if(e.key==="Enter") $("btnSetTech").click(); });
  $("btnSetTech").addEventListener("click", async()=>{
    const name = String($("techName").value||"").trim();
    if (!name){ uiAlert("Escribe el nombre del técnico."); return; }
    state.tech = name; localStorage.setItem("isivolt.tech",name);
    show("home"); await refreshOT();
  });
  $("btnSwitchTech").addEventListener("click",()=>{
    localStorage.removeItem("isivolt.tech"); state.tech=""; $("techName").value=""; show("profile");
  });
  $("btnLogout").addEventListener("click", async()=>{
    const ok = await uiConfirm("¿Cerrar sesión?"); if (!ok) return;
    localStorage.removeItem("isivolt.tech"); sessionStorage.removeItem("isivolt.verified");
    state.tech=""; $("techName").value="";
    show("password");
  });

  // ── Home ──
  $("btnAddCode").addEventListener("click", async()=>{
    const code = await uiPrompt("Introduce el código (5 últimos):","","Añadir punto"); if (code==null) return;
    await addOTCode(code);
  });
  $("btnScan").addEventListener("click",()=>{ setScanMode("ot"); show("scan"); });
  $("btnHistory").addEventListener("click", openHistory);
  $("btnMonthly").addEventListener("click", openMonthly);
  $("btnClearOT").addEventListener("click", async()=>{
    const ok = await uiConfirm("¿Vaciar toda la OT de hoy?"); if (!ok) return;
    await dbDeleteOTByTechDate(state.tech,todayStr()); await refreshOT();
  });

  // ── Scan ──
  $("btnStartScan").addEventListener("click", startScan);
  $("btnStopScan").addEventListener("click", stopScan);
  $("btnManualGo").addEventListener("click", async()=>{
    const c = normalizeCode($("manualCodeFromScan").value);
    if (!c){ uiAlert("Código inválido."); return; }
    stopScan(); await _handleScanResult(c); show("home");
  });

  // ── Punto ──
  $("liters").addEventListener("input", updateDoseUI);
  $("hotelName").addEventListener("input",()=>{ $("pointHotelDisplay").textContent=$("hotelName").value; });
  $("btnUseDefaultLiters").addEventListener("click",()=>{
    $("liters").value=60; updateDoseUI(); $("targetMinutes").value=calcAutoMinutes(60,getSettings());
  });
  $("btnTimeAuto").addEventListener("click",()=>{ $("targetMinutes").value=calcAutoMinutes($("liters").value,getSettings()); });
  $("btnSaveNote").addEventListener("click", async()=>{
    await saveOTNote(state.currentCode,$("pointNote").value,$("hotelName").value); toast("Guardado ✅");
  });
  $("btnStartTimer").addEventListener("click", startTimerForCurrent);
  $("btnMarkIssue").addEventListener("click", markIssue);
  $("btnEditCode").addEventListener("click",()=> editOTCode(state.currentCode));

  // ── Timer ──
  $("btnPause").addEventListener("click", pauseTimer);
  $("btnResume").addEventListener("click", resumeTimer);
  $("btnFinish").addEventListener("click", finishTimer);
  $("btnMinimizeTimer").addEventListener("click",()=>{ show("home"); refreshOT(); });
  $("btnExitTimer").addEventListener("click",()=>{ show("home"); refreshOT(); });

  // ── Historial ──
  $("btnExport").addEventListener("click", exportData);
  $("btnImport").addEventListener("click",()=>$("fileImport").click());
  $("fileImport").addEventListener("change", async(e)=>{
    const f=e.target.files?.[0]; if (!f) return; await importData(f); e.target.value="";
  });

  // ── Mensual ──
  $("btnMonthlyAdd").addEventListener("click", async()=>{ await addMonthlyManual(); await openMonthly(); });
  $("btnMonthlyClear").addEventListener("click", async()=>{
    const ok=await uiConfirm("¿Vaciar checklist mensual?"); if (!ok) return;
    await dbDeleteMonthlyByTechMonth(state.tech,monthKey()); await openMonthly();
  });
  $("btnMonthlyAttach").addEventListener("click",()=>$("monthlyFile").click());
  $("monthlyFile").addEventListener("change", async(e)=>{
    const f=e.target.files?.[0]; if (!f) return; await attachMonthlyFile(f); e.target.value="";
  });
  $("btnMonthlyOpen").addEventListener("click", openMonthlyFile);
  $("btnMonthlyScanHot").addEventListener("click",()=>{ setScanMode("monthlyHot"); show("scan"); });
  $("btnMonthlyScanCold").addEventListener("click",()=>{ setScanMode("monthlyCold"); show("scan"); });
  $("btnMonthlyShowEmpty").addEventListener("click", async()=>{
    state.showEmptyMonthly=!state.showEmptyMonthly;
    $("btnMonthlyShowEmpty").textContent=`👁️ Vacías: ${state.showEmptyMonthly?"ON":"OFF"}`;
    await openMonthly();
  });
  $("btnSaveMonthlyHeader").addEventListener("click", saveMonthlyHeader);
  $("btnMonthlyExport").addEventListener("click", exportMonthly);

  // ── Guía ──
  $("btnGuide").addEventListener("click", openGuide);
  $("btnSpeak").addEventListener("click", speakGuide);
  $("btnStopSpeak").addEventListener("click", stopSpeak);

  // ── Ajustes ──
  $("btnSettings").addEventListener("click", openSettings);
  $("btnCloseSettings").addEventListener("click", closeSettings);
  $("btnSaveSettings").addEventListener("click", saveSettingsFromUI);
  $("btnResetSettings").addEventListener("click", resetSettings);
  $("modalSettings").addEventListener("click",(e)=>{ if(e.target===$("modalSettings")) closeSettings(); });
  $("btnCalcPpm").addEventListener("click", calcPPM);
  ["calcLiters","calcPpm","calcConc"].forEach(id=>{ $(id).addEventListener("input", calcPPM); });
  $("btnChangePass").addEventListener("click", changePassword);
}

init();
