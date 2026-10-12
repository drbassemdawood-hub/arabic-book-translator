/* Resumable progress, stored in the browser (IndexedDB).
 *
 * Mirrors the desktop app's .translation-state.jsonl / .ocr-cache.jsonl:
 * - a header carrying a content fingerprint, so state from a different book,
 *   an edited source, or a different page count is never reused;
 * - one record per finished passage/page, written the moment it completes —
 *   records may arrive out of order (parallel mode) and nothing paid for is
 *   ever lost, even if the tab is closed mid-run.
 */

const DB_NAME = "book-translator";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("headers")) {
          db.createObjectStore("headers", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("records")) {
          db.createObjectStore("records", { keyPath: ["id", "i"] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/** Progress for one job, identified by e.g. "tr:<fingerprint>" or "ocr:<fingerprint>". */
export class ProgressStore {
  constructor(id, header) {
    this.id = id;
    this.header = header;
  }

  /** Returns { index: text } for every saved record, or {} if the stored
   *  header does not match (different book / settings). */
  async load() {
    const db = await openDb();
    const stored = await reqPromise(tx(db, "headers", "readonly").get(this.id));
    if (!stored || !deepEqual(stored.header, this.header)) return {};
    const range = IDBKeyRange.bound([this.id, -Infinity], [this.id, Infinity]);
    const rows = await reqPromise(tx(db, "records", "readonly").getAll(range));
    const done = {};
    for (const row of rows) done[row.i] = row.text;
    return done;
  }

  async startFresh() {
    const db = await openDb();
    const range = IDBKeyRange.bound([this.id, -Infinity], [this.id, Infinity]);
    await reqPromise(tx(db, "records", "readwrite").delete(range));
    await reqPromise(tx(db, "headers", "readwrite").put({ id: this.id, header: this.header }));
  }

  async append(i, text) {
    const db = await openDb();
    await reqPromise(tx(db, "records", "readwrite").put({ id: this.id, i, text }));
  }

  async delete() {
    const db = await openDb();
    const range = IDBKeyRange.bound([this.id, -Infinity], [this.id, Infinity]);
    await reqPromise(tx(db, "records", "readwrite").delete(range));
    await reqPromise(tx(db, "headers", "readwrite").delete(this.id));
  }
}

/** How many saved translation jobs (any pair) exist for the text with fingerprint `fp`. */
export async function translationJobsFor(fp) {
  const db = await openDb();
  const rows = await reqPromise(tx(db, "headers", "readonly").getAll());
  return rows.filter((r) => String(r.id).startsWith("tr:") && r.header && r.header.fingerprint === fp).length;
}

// ------------------------------------------------------------- fingerprints

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fingerprint of the extracted source text (same idea as the desktop app). */
export async function fingerprintText(text) {
  const hex = await sha256Hex(new TextEncoder().encode(text));
  return hex.slice(0, 16);
}

/** Fingerprint of a file: first 1 MB of bytes + the file size. */
export async function fingerprintFile(file) {
  const head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const combined = new Uint8Array(head.length + sizeBytes.length);
  combined.set(head, 0);
  combined.set(sizeBytes, head.length);
  const hex = await sha256Hex(combined);
  return hex.slice(0, 16);
}

// ------------------------------------------------------------ app settings

const SETTINGS_KEY = "bt.settings";
const API_KEY_KEY = "bt.apiKey";

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage may be unavailable (private mode) — settings just won't stick */
  }
}

export function loadApiKey() {
  try {
    return localStorage.getItem(API_KEY_KEY) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(key, remember) {
  try {
    if (remember && key) localStorage.setItem(API_KEY_KEY, key);
    else localStorage.removeItem(API_KEY_KEY);
  } catch {
    /* ignore */
  }
}
