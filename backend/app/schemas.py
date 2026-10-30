"""Case file schema (entity payloads) and sync protocol DTOs.

The entity schemas are the server-side backstop: AI output and client edits are
validated again here before anything reaches the central database.
"""

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

Role = Literal["health_worker", "doctor", "admin"]
EntityName = Literal["patient", "consultation", "document"]
WRITE_ROLES: set[str] = {"health_worker", "doctor"}

Str200 = Field(default=None, max_length=200)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- case file parts


class FieldMeta(_Strict):
    """Provenance of one extracted field, keyed by field path e.g. "vitals.bp_systolic"."""

    source: Literal["voice", "ocr", "llm", "rule", "manual"]
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_ref: str | None = None  # SourceRef.id
    verified: bool = False


class SourceRef(_Strict):
    id: str = Field(min_length=1, max_length=64)
    kind: Literal["audio", "image", "text"]
    document_id: UUID | None = None
    language: str | None = Field(default=None, max_length=16)
    excerpt: str | None = Field(default=None, max_length=4000)


class Vitals(_Strict):
    bp_systolic: int | None = Field(default=None, ge=50, le=260)
    bp_diastolic: int | None = Field(default=None, ge=30, le=160)
    pulse: int | None = Field(default=None, ge=20, le=250)
    temperature_c: float | None = Field(default=None, ge=30, le=45)
    spo2: int | None = Field(default=None, ge=50, le=100)
    resp_rate: int | None = Field(default=None, ge=5, le=80)
    weight_kg: float | None = Field(default=None, ge=0.5, le=300)
    height_cm: float | None = Field(default=None, ge=30, le=250)
    blood_glucose_mg_dl: float | None = Field(default=None, ge=20, le=800)


class Symptom(_Strict):
    name: str = Field(min_length=1, max_length=200)
    duration: str | None = Str200
    severity: Literal["mild", "moderate", "severe"] | None = None


class Medication(_Strict):
    name: str = Field(min_length=1, max_length=200)
    dose: str | None = Str200
    frequency: str | None = Str200
    duration: str | None = Str200
    route: str | None = Field(default=None, max_length=50)


class Allergy(_Strict):
    substance: str = Field(min_length=1, max_length=200)
    reaction: str | None = Str200
    severity: Literal["mild", "moderate", "severe"] | None = None


class LabResult(_Strict):
    name: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=50)
    unit: str | None = Field(default=None, max_length=30)
    reference_range: str | None = Field(default=None, max_length=50)


class FollowUp(_Strict):
    due_date: date | None = None
    instructions: str | None = Field(default=None, max_length=2000)


class Review(_Strict):
    status: Literal["draft", "verified", "rejected"] = "draft"
    reviewed_by: str | None = Field(default=None, max_length=36)
    reviewed_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _reviewer_required(self) -> "Review":
        if self.status != "draft" and not (self.reviewed_by and self.reviewed_at):
            raise ValueError("verified/rejected case files need reviewed_by and reviewed_at")
        return self


# ---------------------------------------------------------------- entities


class Patient(_Strict):
    name: str = Field(min_length=1, max_length=200)
    sex: Literal["male", "female", "other", "unknown"] = "unknown"
    date_of_birth: date | None = None
    age_years: int | None = Field(default=None, ge=0, le=130)
    phone: str | None = Field(default=None, max_length=20)
    village: str | None = Str200
    health_id: str | None = Field(default=None, max_length=64)  # e.g. ABHA number
    preferred_language: str | None = Field(default=None, max_length=16)
    known_allergies: list[Allergy] = []
    chronic_conditions: list[str] = []


class Consultation(_Strict):
    """The structured patient case file for one visit."""

    patient_id: UUID
    visit_date: date
    language: str | None = Field(default=None, max_length=16)
    chief_complaint: str | None = Field(default=None, max_length=1000)
    symptoms: list[Symptom] = []
    vitals: Vitals = Vitals()
    diagnosis: list[str] = []
    medications: list[Medication] = []
    allergies: list[Allergy] = []
    lab_results: list[LabResult] = []
    follow_up: FollowUp | None = None
    notes: str | None = Field(default=None, max_length=10000)
    raw_transcript: str | None = Field(default=None, max_length=50000)
    raw_ocr_text: str | None = Field(default=None, max_length=50000)
    sources: list[SourceRef] = []
    field_meta: dict[str, FieldMeta] = {}
    review: Review = Review()


class LowConfidenceSpan(_Strict):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    confidence: float = Field(ge=0, le=1)


class Document(_Strict):
    """A scanned report/note. The image itself stays on the device; its hash is synced."""

    patient_id: UUID
    consultation_id: UUID | None = None
    kind: Literal["lab_report", "prescription", "handwritten_note", "discharge_summary", "other"] = "other"
    mime_type: str | None = Field(default=None, max_length=100)
    captured_at: datetime | None = None
    ocr_text: str | None = Field(default=None, max_length=50000)
    ocr_confidence: float | None = Field(default=None, ge=0, le=1)
    ocr_language: str | None = Field(default=None, max_length=16)
    low_confidence_spans: list[LowConfidenceSpan] = []
    blob_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")


ENTITY_SCHEMAS: dict[str, type[BaseModel]] = {
    "patient": Patient,
    "consultation": Consultation,
    "document": Document,
}


# ---------------------------------------------------------------- auth DTOs


class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: str
    username: str
    role: Role
    full_name: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    role: Role
    full_name: str = ""


# ---------------------------------------------------------------- sync DTOs


class SyncOp(BaseModel):
    op_id: UUID
    entity: EntityName
    entity_id: UUID
    op_type: Literal["upsert", "delete"]
    # Server version the client's edit was based on; 0 means "create".
    base_version: int = Field(ge=0)
    data: dict[str, Any] | None = None
    client_ts: datetime | None = None
    resolves_conflict_id: str | None = None
    # For conflict resolutions: which side won per field, e.g. {"village": "theirs",
    # "allergies": "both"}. Recorded in the audit log so the decision is verifiable.
    resolution: dict[str, Literal["mine", "theirs", "both", "edited", "delete"]] | None = Field(default=None, max_length=200)


class PushRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    ops: list[SyncOp] = Field(max_length=100)


OpStatus = Literal["applied", "conflict", "rejected", "error"]


class OpResult(BaseModel):
    op_id: str
    status: OpStatus
    version: int | None = None
    conflict_id: str | None = None
    error: str | None = None
    # True when this result was served from the idempotency ledger.
    replayed: bool = False


class PushResponse(BaseModel):
    results: list[OpResult]
    server_time: datetime


class Change(BaseModel):
    entity: str
    id: str
    version: int
    data: dict[str, Any] | None
    deleted: bool
    updated_at: datetime
    updated_by: str
    device_id: str
    seq: int


class PullResponse(BaseModel):
    changes: list[Change]
    next_cursor: int
    has_more: bool


class ConflictOut(BaseModel):
    id: str
    entity: str
    entity_id: str
    op_id: str
    op_type: str
    device_id: str
    user_id: str
    status: str
    base_version: int
    base_data: dict[str, Any] | None
    local_data: dict[str, Any] | None
    local_deleted: bool
    server_version: int
    server_data: dict[str, Any] | None
    server_deleted: bool
    # Latest server state, which may have moved on since the conflict was recorded.
    current_version: int
    current_data: dict[str, Any] | None
    current_deleted: bool
    created_at: datetime
    resolved_at: datetime | None
    resolved_by: str | None = None
    resolution_op_id: str | None
    # Per-field decisions of the resolution (from the audit log), once resolved.
    resolution: dict[str, str] | None = None
    superseded_by: str | None


class AuditEntryOut(BaseModel):
    id: int
    ts: str
    user_id: str
    device_id: str
    op_id: str | None
    entity: str | None
    entity_id: str | None
    action: str
    version: int | None
    details: dict[str, Any]
    hash: str


class AuditVerifyOut(BaseModel):
    ok: bool
    checked: int
    first_bad_id: int | None = None
