# Holla backend

Node/Express backend for the **Holla** safety app — a mobile-to-mobile ecosystem (no web app).
It handles identity, phone-based circles, alert fan-out (FCM push + an in-app inbox polling
fallback), and a server-side dead-man's switch. Zero native deps (JSON-file storage).

## Run locally
```bash
npm install
PORT=8099 npm start          # http://localhost:8099
```
Data persists to `$DATA_DIR/db.json` (default `./data`). Delete it to reset.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (used by the keep-alive ping) |
| GET | `/` | service status + whether FCM is configured |
| POST | `/api/register` | `{deviceId, name, phone, fcmToken}` — identity |
| POST | `/api/guardians` | `{deviceId, guardians:[{name,phone}]}` — the user's circle |
| POST | `/api/heartbeat` | `{deviceId, phone, deadline, status, location}` — arms/extends the dead-man timer |
| POST | `/api/alerts` | sender uploads an alert; backend fans out to the circle |
| GET | `/api/inbox?phone=&since=` | alerts addressed to this phone (the in-app receiver inbox) |
| GET | `/api/alerts/:id` | one alert |

Phone numbers are matched forgivingly (NG-aware canonicalization + last-9 fallback), so
`08011112222`, `+2348011112222`, and `0801 111 2222` all resolve to the same person.

## Deploy to Render (1-click Blueprint)
1. Push this repo to GitHub (already `SteveFunso/holla-backend`).
2. On [render.com](https://render.com): **New → Blueprint → connect `SteveFunso/holla-backend`**.
   `render.yaml` provisions a free Node web service with health checks.
3. (Optional, for push) set the env var **`FIREBASE_SERVICE_ACCOUNT`** to your Firebase
   service-account JSON (one line). Without it, the app still works via inbox polling.
4. Your URL will be `https://holla-backend.onrender.com` (or similar). Put it in the app's
   **Settings → Backend URL**.

### Keep-alive
Render's free instance sleeps after ~15 min idle. `.github/workflows/keep-alive.yml` pings
`/health` every 10 minutes from GitHub Actions. After deploy, set a repo **variable** `HEALTH_URL`
to `https://<your-service>.onrender.com/health` (Settings → Secrets and variables → Actions →
Variables), or edit the default in the workflow.

## Enabling FCM push (optional — polling works without it)
1. Create a Firebase project, add an Android app with package `com.holla.app`.
2. Project Settings → Service accounts → **Generate new private key** → download the JSON.
3. Set `FIREBASE_SERVICE_ACCOUNT` (the JSON, as one line) on Render. The server auto-detects it
   and pushes notifications to guardians' devices; otherwise it logs and relies on the inbox.

> Note: the free Render tier has an ephemeral filesystem — `db.json` resets on redeploy/restart.
> Devices re-register on app launch. For durability, attach a Render disk (paid) and point
> `DATA_DIR` at it.
