// IsiVolt Pro V3 · db.js
const DB_NAME = "isivolt_v3";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      // OT Recirculación (cloro)
      if (!db.objectStoreNames.contains("recirculacion")) {
        const s = db.createObjectStore("recirculacion", { keyPath: "id", autoIncrement: true });
        s.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
      // OT Análisis (muestras mensuales)
      if (!db.objectStoreNames.contains("analisis")) {
        const s = db.createObjectStore("analisis", { keyPath: "id", autoIncrement: true });
        s.createIndex("byTechMonth", ["tech", "month"], { unique: false });
      }
      // Medidas (pH, temperatura, cloro libre, etc.)
      if (!db.objectStoreNames.contains("medidas")) {
        const s = db.createObjectStore("medidas", { keyPath: "id", autoIncrement: true });
        s.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
      // Purga grifos
      if (!db.objectStoreNames.contains("purga")) {
        const s = db.createObjectStore("purga", { keyPath: "id", autoIncrement: true });
        s.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

// --- Recirculación ---
export async function dbAddRecirculacion(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "recirculacion", "readwrite").add(entry);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetRecirculacion(tech, date) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "recirculacion").index("byTechDate").getAll([tech, date]);
    req.onsuccess = () => res((req.result || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetRecirculacionAll(tech) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "recirculacion").index("byTechDate").getAll(IDBKeyRange.bound([tech, ""], [tech, "\uffff"]));
    req.onsuccess = () => res((req.result || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    req.onerror = () => rej(req.error);
  });
}

// --- Análisis ---
export async function dbAddAnalisis(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "analisis", "readwrite").add(entry);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbUpdateAnalisis(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "analisis", "readwrite").put(entry);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetAnalisisByMonth(tech, month) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "analisis").index("byTechMonth").getAll([tech, month]);
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
export async function dbDeleteAnalisis(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "analisis", "readwrite").delete(id);
    req.onsuccess = () => res(true);
    req.onerror = () => rej(req.error);
  });
}

// --- Medidas ---
export async function dbAddMedida(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "medidas", "readwrite").add(entry);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetMedidas(tech, date) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "medidas").index("byTechDate").getAll([tech, date]);
    req.onsuccess = () => res((req.result || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetMedidasAll(tech) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "medidas").getAll();
    req.onsuccess = () => res((req.result || []).filter(m => m.tech === tech).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    req.onerror = () => rej(req.error);
  });
}

// --- Purga ---
export async function dbAddPurga(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "purga", "readwrite").add(entry);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export async function dbGetPurga(tech, date) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const req = tx(db, "purga").index("byTechDate").getAll([tech, date]);
    req.onsuccess = () => res((req.result || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)));
    req.onerror = () => rej(req.error);
  });
}

// --- Export all ---
export async function dbExportAll(tech) {
  const db = await openDB();
  const stores = ["recirculacion", "analisis", "medidas", "purga"];
  const dump = {};
  for (const name of stores) {
    dump[name] = await new Promise((res, rej) => {
      const req = tx(db, name).getAll();
      req.onsuccess = () => res((req.result || []).filter(r => r.tech === tech));
      req.onerror = () => rej(req.error);
    });
  }
  return dump;
}
