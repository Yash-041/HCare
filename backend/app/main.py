import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from . import audit
from .auth import create_token, current_user, hash_password, require_roles, verify_password
from .config import settings
from .db import Base, make_engine
from .models import AuditLog, Conflict, Record, RecordVersion, SyncCounter, User
from .schemas import (
    AuditEntryOut,
    AuditVerifyOut,
    ConflictOut,
    CreateUserRequest,
    LoginRequest,
    LoginResponse,
    PullResponse,
    PushRequest,
    PushResponse,
    UserOut,
)
from .sync import pull_changes, process_ops

log = logging.getLogger(__name__)

DEMO_USERS = [
    ("admin", "admin123", "admin", "Clinic Admin"),
    ("asha", "asha1234", "health_worker", "Asha Devi (ASHA worker)"),
    ("doctor", "doctor123", "doctor", "Dr. R. Mehta"),
]


def _init_db(Session_: sessionmaker, seed_demo_users: bool) -> None:
    with Session_() as db, db.begin():
        if db.get(SyncCounter, 1) is None:
            db.add(SyncCounter(id=1, value=0))
        if seed_demo_users:
            for username, password, role, full_name in DEMO_USERS:
                if db.execute(select(User).where(User.username == username)).scalar_one_or_none() is None:
                    db.add(
                        User(
                            id=str(uuid.uuid4()),
                            username=username,
                            password_hash=hash_password(password),
                            role=role,
                            full_name=full_name,
                            active=True,
                            created_at=datetime.now(timezone.utc),
                        )
                    )


def _user_out(u: User) -> UserOut:
    return UserOut(id=u.id, username=u.username, role=u.role, full_name=u.full_name)


def create_app(database_url: str | None = None, seed_demo_users: bool | None = None) -> FastAPI:
    engine = make_engine(database_url or settings.database_url)
    Base.metadata.create_all(engine)
    Session_ = sessionmaker(engine, expire_on_commit=False)
    _init_db(Session_, settings.seed_demo_users if seed_demo_users is None else seed_demo_users)

    app = FastAPI(title="HCare Sync Server", version="0.1.0")
    app.state.sessionmaker = Session_
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def get_db(request: Request):
        with request.app.state.sessionmaker() as db:
            yield db

    @app.get("/health")
    def health():
        return {"status": "ok", "server_time": datetime.now(timezone.utc)}

    # ------------------------------------------------------------ auth

    @app.post("/auth/login", response_model=LoginResponse)
    def login(body: LoginRequest, db: Session = Depends(get_db)):
        user = db.execute(select(User).where(User.username == body.username)).scalar_one_or_none()
        if user is None or not user.active or not verify_password(body.password, user.password_hash):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid username or password")
        token, ttl = create_token(user)
        return LoginResponse(access_token=token, expires_in=ttl, user=_user_out(user))

    @app.get("/auth/me", response_model=UserOut)
    def me(user: User = Depends(current_user)):
        return _user_out(user)

    @app.post("/admin/users", response_model=UserOut, status_code=201)
    def create_user(body: CreateUserRequest, db: Session = Depends(get_db), _: User = Depends(require_roles("admin"))):
        user = User(
            id=str(uuid.uuid4()),
            username=body.username,
            password_hash=hash_password(body.password),
            role=body.role,
            full_name=body.full_name,
            active=True,
            created_at=datetime.now(timezone.utc),
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            raise HTTPException(status.HTTP_409_CONFLICT, "username already exists")
        return _user_out(user)

    # ------------------------------------------------------------ sync

    @app.post("/sync/push", response_model=PushResponse)
    def push(body: PushRequest, request: Request, user: User = Depends(current_user)):
        results = process_ops(request.app.state.sessionmaker, user, body.device_id, body.ops)
        return PushResponse(results=results, server_time=datetime.now(timezone.utc))

    @app.get("/sync/pull", response_model=PullResponse)
    def pull(
        since: int = Query(0, ge=0),
        limit: int = Query(500, ge=1, le=settings.max_pull_limit),
        db: Session = Depends(get_db),
        _: User = Depends(current_user),
    ):
        changes, cursor, has_more = pull_changes(db, since, limit)
        return PullResponse(changes=changes, next_cursor=cursor, has_more=has_more)

    @app.get("/sync/conflicts", response_model=list[ConflictOut])
    def list_conflicts(
        status_: Literal["open", "resolved", "superseded", "all"] = Query("open", alias="status"),
        device_id: str | None = None,
        db: Session = Depends(get_db),
        _: User = Depends(current_user),
    ):
        q = select(Conflict).order_by(Conflict.created_at)
        if status_ != "all":
            q = q.where(Conflict.status == status_)
        if device_id:
            q = q.where(Conflict.device_id == device_id)
        return [_conflict_out(db, c) for c in db.execute(q).scalars()]

    @app.get("/sync/conflicts/{conflict_id}", response_model=ConflictOut)
    def get_conflict(conflict_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
        c = db.get(Conflict, conflict_id)
        if c is None:
            raise HTTPException(404, "conflict not found")
        return _conflict_out(db, c)

    @app.get("/records/{entity}/{entity_id}/history")
    def record_history(entity: str, entity_id: str, db: Session = Depends(get_db), _: User = Depends(current_user)):
        rows = db.execute(
            select(RecordVersion)
            .where(RecordVersion.entity == entity, RecordVersion.id == entity_id)
            .order_by(RecordVersion.version)
        ).scalars()
        return [
            {
                "version": r.version,
                "data": r.data,
                "deleted": r.deleted,
                "updated_at": r.updated_at,
                "updated_by": r.updated_by,
                "device_id": r.device_id,
                "op_id": r.op_id,
            }
            for r in rows
        ]

    # ------------------------------------------------------------ audit

    @app.get("/audit", response_model=list[AuditEntryOut])
    def list_audit(
        entity_id: str | None = None,
        limit: int = Query(200, ge=1, le=1000),
        db: Session = Depends(get_db),
        _: User = Depends(require_roles("admin", "doctor")),
    ):
        q = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
        if entity_id:
            q = q.where(AuditLog.entity_id == entity_id)
        return [AuditEntryOut.model_validate(e, from_attributes=True) for e in db.execute(q).scalars()]

    @app.get("/audit/verify", response_model=AuditVerifyOut)
    def verify_audit(db: Session = Depends(get_db), _: User = Depends(require_roles("admin"))):
        ok, checked, bad = audit.verify_chain(db)
        return AuditVerifyOut(ok=ok, checked=checked, first_bad_id=bad)

    return app


def _conflict_out(db: Session, c: Conflict) -> ConflictOut:
    base = (
        db.get(RecordVersion, {"entity": c.entity, "id": c.entity_id, "version": c.base_version})
        if c.base_version > 0
        else None
    )
    current = db.get(Record, {"entity": c.entity, "id": c.entity_id})
    return ConflictOut(
        id=c.id,
        entity=c.entity,
        entity_id=c.entity_id,
        op_id=c.op_id,
        op_type=c.op_type,
        device_id=c.device_id,
        user_id=c.user_id,
        status=c.status,
        base_version=c.base_version,
        base_data=base.data if base else None,
        local_data=c.local_data,
        local_deleted=c.local_deleted,
        server_version=c.server_version,
        server_data=c.server_data,
        server_deleted=c.server_deleted,
        current_version=current.version,
        current_data=current.data,
        current_deleted=current.deleted,
        created_at=c.created_at,
        resolved_at=c.resolved_at,
        resolution_op_id=c.resolution_op_id,
        superseded_by=c.superseded_by,
    )
