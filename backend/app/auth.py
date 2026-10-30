import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .models import User

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


def create_token(user: User) -> tuple[str, int]:
    ttl = settings.jwt_ttl_hours * 3600
    payload = {
        "sub": user.id,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=ttl),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256"), ttl


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
    # Re-check the account on every request: a user revoked while a device was
    # offline is refused at sync time even though their token has not expired.
    with request.app.state.sessionmaker() as db:
        user = db.get(User, claims.get("sub"))
    if user is None or not user.active:
        raise unauthorized
    return user


def require_roles(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"role '{user.role}' not allowed")
        return user

    return dep
