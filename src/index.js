import express from "express";
import { store, canonicalPhone, canonicalId } from "./store.js";
import { sendToTokens, fcmEnabled } from "./fcm.js";
import { startDeadmanLoop } from "./deadman.js";

const app = express();
const PORT = process.env.PORT || 8099;
app.use(express.json({ limit: "256kb" }));

const TRIGGER_LABEL = {
  dead_man: "missed check-in",
  timer_missed: "missed check-in",
  fall: "a fall / hard impact",
  acoustic: "acoustic distress (scream/gunshot/glass)",
  voice: "a distress shout",
  duress_word: "a duress word",
  panic_button: "a panic alert",
};

/**
 * Core fan-out used by both /api/alerts and the server-side dead-man switch.
 * Stores the alert (addressed to the sender's guardian phones) and pushes FCM to any
 * guardians who have Holla installed. The receiver app also polls /api/inbox as a fallback.
 */
async function dispatchAlert(raw) {
  // Recipients: explicit Holla ID list from the app, else the sender device's stored guardians.
  let recipients = raw.recipients;
  if (!recipients || recipients.length === 0) {
    const sender = raw.device_id ? store.getDevice(raw.device_id) : null;
    recipients = (sender?.guardians || []).map((g) => g.hollaId).filter(Boolean);
  }
  const saved = store.addAlert({ ...raw, recipients, live: !raw.cancelled });

  // Resolve recipient Holla IDs -> registered devices -> FCM tokens.
  const tokens = [];
  for (const rid of saved.recipients) {
    for (const dev of store.resolveById(rid)) {
      if (dev.fcmToken) tokens.push(dev.fcmToken);
    }
  }
  const uniqueTokens = [...new Set(tokens)];
  const label = TRIGGER_LABEL[saved.trigger] || "a safety alert";
  const isTest = typeof saved.note === "string" && /\b(test|drill)\b/i.test(saved.note);
  const push = await sendToTokens(
    uniqueTokens,
    isTest
      ? { title: `🧪 Test from ${saved.sender_name || "someone"}`, body: `Drill: ${label}. No action needed.` }
      : { title: `🚨 ${saved.sender_name || "Someone"} needs help`, body: `Detected ${label}. Tap to view location.` },
    { type: "holla_alert", alert_id: saved.alert_id, trigger: saved.trigger, is_test: String(isTest) },
  );

  const loc = saved.location ? `${saved.location.lat},${saved.location.lng}` : "no location";
  console.log(
    `🚨 ALERT ${saved.trigger} from "${saved.sender_name}" -> ${saved.recipients.length} guardian(s), ` +
    `${uniqueTokens.length} device(s); push sent=${push.sent ?? 0}; ${loc}`,
  );
  return saved;
}

// ---- status (no web app; JSON only) ----
app.get("/", async (_req, res) =>
  res.json({ service: "holla-backend", status: "ok", fcm: await fcmEnabled() }),
);
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- identity (Holla ID is the shareable identity; phone is optional profile info) ----
app.post("/api/register", (req, res) => {
  const { deviceId, name, phone, hollaId, fcmToken } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const dev = store.upsertDevice(deviceId, { name, phone, hollaId, fcmToken });
  res.json({ ok: true, deviceId: dev.deviceId, hollaId: dev.hollaId });
});

// ---- circle (the user's guardians, by Holla ID) ----
app.post("/api/guardians", (req, res) => {
  const { deviceId, guardians } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const dev = store.setGuardians(deviceId, guardians);
  res.json({ ok: true, count: dev.guardians.length });
});

// ---- lookup: does this Holla ID exist? (used by the app to validate circle additions) ----
app.get("/api/resolve", (req, res) => {
  const matches = store.resolveById(req.query.id);
  res.json({ found: matches.length > 0, name: matches[0]?.name || null });
});

// ---- dead-man heartbeat ----
app.post("/api/heartbeat", (req, res) => {
  const { deviceId, name, phone, deadline, status, location } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const patch = { lastHeartbeat: Date.now() };
  if (name) patch.name = name;
  if (phone) patch.phone = phone;
  if (location) patch.lastLocation = location;
  if (typeof deadline === "number") { patch.deadmanDeadline = deadline; patch.deadmanStatus = "armed"; }
  if (status === "safe" || status === "cancel") { patch.deadmanDeadline = 0; patch.deadmanStatus = "safe"; }
  store.upsertDevice(deviceId, patch);
  res.json({ ok: true });
});

// ---- alert ingest (sender uploads outbox) ----
app.post("/api/alerts", async (req, res) => {
  const raw = req.body || {};
  if (!raw.device_id && !raw.alert_id) return res.status(400).json({ error: "alert payload required" });
  if (raw.device_id) {
    store.upsertDevice(raw.device_id, {
      name: raw.sender_name,
      phone: raw.sender_phone,
      lastLocation: raw.location || undefined,
    });
  }
  const saved = await dispatchAlert(raw);
  res.json({ ok: true, alert_id: saved.alert_id, recipients: saved.recipients.length });
});

// ---- receiver inbox (the in-app "received alerts" dashboard), addressed by Holla ID ----
app.get("/api/inbox", (req, res) => {
  const id = req.query.id || req.query.phone; // ?phone= kept for old clients
  if (!id) return res.status(400).json({ error: "id required" });
  res.json(store.inbox(id, Number(req.query.since || 0)));
});

app.get("/api/alerts/:id", (req, res) => {
  const a = store.getAlert(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});

// ---- live incident feed: the sender streams location points + ambient transcript lines ----
app.post("/api/incident", (req, res) => {
  const { alert_id, device_id, location, transcript, ts } = req.body || {};
  if (!alert_id) return res.status(400).json({ error: "alert_id required" });
  const a = store.getAlert(alert_id);
  if (!a) return res.status(404).json({ error: "unknown alert" });
  if (device_id && a.device_id && a.device_id !== device_id) return res.status(403).json({ error: "not your alert" });
  const updated = store.appendIncident(alert_id, { location, transcript, ts });
  res.json({ ok: true, live: !!updated?.live });
});

// ---- stand down: the sender ends the live session; the circle is told they're OK ----
app.post("/api/alerts/:id/cancel", async (req, res) => {
  const { device_id } = req.body || {};
  const result = store.endAlert(req.params.id, device_id);
  if (result === "forbidden") return res.status(403).json({ error: "not your alert" });
  if (!result) return res.status(404).json({ error: "not found" });
  // Tell the circle the session is over.
  const tokens = [];
  for (const rid of result.recipients || []) {
    for (const dev of store.resolveById(rid)) {
      if (dev.fcmToken) tokens.push(dev.fcmToken);
    }
  }
  await sendToTokens(
    [...new Set(tokens)],
    { title: `✅ ${result.sender_name || "Someone"} stood down`, body: "The alert session has ended — they've marked themselves OK." },
    { type: "holla_alert_ended", alert_id: result.alert_id },
  );
  res.json({ ok: true });
});

startDeadmanLoop(dispatchAlert);

app.listen(PORT, () => {
  console.log(`Holla backend listening on :${PORT}`);
});

export { dispatchAlert, canonicalPhone };
