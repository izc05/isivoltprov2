const DB_NAME = "isivolt_legionella_v13";
const DB_VER = 4;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("ot")) {
        const store = db.createObjectStore("ot", { keyPath: "key" });
        store.createIndex("byTechDate", ["tech", "date"], { unique: false });
      }
      if (!db.objectStoreNames.contains("history")) {
        const store = db.createObjectStore("history", { keyPath: "id", autoIncrement: true });
        store.createIndex("byTech", "tech", { unique: false });
      }
      if (!db.objectStoreNames.contains("monthly")) {
        const store = db.createObjectStore("monthly", { keyPath: "key" });
        store.createIndex("byTechMonth", ["tech", "month"], { unique: false });
      }
      if (!db.objectStoreNames.contains("monthlyFiles")) {
        db.createObjectStore("monthlyFiles", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("monthlyHeader")) {
        const store = db.createObjectStore("monthlyHeader", { keyPath: "key" });
        store.createIndex("byTechMonth", ["tech", "month"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, storeName, mode="readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function dbPutOT(item){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readwrite");
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetOTByTechDate(tech, date){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readonly");
    const idx = store.index("byTechDate");
    const req = idx.getAll([tech, date]);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeleteOTByTechDate(tech, date){
  const db = await openDB();
  const items = await dbGetOTByTechDate(tech, date);
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readwrite");
    let pending = items.length;
    if (!pending) return resolve(true);
    for (const it of items){
      const req = store.delete(it.key);
      req.onsuccess = () => { if (--pending === 0) resolve(true); };
      req.onerror = () => reject(req.error);
    }
  });
}

export async function dbDeleteOTKey(key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "ot", "readwrite");
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbAddHistory(entry){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "history", "readwrite");
    const req = store.add(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetHistoryByTech(tech, limit=200){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "history", "readonly");
    const idx = store.index("byTech");
    const req = idx.getAll(tech);
    req.onsuccess = () => {
      const all = (req.result || []).sort((a,b)=> (b.ts||0)-(a.ts||0));
      resolve(all.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

/* Monthly */
export async function dbPutMonthly(item){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "monthly", "readwrite");
    const req = store.put(item);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetMonthlyByTechMonth(tech, month){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const store = tx(db, "monthly", "readonly");
    const idx = store.index("byTechMonth");
    const req = idx.getAll([tech, month]);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeleteMonthlyByTechMonth(tech, month){
  const db = await openDB();
  const items = await dbGetMonthlyByTechMonth(tech, month);
  return new Promise((resolve, reject) => {
    const store = tx(db, "monthly", "readwrite");
    let pending = items.length;
    if (!pending) return resolve(true);
    for (const it of items){
      const req = store.delete(it.key);
      req.onsuccess = () => { if (--pending === 0) resolve(true); };
      req.onerror = () => reject(req.error);
    }
  });
}

export async function dbPutMonthlyFile(tech, month, fileObj){
  const db = await openDB();
  const key = `${tech}|${month}`;
  return new Promise((resolve, reject) => {
    const store = tx(db, "monthlyFiles", "readwrite");
    const req = store.put({ key, tech, month, ...fileObj });
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetMonthlyFile(tech, month){
  const db = await openDB();
  const key = `${tech}|${month}`;
  return new Promise((resolve, reject) => {
    const store = tx(db, "monthlyFiles", "readonly");
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* Monthly header */
export async function dbPutMonthlyHeader(tech, month, header){
  const db = await openDB();
  const key = `${tech}|${month}`;
  return new Promise((resolve, reject)=>{
    const store = tx(db, "monthlyHeader", "readwrite");
    const req = store.put({ key, tech, month, ...header, updatedAt: Date.now() });
    req.onsuccess = ()=> resolve(true);
    req.onerror = ()=> reject(req.error);
  });
}
export async function dbGetMonthlyHeader(tech, month){
  const db = await openDB();
  const key = `${tech}|${month}`;
  return new Promise((resolve, reject)=>{
    const store = tx(db, "monthlyHeader", "readonly");
    const req = store.get(key);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> reject(req.error);
  });
}

export async function dbExportAll(){
  const db = await openDB();
  const dump = {};
  for (const name of ["ot", "history", "monthly", "monthlyFiles", "monthlyHeader"]){
    dump[name] = await new Promise((resolve, reject) => {
      const store = tx(db, name, "readonly");
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
  return dump;
}

export async function dbImportAll(dump){
  const db = await openDB();

  if (Array.isArray(dump.history)){
    for (const h of dump.history){
      const { id, ...rest } = h;
      await dbAddHistory(rest);
    }
  }
  if (Array.isArray(dump.ot)){
    for (const o of dump.ot){
      await dbPutOT(o);
    }
  }
  if (Array.isArray(dump.monthly)){
    for (const m of dump.monthly){
      await dbPutMonthly(m);
    }
  }
  if (Array.isArray(dump.monthlyFiles)){
    for (const f of dump.monthlyFiles){
      const { tech, month, filename, mime, dataUrl } = f;
      if (tech && month && dataUrl){
        await dbPutMonthlyFile(tech, month, { filename, mime, dataUrl });
      }
    }
  }
  if (Array.isArray(dump.monthlyHeader)){
    for (const h of dump.monthlyHeader){
      const { tech, month, sampleDate, assignedTech, note } = h;
      if (tech && month){
        await dbPutMonthlyHeader(tech, month, { sampleDate, assignedTech, note });
      }
    }
  }
  return true;
}
