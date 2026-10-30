"""Application-layer payload encryption (on top of TLS) between devices and the server.

Each login gets its own random AES-256-GCM key. Every ciphertext is bound by its AAD to
where it belongs (the op_id for pushes, entity:id:version for pulls), so a captured
payload cannot be replayed as a different operation or record.
"""

import base64
import json
import os
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class PayloadError(ValueError):
    pass


def new_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def encrypt(key_b64: str, value: Any, aad: str) -> dict[str, str]:
    iv = os.urandom(12)
    ct = AESGCM(base64.b64decode(key_b64)).encrypt(iv, json.dumps(value, separators=(",", ":"), default=str).encode(), aad.encode())
    return {"iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def decrypt(key_b64: str, envelope: dict[str, str], aad: str) -> Any:
    try:
        pt = AESGCM(base64.b64decode(key_b64)).decrypt(base64.b64decode(envelope["iv"]), base64.b64decode(envelope["ct"]), aad.encode())
    except (InvalidTag, KeyError, ValueError) as e:
        raise PayloadError("payload could not be decrypted (wrong key, tampered, or moved)") from e
    return json.loads(pt)
