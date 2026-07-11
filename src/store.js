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

// --- Holla ID: the user's shareable identity (8-char alphanumeric, unambiguous charset) ---
export function canonicalId(v) {
  if (!v) return "";
  return String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// --- legacy phone helper (phone is now optional profile info, not identity) ---
export function canonicalPhone(p) {
  if (!p) return "";
  let d = String(p).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = "234" + d.slice(1); // 080... -> 23480...
  else if (d.length === 10) d = "234" + d;                          // 80...  -> 23480...
  return d;
}

const TRAIL_CAP = 300;      // location points kept per alert
const TRANSCRIPT_CAP = 500; // transcript lines kept per alert

export const store = {
  upsertDevice(deviceId, patch) {
    const db = load();
    const prev = db.devices[deviceId] || { deviceId, guardians: [] };
    const next = { ...prev, ...patch, updatedTs: Date.now() };
    if (patch.phone !== undefined) next.phone = canonicalPhone(patch.phone);
    if (patch.hollaId !== undefined) next.hollaId = canonicalId(patch.hollaId);
    db.devices[deviceId] = next;
    save(db);
    return next;
  },

  setGuardians(deviceId, guardians) {
    const db = load();
    const dev = db.devices[deviceId] || { deviceId };
    dev.guardians = (guardians || []).map((g) => ({
      name: g.name || "",
      hollaId: canonicalId(g.hollaId || g.holla_id),
    })).filter((g) => g.hollaId);
    dev.updatedTs = Date.now();
    db.devices[deviceId] = dev;
    save(db);
    return dev;
  },

  getDevice(deviceId) { return load().devices[deviceId] || null; },
  allDevices() { return Object.values(load().devices); },

  /** Registered devices whose Holla ID matches. */
  resolveById(hollaId) {
    const c = canonicalId(hollaId);
    if (!c) return [];
    return this.allDevices().filter((d) => d.hollaId === c);
  },

  addAlert(alert) {
    const db = load();
    const id = alert.alert_id || `srv_${Date.now()}`;
    const recipients = (alert.recipients || []).map(canonicalId).filter(Boolean);
    const record = {
      ...alert,
      alert_id: id,
      recipients,
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

  /** Live incident feed: append a location point and/or a transcript line to an alert. */
  appendIncident(alertId, { location, transcript, ts }) {
    const db = load();
    const a = db.alerts.find((x) => x.alert_id === alertId);
    if (!a) return null;
    if (a.ended_ts) return a; // session was stood down — ignore late posts
    const when = typeof ts === "number" ? ts : Date.now();
    if (location && typeof location.lat === "number" && typeof location.lng === "number") {
      a.trail = a.trail || [];
      a.trail.push({ lat: location.lat, lng: location.lng, ts: when });
      if (a.trail.length > TRAIL_CAP) a.trail = a.trail.slice(-TRAIL_CAP);
      a.location = { ...(a.location || {}), lat: location.lat, lng: location.lng, fix_ts: when,
        maps_url: `https://maps.google.com/?q=${location.lat},${location.lng}` };
    }
    if (transcript && String(transcript).trim()) {
      a.transcript = a.transcript || [];
      a.transcript.push({ text: String(transcript).trim().slice(0, 500), ts: when });
      if (a.transcript.length > TRANSCRIPT_CAP) a.transcript = a.transcript.slice(-TRANSCRIPT_CAP);
    }
    a.live = true;
    a.last_update_ts = Date.now();
    save(db);
    return a;
  },

  /** Sender stands the alert down — the circle stops seeing a live session. */
  endAlert(alertId, deviceId) {
    const db = load();
    const a = db.alerts.find((x) => x.alert_id === alertId);
    if (!a) return null;
    if (deviceId && a.device_id && a.device_id !== deviceId) return "forbidden";
    a.live = false;
    a.ended_ts = Date.now();
    save(db);
    return a;
  },

  /** Alerts addressed to this Holla ID (the receiver inbox). */
  inbox(hollaId, sinceTs = 0) {
    const c = canonicalId(hollaId);
    return load()
      .alerts.filter(
        (a) =>
          ((a.received_ts || 0) >= sinceTs || (a.last_update_ts || 0) >= sinceTs) &&
          (a.recipients || []).includes(c),
      )
      .sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0))
      .map((a) => ({
        ...a,
        // keep inbox payloads small: recent tail only
        trail: (a.trail || []).slice(-40),
        transcript: (a.transcript || []).slice(-12),
      }));
  },

  getAlert(id) { return load().alerts.find((a) => a.alert_id === id) || null; },
};
