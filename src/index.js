import express from "express";
import { store, canonicalPhone } from "./store.js";
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
  // Recipients: explicit list from the app, else the sender device's stored guardian phones.
  let recipients = raw.recipients;
  if (!recipients || recipients.length === 0) {
    const sender = raw.device_id ? store.getDevice(raw.device_id) : null;
    recipients = (sender?.guardians || []).map((g) => g.phone);
  }
  const saved = store.addAlert({ ...raw, recipients });

  // Resolve recipient phones -> registered devices -> FCM tokens.
  const tokens = [];
  for (const phone of saved.recipients) {
    for (const dev of store.resolveByPhone(phone)) {
      if (dev.fcmToken) tokens.push(dev.fcmToken);
    }
  }
  const uniqueTokens = [...new Set(tokens)];
  const label = TRIGGER_LABEL[saved.trigger] || "a safety alert";
  const push = await sendToTokens(
    uniqueTokens,
    { title: `🚨 ${saved.sender_name || "Someone"} needs help`, body: `Detected ${label}. Tap to view location.` },
    { type: "holla_alert", alert_id: saved.alert_id, trigger: saved.trigger },
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

// ---- identity ----
app.post("/api/register", (req, res) => {
  const { deviceId, name, phone, fcmToken } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const dev = store.upsertDevice(deviceId, { name, phone, fcmToken });
  res.json({ ok: true, deviceId: dev.deviceId, phone: dev.phone });
});

// ---- circle (the user's guardians, by phone) ----
app.post("/api/guardians", (req, res) => {
  const { deviceId, guardians } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const dev = store.setGuardians(deviceId, guardians);
  res.json({ ok: true, count: dev.guardians.length });
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

// ---- receiver inbox (the in-app "received alerts" dashboard) ----
app.get("/api/inbox", (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });
  res.json(store.inbox(phone, Number(req.query.since || 0)));
});

app.get("/api/alerts/:id", (req, res) => {
  const a = store.getAlert(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  res.json(a);
});

startDeadmanLoop(dispatchAlert);

app.listen(PORT, () => {
  console.log(`Holla backend listening on :${PORT}`);
});

export { dispatchAlert, canonicalPhone };
