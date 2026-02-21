// IsiVolt Pro V3 · app.js
// Módulos: Recirculación, Análisis Muestras, Medidas, Purga Grifos

import {
  dbAddRecirculacion, dbGetRecirculacion, dbGetRecirculacionAll,
  dbAddAnalisis, dbUpdateAnalisis, dbGetAnalisisByMonth, dbDeleteAnalisis,
  dbAddMedida, dbGetMedidas, dbGetMedidasAll,
  dbAddPurga, dbGetPurga,
  dbExportAll
} from "./db.js";

// ========================== UTILS ==========================
const $ = id => document.getElementById(id);
const escH = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const monthStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; };
const fmtTime = ms => { const s = Math.max(0, Math.ceil(ms/1000)); return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`; };
const normalizeCode = s => { const c = String(s||"").trim().replace(/[^a-zA-Z0-9]/g,""); return c.length <= 5 ? c.toUpperCase() : c.slice(-5).toUpperCase(); };

// ========================== AUTH ==========================
const AUTH_KEY = "isivolt_v3_auth";
const SESSION_KEY = "isivolt_v3_session";
const TECH_KEY = "isivolt_v3_tech";

function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || "{}"); } catch { return {}; }
}
function saveAuth(u, p) { localStorage.setItem(AUTH_KEY, JSON.stringify({u, p})); }
function isLoggedIn() { return localStorage.getItem(SESSION_KEY) === "1"; }
function setSession(val) { val ? localStorage.setItem(SESSION_KEY,"1") : localStorage.removeItem(SESSION_KEY); }
function getTech() { return localStorage.getItem(TECH_KEY) || ""; }
function setTech(t) { localStorage.setItem(TECH_KEY, t); }

// ========================== SONIDOS ==========================
let _ctx = null;
function getCtx() {
  if (!_ctx || _ctx.state === "closed") {
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  return _ctx;
}
function beep(freq, dur, gain = 0.08, type = "sine") {
  try {
    const ctx = getCtx(); if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur / 1000);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur / 1000 + 0.02);
  } catch {}
}
function soundOK() { beep(523,80); setTimeout(()=>beep(659,80),90); setTimeout(()=>beep(784,200),180); }
function soundWarn() { beep(440,120,"0.08","sawtooth"); setTimeout(()=>beep(330,200,"0.07","sawtooth"),150); }
function soundSave() { beep(660,60); setTimeout(()=>beep(880,80),70); }

// Alarma compleja (cuando termina el cronómetro)
let alarmInterval = null;
function playAlarm() {
  stopAlarm();
  let i = 0;
  const notes = [880, 988, 1047, 880, 988, 1047, 1319, 1319];
  const durations = [120, 120, 200, 120, 120, 200, 400, 400];
  function playNext() {
    if (i >= notes.length) { i = 0; } // loop
    beep(notes[i], durations[i], 0.09, "sine");
    i++;
  }
  playNext();
  alarmInterval = setInterval(playNext, 220);
  // vibrar
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch {}
}
function stopAlarm() {
  if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
}

// ========================== TOAST ==========================
function toast(msg, type = "info", title = "") {
  const root = $("toastRoot"); if (!root) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div><div class="toast-title">${escH(title||{ok:"✅ Hecho",warn:"⚠ Aviso",err:"❌ Error",info:"ℹ️ Info"}[type]||"Info")}</div><div class="toast-msg">${escH(msg)}</div></div><button class="toast-close">✖</button>`;
  el.querySelector(".toast-close").addEventListener("click", ()=>el.remove());
  root.prepend(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transform="translateX(20px)"; }, 3800);
  setTimeout(()=>el.remove(), 4100);
}

// ========================== SETTINGS LOCAL ==========================
const CALC_KEY = "isivolt_v3_calc";
function getCalc() { try { return JSON.parse(localStorage.getItem(CALC_KEY)||"{}"); } catch { return {}; } }
function saveCalc(o) { localStorage.setItem(CALC_KEY, JSON.stringify(o)); }
function getPPM() { return Number(getCalc().ppm || 50); }
function getPctLejia() { return Number(getCalc().pctLejia || 5); }
function calcDosis(litros, pctLejia) {
  const L = Number(litros); if (!L || L <= 0) return null;
  const mgTotal = getPPM() * L;
  const mgPerMl = Number(pctLejia || getPctLejia()) * 100;
  if (mgPerMl <= 0) return null;
  return Math.round(mgTotal / mgPerMl);
}

// ========================== NAV ==========================
function initNav() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const screen = btn.getAttribute("data-screen");
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
      btn.classList.add("active");
      $(screen)?.classList.add("active");
      // refresh
      if (screen === "screenRecirculacion") refreshRecirList();
      if (screen === "screenAnalisis") refreshAnalisisList();
      if (screen === "screenMedidas") refreshMedidasList();
      if (screen === "screenPurga") refreshPurgaList();
    });
  });
}

// ========================== ONLINE PILL ==========================
function initOnline() {
  const pill = $("pillOnline");
  function update() {
    const on = navigator.onLine;
    pill.textContent = on ? "Online" : "Offline";
    pill.className = `badge ${on ? "badge-blue" : "badge-warn"}`;
  }
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

// ========================== LOGIN ==========================
function initLogin() {
  const auth = getAuth();
  // Si no hay credenciales, crear defaults
  if (!auth.u) saveAuth("paco", "1234");

  if (isLoggedIn()) {
    showApp();
    return;
  }

  const loginWrap = $("loginWrap");
  const btnLogin = $("btnLogin");
  const loginErr = $("loginErr");

  btnLogin.addEventListener("click", () => {
    const u = $("loginUser").value.trim().toLowerCase();
    const p = $("loginPass").value.trim();
    const a = getAuth();
    if (u === (a.u||"paco").toLowerCase() && p === (a.p||"1234")) {
      setSession(true);
      loginErr.classList.remove("show");
      soundOK();
      loginWrap.classList.remove("active");
      showApp();
    } else {
      loginErr.classList.add("show");
      soundWarn();
      try { navigator.vibrate?.([80,40,80]); } catch {}
      $("loginPass").value = "";
      $("loginPass").focus();
    }
  });
  $("loginPass").addEventListener("keydown", e => { if (e.key === "Enter") btnLogin.click(); });
  $("loginUser").addEventListener("keydown", e => { if (e.key === "Enter") $("loginPass").focus(); });
}

function showApp() {
  $("loginWrap").classList.remove("active");
  $("appWrap").style.display = "";
  initAfterLogin();
}

async function initAfterLogin() {
  const tech = getTech();
  if (!tech) {
    const name = prompt("¿Cómo te llamas? (aparecerá como técnico)") || "";
    if (!name.trim()) { toast("Necesitas introducir un nombre para continuar.", "warn"); return; }
    setTech(name.trim());
  }
  updateTechDisplay();
  refreshRecirList();
  initCalcSettings();
}

function updateTechDisplay() {
  const t = getTech();
  const el = $("techDisplay");
  if (el) el.textContent = t || "—";
  const ai = $("analisisTecnico");
  if (ai) ai.value = t;
}

$("btnChangeTech")?.addEventListener("click", () => {
  const name = prompt("Nombre del técnico:", getTech());
  if (name == null) return;
  setTech(name.trim() || getTech());
  updateTechDisplay();
});

// ========================== AJUSTES MODAL ==========================
$("btnSettings")?.addEventListener("click", () => {
  const a = getAuth(), c = getCalc();
  $("setUser").value = a.u || "paco";
  $("setCloroLejia").value = c.pctLejia || 5;
  $("setTargetPPM").value = c.ppm || 50;
  $("modalSettings").classList.add("open");
});
$("btnCloseSettings")?.addEventListener("click", () => $("modalSettings").classList.remove("open"));

$("btnSaveAccess")?.addEventListener("click", () => {
  const oldAuth = getAuth();
  const oldPass = $("setPassOld").value.trim();
  const newUser = $("setUser").value.trim();
  const newPass = $("setPassNew").value.trim();
  if (oldPass !== (oldAuth.p || "1234")) return toast("Contraseña actual incorrecta.", "warn");
  if (!newUser) return toast("El usuario no puede estar vacío.", "warn");
  saveAuth(newUser, newPass || oldAuth.p);
  toast("Acceso actualizado ✅", "ok");
  $("setPassOld").value = ""; $("setPassNew").value = "";
});

$("btnSaveCalc")?.addEventListener("click", () => {
  saveCalc({ pctLejia: Number($("setCloroLejia").value)||5, ppm: Number($("setTargetPPM").value)||50 });
  toast("Configuración guardada ✅", "ok");
  soundSave();
  updateDosisCalc();
});

$("btnLogout")?.addEventListener("click", () => {
  if (!confirm("¿Cerrar sesión?")) return;
  setSession(false);
  $("modalSettings").classList.remove("open");
  $("appWrap").style.display = "none";
  $("loginWrap").classList.add("active");
  $("loginPass").value = "";
});

$("btnExportAll")?.addEventListener("click", async () => {
  const tech = getTech();
  const dump = await dbExportAll(tech);
  const blob = new Blob([JSON.stringify({app:"IsiVolt Pro V3",tech,exportedAt:new Date().toISOString(),data:dump},null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href=url; a.download=`isivolt_export_${tech}_${todayStr()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast("Exportación completa ✅","ok");
});

function initCalcSettings() {
  const c = getCalc();
  const rl = $("recirLejia");
  if (rl && c.pctLejia) rl.value = c.pctLejia;
  updateDosisCalc();
}

function updateDosisCalc() {
  const l = Number($("recirLitros")?.value || 0);
  const pct = Number($("recirLejia")?.value || getPctLejia());
  const ml = calcDosis(l, pct);
  const el = $("dosisCalc");
  if (el) el.textContent = ml ? `💧 Dosis estimada: ${ml} ml de lejía (${pct}%, ${getPPM()} ppm)` : "Introduce los litros para calcular la dosis";
}

// ========================== QR SCAN ==========================
let scanStream = null, scanDetector = null, scanTarget = "recir";

$("btnScanQR")?.addEventListener("click", () => { scanTarget = "recir"; openQRModal(); });
$("btnCloseQR")?.addEventListener("click", closeQRModal);
$("btnQRManual")?.addEventListener("click", () => {
  const c = normalizeCode($("qrManual").value);
  if (!c) return toast("Código inválido.", "warn");
  closeQRModal();
  if (scanTarget === "recir") $("puntoCode").value = c;
  else if (scanTarget === "analisis") $("analisisPuntoCode").value = c;
  else if (scanTarget === "purga") $("purgaCodigo").value = c;
});

async function openQRModal() {
  $("modalQR").classList.add("open");
  $("qrManual").value = "";
  if (!("mediaDevices" in navigator)) return;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"},audio:false});
    $("qrVideo").srcObject = scanStream;
    await $("qrVideo").play();
    if ("BarcodeDetector" in window) {
      scanDetector = new BarcodeDetector({formats:["qr_code"]});
      qrLoop();
    }
  } catch {}
}
function closeQRModal() {
  $("modalQR").classList.remove("open");
  if (scanStream) { scanStream.getTracks().forEach(t=>t.stop()); scanStream=null; }
  scanDetector = null;
}
async function qrLoop() {
  if (!scanDetector || !scanStream) return;
  try {
    const barcodes = await scanDetector.detect($("qrVideo"));
    if (barcodes?.length) {
      const c = normalizeCode(barcodes[0].rawValue);
      if (c) {
        beep(1200, 60, 0.06, "square");
        closeQRModal();
        if (scanTarget === "recir") $("puntoCode").value = c;
        else if (scanTarget === "analisis") $("analisisPuntoCode").value = c;
        else if (scanTarget === "purga") $("purgaCodigo").value = c;
        return;
      }
    }
  } catch {}
  requestAnimationFrame(qrLoop);
}

// ==========================
// MÓDULO 1: RECIRCULACIÓN
// ==========================
let recirTimer = {
  running: false, paused: false,
  startTs: 0, durationMs: 0, elapsedMs: 0, raf: 0,
  code: "", minimized: false
};

// Dosis auto al cambiar litros/lejía
$("recirLitros")?.addEventListener("input", updateDosisCalc);
$("recirLejia")?.addEventListener("input", updateDosisCalc);

$("btnAddPunto")?.addEventListener("click", async () => {
  const code = normalizeCode($("puntoCode").value);
  if (!code) return toast("Introduce un código de punto.", "warn");
  if (recirTimer.running) return toast("Hay un cronómetro en marcha. Finalízalo primero.", "warn");

  const mins = Number($("recirMinutos").value) || 30;
  const litros = Number($("recirLitros").value) || 60;
  const lejia = Number($("recirLejia").value) || getPctLejia();
  const dosis = calcDosis(litros, lejia);

  // Iniciar cronómetro
  recirTimer.code = code;
  recirTimer.durationMs = mins * 60 * 1000;
  recirTimer.elapsedMs = 0;
  recirTimer.startTs = performance.now();
  recirTimer.running = true;
  recirTimer.paused = false;
  recirTimer.minimized = false;

  $("timerCode").textContent = code;
  $("timerStatus").textContent = "⏱ Activo";
  $("timerStatus").className = "badge badge-blue";
  $("sealResult").className = "hidden";
  $("btnStartTimer").classList.add("hidden");
  $("btnPauseTimer").classList.remove("hidden");
  $("btnResumeTimer").classList.add("hidden");
  $("miniTimer").classList.remove("show");
  $("miniCode").textContent = code;

  toast(`Cronómetro iniciado · ${code} · ${mins} min`, "ok", "Recirculación");
  soundSave();
  recirTimerTick();
});

$("btnStartTimer")?.addEventListener("click", () => {
  toast("Añade un punto con el botón '✅ Añadir'", "info");
});

$("btnPauseTimer")?.addEventListener("click", () => {
  if (!recirTimer.running || recirTimer.paused) return;
  recirTimer.paused = true;
  recirTimer.elapsedMs = performance.now() - recirTimer.startTs;
  cancelAnimationFrame(recirTimer.raf);
  $("timerStatus").textContent = "⏸ Pausado";
  $("timerStatus").className = "badge badge-warn";
  $("btnPauseTimer").classList.add("hidden");
  $("btnResumeTimer").classList.remove("hidden");
  toast("Cronómetro pausado", "warn");
});

$("btnResumeTimer")?.addEventListener("click", () => {
  if (!recirTimer.running || !recirTimer.paused) return;
  recirTimer.paused = false;
  recirTimer.startTs = performance.now() - recirTimer.elapsedMs;
  $("timerStatus").textContent = "⏱ Activo";
  $("timerStatus").className = "badge badge-blue";
  $("btnPauseTimer").classList.remove("hidden");
  $("btnResumeTimer").classList.add("hidden");
  recirTimerTick();
});

$("btnFinishOK")?.addEventListener("click", () => finishRecir("ok"));
$("btnFinishIssue")?.addEventListener("click", () => finishRecirIssue());

function recirTimerTick() {
  if (!recirTimer.running || recirTimer.paused) return;
  const elapsed = performance.now() - recirTimer.startTs;
  recirTimer.elapsedMs = elapsed;
  const left = Math.max(0, recirTimer.durationMs - elapsed);
  const pct = Math.min(1, elapsed / recirTimer.durationMs);

  $("timerDisplay").textContent = fmtTime(left);
  $("tankWater").style.height = `${Math.round(pct*100)}%`;
  $("tankPct").textContent = `${Math.round(pct*100)}%`;
  $("tankTime").textContent = fmtTime(left);
  $("timerProgress").style.width = `${Math.round(pct*100)}%`;
  $("miniLeft").textContent = fmtTime(left);

  if (left <= 0) {
    // ¡COMPLETADO!
    recirTimer.running = false;
    recirTimer.paused = false;
    $("timerStatus").textContent = "✅ Completado";
    $("timerStatus").className = "badge badge-ok";
    $("btnPauseTimer").classList.add("hidden");
    $("btnResumeTimer").classList.add("hidden");
    $("tankWater").style.height = "100%";
    $("tankPct").textContent = "100%";
    $("timerProgress").style.width = "100%";
    $("miniTimer").classList.remove("show");

    // Mostrar alarma
    showAlarm(recirTimer.code, "recir");
    return;
  }
  recirTimer.raf = requestAnimationFrame(recirTimerTick);
}

let pendingAlarmType = "recir";
function showAlarm(code, type) {
  pendingAlarmType = type;
  $("alarmTitle").textContent = type === "recir" ? "✅ ¡Recirculación completada!" : "✅ ¡Purga completada!";
  $("alarmCode").textContent = code;
  $("alarmOverlay").classList.add("show");
  playAlarm();
}

$("alarmOverlay")?.addEventListener("click", () => {
  stopAlarm();
  $("alarmOverlay").classList.remove("show");
  if (pendingAlarmType === "recir") finishRecir("ok", true);
  else finishPurga("ok", true);
});
$("btnAlarmClose")?.addEventListener("click", (e) => {
  e.stopPropagation();
  stopAlarm();
  $("alarmOverlay").classList.remove("show");
  if (pendingAlarmType === "recir") finishRecir("ok", true);
  else finishPurga("ok", true);
});

async function finishRecir(result, fromAlarm = false) {
  if (!recirTimer.code) return;
  const code = recirTimer.code;
  const litros = Number($("recirLitros").value) || 60;
  const lejia = Number($("recirLejia").value) || getPctLejia();
  const mins = Math.round(recirTimer.elapsedMs / 60000) || Number($("recirMinutos").value) || 0;
  const nota = $("recirNota")?.value?.trim() || "";
  const dosis = calcDosis(litros, lejia);

  await dbAddRecirculacion({
    tech: getTech(), date: todayStr(), ts: Date.now(),
    code, litros, lejia, doseMl: dosis, minutos: mins,
    result, nota
  });

  recirTimer.running = false; recirTimer.paused = false; recirTimer.code = "";
  cancelAnimationFrame(recirTimer.raf);
  $("miniTimer").classList.remove("show");
  $("btnStartTimer").classList.remove("hidden");
  $("btnPauseTimer").classList.add("hidden");
  $("btnResumeTimer").classList.add("hidden");
  $("timerStatus").textContent = "Listo";
  $("timerStatus").className = "badge badge-gray";
  $("timerCode").textContent = "—";
  $("timerDisplay").textContent = "00:00";
  $("tankWater").style.height = "0%";
  $("tankPct").textContent = "0%";
  $("timerProgress").style.width = "0%";
  $("puntoCode").value = ""; $("recirNota").value = "";

  const seal = $("sealResult");
  if (seal) {
    seal.className = `seal ${result==="ok"?"seal-ok":"seal-warn"} mt14`;
    seal.textContent = result==="ok" ? `✅ ${code} registrado · ${mins} min · ${dosis}ml` : `⚠ ${code} con incidencia registrada`;
    seal.classList.remove("hidden");
  }

  soundOK(); toast(`${code} registrado ✅`, "ok", "Recirculación");
  await refreshRecirList();
}

async function finishRecirIssue() {
  if (!recirTimer.running && !recirTimer.code) return;
  const reason = prompt("Motivo de la incidencia (corto):", "Sin acceso");
  if (reason == null) return;
  recirTimer.elapsedMs = recirTimer.elapsedMs || (performance.now() - recirTimer.startTs);
  const code = recirTimer.code || "—";
  const nota = reason.trim().slice(0, 120);
  $("recirNota").value = nota;
  cancelAnimationFrame(recirTimer.raf);
  recirTimer.running = false;
  await finishRecir("issue");
}

$("btnMinimize")?.addEventListener("click", () => {
  if (!recirTimer.running) return;
  recirTimer.minimized = true;
  // Ir a otra pantalla
  document.querySelector('[data-screen="screenAnalisis"]')?.click();
  $("miniTimer").classList.add("show");
  toast("Cronómetro minimizado · sigue en marcha ⏱", "info");
});

$("miniTimerInner")?.addEventListener("click", () => {
  $("miniTimer").classList.remove("show");
  recirTimer.minimized = false;
  document.querySelector('[data-screen="screenRecirculacion"]')?.click();
});

async function refreshRecirList() {
  const tech = getTech(), date = todayStr();
  const items = await dbGetRecirculacion(tech, date);
  const list = $("recirList");
  const kpi = $("kpiRecirHoy");
  if (kpi) kpi.textContent = `${items.filter(i=>i.result==="ok").length}/${items.length} hoy`;

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">Sin puntos hoy. Añade un punto arriba.</div></div>`;
    return;
  }
  list.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div"); el.className = "list-item";
    const dt = new Date(it.ts).toLocaleTimeString();
    const badge = it.result==="ok" ? "badge-ok" : "badge-danger";
    const badgeTxt = it.result==="ok" ? "✅ OK" : "⚠ Incidencia";
    el.innerHTML = `
      <div class="list-item-left">
        <div class="list-item-code">${escH(it.code)}</div>
        <div class="list-item-meta">${dt} · ${it.litros}L · ${it.minutos}min · ${it.doseMl}ml${it.nota?` · ${escH(it.nota.slice(0,40))}`:""}</div>
      </div>
      <div class="list-item-actions">
        <span class="badge ${badge}">${badgeTxt}</span>
      </div>`;
    list.appendChild(el);
  }
}

$("btnExportRecir")?.addEventListener("click", async () => {
  await exportToExcel("recirculacion");
});

// ==========================
// MÓDULO 2: ANÁLISIS MUESTRAS
// ==========================
const PLANTAS = ["-1","Baja","1","2","3","4","5","6","7","8","Otros"];

$("analisisMes")?.addEventListener("change", refreshAnalisisList);
document.addEventListener("DOMContentLoaded", () => {
  if ($("analisisMes")) $("analisisMes").value = monthStr();
  if ($("medidaFecha")) $("medidaFecha").value = todayStr();
  if ($("medidaFiltroFecha")) $("medidaFiltroFecha").value = todayStr();
});

$("btnAddAnalisis")?.addEventListener("click", async () => {
  const code = normalizeCode($("analisisPuntoCode").value);
  if (!code) return toast("Introduce un código de punto.", "warn");
  const mes = $("analisisMes").value || monthStr();
  const planta = $("analisisPlanta").value || "Baja";
  const tipo = $("analisisTipo").value || "ACS";
  const tech = getTech();

  await dbAddAnalisis({ tech, month: mes, ts: Date.now(), code, planta, tipo, status: "pendiente", nota: "" });
  soundSave(); toast(`Punto ${code} añadido ✅`, "ok", "Análisis");
  $("analisisPuntoCode").value = "";
  await refreshAnalisisList();
});

// Subida de Excel/CSV
const uploadZone = $("uploadZone");
const fileAnalisis = $("fileAnalisis");
if (uploadZone && fileAnalisis) {
  ["dragenter","dragover"].forEach(ev => uploadZone.addEventListener(ev, e => { e.preventDefault(); uploadZone.style.borderColor="rgba(0,212,255,.6)"; }));
  ["dragleave","drop"].forEach(ev => uploadZone.addEventListener(ev, e => { e.preventDefault(); uploadZone.style.borderColor=""; if(ev==="drop") handleAnalisisFile(e.dataTransfer.files[0]); }));
  fileAnalisis.addEventListener("change", e => { handleAnalisisFile(e.target.files[0]); e.target.value=""; });
}

async function handleAnalisisFile(file) {
  if (!file) return;
  uploadZone?.classList.add("has-file");
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const mes = $("analisisMes").value || monthStr();
  const tech = getTech();
  let added = 0;
  for (const line of lines) {
    const parts = line.split(/[,;\t]/);
    const code = normalizeCode(parts[0] || "");
    if (!code) continue;
    const planta = (parts[1] || "Baja").trim() || "Baja";
    const tipo = (parts[2] || "ACS").trim().toUpperCase().startsWith("AF") ? "AFCH" : "ACS";
    await dbAddAnalisis({ tech, month: mes, ts: Date.now(), code, planta, tipo, status: "pendiente", nota: "" });
    added++;
  }
  if (added) { toast(`${added} puntos importados ✅`, "ok", "Análisis"); await refreshAnalisisList(); }
  else toast("No se encontraron códigos en el archivo.", "warn");
}

async function refreshAnalisisList() {
  const mes = $("analisisMes")?.value || monthStr();
  const tech = getTech();
  const items = await dbGetAnalisisByMonth(tech, mes);

  // KPIs
  const tot = items.length;
  const ok = items.filter(i=>i.status==="hecho").length;
  const pend = items.filter(i=>i.status==="pendiente").length;
  const iss = items.filter(i=>i.status==="incidencia").length;
  $("kpiATot").textContent = tot; $("kpiAOk").textContent = ok;
  $("kpiAPend").textContent = pend; $("kpiAIssue").textContent = iss;

  const container = $("analisisList");
  if (!tot) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🧪</div><div class="empty-text">Importa un listado o añade puntos manualmente</div></div>`;
    return;
  }

  // Agrupar por planta
  const grupos = new Map();
  for (const p of PLANTAS) grupos.set(p, []);
  for (const it of items) {
    const pl = PLANTAS.includes(String(it.planta)) ? String(it.planta) : "Otros";
    grupos.get(pl).push(it);
  }

  container.innerHTML = "";
  for (const planta of PLANTAS) {
    const arr = grupos.get(planta) || [];
    if (!arr.length) continue;

    const done = arr.filter(i=>i.status==="hecho").length;
    const pct = Math.round((done/arr.length)*100);

    const group = document.createElement("div"); group.className = "analysis-group card";
    group.innerHTML = `
      <div class="analysis-group-title">
        <span>Planta ${escH(planta)} · <span style="color:var(--ok)">${done}</span>/<span>${arr.length}</span></span>
        <span class="badge ${pct===100?"badge-ok":"badge-gray"}">${pct}%</span>
      </div>
      <div class="progress-bar" style="margin-bottom:10px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="list grp-list"></div>`;
    const listEl = group.querySelector(".grp-list");

    for (const it of arr) {
      const row = document.createElement("div"); row.className = "list-item";
      const badge = it.status==="hecho"?"badge-ok":it.status==="incidencia"?"badge-danger":"badge-gray";
      const badgeTxt = it.status==="hecho"?"✅ Tomada":it.status==="incidencia"?"⚠ Incid.":"⏳ Pend.";
      const water = it.tipo==="ACS"?"🔥":"❄️";
      row.innerHTML = `
        <div class="list-item-left">
          <div class="list-item-code">${water} ${escH(it.code)}</div>
          <div class="list-item-meta">${it.nota ? escH(it.nota.slice(0,50)) : "Sin nota"}</div>
        </div>
        <div class="list-item-actions">
          <span class="badge ${badge}">${badgeTxt}</span>
          <button class="btn btn-sm btn-success" data-id="${it.id}" data-action="hecho">✅</button>
          <button class="btn btn-sm btn-danger" data-id="${it.id}" data-action="incidencia">⚠</button>
          <button class="btn btn-sm btn-danger" data-id="${it.id}" data-action="delete" style="opacity:.6">🗑</button>
        </div>`;
      row.querySelectorAll("[data-action]").forEach(btn => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const action = btn.getAttribute("data-action");
          const id = Number(btn.getAttribute("data-id"));
          if (action === "delete") {
            if (!confirm("¿Eliminar este punto?")) return;
            await dbDeleteAnalisis(id);
          } else {
            let nota = "";
            if (action === "incidencia") { nota = prompt("Motivo incidencia:", "") || ""; if (nota === null) return; }
            it.status = action; it.nota = nota; it.updatedAt = Date.now();
            await dbUpdateAnalisis(it);
            if (action==="hecho") soundOK(); else soundWarn();
          }
          await refreshAnalisisList();
        });
      });
      listEl.appendChild(row);
    }
    container.appendChild(group);
  }
}

$("btnClearAnalisis")?.addEventListener("click", async () => {
  const mes = $("analisisMes")?.value || monthStr();
  if (!confirm(`¿Vaciar todos los puntos del mes ${mes}?`)) return;
  const tech = getTech();
  const items = await dbGetAnalisisByMonth(tech, mes);
  for (const it of items) await dbDeleteAnalisis(it.id);
  uploadZone?.classList.remove("has-file");
  await refreshAnalisisList();
  toast("Checklist del mes vaciado.", "warn");
});

$("btnExportAnalisis")?.addEventListener("click", async () => {
  const mes = $("analisisMes")?.value || monthStr();
  const tech = getTech();
  const items = await dbGetAnalisisByMonth(tech, mes);
  if (!items.length) return toast("No hay datos para exportar.", "warn");
  exportListToExcel(items.map(it => ({
    Mes: it.month, Codigo: it.code, Planta: it.planta, Tipo: it.tipo,
    Estado: it.status, Nota: it.nota||"", Fecha: it.ts ? new Date(it.ts).toLocaleDateString() : ""
  })), `analisis_${mes}_${tech}.xls`);
});

// ==========================
// MÓDULO 3: MEDIDAS
// ==========================
const RANGOS = {
  ph: {min:6.5, max:9.0, label:"pH"},
  temp: {min:50, max:70, label:"Temperatura (°C)", note:"ACS debe estar ≥ 50°C"},
  cloroL: {min:0.2, max:1.0, label:"Cloro libre (mg/L)"},
  cloroT: {min:0.2, max:2.0, label:"Cloro total (mg/L)"},
  turb: {min:0, max:1.0, label:"Turbidez (NTU)"},
};

$("medidaFiltroFecha")?.addEventListener("change", refreshMedidasList);
$("btnSaveMedida")?.addEventListener("click", async () => {
  const codigo = $("medidaCodigo").value.trim();
  if (!codigo) return toast("Introduce el código del punto.", "warn");
  const fecha = $("medidaFecha").value || todayStr();

  const ph = parseFloat($("mPH").value) || null;
  const temp = parseFloat($("mTemp").value) || null;
  const cloroL = parseFloat($("mCloroL").value) || null;
  const cloroT = parseFloat($("mCloroT").value) || null;
  const turb = parseFloat($("mTurb").value) || null;
  const cond = parseFloat($("mCond").value) || null;
  const nota = $("mNota").value.trim();

  await dbAddMedida({ tech: getTech(), date: fecha, ts: Date.now(), codigo, ph, temp, cloroL, cloroT, turb, cond, nota });

  soundOK(); toast(`Medida de ${codigo} guardada ✅`, "ok", "Medidas");
  [$("mPH"),$("mTemp"),$("mCloroL"),$("mCloroT"),$("mTurb"),$("mCond"),$("mNota")].forEach(el=>{if(el)el.value="";});
  checkRangos(ph, temp, cloroL, cloroT, turb);
  await refreshMedidasList();
});

function checkRangos(ph, temp, cloroL, cloroT, turb) {
  const alerts = [];
  if (ph !== null && (ph < RANGOS.ph.min || ph > RANGOS.ph.max)) alerts.push(`⚠ pH ${ph} fuera de rango (${RANGOS.ph.min}–${RANGOS.ph.max})`);
  if (temp !== null && temp < RANGOS.temp.min) alerts.push(`⚠ Temperatura ${temp}°C < 50°C (Legionella riesgo)`);
  if (cloroL !== null && (cloroL < RANGOS.cloroL.min || cloroL > RANGOS.cloroL.max)) alerts.push(`⚠ Cloro libre ${cloroL} fuera de rango (${RANGOS.cloroL.min}–${RANGOS.cloroL.max} mg/L)`);
  if (cloroT !== null && cloroT < RANGOS.cloroT.min) alerts.push(`⚠ Cloro total ${cloroT} bajo`);
  if (turb !== null && turb > RANGOS.turb.max) alerts.push(`⚠ Turbidez ${turb} NTU > 1 NTU`);
  const div = $("medidasAlerts"), txt = $("alertText");
  if (alerts.length && div && txt) {
    txt.textContent = alerts.join(" · ");
    div.classList.remove("hidden");
    soundWarn();
    try { navigator.vibrate?.([100,50,100]); } catch {}
  } else { div?.classList.add("hidden"); }
}

async function refreshMedidasList() {
  const tech = getTech();
  const fecha = $("medidaFiltroFecha")?.value || todayStr();
  const items = await dbGetMedidas(tech, fecha);
  const list = $("medidasList");
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">Sin medidas registradas el ${fecha}</div></div>`;
    return;
  }
  list.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div"); el.className = "list-item";
    const hr = new Date(it.ts).toLocaleTimeString();
    const alerts = [];
    if (it.ph && (it.ph < 6.5 || it.ph > 9)) alerts.push("pH⚠");
    if (it.temp && it.temp < 50) alerts.push("T°⚠");
    if (it.cloroL && (it.cloroL < 0.2 || it.cloroL > 1)) alerts.push("Cl⚠");
    const alertBadge = alerts.length ? `<span class="badge badge-warn">${alerts.join(" ")}</span>` : `<span class="badge badge-ok">OK</span>`;

    el.innerHTML = `
      <div class="list-item-left">
        <div class="list-item-code">${escH(it.codigo)}</div>
        <div class="list-item-meta">${hr}${it.ph?` · pH ${it.ph}`:""}${it.temp?` · ${it.temp}°C`:""}${it.cloroL?` · Cl.L ${it.cloroL}`:""}${it.cloroT?` · Cl.T ${it.cloroT}`:""}${it.turb?` · ${it.turb}NTU`:""}${it.nota?` · ${escH(it.nota.slice(0,30))}`:""}</div>
      </div>
      <div class="list-item-actions">${alertBadge}</div>`;
    list.appendChild(el);
  }
}

$("btnExportMedidas")?.addEventListener("click", async () => {
  const tech = getTech();
  const items = await dbGetMedidasAll(tech);
  if (!items.length) return toast("Sin medidas para exportar.", "warn");
  exportListToExcel(items.map(it => ({
    Fecha: it.date, Hora: new Date(it.ts).toLocaleTimeString(), Tecnico: it.tech,
    Punto: it.codigo, pH: it.ph??"", Temp_C: it.temp??"", CloroLibre: it.cloroL??"",
    CloroTotal: it.cloroT??"", Turbidez: it.turb??"", Conductividad: it.cond??"", Nota: it.nota||""
  })), `medidas_${tech}.xls`);
});

// ==========================
// MÓDULO 4: PURGA GRIFOS
// ==========================
let purgaState = { tipo: "ACS" };
let purgaTimer = {
  running: false, paused: false,
  startTs: 0, durationMs: 0, elapsedMs: 0, raf: 0,
  code: "", minimized: false
};

window.selectTipoPurga = function(tipo) {
  purgaState.tipo = tipo;
  $("tipoACS").classList.toggle("selected", tipo === "ACS");
  $("tipoAFCH").classList.toggle("selected", tipo === "AFCH");
  $("purgaTipoLabel").textContent = tipo === "ACS" ? "🔥 ACS · Apertura" : "❄️ AFCH · Apertura";
};

$("purgaMinutos")?.addEventListener("input", () => {
  const m = Number($("purgaMinutos").value) || 5;
  $("purgaDisplay").textContent = `${String(m).padStart(2,"0")}:00`;
  $("purgaProgress").style.width = "0%";
});

$("btnStartPurga")?.addEventListener("click", () => {
  const code = ($("purgaCodigo").value || "").trim();
  if (!code) return toast("Introduce el código o ubicación del grifo.", "warn");
  if (purgaTimer.running) return toast("Hay una purga en marcha. Finalízala primero.", "warn");

  const mins = Number($("purgaMinutos").value) || 5;
  purgaTimer.code = code;
  purgaTimer.durationMs = mins * 60 * 1000;
  purgaTimer.elapsedMs = 0;
  purgaTimer.startTs = performance.now();
  purgaTimer.running = true;
  purgaTimer.paused = false;
  purgaTimer.minimized = false;

  $("purgaCode").textContent = code;
  $("purgaStatus").textContent = "⏱ Activo";
  $("purgaStatus").className = "badge badge-blue";
  $("purgaSeal").className = "hidden";
  $("btnStartPurga").classList.add("hidden");
  $("btnPausePurga").classList.remove("hidden");
  $("btnResumePurga").classList.add("hidden");
  $("miniTimerPurga").classList.remove("show");
  $("miniPurgaCode").textContent = code;

  toast(`Purga iniciada · ${code} · ${purgaState.tipo} · ${mins} min`, "ok", "Purga");
  soundSave();
  purgaTimerTick();
});

$("btnPausePurga")?.addEventListener("click", () => {
  if (!purgaTimer.running || purgaTimer.paused) return;
  purgaTimer.paused = true;
  purgaTimer.elapsedMs = performance.now() - purgaTimer.startTs;
  cancelAnimationFrame(purgaTimer.raf);
  $("purgaStatus").textContent = "⏸ Pausado";
  $("purgaStatus").className = "badge badge-warn";
  $("btnPausePurga").classList.add("hidden");
  $("btnResumePurga").classList.remove("hidden");
});

$("btnResumePurga")?.addEventListener("click", () => {
  if (!purgaTimer.running || !purgaTimer.paused) return;
  purgaTimer.paused = false;
  purgaTimer.startTs = performance.now() - purgaTimer.elapsedMs;
  $("purgaStatus").textContent = "⏱ Activo";
  $("purgaStatus").className = "badge badge-blue";
  $("btnPausePurga").classList.remove("hidden");
  $("btnResumePurga").classList.add("hidden");
  purgaTimerTick();
});

$("btnFinishPurgaOK")?.addEventListener("click", () => finishPurga("ok"));
$("btnFinishPurgaIssue")?.addEventListener("click", () => {
  const reason = prompt("Motivo del problema:", "") || "";
  if (reason === null) return;
  finishPurga("issue", false, reason);
});

function purgaTimerTick() {
  if (!purgaTimer.running || purgaTimer.paused) return;
  const elapsed = performance.now() - purgaTimer.startTs;
  purgaTimer.elapsedMs = elapsed;
  const left = Math.max(0, purgaTimer.durationMs - elapsed);
  const pct = Math.min(1, elapsed / purgaTimer.durationMs);

  $("purgaDisplay").textContent = fmtTime(left);
  $("purgaProgress").style.width = `${Math.round(pct*100)}%`;
  $("miniPurgaLeft").textContent = fmtTime(left);

  if (left <= 0) {
    purgaTimer.running = false; purgaTimer.paused = false;
    $("purgaStatus").textContent = "✅ Completado";
    $("purgaStatus").className = "badge badge-ok";
    $("btnPausePurga").classList.add("hidden");
    $("btnResumePurga").classList.add("hidden");
    $("purgaProgress").style.width = "100%";
    $("miniTimerPurga").classList.remove("show");
    showAlarm(purgaTimer.code, "purga");
    return;
  }
  purgaTimer.raf = requestAnimationFrame(purgaTimerTick);
}

async function finishPurga(result, fromAlarm = false, nota = "") {
  if (!purgaTimer.code && !nota) return;
  const code = purgaTimer.code || "—";
  const mins = Math.round(purgaTimer.elapsedMs / 60000) || Number($("purgaMinutos").value) || 0;
  const n = nota || $("purgaNota")?.value?.trim() || "";

  await dbAddPurga({
    tech: getTech(), date: todayStr(), ts: Date.now(),
    code, tipo: purgaState.tipo, minutos: mins, result, nota: n
  });

  purgaTimer.running = false; purgaTimer.paused = false; purgaTimer.code = "";
  cancelAnimationFrame(purgaTimer.raf);
  $("miniTimerPurga").classList.remove("show");
  $("btnStartPurga").classList.remove("hidden");
  $("btnPausePurga").classList.add("hidden");
  $("btnResumePurga").classList.add("hidden");
  $("purgaStatus").textContent = "Listo";
  $("purgaStatus").className = "badge badge-gray";
  $("purgaCode").textContent = "—";
  $("purgaDisplay").textContent = "05:00";
  $("purgaProgress").style.width = "0%";
  $("purgaCodigo").value = ""; $("purgaNota").value = "";

  const seal = $("purgaSeal");
  if (seal) {
    seal.className = `seal ${result==="ok"?"seal-ok":"seal-warn"} mt14`;
    seal.textContent = result==="ok" ? `✅ ${code} (${purgaState.tipo}) purgado · ${mins} min` : `⚠ ${code} con incidencia · ${n}`;
    seal.classList.remove("hidden");
  }

  soundOK(); toast(`Purga ${code} registrada ✅`, "ok", "Purga");
  await refreshPurgaList();
}

$("btnMinimizePurga")?.addEventListener("click", () => {
  if (!purgaTimer.running) return;
  purgaTimer.minimized = true;
  document.querySelector('[data-screen="screenRecirculacion"]')?.click();
  $("miniTimerPurga").classList.add("show");
  toast("Purga minimizada · sigue en marcha ⏱", "info");
});

$("miniTimerPurgaInner")?.addEventListener("click", () => {
  $("miniTimerPurga").classList.remove("show");
  purgaTimer.minimized = false;
  document.querySelector('[data-screen="screenPurga"]')?.click();
});

async function refreshPurgaList() {
  const tech = getTech(), date = todayStr();
  const items = await dbGetPurga(tech, date);
  const list = $("purgaList");
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🚰</div><div class="empty-text">Sin purgados hoy</div></div>`;
    return;
  }
  list.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div"); el.className = "list-item";
    const water = it.tipo==="ACS"?"🔥":"❄️";
    const badge = it.result==="ok"?"badge-ok":"badge-danger";
    el.innerHTML = `
      <div class="list-item-left">
        <div class="list-item-code">${water} ${escH(it.code)}</div>
        <div class="list-item-meta">${new Date(it.ts).toLocaleTimeString()} · ${it.tipo} · ${it.minutos}min${it.nota?` · ${escH(it.nota.slice(0,40))}`:""}</div>
      </div>
      <span class="badge ${badge}">${it.result==="ok"?"✅ OK":"⚠ Incid."}</span>`;
    list.appendChild(el);
  }
}

$("btnExportPurga")?.addEventListener("click", async () => {
  await exportToExcel("purga");
});

// ========================== EXPORT EXCEL ==========================
async function exportToExcel(tipo) {
  const tech = getTech();
  let items = [], filename = "";
  if (tipo === "recirculacion") {
    items = (await dbGetRecirculacionAll(tech)).map(it => ({
      Fecha: it.date, Hora: it.ts?new Date(it.ts).toLocaleTimeString():"", Tecnico: it.tech,
      Codigo: it.code, Litros: it.litros, Dosis_ml: it.doseMl, Minutos: it.minutos,
      Resultado: it.result, Nota: it.nota||""
    }));
    filename = `recirculacion_${tech}.xls`;
  } else if (tipo === "purga") {
    const today = await dbGetPurga(tech, todayStr());
    items = today.map(it => ({
      Fecha: it.date, Hora: it.ts?new Date(it.ts).toLocaleTimeString():"", Tecnico: it.tech,
      Codigo: it.code, Tipo: it.tipo, Minutos: it.minutos, Resultado: it.result, Nota: it.nota||""
    }));
    filename = `purga_${tech}_${todayStr()}.xls`;
  }
  if (!items.length) return toast("Sin datos para exportar.", "warn");
  exportListToExcel(items, filename);
}

function exportListToExcel(rows, filename) {
  if (!rows.length) return;
  const header = Object.keys(rows[0]);
  let html = `<html><head><meta charset="utf-8"></head><body><table border="1" cellspacing="0" cellpadding="4">`;
  html += `<tr>${header.map(h=>`<th>${escH(h)}</th>`).join("")}</tr>`;
  for (const r of rows) html += `<tr>${header.map(h=>`<td>${escH(String(r[h]??""))}</td>`).join("")}</tr>`;
  html += `</table></body></html>`;
  const blob = new Blob([html], {type:"application/vnd.ms-excel;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  toast("Excel descargado ✅", "ok");
}

// ========================== SERVICE WORKER ==========================
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}

// ========================== INIT ==========================
function init() {
  initNav();
  initOnline();
  initLogin();

  // Set default dates
  if ($("analisisMes")) $("analisisMes").value = monthStr();
  if ($("medidaFecha")) $("medidaFecha").value = todayStr();
  if ($("medidaFiltroFecha")) $("medidaFiltroFecha").value = todayStr();
}

init();
