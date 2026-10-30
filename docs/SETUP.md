# Setting up HCare on a new laptop

These steps take a fresh Windows, macOS or Linux machine to a running app, then optionally to a full test run. Expect about 15 minutes, most of it downloads.

Commands are shown for **Windows (PowerShell)** and **macOS / Linux** where they differ.

---

## 1. Install the tools

| Tool | Version | Needed for | Download |
|---|---|---|---|
| Git | any | getting the code | https://git-scm.com/downloads |
| Docker Desktop | 4.x or newer | backend + database | https://www.docker.com/products/docker-desktop |
| Node.js | 20 or newer (we use 24) | the web app | https://nodejs.org (LTS) |
| Google Chrome | recent | running the app; WebGPU for the optional on-device LLM | https://www.google.com/chrome |
| Python | 3.12 or newer | **only** for running tests or the backend without Docker | https://www.python.org/downloads |

Check that they're installed:

```bash
git --version
docker --version
node --version     # v20 or higher
npm --version
python --version   # optional; on macOS/Linux it may be python3
```

> **Windows:** when installing Python, tick **"Add python.exe to PATH"**.
> **Docker Desktop must be running** (whale icon in the system tray / menu bar) before step 3.

---

## 2. Get the code

```bash
git clone https://github.com/Yash-041/HCare.git
cd HCare
```

---

## 3. Start the backend (API + PostgreSQL)

From the `HCare` folder:

```bash
docker compose up -d --build
```

The first run downloads images and builds, which takes 2–5 minutes. Then check it's up:

- Open http://localhost:8000/health. It should show `{"status":"ok", ...}`.
- Interactive API docs are at http://localhost:8000/docs.

Containers this starts:

| Container | Port on your laptop | What it is |
|---|---|---|
| `backend` | **8000** | FastAPI sync server |
| `db` | **55432** | PostgreSQL 16. The unusual port avoids clashing with a PostgreSQL already installed on your machine |

To stop: `docker compose down`. To stop **and delete all server data**: `docker compose down -v`.

---

## 4. Start the web app

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** in Chrome. API calls go to `/api`, which the dev server forwards to the backend on port 8000.

### Demo accounts

| Username | Password | Role |
|---|---|---|
| `asha` | `asha1234` | health worker |
| `doctor` | `doctor123` | doctor |
| `admin` | `admin123` | admin: manages users and the audit log; cannot edit patient records |

Each role lands on its own home screen:

- **Health worker:** patients, capture and sync.
- **Doctor:** the same, plus **Waiting for your review** (draft case files to verify) and the audit log.
- **Admin:** **Staff**, **Devices** and **Audit log** only.

**To add a real doctor or health worker:**

1. Sign in as `admin`.
2. Open **Staff** → **Add a doctor or health worker**, and give the person their username and temporary password.
3. They sign in once while online on their own device. After that they can also sign in offline.

From the same screen the admin can change a role, reset a password, or deactivate an account. Deactivation cuts off that person's devices at their next sync.

---

## 5. Try offline mode

Offline support comes from a Service Worker, which only exists in a **production build**:

```bash
# still inside frontend/
npm run build
npx vite preview
```

Open **http://localhost:4173** and do the following:

1. **Sign in while online.** That first sign-in is what enables later offline sign-ins on this device.
2. **Download the AI models while online.** Open a patient → **+ New consultation** → **Offline AI models** → **Download** for both the speech model and OCR.
3. Optionally, on the home screen open **Filters** → tick **Smart search** (a 22 MB model).
4. **Go offline:** open Chrome DevTools (F12) → **Network** tab → change *No throttling* to **Offline**. Turning off Wi-Fi works too.
5. Reload the page. The app still loads.
6. Add a patient, record a voice note or scan a document, and save the case file. The top-right badge shows **Offline · N pending**.
7. **Go back online.** The badge changes to **Synced** within a few seconds.

To demo a conflict, open the app in two different Chrome profiles (or one normal and one Incognito window). Edit the same patient in both while offline, then reconnect both. The second device to sync shows **Conflict**; resolve it on the **Sync** screen.

---

## 6. Use it on a phone (optional)

Service Workers, the microphone and on-device encryption only work over **HTTPS** or on **localhost**. Plain `http://192.168.x.x` from a phone won't work. There are two easy options:

**A. USB port forwarding (Android + Chrome, no internet needed)**

1. On the phone, enable **Developer options → USB debugging**, then connect it to the laptop by USB.
2. On the laptop, open `chrome://inspect/#devices` in Chrome → **Port forwarding…** → add `4173` → `localhost:4173` → tick **Enable port forwarding**.
3. With `npx vite preview` running, open **http://localhost:4173** in Chrome on the phone.

**B. HTTPS tunnel (any phone, needs internet)**

1. Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. With `npx vite preview` running, run `cloudflared tunnel --url http://localhost:4173`.
3. Open the printed `https://….trycloudflare.com` address on the phone.

---

## 7. Run the tests (optional)

### Backend (pytest)

```bash
cd backend
python -m venv .venv
```

Activate the environment:

| Windows (PowerShell) | macOS / Linux |
|---|---|
| `.venv\Scripts\Activate.ps1` | `source .venv/bin/activate` |

> If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or skip activating and call `.venv\Scripts\python.exe` directly.

```bash
pip install -r requirements-dev.txt
pytest                                   # uses a temporary SQLite database
```

To run the same tests against the Docker PostgreSQL (with `docker compose up -d` running):

| Windows (PowerShell) | macOS / Linux |
|---|---|
| `$env:TEST_DATABASE_URL="postgresql+psycopg://hcare:hcare@localhost:55432/hcare_test"; pytest` | `TEST_DATABASE_URL=postgresql+psycopg://hcare:hcare@localhost:55432/hcare_test pytest` |

### Frontend

The frontend tests start their own throwaway backend, so **the backend virtual environment above (`backend/.venv`) must exist**. Docker doesn't need to be running.

```bash
cd frontend
npm test                          # unit + sync-engine tests against the real API
npx playwright install chromium   # once
npm run test:e2e                  # browser tests: offline mode, conflicts, search, history
```

The tests that use real AI models download them, so they're opt-in:

| What | Windows (PowerShell) | macOS / Linux |
|---|---|---|
| Speech, OCR and embeddings (~100 MB) | `$env:HCARE_E2E_AI="1"; npm run test:e2e` | `HCARE_E2E_AI=1 npm run test:e2e` |
| Also the on-device LLM (1.1 GB, needs WebGPU, opens a visible browser window) | `$env:HCARE_E2E_AI="1"; $env:HCARE_E2E_LLM="1"; npm run test:e2e` | `HCARE_E2E_AI=1 HCARE_E2E_LLM=1 npm run test:e2e` |

---

## 8. Running the backend without Docker (optional)

Set up the virtual environment as in step 7, then:

```bash
cd backend
uvicorn app.main:create_app --factory --reload
```

This uses a local SQLite file (`backend/hcare.db`) instead of PostgreSQL. The web app works the same way.

---

## Configuration

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `JWT_SECRET` | backend / `docker-compose.yml` | dev value | **Change for any shared deployment.** Signs login tokens |
| `DATABASE_URL` | backend | SQLite file | SQLAlchemy URL, e.g. `postgresql+psycopg://…` |
| `SEED_DEMO_USERS` | backend | `1` | Create the demo accounts on start |
| `CORS_ORIGINS` | backend | `*` | Allowed origins if the app is served from another host |
| `HCARE_API_TARGET` | frontend dev/preview server | `http://localhost:8000` | Where `/api` is forwarded |
| `VITE_API_URL` | frontend build | `/api` | API base URL baked into the build |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `docker compose` says *"failed to connect to the docker API"* | Docker Desktop isn't running. Start it and wait for "Engine running" |
| *"port is already allocated"* for 8000 or 55432 | Another program uses that port. Stop it, or change the left-hand number under `ports:` in `docker-compose.yml` |
| App shows **Locked** after a reload | Expected: patient data is encrypted and the app locks on every restart and after 15 minutes idle. Enter the password; this works offline |
| Phone lost or stolen | Sign in as `admin` → **Sync** → **Manage devices** → **Report lost & wipe**. See [SECURITY.md](SECURITY.md) |
| Sign-in fails with *"Sign-in failed"* | The backend isn't reachable. Check http://localhost:8000/health and that `npm run dev` / `vite preview` is running |
| *"No connection, and this user has never signed in on this device"* | Offline sign-in needs one successful **online** sign-in on that browser first |
| The app looks outdated after pulling new code | Click **Update** on the "new version available" toast. Or in DevTools → **Application → Storage → Clear site data** (this also deletes local patient data that hasn't synced) |
| Voice or OCR stuck on "Loading model…" offline | Models must be downloaded once while online (step 5.2) |
| Microphone button errors on a phone | The page isn't on HTTPS or localhost. See step 6 |
| On-device LLM option is missing | Expected on browsers without WebGPU. Rule-based extraction works everywhere |
| `npm test` fails with *"backend venv not found"* | Create `backend/.venv` and install requirements (step 7) |
| Reset everything | `docker compose down -v` (server) and **Clear site data** in Chrome (device) |
