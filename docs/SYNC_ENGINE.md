# Sync engine

The primary deliverable. This document covers how offline changes reach the central database **without being lost, duplicated or silently overwritten**, and how conflicts get resolved in a way anyone can check afterwards.

## Guarantees and where they're proven

| Guarantee | How | Proven by |
|---|---|---|
| No offline change is lost | Each save writes the record **and** its outbox op in one IndexedDB transaction. An op leaves the outbox only after the server acknowledges it | `sync.e2e.test.ts`: offline capture; `offline.pw.ts`: reload and sign-in while offline |
| Retries never duplicate | Every op has a client-generated UUID `op_id`. The server records it in an idempotency ledger **in the same transaction** as the change, and replays the stored result when the op is resent | `test_sync.py`: duplicate op, lost ack, partial batch; `sync.e2e.test.ts`: "lost acknowledgment" |
| A sent op is never changed | An op that has left the device once (`sent_once`) is frozen. Later edits become new ops | `sync.e2e.test.ts`: "edit after a send attempt…" |
| No false conflicts with yourself | **Version chaining:** once an op is applied at version *v*, any queued op for the same record that was based on the same version is re-based on *v* | `sync.e2e.test.ts`: "edit made while a push is in flight" |
| Concurrent edits are detected, never overwritten | Each op carries `base_version`. A stale one is stored as a conflict holding base, mine and theirs; the server record is left untouched | `test_sync.py`: concurrent edits, create/create, delete/edit |
| A conflicted record stops syncing | Later ops for that record are held back until it's resolved. Other records keep syncing | `sync.e2e.test.ts`: "holds back"; `test_sync.py`: "does not block others" |
| A pull never clobbers local edits | Records with queued ops ignore incoming versions. The push reports the conflict instead | `sync.e2e.test.ts`: "pull does not overwrite…" |
| Pulls never skip a change | A global sequence number is assigned under a lock, so commit order equals sequence order. Clients pull with a cursor | `test_sync.py`: cursor pagination |
| Ordering | The outbox sends oldest first, at most one op per record per batch. A patient is always created before its visits | `test_sync.py` and `sync.e2e.test.ts`: ordering |
| Retry with backoff | Delays of 1 s, 2 s, 4 s… up to 5 minutes, with ±20% jitter. Ops interrupted mid-send (crash, closed tab) are resent with the same `op_id` | `sync.e2e.test.ts`: network down |
| Every operation is audited | Append-only, hash-chained log recording who, what, when, which device and which op. Tampering is detectable through `/audit/verify` | `test_security.py`: audit chain |

## Protocol

```
POST /sync/push  { device_id, ops: [{ op_id, entity, entity_id, op_type, base_version, data,
                                       resolves_conflict_id?, resolution? }] }
             →   { results: [{ op_id, status: applied|conflict|rejected|error, version, conflict_id, replayed }] }
GET  /sync/pull?since=<cursor>        → changes ordered by sequence, next_cursor, has_more
GET  /sync/conflicts?status=open|resolved&device_id=…
GET  /sync/conflicts/{id}             → base, mine, server-at-conflict-time, current server, resolution
```

## Conflict resolution workflow

1. **Detection.** The server answers `conflict`. The device marks the record **Conflict** and fetches the three versions. A banner appears on the home screen, and the badge reads *Conflict · N*.
2. **Three-way merge** ([merge.ts](../frontend/src/lib/merge.ts)) compares *base* (the version both edits started from), *mine* (this device, including later local edits) and *theirs* (the current server version), field by field:
   - **Changed on one side only:** merged automatically. Example: phone changed on device A, age on device B.
   - **Changed on both sides, differently:** a clash. A person must choose *this device*, *server*, or, for lists, *combine both*.
   - **Vitals merge per value**, so BP from one device and weight from the other both survive.
   - **Allergy safety rule:** no merge, automatic or suggested, drops an allergy. If a result would lose one, the field becomes a clash with *combine both* suggested, and the clinician must say explicitly that it was recorded in error.
   - **Verification integrity:** a merged case file keeps a side's *verified* status only if its clinical content equals exactly what was verified. Otherwise it goes back to *draft* for re-verification, and the resolver warns about this.
   - Field provenance follows each decision. Source references from both sides are kept.
3. **Resolution.** **Apply merge** is enabled only once every clash is decided and the merged record passes validation. The merge is sent as a new op with:
   - `base_version` = the current server version
   - `resolves_conflict_id` set to the conflict
   - `resolution` = the per-field decisions, e.g. `{"village": "mine", "phone": "theirs", "known_allergies": "both"}`

   If the server moved on again in the meantime, the resolution itself conflicts and the old conflict is marked **superseded**. Nothing is lost.
4. **Verification.** The server writes a `resolve_conflict` audit entry with the decisions and the resolver's identity, inside the hash chain. `GET /sync/conflicts/{id}` returns them, and the **Sync** screen lists recently resolved conflicts with each field's outcome.
5. **Record-level conflicts** (deleted on one device, edited on the other) get a separate choice: delete it, or keep the edited record.

## Try it

[SETUP.md](SETUP.md) section 5 has the demo steps. The scripted version is `e2e/offline.pw.ts`: two browsers edit the same patient offline, one field clashes, two merge automatically, the clash is resolved, and both devices end up with the same merged record, with the decision visible from the audit log.
