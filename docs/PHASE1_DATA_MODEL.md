# Phase 1: Requirements and data model

## 1. User roles

| Role | Can do | Cannot do |
|---|---|---|
| `health_worker` | Register patients, record consultations, scan documents, edit and verify draft case files, resolve conflicts on records they touched | Read the audit log, manage users |
| `doctor` | Everything a health worker can, plus read the audit log | Manage users |
| `admin` | Manage users, read and verify the audit log | Change clinical records (enforced by the server on every op) |

The server checks roles on every request. A user who is deactivated while their device is offline is refused at the next sync, even though their token has not expired.

## 2. Case file schema

Source of truth: [backend/app/schemas.py](../backend/app/schemas.py). The frontend will mirror it with Zod.

There are three synced entities. Each is identified by a UUID generated on the device.

**patient**: `name`, `sex`, `date_of_birth` / `age_years`, `phone`, `village`, `health_id` (ABHA), `preferred_language`, `known_allergies[]`, `chronic_conditions[]`

**consultation** (the case file for one visit):

| Field | Notes |
|---|---|
| `patient_id`, `visit_date`, `language` | |
| `chief_complaint` | |
| `symptoms[]` | name, duration, severity |
| `vitals` | Each value is range-checked. For example, `temperature_c` must be 30–45, which catches a Fahrenheit value typed into a Celsius field. |
| `diagnosis[]`, `medications[]` (name, dose, frequency, duration, route), `allergies[]` | |
| `follow_up` | due_date, instructions |
| `notes` | |
| `raw_transcript`, `raw_ocr_text` | The unedited AI input, kept for verification |
| `sources[]` | References to audio or image inputs, with id, kind, document_id, language and an excerpt |
| `field_meta{}` | Keyed by field path (e.g. `vitals.bp_systolic`). Holds `source` (voice/ocr/llm/rule/manual), `confidence`, `source_ref` and `verified`. |
| `review` | `draft` / `verified` / `rejected`. A case file cannot be verified or rejected without `reviewed_by` and `reviewed_at`. |

**document**: `patient_id`, `consultation_id`, `kind`, `mime_type`, `captured_at`, `ocr_text`, `ocr_confidence`, `ocr_language`, `low_confidence_spans[]`, `blob_sha256`. The image itself stays on the device. Only its hash and the OCR text are synced, which keeps sync payloads small on 2G connections.

Every schema rejects unknown fields (`extra="forbid"`). If the LLM invents a field, the payload is rejected rather than stored.

## 3. Central schema (PostgreSQL)

Defined in [backend/app/models.py](../backend/app/models.py).

| Table | Purpose |
|---|---|
| `records` | Current state of each entity: `entity, id, version, data (JSONB), deleted, updated_at, updated_by, device_id, seq`. Deleted records are kept as tombstones. |
| `record_versions` | Every version ever written. Supplies the common ancestor (base) for three-way merges, and the record history. |
| `processed_ops` | Idempotency ledger: `op_id` mapped to the stored result. |
| `conflicts` | Base, local and server versions. Status is open, resolved or superseded. |
| `audit_log` | Append-only and hash-chained: who, what, when, which device, which op. |
| `sync_counter` | A single row, locked at the start of every write. It orders the change sequence and the audit chain. |
| `users` | Passwords hashed with PBKDF2-SHA256 (210k iterations). |

## 4. Local schema (IndexedDB, via Dexie), implemented in Phase 2

```ts
patients       : id, version, data, deleted, updated_at, updated_by, device_id, sync_status, base_data
consultations  : (same fields) + index on data.patient_id, data.visit_date
documents      : (same fields) + blob (the image; never synced)
outbox         : ++seq, op_id, entity, entity_id, op_type, base_version, data,
                 status, retry_count, next_attempt_at, last_error, conflict_id, created_at
conflicts      : id, entity, entity_id, base_data, local_data, server_data, ... (copied from the server)
search_index   : entity_id, patient_id, tokens[], embedding (Float32Array)
meta           : key -> value   (device_id, pull_cursor, cached_session, key-derivation salt)
```

`sync_status` is one of `synced`, `pending`, `conflict` or `error`. It drives the status badge in the UI.

`version` on a local record means *the last server version this device knows about*. `base_data` is that server version's content, kept so the conflict screen can show what changed.

## 5. Sync protocol

### `POST /sync/push`

Request:

```json
{ "device_id": "...", "ops": [ { "op_id": "uuid", "entity": "patient", "entity_id": "uuid",
  "op_type": "upsert|delete", "base_version": 3, "data": {...}, "resolves_conflict_id": null } ] }
```

The response has one result per op:

| `status` | Meaning | What the client does |
|---|---|---|
| `applied` | Saved, and the record is now at `version` | Mark the op done and set the record's version |
| `conflict` | `base_version` was stale. The server copy is untouched and a conflict was stored | Hold back further ops on this record and show the diff |
| `rejected` | Failed validation or authorization. It will never succeed | Mark the op failed and show the error |
| `error` | A temporary server problem | Retry with backoff |

`replayed: true` means the result came from the idempotency ledger and nothing was re-applied.

### Server rules (per op, in one transaction)

1. Lock `sync_counter`. Writes are serialized, so seq order equals commit order and the audit chain stays linear.
2. If `op_id` is in `processed_ops`, return the stored result and log `duplicate_ignored`.
3. Check the user's role and validate the payload against the entity schema. If either fails, the op is `rejected`.
4. If `base_version` equals the server version, apply the change, increment the version, assign the next `seq`, and write a `record_versions` row.
   Otherwise, store a conflict and leave the record unchanged.
5. Write the audit entry and the `processed_ops` row **in the same transaction** as the change.

Step 5 is what makes retries safe. If a response is lost after the server committed, the client resends and gets the original result back.

### `GET /sync/pull?since=<cursor>&limit=N`

Returns records changed after `since`, ordered by `seq`, plus `next_cursor` and `has_more`. Because `seq` is assigned while the lock is held, a pull can never skip a change that commits late.

### Conflict resolution

`GET /sync/conflicts/{id}` returns `base_data`, `local_data`, `server_data`, and the current server state.

The user picks **keep mine**, **keep server**, or **merge field by field**. Fields changed on only one side can be pre-merged automatically. The client then pushes a normal upsert with:

- `base_version` set to the current server version
- `resolves_conflict_id` set to the conflict's id

That push creates a new version, marks the conflict `resolved`, and is audited. If the server moved on again in the meantime, the resolution itself conflicts and the old conflict is marked `superseded`.

## 6. Client outbox rules (Phase 2)

1. **Save locally and write the outbox entry together.** Every local save writes the record and its outbox op in one IndexedDB transaction.
2. **Coalesce edits.** If the last op for the same record has never left the device (`sent_once = false`), replace its data instead of adding a second op. It keeps its original `base_version`. An op that was sent even once is frozen, because the server may already have applied it.
3. **Send in order.** Ops go out in `seq` order, in batches of up to 50. A create for a patient therefore always goes before that patient's consultations.
4. **Mark ops done only after the server confirms.** On a network failure, the whole batch is retried with the same op_ids, with exponential backoff and jitter (1s, 2s, 4s… capped at 5 minutes).
5. **Chain versions.** When an op is applied at version *v*, any later queued op for the same record gets `base_version = v`.
6. **Hold back after a conflict.** Once a record has an open conflict, its later ops are not sent until the conflict is resolved.
7. **Pulling must not overwrite unsynced edits.** If a record has pending ops, the server copy is only used to detect conflicts. It does not replace the local edit.
8. **Order of a sync run.** Push first, then pull from `meta.pull_cursor`, then fetch any open conflicts for this device.
