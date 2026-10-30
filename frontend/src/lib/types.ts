// Mirrors backend/app/schemas.py. The server re-validates everything.

export type EntityName = "patient" | "consultation" | "document";
export type Role = "health_worker" | "doctor" | "admin";
export type Severity = "mild" | "moderate" | "severe";

// ------------------------------------------------------------------ case file

export interface Allergy {
  substance: string;
  reaction?: string | null;
  severity?: Severity | null;
}

export interface PatientData {
  name: string;
  sex: "male" | "female" | "other" | "unknown";
  date_of_birth?: string | null;
  age_years?: number | null;
  phone?: string | null;
  village?: string | null;
  health_id?: string | null;
  preferred_language?: string | null;
  known_allergies: Allergy[];
  chronic_conditions: string[];
}

export interface Vitals {
  bp_systolic?: number | null;
  bp_diastolic?: number | null;
  pulse?: number | null;
  temperature_c?: number | null;
  spo2?: number | null;
  resp_rate?: number | null;
  weight_kg?: number | null;
  height_cm?: number | null;
  blood_glucose_mg_dl?: number | null;
}

export interface Symptom {
  name: string;
  duration?: string | null;
  severity?: Severity | null;
}

export interface Medication {
  name: string;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
  route?: string | null;
}

export interface LabResult {
  name: string;
  value: string;
  unit?: string | null;
  reference_range?: string | null;
}

export interface FieldMeta {
  source: "voice" | "ocr" | "llm" | "rule" | "manual";
  confidence?: number | null;
  source_ref?: string | null;
  verified?: boolean;
}

export interface SourceRef {
  id: string;
  kind: "audio" | "image" | "text";
  document_id?: string | null;
  language?: string | null;
  excerpt?: string | null;
}

export interface Review {
  status: "draft" | "verified" | "rejected";
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  notes?: string | null;
}

export interface ConsultationData {
  patient_id: string;
  visit_date: string;
  language?: string | null;
  chief_complaint?: string | null;
  symptoms: Symptom[];
  vitals: Vitals;
  diagnosis: string[];
  medications: Medication[];
  allergies: Allergy[];
  lab_results?: LabResult[];
  follow_up?: { due_date?: string | null; instructions?: string | null } | null;
  notes?: string | null;
  raw_transcript?: string | null;
  raw_ocr_text?: string | null;
  sources: SourceRef[];
  field_meta: Record<string, FieldMeta>;
  review: Review;
}

export interface DocumentData {
  patient_id: string;
  consultation_id?: string | null;
  kind: "lab_report" | "prescription" | "handwritten_note" | "discharge_summary" | "other";
  mime_type?: string | null;
  captured_at?: string | null;
  ocr_text?: string | null;
  ocr_confidence?: number | null;
  ocr_language?: string | null;
  low_confidence_spans: { start: number; end: number; confidence: number }[];
  blob_sha256?: string | null;
}

export interface EntityDataMap {
  patient: PatientData;
  consultation: ConsultationData;
  document: DocumentData;
}

// ------------------------------------------------------------------ local storage

/** synced: matches the server · pending: local changes queued · conflict: needs a human · error: rejected by server */
export type RecordSyncStatus = "synced" | "pending" | "conflict" | "error";

export interface LocalRecord<T = unknown> {
  id: string;
  entity: EntityName;
  /** Last server version this device knows about (0 = never synced). */
  version: number;
  data: T | null;
  deleted: boolean;
  updated_at: string;
  updated_by: string;
  device_id: string;
  sync_status: RecordSyncStatus;
  /** Server content at `version`; the "base" side of a three-way diff. */
  base_data: T | null;
  /** Denormalized for indexing consultations/documents by patient. */
  patient_id?: string;
}

export type OutboxStatus = "pending" | "sending" | "conflict" | "rejected";

export interface OutboxOp {
  seq?: number;
  op_id: string;
  entity: EntityName;
  entity_id: string;
  op_type: "upsert" | "delete";
  base_version: number;
  data: unknown | null;
  resolves_conflict_id?: string | null;
  /** Per-field decisions of a conflict resolution, recorded in the server audit log. */
  resolution?: Record<string, string> | null;
  status: OutboxStatus;
  /** Once an op has left the device its payload is frozen: the server may already have applied it. */
  sent_once: boolean;
  retry_count: number;
  next_attempt_at: number;
  last_error?: string | null;
  conflict_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CachedSession {
  username: string;
  user: UserOut;
  token: string;
  token_expires_at: number;
  /** PBKDF2 verifier so the same password can unlock the app offline. */
  salt: string;
  verifier: string;
  iterations: number;
  cached_at: string;
}

export interface MetaEntry {
  key: string;
  value: unknown;
}

/** One row per searchable record. Derived data: always rebuildable from the records. */
export interface SearchEntry {
  entity_id: string;
  entity: EntityName;
  patient_id: string;
  /** Visit date / capture date (YYYY-MM-DD); null for patients. */
  date: string | null;
  /** Normalized words plus tags: "sym:fever", "med:paracetamol", "dx:…", "lab:…", "all:…", "date:…". */
  tokens: string[];
  /** Short English summary used for semantic (embedding) search. */
  text: string;
  text_hash: string;
  embedding?: number[];
  embedded_hash?: string;
}

export interface BlobEntry {
  id: string;
  blob: Blob;
  mime_type: string;
}

// ------------------------------------------------------------------ capture (local only, never synced)

export type CaptureStatus = "queued" | "processing" | "done" | "error";

interface CaptureItemBase {
  id: string;
  draft_id: string;
  blob_id: string;
  mime_type: string;
  created_at: string;
  status: CaptureStatus;
  /** 0..1 while processing. */
  progress?: number | null;
  stage?: string | null;
  error?: string | null;
  /** The clinician's corrected text; starts as the machine output. */
  edited_text: string | null;
}

export interface AudioCaptureItem extends CaptureItemBase {
  kind: "audio";
  duration_s: number | null;
  /** Spoken language chosen by the user; null = let Whisper detect it. */
  language: string | null;
  model: string;
  transcript: string | null;
  translate: boolean;
  translation: string | null;
}

export interface ImageCaptureItem extends CaptureItemBase {
  kind: "image";
  doc_kind: DocumentData["kind"];
  /** Tesseract language string, e.g. "eng+hin". */
  ocr_langs: string;
  processed_blob_id: string | null;
  skew_deg: number | null;
  ocr_text: string | null;
  confidence: number | null;
  low_confidence_spans: { start: number; end: number; confidence: number }[];
  sha256: string | null;
}

export type CaptureItem = AudioCaptureItem | ImageCaptureItem;

export interface CaptureDraft {
  /** One open draft per patient: id = patient id. */
  id: string;
  patient_id: string;
  language: string;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------------ protocol

export interface UserOut {
  id: string;
  username: string;
  role: Role;
  full_name: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: UserOut;
}

export interface WireOp {
  op_id: string;
  entity: EntityName;
  entity_id: string;
  op_type: "upsert" | "delete";
  base_version: number;
  data: unknown | null;
  client_ts?: string;
  resolves_conflict_id?: string | null;
  resolution?: Record<string, string> | null;
}

export interface OpResult {
  op_id: string;
  status: "applied" | "conflict" | "rejected" | "error";
  version: number | null;
  conflict_id: string | null;
  error: string | null;
  replayed: boolean;
}

export interface PushResponse {
  results: OpResult[];
  server_time: string;
}

export interface Change {
  entity: EntityName;
  id: string;
  version: number;
  data: unknown | null;
  deleted: boolean;
  updated_at: string;
  updated_by: string;
  device_id: string;
  seq: number;
}

export interface PullResponse {
  changes: Change[];
  next_cursor: number;
  has_more: boolean;
}

export interface ConflictOut {
  id: string;
  entity: EntityName;
  entity_id: string;
  op_id: string;
  op_type: "upsert" | "delete";
  device_id: string;
  user_id: string;
  status: "open" | "resolved" | "superseded";
  base_version: number;
  base_data: unknown | null;
  local_data: unknown | null;
  local_deleted: boolean;
  server_version: number;
  server_data: unknown | null;
  server_deleted: boolean;
  current_version: number;
  current_data: unknown | null;
  current_deleted: boolean;
  created_at: string;
  resolved_at: string | null;
  resolved_by?: string | null;
  resolution_op_id: string | null;
  resolution?: Record<string, string> | null;
  superseded_by: string | null;
}
