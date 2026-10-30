import Dexie, { type Table } from "dexie";
import { newId } from "./ids";
import type {
  BlobEntry,
  CachedSession,
  CaptureDraft,
  CaptureItem,
  ConflictOut,
  ConsultationData,
  DocumentData,
  EntityName,
  LocalRecord,
  MetaEntry,
  OutboxOp,
  PatientData,
  SearchEntry,
} from "./types";

export const RECORD_TABLES = {
  patient: "patients",
  consultation: "consultations",
  document: "documents",
} as const satisfies Record<EntityName, string>;

export class HCareDB extends Dexie {
  patients!: Table<LocalRecord<PatientData>, string>;
  consultations!: Table<LocalRecord<ConsultationData>, string>;
  documents!: Table<LocalRecord<DocumentData>, string>;
  outbox!: Table<OutboxOp, number>;
  conflicts!: Table<ConflictOut, string>;
  meta!: Table<MetaEntry, string>;
  sessions!: Table<CachedSession, string>;
  search_index!: Table<SearchEntry, string>;
  blobs!: Table<BlobEntry, string>;
  capture_drafts!: Table<CaptureDraft, string>;
  capture_items!: Table<CaptureItem, string>;

  constructor(name = "hcare") {
    super(name);
    this.version(1).stores({
      patients: "id, sync_status, updated_at",
      consultations: "id, sync_status, patient_id, updated_at",
      documents: "id, sync_status, patient_id, updated_at",
      outbox: "++seq, &op_id, entity_id, status",
      conflicts: "id, entity_id, status",
      meta: "key",
      sessions: "username",
      search_index: "entity_id, patient_id, *tokens",
      blobs: "id",
    });
    // Phase 3: capture drafts stay on the device until the clinician saves them.
    this.version(2).stores({
      capture_drafts: "id, patient_id",
      capture_items: "id, draft_id, status, created_at",
    });
    // Phase 5: richer search index. It is derived data, so the old one is simply dropped
    // and rebuilt from the records.
    this.version(3)
      .stores({ search_index: "entity_id, patient_id, *tokens, entity, date" })
      .upgrade((tx) => tx.table("search_index").clear());
  }

  records(entity: EntityName): Table<LocalRecord, string> {
    return this[RECORD_TABLES[entity]] as unknown as Table<LocalRecord, string>;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }

  async deviceId(): Promise<string> {
    return this.transaction("rw", this.meta, async () => {
      const existing = await this.getMeta<string>("device_id");
      if (existing) return existing;
      const id = `dev-${newId()}`;
      await this.setMeta("device_id", id);
      return id;
    });
  }
}
