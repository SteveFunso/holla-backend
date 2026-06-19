// Firebase Cloud Messaging sender. Lazily initialized and gracefully disabled when no
// credentials are present — the app still works via the in-app inbox polling fallback.
// Provide credentials via FIREBASE_SERVICE_ACCOUNT (the service-account JSON as a string)
// or GOOGLE_APPLICATION_CREDENTIALS (path to the JSON file).
let adminMod = null;
let ready = false;
let tried = false;

async function init() {
  if (tried) return ready;
  tried = true;
  const hasCred = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!hasCred) {
    console.log("[fcm] no credentials set — push disabled, inbox polling still active");
    return false;
  }
  try {
    adminMod = (await import("firebase-admin")).default;
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT
      ? adminMod.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      : adminMod.credential.applicationDefault();
    adminMod.initializeApp({ credential });
    ready = true;
    console.log("[fcm] initialized");
  } catch (e) {
    console.warn("[fcm] init failed:", e.message);
    ready = false;
  }
  return ready;
}

function strData(data) {
  return Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)]));
}

export async function sendToTokens(tokens, notification, data) {
  const list = (tokens || []).filter(Boolean);
  if (!(await init()) || list.length === 0) return { sent: 0, skipped: list.length };
  try {
    const res = await adminMod.messaging().sendEachForMulticast({
      tokens: list,
      notification, // { title, body }
      data: strData(data),
      android: { priority: "high" },
    });
    return { sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.warn("[fcm] send failed:", e.message);
    return { sent: 0, error: e.message };
  }
}

export async function fcmEnabled() {
  return init();
}
