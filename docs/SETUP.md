# HCare: complete setup guide (from zero to running)

This guide takes **any laptop** (Windows, macOS or Linux) from nothing installed to:

- the app running, offline mode included,
- a demo patient with history,
- every feature tried once,
- optionally, the full test suite and the evaluation.

**Time:** about 20–30 minutes the first time, mostly downloads.
**Commands:** shown for **Windows (PowerShell)** and **macOS / Linux** where they differ. Run every command from the folder it says.

---

## Contents

0. [What you are setting up](#0-what-you-are-setting-up)
1. [Install the tools](#1-install-the-tools)
2. [Get the code](#2-get-the-code)
3. [Start the server (Docker)](#3-start-the-server-docker)
4. [Start the app](#4-start-the-app)
5. [First sign-in, roles and staff accounts](#5-first-sign-in-roles-and-staff-accounts)
6. [Prepare for offline use (download the AI models)](#6-prepare-for-offline-use-download-the-ai-models)
7. [Tour: a full patient visit](#7-tour-a-full-patient-visit)
8. [Offline, sync and conflicts](#8-offline-sync-and-conflicts)
9. [Security features](#9-security-features)
10. [Use it on a phone (optional)](#10-use-it-on-a-phone-optional)
11. [Run the tests and the evaluation (optional)](#11-run-the-tests-and-the-evaluation-optional)
12. [Run the server without Docker (optional)](#12-run-the-server-without-docker-optional)
13. [Everyday use: stop, start, update, reset](#13-everyday-use-stop-start-update-reset)
14. [Configuration](#14-configuration)
15. [Troubleshooting](#15-troubleshooting)
16. [Where to read more](#16-where-to-read-more)

---

## 0. What you are setting up

```
 Laptop
 ├── Docker
 │    ├── backend   FastAPI sync server           → http://localhost:8000
 │    └── db        PostgreSQL 16                 → localhost:55432
 └── Node.js
      └── frontend  the web app (PWA), served by Vite → http://localhost:4173  (or :5173 in dev mode)
                    talks to the backend through /api
```

- The **app runs in the browser**. All AI (speech, OCR, extraction, search) runs inside the browser, on the device.
- The **server** is only needed for sign-in the first time and for syncing. Everything else works offline.

**Hardware:**
- 8 GB RAM or more.
- About 4 GB of free disk: Docker images ~1 GB, `node_modules` ~0.6 GB, AI models in the browser ~150 MB, plus the test browser.
- **Browser:** Google Chrome or Microsoft Edge, recent. Other browsers are untested.

---

## 1. Install the tools

| Tool | Version | Needed for |
|---|---|---|
| **Git** | any recent | getting the code |
| **Docker Desktop** | 4.x or newer | the server and database |
| **Node.js** | **22.12 or newer** (22 LTS or 24 recommended) | the app (Node 20 is too old for the test tools) |
| **Google Chrome** or **Edge** | recent | using the app |
| **Python** | 3.12 or newer | **only** to run tests, the evaluation, or the server without Docker |

### Windows

1. **Git:** https://git-scm.com/download/win (accept the defaults).
2. **Docker Desktop:** https://www.docker.com/products/docker-desktop.
   - The installer sets up **WSL 2**; allow it and restart when asked.
   - If it says virtualization is disabled, enable *Intel VT-x / AMD-V* in the BIOS.
3. **Node.js:** https://nodejs.org → **LTS** installer (22.x or newer).
4. **Python** (optional): https://www.python.org/downloads/. **Tick "Add python.exe to PATH"** on the first screen.

Or, from an administrator PowerShell, all at once:

```powershell
winget install Git.Git Docker.DockerDesktop OpenJS.NodeJS.LTS Python.Python.3.12
```

### macOS

```bash
# with Homebrew (https://brew.sh)
brew install git node python@3.12
brew install --cask docker google-chrome
```

Then open **Docker** from Applications once, so it starts its engine.

### Linux (Ubuntu / Debian)

- **Docker Engine + Compose plugin:** follow https://docs.docker.com/engine/install/ubuntu/, then:

  ```bash
  sudo usermod -aG docker $USER
  ```

  Log out and back in afterwards.
- **Node.js 22:** https://github.com/nodesource/distributions. Or use `nvm install 22`.
- **Git and Python:**

  ```bash
  sudo apt install git python3 python3-venv
  ```

### Check everything

Open a **new** terminal (so PATH changes apply) and run:

```bash
git --version
docker --version
docker compose version     # must print a version (Compose v2)
node --version             # must be v22.12 or higher
npm --version
python --version           # optional; macOS/Linux: python3 --version
```

> **Start Docker Desktop now** and wait until it says *Engine running*: the whale icon in the Windows tray or the macOS menu bar. On Linux the service runs on its own.

---

## 2. Get the code

```bash
git clone https://github.com/Yash-041/HCare.git
cd HCare
```

Everything below assumes you start in this `HCare` folder.

---

## 3. Start the server (Docker)

### 3.1 Build and start

```bash
docker compose up -d --build
```

The first run takes 2–5 minutes (it downloads Python and PostgreSQL images and installs dependencies). Later runs take seconds.

### 3.2 Check it is running

```bash
docker compose ps
```

Both `backend` and `db` should be **running / healthy**. Then open:

- http://localhost:8000/health. It should show `{"status":"ok", ...}`.
- http://localhost:8000/docs for the interactive API documentation (optional).

### 3.3 Load the demo patient

This creates **Kamla Devi**, with three earlier visits, so the history, trends and allergy alert have something to show:

```bash
docker compose exec backend python -m app.seed_demo
```

It prints `Seeded Kamla Devi with 3 earlier visits`. Running it again is harmless.

> The demo **user accounts** (step 5) are created automatically when the server starts.

---

## 4. Start the app

Open a **second terminal** in the `HCare` folder.

### 4.1 Install the app's dependencies (first time, and after each `git pull`)

```bash
cd frontend
npm ci
```

`npm ci` installs the exact tested versions from `package-lock.json`. It takes 1–2 minutes and prints `added … packages`. Warnings about funding or deprecated packages are normal.

### 4.2 Build and serve it (recommended)

```bash
npm run build
npx vite preview
```

Open **http://localhost:4173** in Chrome.

> **Why build?** Offline mode depends on a *Service Worker*, which exists only in the built app. Use this mode for demos and for trying offline.

### 4.3 Dev mode (only if you're changing the code)

```bash
npm run dev          # http://localhost:5173, reloads instantly when you edit files
```

Everything works in dev mode **except** loading the app while offline.

**Leave this terminal running.** Stop the app with **Ctrl + C**.

---

## 5. First sign-in, roles and staff accounts

### 5.1 Demo accounts

| Username | Password | Role | Lands on |
|---|---|---|---|
| `asha` | `asha1234` | Health worker | **Patients**: register patients, record visits, sync |
| `doctor` | `doctor123` | Doctor | **Patients** + **Waiting for your review** (case files to verify) + **Audit log** |
| `admin` | `admin123` | Admin | **Staff**, **Devices** and **Audit log**. No patient screens: admins can't edit medical records |

> **The first sign-in on a browser must be online.** It downloads the account and sets up the encryption key on that device. After that, the same person can sign in **offline**.

### 5.2 Add a real doctor or health worker

1. Sign in as `admin` → **Staff** → **Add a doctor or health worker**.
2. Enter their full name, role, a username, and a temporary password (8+ characters) → **Add**.
3. Give them the username and password. They sign in once, online, on their own phone or laptop.

On the same screen the admin can:
- **change a role**,
- **reset a password** (they're signed out everywhere),
- **deactivate** an account (their devices are cut off at their next sync).

Every change is recorded in the **Audit log**.

---

## 6. Prepare for offline use (download the AI models)

The AI runs on the device, so its models must be downloaded **once, while online**. Sign in as `asha`, then:

1. Open any patient (e.g. **Kamla Devi**) → **+ New consultation**.
2. Open the **Offline AI models** panel at the top:
   - **Speech model:** keep **Whisper Base** (~80 MB) → **Download**.
     - Use *Whisper Small* (~250 MB) for better Hindi and regional languages on a powerful laptop.
     - Use *Whisper Tiny* (~45 MB) on a weak device.
   - **Document reading (OCR)** for the visit language → **Download**.
     - If you'll work in Hindi, set **Visit language** to Hindi first. That downloads English + Hindi OCR.
   - Wait until the panel shows **Ready offline**.
3. **Optional, smart search:** home screen → **Filters** → tick **Smart search** (22 MB). It lets search find related wording, e.g. "breathing problem" finds "breathlessness".
4. **Optional, on-device language model:** only on laptops or phones whose browser supports **WebGPU**. In a case file, tick **Also use the on-device AI model** → **Download now** (~1.1 GB). Without WebGPU the option is hidden, and the built-in rule extractor is used. That's the default and works everywhere.

Models are stored in the browser and survive restarts. They're needed again only if you clear the site data.

---

## 7. Tour: a full patient visit

Sign in as `asha` (online or offline).

1. **Search:** type `bukhar` (Hindi for fever) in the search box. Kamla Devi's earlier fever visit appears. Try `बुखार`, `dolo` (finds paracetamol) or a date like `2026-10`.
2. **Patient history:** open **Kamla Devi**. The **Patient history** panel shows:
   - her **Penicillin allergy**,
   - **Hypertension**,
   - medicines,
   - BP and haemoglobin **trends** (tap a point on a chart),
   - a date chip on every line that opens the visit it came from.
3. **New visit:** **+ New consultation**.
   - **Voice:** tap **🎙 Record voice note** and speak, or **Upload audio file** → `docs/demo-assets/voice-note-fever.wav`. The transcript appears after a few seconds; correct it if needed.
   - **Document:** **Upload image** → `docs/demo-assets/lab-report-photo.png`, or **📷 Take photo** of the printout `docs/demo-assets/lab-report-printable.pdf`.
     - The photo is straightened.
     - Uncertain words are highlighted.
     - **Show cleaned image** shows what the OCR read.
4. **Save & structure case file.** The fields fill in automatically: symptoms, vitals, medicines, allergies, lab values.
   - Each field shows a chip such as **Rule · 90 % · Voice note 1**. **Click it** to see the exact sentence it came from.
   - Fields below 60 % confidence must be **confirmed** before verifying.
5. Edit anything that's wrong. The field turns **Edited**. Then **Verify & save**.
6. Sign in as `doctor` in another browser profile. The **Waiting for your review** list shows draft case files from health workers.

---

## 8. Offline, sync and conflicts

### 8.1 Work offline

1. With the app open at http://localhost:4173, **go offline**: turn off Wi-Fi, or DevTools (F12) → **Network** → *No throttling* → **Offline**.
2. **Reload.** The app still loads and shows **Locked**. Enter the password; this works offline.
3. Add a patient or record a visit. The badge shows **Offline · N pending**.
4. **Go back online.** The badge goes **Syncing… → Synced** within a few seconds.

### 8.2 Create and resolve a conflict

You need two "devices": two **Chrome profiles** (profile icon → *Add*), or one normal and one **Guest** window.

1. **Device A:** sign in as `asha`. **Device B:** sign in as `doctor`. Both open the **same patient**; wait for **Synced** on both.
2. Put **both offline**.
3. On A, edit the patient: change **Village** and **Phone** → Save.
4. On B, edit the same patient: change **Village** to something else, and **Age** → Save.
5. Bring **A** online (it syncs first), then **B**.
6. B shows **Conflict · 1** and a banner → **Sync** → **Review & resolve**:
   - **Village** was changed on both, so it's the only real clash: choose a value.
   - **Phone** and **Age** were each changed on one side, so they merged automatically.
7. **Apply merge** → **Synced**.
   - **Recently resolved** on the Sync screen lists the decisions.
   - Device A receives the merged record at its next sync.

---

## 9. Security features

- **Encrypted on the device:** all patient data in the browser is encrypted (AES-256-GCM).
  - The app **locks** on every restart and after **15 minutes** idle, and with **Lock** in the top bar.
  - Unlocking needs the password, and works offline.
- **Wrong passwords:** after 5 wrong attempts the app slows down. After 10, the patient data on that device is **erased**.
- **Wipe this device:** **Sync** → **Security** → **Wipe this device** (type `WIPE` to confirm).
- **Lost phone:** sign in as `admin` → **Devices** → **Report lost & wipe**. The phone erases its data the next time it connects.
- **Audit log:** sign in as `admin` → **Audit log** → **Check integrity** shows ✓ Intact.

Details: [SECURITY.md](SECURITY.md).

---

## 10. Use it on a phone (optional)

Browsers allow the Service Worker, the microphone and the camera only on **HTTPS** or **localhost**. Opening `http://192.168.x.x:4173` from a phone loads the page, but offline mode and the microphone won't work. Use one of these:

**A. USB (Android + Chrome; no internet needed)**

1. On the phone: **Settings → About → tap Build number 7 times** → **Developer options → USB debugging: on**. Connect the phone by USB and accept the prompt.
2. On the laptop, in Chrome: open `chrome://inspect/#devices` → **Port forwarding…** → add **`4173`** → **`localhost:4173`** → tick **Enable port forwarding** → **Done**.
3. On the phone, open Chrome at **http://localhost:4173**.
4. Optional: Chrome menu → **Add to Home screen** to install it like an app.

**B. HTTPS tunnel (any phone; needs internet on the laptop)**

1. Install **cloudflared**: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. With `npx vite preview` running:

   ```bash
   cloudflared tunnel --url http://localhost:4173
   ```

3. Open the printed `https://<random>.trycloudflare.com` address on the phone.

---

## 11. Run the tests and the evaluation (optional)

### 11.1 One-time setup

Set up the server's Python environment. The app's tests also use it to start a throwaway server.

```bash
cd backend
python -m venv .venv
```

| Windows (PowerShell) | macOS / Linux |
|---|---|
| `.venv\Scripts\Activate.ps1` | `source .venv/bin/activate` |

```bash
pip install -r requirements-dev.txt
cd ../frontend
npx playwright install chromium        # the test browser (~150 MB)
```

> **Windows:**
> - If activation is blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. Or skip activating and use `.venv\Scripts\python.exe -m pip …`.
> - If `python` opens the Microsoft Store, use `py` instead.

### 11.2 Server tests (pytest)

```bash
cd backend
pytest                                  # temporary SQLite database; ~44 tests
```

To run against the Docker PostgreSQL instead (needs `docker compose up -d`):

| Windows (PowerShell) | macOS / Linux |
|---|---|
| `$env:TEST_DATABASE_URL="postgresql+psycopg://hcare:hcare@localhost:55432/hcare_test"; pytest` | `TEST_DATABASE_URL=postgresql+psycopg://hcare:hcare@localhost:55432/hcare_test pytest` |

### 11.3 App tests

These start their own server on ports **8765** and **8001**, and the app on **4173**. Stop `npx vite preview` first, because it uses port 4173.

```bash
cd frontend
npm test              # ~131 unit/integration tests: sync engine vs. a real server, encryption, AI extraction, search…
npm run test:e2e      # ~11 browser tests: offline reload, two-device conflict, search, history, roles
```

The tests that download the real AI models are opt-in:

| What | Windows (PowerShell) | macOS / Linux |
|---|---|---|
| Real speech, OCR and embedding models (~130 MB) | `$env:HCARE_E2E_AI="1"; npm run test:e2e` | `HCARE_E2E_AI=1 npm run test:e2e` |
| Also the 1.1 GB on-device LLM (WebGPU only; opens a visible browser) | `$env:HCARE_E2E_AI="1"; $env:HCARE_E2E_LLM="1"; npm run test:e2e` | `HCARE_E2E_AI=1 HCARE_E2E_LLM=1 npm run test:e2e` |

### 11.4 Evaluation (accuracy numbers)

```bash
cd frontend
npx vitest run tests/extraction-eval.test.ts --silent=false     # case-file extraction precision/recall table
```

Speech word error rate, OCR character error rate and timing (writes `docs/eval/results.json`):

| Windows (PowerShell) | macOS / Linux |
|---|---|
| `$env:HCARE_EVAL="1"; npx playwright test e2e/evaluation.pw.ts` | `HCARE_EVAL=1 npx playwright test e2e/evaluation.pw.ts` |

**To measure your own language** (e.g. Hindi):
1. Put recordings in `frontend/e2e/eval-data/speech/` as pairs: `name.wav` plus `name.txt`, holding exactly what was said.
2. Add `HCARE_EVAL_LANG=hi` to the evaluation command.

Results and methods: [EVALUATION.md](EVALUATION.md).

---

## 12. Run the server without Docker (optional)

With the Python environment from 11.1:

```bash
cd backend
uvicorn app.main:create_app --factory --reload      # http://localhost:8000, data in backend/hcare.db (SQLite)
python -m app.seed_demo                              # demo patient, as in step 3.3
```

The app (step 4) works the same way.

---

## 13. Everyday use: stop, start, update, reset

| Task | Command / action |
|---|---|
| Stop the server | `docker compose down` (data is kept) |
| Start it again | `docker compose up -d` |
| Stop the app | **Ctrl + C** in the `npx vite preview` terminal |
| Start it again | `cd frontend` → `npx vite preview` |
| **Update to the latest code** | `git pull` → `docker compose up -d --build` → `cd frontend` → `npm ci` → `npm run build` → `npx vite preview`. In the browser, click **Update** on the "new version available" message |
| Reset the **server** data | `docker compose down -v` → `docker compose up -d --build` → seed again (step 3.3) |
| Reset **one browser's** data | Sign in → **Sync** → **Security** → **Wipe this device**. Or DevTools → **Application** → **Storage** → **Clear site data** (this also removes downloaded models) |
| See server logs | `docker compose logs -f backend` |
| Remove everything | `docker compose down -v --rmi local` and delete the `HCare` folder |

> **Before wiping or clearing a browser**, make sure the badge says **Synced**. Changes that haven't synced are lost.

---

## 14. Configuration

Server settings are environment variables, set in `docker-compose.yml` under `backend → environment`:

| Variable | Default | Meaning |
|---|---|---|
| `JWT_SECRET` | dev value | Signs sign-in tokens. **Set a long random value for any shared deployment** |
| `DATABASE_URL` | Postgres in Docker; SQLite file without Docker | SQLAlchemy database URL |
| `SEED_DEMO_USERS` | `1` | Create the demo accounts. Set to `0` in a real deployment |
| `REQUIRE_ENCRYPTED_PAYLOADS` | `1` in Docker, `0` otherwise | Refuse sync data that isn't encrypted by the app |
| `JWT_TTL_HOURS` | `168` | How long a sign-in lasts (7 days, for long offline periods) |
| `CORS_ORIGINS` | `*` | Allowed origins if the app is served from another host |

App settings:

| Variable | Default | Meaning |
|---|---|---|
| `HCARE_API_TARGET` | `http://localhost:8000` | Where the Vite server forwards `/api` (dev and preview) |
| `VITE_API_URL` | `/api` | API address built into the app |

Ports used: **8000** (server) · **55432** (database) · **4173** (app) · **5173** (dev mode) · **8001, 8765** (tests only).

---

## 15. Troubleshooting

| Problem | Fix |
|---|---|
| `docker compose` says *failed to connect to the docker API* / *Cannot connect to the Docker daemon* | Docker Desktop isn't running. Start it and wait for *Engine running*. On Linux: `sudo systemctl start docker` |
| *port is already allocated* (8000 or 55432) | Another program uses that port. Stop it, or change the **left** number under `ports:` in `docker-compose.yml` (e.g. `"8080:8000"`), then set `HCARE_API_TARGET=http://localhost:8080` before `npx vite preview` |
| `npm ci` fails or tests say *Unsupported engine* | Node.js is too old. Install **Node 22.12+**, open a new terminal, and run `npm ci` again |
| Sign-in shows *Sign-in failed* | The server isn't reachable. Check http://localhost:8000/health and `docker compose ps` |
| *No connection, and this user has never signed in on this device* | The first sign-in on each browser must be **online** (step 5) |
| The app shows **Locked** | Expected after a reload or 15 minutes idle. Enter the password (works offline) |
| *Too many wrong attempts. Try again in N seconds* | Protection against password guessing. Wait, then use the right password. Ten wrong attempts erase that device's local data |
| Badge stays **Syncing…** or **Server unreachable** | The server is down or unreachable. Run `docker compose ps`; restart with `docker compose up -d`. Nothing is lost: changes wait in the outbox |
| Badge shows **Sign in to sync** | The account's session expired or was changed by an admin. **Sign out** and sign in while online |
| **Conflict · 1** badge | Two devices changed the same record. Go to **Sync** → **Review & resolve** (step 8.2) |
| Speech or OCR stuck on *Loading speech model* while offline | Models weren't downloaded yet. Go online and download them (step 6) |
| Transcription slow the first time | The first run loads the model (~20–30 s on a laptop). Later clips take a few seconds |
| Microphone or camera doesn't work on a phone | The page isn't on HTTPS or localhost. Use step 10 |
| *On-device AI model* option missing | That browser has no WebGPU. Expected; the rule-based extraction is used |
| App looks old after `git pull` | Rebuild (step 13), then click **Update** in the app, or close every tab of the app and reopen it |
| `npm test` says *backend venv not found* | Create `backend/.venv` and install requirements (step 11.1) |
| Tests fail with *port 4173 already in use* | Stop `npx vite preview` before running `npm run test:e2e` |
| Windows: `python` opens the Microsoft Store | Use `py` instead of `python`, or reinstall Python with *Add to PATH* ticked |
| Windows: scripts are blocked when activating `.venv` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| macOS: `docker: command not found` | Open the Docker app once from Applications so it installs its command-line tools |

---

## 16. Where to read more

| Document | What's in it |
|---|---|
| [../README.md](../README.md) | Project overview, architecture diagram, results |
| [DEMO.md](DEMO.md) | 7-minute presentation script, checklist, fallbacks |
| [SYNC_ENGINE.md](SYNC_ENGINE.md) | How sync guarantees no loss, no duplicates, no silent overwrites, and the conflict workflow |
| [SECURITY.md](SECURITY.md) | Encryption, lock screen, wipe, audit log, threat model |
| [AI_PIPELINE.md](AI_PIPELINE.md) | Speech, OCR, extraction, search and history: how they work and why |
| [EVALUATION.md](EVALUATION.md) | Measured accuracy and speed, with caveats |
| [PHASE1_DATA_MODEL.md](PHASE1_DATA_MODEL.md) | Data model and sync protocol |
