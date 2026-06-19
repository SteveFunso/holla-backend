// Server-side dead-man's switch. If a device's check-in deadline passes without a "safe"
// heartbeat, the SERVER raises the alert and fans it out to that user's guardians — the only
// path that survives a seized/destroyed/offline phone.
import { store } from "./store.js";

const GRACE_MS = 90_000; // matches the on-device cancel countdown + a network buffer

export function startDeadmanLoop(dispatch, intervalMs = 15_000) {
  setInterval(async () => {
    const now = Date.now();
    for (const device of store.allDevices()) {
      const deadline = device.deadmanDeadline || 0;
      if (deadline > 0 && now > deadline + GRACE_MS && device.deadmanStatus === "armed") {
        store.upsertDevice(device.deviceId, { deadmanStatus: "fired", deadmanDeadline: 0 });
        await dispatch({
          alert_id: `deadman_${device.deviceId}_${deadline}`,
          device_id: device.deviceId,
          sender_name: device.name || "A Holla user",
          sender_phone: device.phone,
          trigger: "timer_missed",
          created_ts: now,
          network: "server",
          note: "Device went dark — missed check-in. Last known location below.",
          location: device.lastLocation || null,
          recipients: (device.guardians || []).map((g) => g.phone),
          server_raised: true,
        });
      }
    }
  }, intervalMs);
}
