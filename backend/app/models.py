"""Central (PostgreSQL) schema.

Clinical data lives in a generic versioned record store keyed by (entity, id), so the
sync engine treats patients, consultations and documents identically. The shape of
`data` per entity is enforced by the Pydantic schemas in `schemas.py`.
"""

from datetime import datetime

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20))  # health_worker | doctor | admin
    full_name: Mapped[str] = mapped_column(String(200), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Record(Base):
    """Current state of every synced entity. Deletes are tombstones (deleted=True)."""

    __tablename__ = "records"

    entity: Mapped[str] = mapped_column(String(32), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_by: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(String(64))
    # Global change sequence used as the pull cursor. Assigned under the sync lock,
    # so commit order == seq order and pulls can never skip a change.
    seq: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)


class RecordVersion(Base):
    """Every version ever written. Supplies the common ancestor for three-way merges."""

    __tablename__ = "record_versions"

    entity: Mapped[str] = mapped_column(String(32), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_by: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(String(64))
    op_id: Mapped[str] = mapped_column(String(36))


class ProcessedOp(Base):
    """Idempotency ledger: the stored result is replayed if an op_id is seen again."""

    __tablename__ = "processed_ops"

    op_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str] = mapped_column(String(36))
    user_id: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    result: Mapped[dict] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Conflict(Base):
    __tablename__ = "conflicts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    entity: Mapped[str] = mapped_column(String(32), index=True)
    entity_id: Mapped[str] = mapped_column(String(36), index=True)
    op_id: Mapped[str] = mapped_column(String(36), unique=True)
    op_type: Mapped[str] = mapped_column(String(16))
    user_id: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    base_version: Mapped[int] = mapped_column(Integer)
    server_version: Mapped[int] = mapped_column(Integer)
    local_data: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    local_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    server_data: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    server_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open | resolved | superseded
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    resolution_op_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    superseded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class AuditLog(Base):
    """Append-only, hash-chained: each entry commits to the previous entry's hash."""

    __tablename__ = "audit_log"
    __table_args__ = (UniqueConstraint("prev_hash", name="uq_audit_prev_hash"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[str] = mapped_column(String(40))  # ISO-8601 string, hashed verbatim
    user_id: Mapped[str] = mapped_column(String(36))
    device_id: Mapped[str] = mapped_column(String(64))
    op_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    entity: Mapped[str | None] = mapped_column(String(32), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(32))
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    details: Mapped[dict] = mapped_column(JSONType)
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


class Device(Base):
    """A phone/tablet. `secret` lets any authorised user who signs in online unlock the
    device's encrypted local data (shared clinic tablets); it is never stored on the device."""

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    secret: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | wipe_requested | wiped
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    wipe_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    wipe_requested_by: Mapped[str | None] = mapped_column(String(36), nullable=True)


class AuthSession(Base):
    """One per login: lets tokens be revoked, and holds that session's payload key."""

    __tablename__ = "auth_sessions"

    jti: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    transport_key: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SyncCounter(Base):
    """Single row. Locked FOR UPDATE at the start of every write to serialize the
    change sequence and the audit hash chain."""

    __tablename__ = "sync_counter"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    value: Mapped[int] = mapped_column(BigInteger, default=0)
