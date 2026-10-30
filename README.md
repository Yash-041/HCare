# HCare — Offline-first clinical assistant

Offline-first PWA for rural health workers: voice notes and document scans become structured, clinician-verified case files that sync safely to a central server.

| Part | Stack |
|---|---|
| `backend/` | FastAPI, SQLAlchemy, PostgreSQL. Contains the sync engine (idempotent ops, versioning, conflicts, hash-chained audit log). |
| `frontend/` | React, TypeScript, Vite PWA, Dexie (IndexedDB). Contains the offline app shell and the client sync engine (outbox, retries, conflicts). |
| `docs/` | Design docs. Start with [PHASE1_DATA_MODEL.md](docs/PHASE1_DATA_MODEL.md). |

**New laptop? Follow [docs/SETUP.md](docs/SETUP.md)** for step-by-step setup, offline demo, phone access, tests and troubleshooting.

## Run the backend

With Docker (PostgreSQL plus the API on http://localhost:8000; API docs at `/docs`):

```bash
docker compose up -d --build
```

Without Docker (uses SQLite):

```bash
cd backend
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements-dev.txt
uvicorn app.main:create_app --factory --reload
```

## Run the frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 ; /api is proxied to the backend on :8000
```

The Service Worker only exists in a production build. To try offline mode:

```bash
npm run build && npx vite preview    # http://localhost:4173
```

Open the app once while online and sign in. Then turn on airplane mode, or tick "Offline" in DevTools → Network, and reload. The app still loads, sign-in works, and saved changes queue up until the connection returns.

On a phone, Service Workers and WebCrypto need HTTPS, or `localhost` if you use USB port forwarding.

Demo users (seeded when `SEED_DEMO_USERS=1`):

| Username | Password | Role |
|---|---|---|
| `asha` | `asha1234` | health worker |
| `doctor` | `doctor123` | doctor |
| `admin` | `admin123` | admin |

## Tests

```bash
cd backend
pytest                                   # SQLite
# against PostgreSQL (start the db with: docker compose up -d db)
TEST_DATABASE_URL=postgresql+psycopg://hcare:hcare@localhost:55432/hcare_test pytest
```

Frontend tests start the real backend automatically (they need `backend/.venv`):

```bash
cd frontend
npm test             # TypeScript sync engine vs. the real API, with network faults injected
npm run test:e2e     # Playwright in Chromium: offline reload, offline sign-in, two-device conflict
```

The tests cover these sync scenarios:

- duplicate ops
- a lost acknowledgment
- a batch cut off partway
- concurrent edits from two devices
- merge resolution
- a stale resolution that is superseded
- two devices creating the same record
- a delete that conflicts with an edit
- pull pagination and ordering
- validation and role-based access
- detecting tampering in the audit log
