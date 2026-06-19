// JSON-file persistence for the Holla mobile-to-mobile ecosystem.
// Zero native deps. DATA_DIR is configurable (Render disk or ephemeral).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ devices: {}, alerts: [] }, null, 2));
}
function load() {
  ensure();
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return { devices: {}, alerts: [] }; }
}
function save(db) { ensure(); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// --- phone helpers (forgiving NG-aware matching) ---
export function canonicalPhone(p) {
  if (!p) return "";
  let d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = "234" + d.slice(1); // 080... -> 23480...
  else if (d.length === 10) d = "234" + d;                          // 80...  -> 23480...
  return d;
}
export function last9(p) {
  const d = canonicalPhone(p);
  return d.length >= 9 ? d.slice(-9) : d;
}

export const store = {
  upsertDevice(deviceId, patch) {
    const db = load();
    const prev = db.devices[deviceId] || { deviceId, guardians: [] };
    const next = { ...prev, ...patch, updatedTs: Date.now() };
    if (patch.phone !== undefined) {
      next.phone = canonicalPhone(patch.phone);
      next.phoneLast9 = last9(patch.phone);
    }
    db.devices[deviceId] = next;
    save(db);
    return next;
  },

  setGuardians(deviceId, guardians) {
    const db = load();
    const dev = db.devices[deviceId] || { deviceId };
    dev.guardians = (guardians || []).map((g) => ({
      name: g.name || "",
      phone: canonicalPhone(g.phone),
    }));
    dev.updatedTs = Date.now();
    db.devices[deviceId] = dev;
    save(db);
    return dev;
  },

  getDevice(deviceId) { return load().devices[deviceId] || null; },
  allDevices() { return Object.values(load().devices); },

  /** Registered devices whose phone matches (canonical or last-9). */
  resolveByPhone(phone) {
    const c = canonicalPhone(phone), l9 = last9(phone);
    return this.allDevices().filter((d) => d.phone === c || d.phoneLast9 === l9);
  },

  addAlert(alert) {
    const db = load();
    const id = alert.alert_id || `srv_${Date.now()}`;
    const recipients = (alert.recipients || []).map(canonicalPhone).filter(Boolean);
    const record = {
      ...alert,
      alert_id: id,
      recipients,
      recipients_last9: recipients.map((r) => r.slice(-9)),
      received_ts: Date.now(),
    };
    const i = db.alerts.findIndex((a) => a.alert_id === id);
    if (i >= 0) db.alerts[i] = { ...db.alerts[i], ...record };
    else db.alerts.push(record);
    // keep the store bounded
    if (db.alerts.length > 2000) db.alerts = db.alerts.slice(-2000);
    save(db);
    return record;
  },

  /** Alerts addressed to this phone (the receiver inbox). */
  inbox(phone, sinceTs = 0) {
    const c = canonicalPhone(phone), l9 = last9(phone);
    return load()
      .alerts.filter(
        (a) =>
          (a.received_ts || 0) >= sinceTs &&
          ((a.recipients || []).includes(c) || (a.recipients_last9 || []).includes(l9)),
      )
      .sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
  },

  getAlert(id) { return load().alerts.find((a) => a.alert_id === id) || null; },
};
