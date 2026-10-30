/**
 * Transparent field encryption for IndexedDB (Dexie DBCore middleware). Every write path,
 * whether a local save, sync pull, conflict resolution or capture runner, passes through
 * here, so no code can store patient data in clear by mistake. Indexed fields (ids,
 * statuses, dates) stay plaintext so queries keep working; payloads are encrypted.
 */
import type { DBCore, DBCoreCursor, DBCoreTable, Middleware } from "dexie";
import { isEnvelope, LockedError, type Vault } from "./vault";

/** table -> encrypted fields, and the field that identifies the row (bound into the AAD). */
export const ENCRYPTED: Record<string, { fields: string[]; idField: string }> = {
  patients: { fields: ["data", "base_data"], idField: "id" },
  consultations: { fields: ["data", "base_data"], idField: "id" },
  documents: { fields: ["data", "base_data"], idField: "id" },
  outbox: { fields: ["data"], idField: "op_id" },
  conflicts: { fields: ["base_data", "local_data", "server_data", "current_data"], idField: "id" },
  capture_items: { fields: ["transcript", "edited_text", "translation", "ocr_text", "low_confidence_spans"], idField: "id" },
  search_index: { fields: ["text", "embedding", "words"], idField: "entity_id" },
};

type Row = Record<string, unknown>;

function encryptRow(vault: Vault, table: string, row: Row): Row {
  const spec = ENCRYPTED[table];
  const out = { ...row };
  for (const f of spec.fields) {
    const v = row[f];
    if (v === undefined || v === null || isEnvelope(v)) continue;
    out[f] = vault.encrypt(v, `${table}.${f}:${String(row[spec.idField])}`);
  }
  return out;
}

function decryptRow(vault: Vault, table: string, row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const spec = ENCRYPTED[table];
  let out: Row | null = null;
  for (const f of spec.fields) {
    const v = (row as Row)[f];
    if (!isEnvelope(v)) continue;
    if (!vault.unlocked) throw new LockedError();
    out ??= { ...(row as Row) };
    out[f] = vault.decrypt(v, `${table}.${f}:${String((row as Row)[spec.idField])}`);
  }
  return out ?? row;
}

function wrapCursor(vault: Vault, table: string, cursor: DBCoreCursor): DBCoreCursor {
  return Object.create(cursor, {
    value: { get: () => decryptRow(vault, table, cursor.value) },
  });
}

export function encryptionMiddleware(vault: Vault): Middleware<DBCore> {
  return {
    stack: "dbcore",
    name: "hcare-encryption",
    create(down) {
      return {
        ...down,
        table(name: string): DBCoreTable {
          const table = down.table(name);
          if (!ENCRYPTED[name]) return table;
          return {
            ...table,
            mutate(req) {
              if (req.type !== "add" && req.type !== "put") return table.mutate(req);
              if (!vault.unlocked) {
                if (vault.required) return Promise.reject(new LockedError());
                return table.mutate(req);
              }
              return table.mutate({ ...req, values: req.values.map((v) => encryptRow(vault, name, v as Row)) });
            },
            get(req) {
              return table.get(req).then((v) => decryptRow(vault, name, v));
            },
            getMany(req) {
              return table.getMany(req).then((vs) => vs.map((v) => decryptRow(vault, name, v)));
            },
            query(req) {
              return table.query(req).then((res) => (req.values ? { ...res, result: res.result.map((v) => decryptRow(vault, name, v)) } : res));
            },
            openCursor(req) {
              return table.openCursor(req).then((c) => (c && req.values !== false ? wrapCursor(vault, name, c) : c));
            },
          };
        },
      };
    },
  };
}
