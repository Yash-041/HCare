"""Tamper-evident audit log.

Each entry stores sha256(prev_hash + canonical entry). Editing or deleting any row
breaks every hash after it, which `verify_chain` detects. Appends must run while the
sync lock (SyncCounter row) is held so the chain stays linear.
"""

import hashlib
import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditLog

GENESIS_HASH = "0" * 64


def _entry_hash(prev_hash: str, fields: dict) -> str:
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256((prev_hash + canonical).encode()).hexdigest()


def _fields(e: AuditLog) -> dict:
    return {
        "ts": e.ts,
        "user_id": e.user_id,
        "device_id": e.device_id,
        "op_id": e.op_id,
        "entity": e.entity,
        "entity_id": e.entity_id,
        "action": e.action,
        "version": e.version,
        "details": e.details,
    }


def append(
    db: Session,
    *,
    user_id: str,
    device_id: str,
    action: str,
    op_id: str | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    version: int | None = None,
    details: dict | None = None,
) -> AuditLog:
    last = db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).scalar_one_or_none()
    entry = AuditLog(
        ts=datetime.now(timezone.utc).isoformat(),
        user_id=user_id,
        device_id=device_id,
        op_id=op_id,
        entity=entity,
        entity_id=entity_id,
        action=action,
        version=version,
        details=details or {},
        prev_hash=last.hash if last else GENESIS_HASH,
    )
    entry.hash = _entry_hash(entry.prev_hash, _fields(entry))
    db.add(entry)
    db.flush()
    return entry


def verify_chain(db: Session) -> tuple[bool, int, int | None]:
    """Returns (ok, entries_checked, first_bad_id)."""
    prev = GENESIS_HASH
    checked = 0
    for entry in db.execute(select(AuditLog).order_by(AuditLog.id)).scalars():
        checked += 1
        if entry.prev_hash != prev or entry.hash != _entry_hash(prev, _fields(entry)):
            return False, checked, entry.id
        prev = entry.hash
    return True, checked, None
