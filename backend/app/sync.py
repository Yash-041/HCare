"""Server side of the sync engine.

Each pushed op runs in its own transaction:

  1. lock the sync counter row (serializes writers, the change sequence and the audit chain)
  2. idempotency: if op_id is in the ledger, replay the stored result and change nothing
  3. authorize + validate the payload against the entity schema
  4. version check: base_version == server version -> apply and bump the version;
     otherwise record a conflict and leave the server record untouched
  5. write the audit entry and the ledger entry in the same transaction as the change

Because the ledger row commits atomically with the change, a client that loses the
response and retries gets the original result back instead of a second write.
"""

import logging
import uuid
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from . import audit
from .models import Conflict, ProcessedOp, Record, RecordVersion, SyncCounter, User
from .schemas import ENTITY_SCHEMAS, WRITE_ROLES, Change, OpResult, SyncOp

log = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _summarize_validation(e: ValidationError) -> str:
    parts = [f"{'.'.join(str(p) for p in err['loc']) or '(root)'}: {err['msg']}" for err in e.errors()[:5]]
    return "invalid payload: " + "; ".join(parts)


class _Reject(Exception):
    def __init__(self, message: str):
        self.message = message


def process_ops(Session_: sessionmaker, user: User, device_id: str, ops: list[SyncOp]) -> list[OpResult]:
    """Ops are applied strictly in the order sent. A conflict or rejection on one op
    does not stop the rest; the client decides what to hold back."""
    return [process_op(Session_, user, device_id, op) for op in ops]


def process_op(Session_: sessionmaker, user: User, device_id: str, op: SyncOp) -> OpResult:
    op_id = str(op.op_id)
    try:
        with Session_() as db, db.begin():
            counter = db.execute(select(SyncCounter).where(SyncCounter.id == 1).with_for_update()).scalar_one()
            prior = db.get(ProcessedOp, op_id)
            if prior is not None:
                return _replay(db, prior, op, user, device_id)
            result = _apply(db, counter, user, device_id, op)
            db.add(
                ProcessedOp(
                    op_id=op_id,
                    entity=op.entity,
                    entity_id=str(op.entity_id),
                    user_id=user.id,
                    device_id=device_id,
                    status=result.status,
                    result=result.model_dump(mode="json"),
                    created_at=_now(),
                )
            )
            return result
    except IntegrityError:
        # Lost a race with a concurrent request carrying the same op_id.
        with Session_() as db:
            prior = db.get(ProcessedOp, op_id)
            if prior is not None:
                return OpResult(**{**prior.result, "replayed": True})
        log.exception("integrity error applying op %s", op_id)
        return OpResult(op_id=op_id, status="error", error="temporary conflict, retry")
    except Exception:
        log.exception("failed to apply op %s", op_id)
        return OpResult(op_id=op_id, status="error", error="internal error, retry")


def _replay(db: Session, prior: ProcessedOp, op: SyncOp, user: User, device_id: str) -> OpResult:
    if prior.entity != op.entity or prior.entity_id != str(op.entity_id):
        # Never let a reused op_id silently map to another record.
        return OpResult(op_id=prior.op_id, status="rejected", error="op_id already used for a different record")
    audit.append(
        db,
        user_id=user.id,
        device_id=device_id,
        action="duplicate_ignored",
        op_id=prior.op_id,
        entity=op.entity,
        entity_id=str(op.entity_id),
        details={"original_status": prior.status},
    )
    return OpResult(**{**prior.result, "replayed": True})


def _apply(db: Session, counter: SyncCounter, user: User, device_id: str, op: SyncOp) -> OpResult:
    op_id, entity_id = str(op.op_id), str(op.entity_id)
    audit_ctx = dict(user_id=user.id, device_id=device_id, op_id=op_id, entity=op.entity, entity_id=entity_id)

    try:
        data = _authorize_and_validate(user, op)
        rec = db.execute(
            select(Record).where(Record.entity == op.entity, Record.id == entity_id).with_for_update()
        ).scalar_one_or_none()
        resolving = _conflict_being_resolved(db, op, entity_id)

        if rec is None and op.base_version != 0:
            raise _Reject(f"record not found on server (base_version={op.base_version})")
        if rec is None and op.op_type == "delete":
            raise _Reject("cannot delete a record that does not exist")
    except _Reject as r:
        audit.append(db, **audit_ctx, action="rejected", details={"reason": r.message})
        return OpResult(op_id=op_id, status="rejected", error=r.message)

    if rec is not None and op.base_version != rec.version:
        return _record_conflict(db, user, device_id, op, rec, data, resolving, audit_ctx)

    now = _now()
    counter.value += 1
    if rec is None:
        rec = Record(entity=op.entity, id=entity_id, version=0)
        db.add(rec)
        action = "create"
    else:
        action = "delete" if op.op_type == "delete" else "update"

    rec.version += 1
    if op.op_type == "delete":
        rec.deleted = True  # tombstone; data kept for history
    else:
        rec.data, rec.deleted = data, False
    rec.updated_at, rec.updated_by, rec.device_id, rec.seq = now, user.id, device_id, counter.value

    db.add(
        RecordVersion(
            entity=op.entity,
            id=entity_id,
            version=rec.version,
            data=rec.data,
            deleted=rec.deleted,
            updated_at=now,
            updated_by=user.id,
            device_id=device_id,
            op_id=op_id,
        )
    )
    details = {"base_version": op.base_version}
    if resolving is not None:
        resolving.status = "resolved"
        resolving.resolved_at = now
        resolving.resolved_by = user.id
        resolving.resolution_op_id = op_id
        details["resolved_conflict_id"] = resolving.id
        action = "resolve_conflict"
    audit.append(db, **audit_ctx, action=action, version=rec.version, details=details)
    return OpResult(op_id=op_id, status="applied", version=rec.version)


def _authorize_and_validate(user: User, op: SyncOp) -> dict | None:
    if user.role not in WRITE_ROLES:
        raise _Reject(f"role '{user.role}' cannot modify clinical records")
    if op.op_type == "delete":
        return None
    if op.data is None:
        raise _Reject("upsert requires data")
    try:
        return ENTITY_SCHEMAS[op.entity].model_validate(op.data).model_dump(mode="json")
    except ValidationError as e:
        raise _Reject(_summarize_validation(e))


def _conflict_being_resolved(db: Session, op: SyncOp, entity_id: str) -> Conflict | None:
    if not op.resolves_conflict_id:
        return None
    c = db.get(Conflict, op.resolves_conflict_id)
    if c is None or c.entity != op.entity or c.entity_id != entity_id:
        raise _Reject("resolves_conflict_id does not match this record")
    if c.status != "open":
        raise _Reject(f"conflict is already {c.status}")
    return c


def _record_conflict(
    db: Session,
    user: User,
    device_id: str,
    op: SyncOp,
    rec: Record,
    data: dict | None,
    resolving: Conflict | None,
    audit_ctx: dict,
) -> OpResult:
    conflict = Conflict(
        id=str(uuid.uuid4()),
        entity=op.entity,
        entity_id=rec.id,
        op_id=str(op.op_id),
        op_type=op.op_type,
        user_id=user.id,
        device_id=device_id,
        base_version=op.base_version,
        server_version=rec.version,
        local_data=data,
        local_deleted=op.op_type == "delete",
        server_data=rec.data,
        server_deleted=rec.deleted,
        status="open",
        created_at=_now(),
    )
    db.add(conflict)
    if resolving is not None:
        # The server moved again while the user was resolving; the new conflict replaces the old one.
        resolving.status = "superseded"
        resolving.superseded_by = conflict.id
    audit.append(
        db,
        **audit_ctx,
        action="conflict",
        version=rec.version,
        details={"base_version": op.base_version, "server_version": rec.version, "conflict_id": conflict.id},
    )
    return OpResult(op_id=str(op.op_id), status="conflict", version=rec.version, conflict_id=conflict.id)


def pull_changes(db: Session, since: int, limit: int) -> tuple[list[Change], int, bool]:
    rows = list(db.execute(select(Record).where(Record.seq > since).order_by(Record.seq).limit(limit + 1)).scalars())
    has_more = len(rows) > limit
    rows = rows[:limit]
    changes = [
        Change(
            entity=r.entity,
            id=r.id,
            version=r.version,
            data=r.data,
            deleted=r.deleted,
            updated_at=r.updated_at,
            updated_by=r.updated_by,
            device_id=r.device_id,
            seq=r.seq,
        )
        for r in rows
    ]
    return changes, (rows[-1].seq if rows else since), has_more
