# Development log

How HCare was built, phase by phase: what was built in each phase, the decisions made, and the problems found and fixed. The finished system is described in [README.md](../README.md), with the measured results in [EVALUATION.md](EVALUATION.md).

## Timeline

| When | Commit | Milestone | Size |
|---|---|---|---|
| 2026-10-30 15:26 | `f149131` | Phases 1–6: data model, offline app, capture, AI structuring, search, history | 108 files, +21,401 lines |
| 2026-10-30 15:41 | `33f309c` | Phase 7: field-by-field conflict resolution | 20 files, +932 |
| 2026-10-30 23:31 | `fc0f29a` | Phase 8: encryption at rest and in transit, lock screen, remote wipe | 46 files, +1,873 |
| 2026-10-30 23:39 | `709618b` | Role-based homes and staff management | 13 files, +694 |
| 2026-10-31 00:01 | `87cb13e` | Hackathon readiness: evaluation, README, demo script and assets (phases 9–11) | 31 files, +1,013 |
| 2026-10-31 00:20 | `3223329` | Zero-to-running setup guide | 3 files, +412 |

Phases 1–6 were built and tested one at a time on the development laptop, then pushed to GitHub together as the first commit.

## Phase 0: Choosing the approach

- **Problem statement:** an offline-first assistant for rural health workers. It turns voice notes and document photos into structured case files that a clinician verifies, keeps a local database with history summaries, and syncs safely. **The sync engine is the core deliverable.**
- **Requirements set:** English, Hindi and some regional languages; Docker available; a hackathon scope.
- **Stack decision:**
  - We first considered Streamlit, then chose a **TypeScript React PWA** with a **FastAPI + PostgreSQL** server.
  - Streamlit runs on a server, so it cannot work offline or run AI on the phone. A PWA can do both.
- **Plan:** 11 phases: data model, offline shell, input capture, AI structuring, storage and search, history summaries, sync engine, security, performance, testing and evaluation, deployment and documentation.

## Phase 1: Requirements and data model

- **Built:**
  - The server data model: users, records, record versions, processed operations, conflicts, audit log.
  - The sync protocol: every change is an operation with a unique `op_id` and the `base_version` it was made from.
  - The design is written up in [PHASE1_DATA_MODEL.md](PHASE1_DATA_MODEL.md).
- **Key decisions:**
  - **Idempotency ledger:** the server saves each applied `op_id` in the same transaction as the change. A retried request gets the stored result back instead of being applied twice.
  - **Version checks:** a change based on an old version is never applied over a newer one. It becomes a stored **conflict** that keeps both versions.
  - **Hash-chained audit log:** each entry includes the hash of the previous one, so tampering is detectable.
- **Tests:** 29 backend tests passing.

## Phase 2: Offline app shell

- **Built:**
  - A React + TypeScript PWA. A service worker caches the app so it opens with no network.
  - Local storage in IndexedDB (Dexie).
  - An **outbox**: each record and its outbox entry are saved in one transaction.
  - Offline sign-in and the Offline / Pending / Synced status badge.
  - The client sync engine, with retries using exponential backoff and jitter, plus a pull cursor for changes from other devices.
- **Key decisions:**
  - **Edits made offline are coalesced** into one outbox entry, but only if that entry was never sent. Once sent, it may already be on the server.
  - **One sync run at a time**, enforced with Web Locks.
  - Entries left in "sending" by an interrupted run are recovered on the next run.
- **Tests:** 44 passing: 29 backend, 13 sync-engine tests against the real server with injected network faults, and 2 in a real browser.

## Phase 3: Input capture

- **Built:**
  - **Voice:** record in the app, or upload an audio file. Whisper (transformers.js) runs in a Web Worker, using WebGPU when available and CPU (WASM) otherwise. Supports English, Hindi and 9 other Indian languages, with optional translation to English.
  - **Documents:** photo or upload. The image is cleaned up on the device (contrast stretch, denoise, deskew, Sauvola thresholding for shadows), then read with Tesseract.js. Low-confidence words are highlighted.
  - **Storage:** photos and recordings are stored locally as source files. The transcript and OCR text are always editable.
- **Key decision:** all AI runs in background workers, so the interface stays responsive on slow phones.

## Phase 4: AI structuring

- **Built:**
  - A **rule-based extractor** for English, Hinglish and Devanagari that runs on any phone and needs no model. It extracts chief complaint, symptoms with durations, vitals, medicines with dose and frequency, allergies, labs and follow-up.
  - **Provenance:** every field records its source, confidence and the exact text it came from. Fields below 60 % confidence must be confirmed before **Verify** is enabled.
  - An **optional on-device LLM** (Qwen2.5) to help with harder notes.
- **Key decision:** negation scoping, so "no fever" is not extracted as a symptom.
- **Problems found and fixed:**
  - **The small LLM copied the example values, listed an allergy as a medicine and invented vitals.** Fixes:
    - a placeholder schema;
    - a grounding check: every item must appear in the source text, or it is dropped and reported;
    - an allergy/medication guard.
  - **The 1.5B model ran out of memory on CPU.** It is now offered only on devices with WebGPU, and is off by default.

## Phase 5: Local storage and search

- **Built:**
  - Offline search by name, ID, symptom, medicine or date, in any language: "bukhar" and "बुखार" find "fever", and "dolo" finds paracetamol.
  - Typo tolerance.
  - Optional search by meaning, with a 22 MB MiniLM model.
- **Problem found and fixed:** one query took **8 seconds**, caused by Dexie `anyOf` on a multi-entry index. Replacing it with one lookup per token brought it to about **6 ms**.
- **Tests:** 88 unit tests and 8 browser tests passing, including the real speech, OCR and embedding models.

## Phase 6: History summaries (RAG)

- **Built:**
  - A patient-history panel: conditions, allergies, current medicines, and trends (BP, haemoglobin) as charts.
  - **Every line links to the visit it came from.**
  - Safety alerts, e.g. a medicine the patient is allergic to.
  - An optional narrative summary that must cite the facts it uses; it is validated before it is shown.
- **Key decision:** the summary is built deterministically from stored facts, so it works on any phone with no model and cannot make up history.
- **Tests:** 101 frontend, 30 backend and the browser tests passing.

## Phase 7: Sync engine conflict resolution (core deliverable)

- **Built:**
  - A **three-way merge**, field by field, using the base version and the two edited versions:
    - Fields changed on only one side merge automatically.
    - Vitals merge one measurement at a time.
    - Lists can be combined.
    - Only real clashes need a person.
  - Every decision is recorded in the audit log.
  - A conflict-resolution screen.
- **Safety rules:**
  - A merge never silently drops an allergy.
  - A verified case file stays verified only if its content is unchanged by the merge. Otherwise it goes back for review.
- **Tests:** create/create, delete/edit and stale-resolution cases, and a two-device conflict in a real browser.

## Phase 8: Security

- **Built:**
  - **Encryption at rest:** AES-256-GCM on every patient field in IndexedDB, plus photos and recordings.
    - The data key is wrapped twice: once by a device secret from the server, and once by a key derived from the user's password (PBKDF2, 210,000 iterations). A shared tablet can unlock for each of its users.
  - **Encryption in transit:** sync payloads are encrypted on top of HTTPS. The server can be set to reject unencrypted payloads.
  - **Blind search index:** search terms are stored as HMAC tokens, so the index reveals no patient words.
  - **Lock screen and auto-lock** after 15 minutes. Too many wrong passwords slow down unlocking, and after 10 the device erases its data.
  - **Remote wipe:** an admin wipes a lost device the next time it connects.
  - **Revocable sessions** and role-based access on the server.
  - Recordings are deleted 30 days after verification.
- **Problems found and fixed:**
  - The badge showed "Synced" before the first sync had run. It now shows "Syncing…" until then.
  - A missing record showed "Loading" forever. It now says the record is not on this device.
- **Details:** [SECURITY.md](SECURITY.md).

## Roles and staff management

- **Requested:** each role should land on its own home page.
- **Built:**
  - **Health worker:** capture and register patients.
  - **Doctor:** a review queue of draft case files to verify.
  - **Admin:** staff accounts, devices with remote wipe, and the audit log with an integrity check.
- **Scope:** one clinic with doctors and health workers. Multi-clinic support was left out.

## Phases 9–11: Performance, evaluation, documentation

- **Evaluation harness:** Playwright drives the real app with labeled test files. It measures word error rate (speech), character error rate (OCR) and field-level precision and recall (extraction).
- **The evaluation found two real problems, both fixed:**
  - **A misheard drug name produced no prescription.** Whisper wrote "paracetamal" and "para-setimal". Near-misses of known drug names are now corrected, at 50 % confidence, so a clinician must confirm them.
  - "3 times a day" written in digits wasn't recognized as a frequency.
- **Results:**

  | Measure | Result |
  |---|---|
  | Speech word error rate (Whisper Base) | 3.6 % |
  | OCR character error rate | 2.1 % |
  | Extraction precision and recall (74 fields) | 100 % / 100 % |
  | Sync fault scenarios | All pass |
  | Search time per query | 1–15 ms |

- **Documentation:** README, demo script, evaluation report, sync engine, security, AI pipeline and setup guide, plus demo files (a voice note, a lab-report photo, a printable report).
- **Correction:** the Node.js requirement is 22.12+, because Vitest 5 does not run on Node 20.
- **Final test count:** 131 frontend, 44 backend and 11 browser tests, all passing. Following the setup guide on a fresh clone from GitHub also worked.

## Other problems along the way

| Problem | Fix |
|---|---|
| A local Windows PostgreSQL already used port 5432, and another project's database used 5433 | The Docker database uses host port 55432 |
| Commit messages written from PowerShell got a byte-order mark | Messages are written to a UTF-8 file without a BOM and committed with `git commit -F` |
| React reused a button, so Edit → Save submitted the form | Gave the two buttons distinct keys |
| Testing offline by turning off Wi-Fi did nothing, because the server runs on localhost | Test by stopping the server and the app preview instead (see [SETUP.md](SETUP.md)) |

## Not done yet

- HTTPS hosting of the server, so devices in different cities can sync.
- Real Hindi and regional-language recordings for the speech evaluation.
- Measurements on a low-cost phone.
- Handwriting OCR, which is weak; the app shows a warning for handwritten notes.
- Data scoping by area, and key rotation.
