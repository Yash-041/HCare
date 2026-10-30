# Security and privacy

The problem statement asks for encryption at rest and in transit, role-based access, tamper-evident audit logs, minimal stored personal data, and secure local wipe if a device is lost. This document covers how each one is done, and what isn't.

## Threat model

| Threat | Defence |
|---|---|
| A phone is lost or stolen | All patient data on it is encrypted. It opens only with a user's password. Repeated wrong guesses slow down, then erase the data. An admin can trigger a remote wipe |
| Someone reads the phone's storage directly (USB, a backup, malware without the key) | They find only AES-256-GCM ciphertext, keyed hashes in the search index, and wrapped keys |
| Network interception (a hostile Wi-Fi, a proxy) | HTTPS **plus** payload encryption with a per-session key. A payload is bound to its operation, so it can't be replayed as a different one |
| A stolen or old login token | Tokens are tied to server-side sessions, which are revoked at logout and when a device is wiped. Deactivated users are refused on their next request |
| Someone altering records or history afterwards | Versioned records, an idempotency ledger, and a hash-chained audit log checked by `/audit/verify` |

## Encryption at rest (on the device)

- **Key hierarchy:**
  - A random 256-bit **data key** per device.
  - It is never stored in clear. It's stored only *wrapped* (AES-GCM, WebCrypto) under two keys:
    1. the server's **per-device secret**, which any authorised user receives at an online sign-in, so several health workers can share one clinic tablet; and
    2. each user's **password key** (PBKDF2-SHA256, 210,000 iterations, random salt), for offline sign-in.
  - Offline, the password is checked by unwrapping (2). The device keeps no password hash or verifier.
  - Purpose-specific sub-keys are derived with HKDF: one for records, one for the search index, one for photos and recordings.
- **What is encrypted:**
  - patient, visit and document records, including the server-version copies
  - queued changes (the outbox)
  - conflict copies
  - capture transcripts and OCR text
  - search summaries and embeddings
  - photos and recordings
  - the sign-in token and the session key
- **How it's enforced:** a Dexie (IndexedDB) middleware encrypts the listed fields on *every* write path and decrypts on read. The app runs with `requireEncryption`, so a write while locked *fails* rather than storing plain text.
  - Each ciphertext's AAD names its table, field and record id, so ciphertext copied onto another record is rejected (tested).
  - IndexedDB transactions commit as soon as they're left waiting on a non-IndexedDB promise, so records are encrypted with the audited **synchronous** `@noble/ciphers` AES-GCM inside transactions. Photos, recordings and key handling use **WebCrypto**.
- **Search without readable data:** index tokens are HMAC-SHA256 blind tokens. Equal words still match; prefixes are indexed as hashed prefixes. Typo tolerance uses each record's word list, which is kept encrypted.
  - Search speed with encryption on: 2,000 encrypted patients are indexed in about 0.4 s, and queries take 3–15 ms.
  - **Trade-off:** visit dates stay plaintext in an index column, so date-range filters work. A date alone, with no name attached, reveals very little.
- **Locking:** the app locks on every restart, after 15 minutes without use, and on demand via **Lock**. Keys are held in memory only and zeroed on lock.
- **Existing data:** anything written before encryption existed is encrypted on the first unlock.

## Encryption in transit

- **HTTPS is required:** deployment serves the app and API over HTTPS. Browsers also require it for Service Workers and the microphone.
- **Payload encryption on top:** each login gets a fresh random AES-256-GCM key. The device encrypts every op's `data` with AAD = `op_id`. The server encrypts pulled records (AAD = `entity:id:version`) and conflict copies (AAD = `conflict:id:field`).
- **Tamper detection:** a tampered, replayed or wrong-key payload is rejected for that op only, and the rest of the batch still applies (tested).
- **Strict mode:** in production (`REQUIRE_ENCRYPTED_PAYLOADS=1`, the default in `docker-compose.yml`), plaintext payloads are refused.

## Access control and audit

- **Role-based access:** roles are health worker, doctor and admin. Admins manage users and devices and read the audit log, but can't change clinical records. This is enforced server-side on every op.
- **Tokens:** JWTs carry a session id (`jti`). The server checks the session on every request, so logout and remote wipe revoke access immediately. A forged token without a session is refused (tested).
- **Audit log:** append-only and hash-chained. It records every sync operation (apply, conflict, rejection, duplicate, conflict resolution with its per-field decisions) plus remote-wipe requests and deliveries.

## Lost device and secure wipe

| Mechanism | How |
|---|---|
| **Wipe this device** | Sync screen → **Wipe this device**. It warns how many unsynced changes would be lost and requires typing `WIPE`. It deletes the whole IndexedDB database: records, outbox, photos, recordings, sessions and wrapped keys. App code and AI models stay cached; they hold no patient data |
| **Remote wipe** | Admin → **Devices** → **Report lost & wipe**. The next time that device contacts the server, it gets `410 device_wipe` and erases itself. Its sessions are revoked and it can't sign in again. Both the request and the delivery are audited |
| **Wrong-password limit** | After 5 wrong offline passwords, each further attempt is delayed (30 s, 60 s, …). After 10, local data is erased |
| **Until any wipe happens** | The data stays encrypted, and a thief also needs a user's password |

## Data minimisation

- **Recordings expire:** voice recordings are deleted from the device **30 days after their visit is verified and synced**. The transcript stays in the record. Document photos are kept, because they're part of the medical record.
- **Images are kept small:** they're stored as compressed JPEG, and the original camera file is replaced.
- **The search index holds no readable personal data** (see above).
- **No personal data in logs:** the app doesn't log patient data to the console, and the server's audit log stores who, what, when and which op, but not record contents.

## Not covered (out of scope for the hackathon)

- **Key rotation and re-encryption** of existing data.
- **Hardware-backed keys:** browsers give no access to the phone's secure element.
- **Malware with access to the unlocked app:** this can read what the user can see. That's inherent to any app.
- **Server-side encryption at rest:** it relies on encrypted PostgreSQL storage or volumes at deployment.
- **Deleting already-synced data from the server** when a device is wiped: wipe protects the device. Server records are the clinic's medical record.

## Tests

| Test | What it proves |
|---|---|
| `frontend/tests/crypto.test.ts` | Raw IndexedDB holds only ciphertext. Tampering and moved ciphertext are detected. Locked reads and writes are refused. A wrong key fails. Blobs and transcripts are encrypted. The blind index has no readable words, and search still works and is fast |
| `frontend/tests/sync.e2e.test.ts` | Every sync test runs with encryption required and encrypted payloads against the real server. Also: offline unlock, shared-tablet unlock, wrong-password slowdown and wipe, remote wipe |
| `frontend/tests/retention.test.ts` | Recordings expire after verification; everything else is kept |
| `backend/tests/test_transport.py` | Payload round trip, tampered/replayed/wrong-key rejection, strict mode, logout revocation, remote wipe and its audit trail, forged tokens |
| `frontend/e2e/offline.pw.ts` | In a real browser: reload shows the lock screen, a wrong password is refused, unlocking works offline |
