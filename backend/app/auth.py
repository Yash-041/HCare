import base64
import hashlib
import hmac
import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit, transport
from .config import settings
from .models import AuthSession, Device, SyncCounter, User

PBKDF2_ITERATIONS = 210_000
_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str, *, salt: bytes | None = None, iterations: int = PBKDF2_ITERATIONS) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iterations, salt_b64, digest_b64 = encoded.split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iterations))
    return hmac.compare_digest(digest, base64.b64decode(digest_b64))


def create_session(db: Session, user: User, device_id: str | None) -> tuple[str, int, AuthSession]:
    """Issue a token bound to a server-side session (revocable, with its own payload key)."""
    ttl = settings.jwt_ttl_hours * 3600
    now = datetime.now(timezone.utc)
    session = AuthSession(
        jti=str(uuid.uuid4()),
        user_id=user.id,
        device_id=device_id,
        transport_key=transport.new_key(),
        created_at=now,
        expires_at=now + timedelta(seconds=ttl),
    )
    db.add(session)
    payload = {"sub": user.id, "role": user.role, "jti": session.jti, "exp": session.expires_at}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256"), ttl, session


def deliver_wipe(db: Session, device: Device, user_id: str) -> None:
    """Mark a lost device wiped, revoke its sessions and audit it. Caller commits."""
    db.execute(select(SyncCounter).where(SyncCounter.id == 1).with_for_update()).scalar_one()
    device.status = "wiped"
    now = datetime.now(timezone.utc)
    for s in db.execute(select(AuthSession).where(AuthSession.device_id == device.id, AuthSession.revoked_at.is_(None))).scalars():
        s.revoked_at = now
    audit.append(db, user_id=user_id, device_id=device.id, action="device_wipe_delivered", details={})


DEVICE_WIPE = HTTPException(status.HTTP_410_GONE, "device_wipe")


def current_user(
    request: Request, creds: HTTPAuthorizationCredentials | None = Depends(_bearer)
) -> User:
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED, "invalid or missing token", headers={"WWW-Authenticate": "Bearer"}
    )
    if creds is None:
        raise unauthorized
    try:
        claims = jwt.decode(creds.credentials, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise unauthorized
    wipe = False
    with request.app.state.sessionmaker() as db, db.begin():
        session = db.get(AuthSession, claims.get("jti") or "")
        if session is None or session.revoked_at is not None:
            raise unauthorized
        # A device reported lost is told to wipe itself the next time it connects.
        device = db.get(Device, session.device_id) if session.device_id else None
        if device is not None and device.status != "active":
            if device.status == "wipe_requested":
                deliver_wipe(db, device, session.user_id)  # committed when the block exits
            wipe = True
        # Re-check the account on every request: a user revoked while a device was
        # offline is refused at sync time even though their token has not expired.
        user = db.get(User, claims.get("sub"))
        if not wipe and (user is None or not user.active):
            raise unauthorized
        db.expunge(session)
    if wipe:
        raise DEVICE_WIPE
    request.state.auth_session = session
    return user


def require_roles(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"role '{user.role}' not allowed")
        return user

    return dep
