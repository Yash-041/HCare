"""Payload encryption, revocable sessions and remote device wipe."""

import base64

from fastapi.testclient import TestClient

from app import transport
from app.main import create_app
from conftest import new_id, op, patient_data, push


def device_login(client, username="asha", password="asha1234", device_id="tablet-1"):
    r = client.post("/auth/login", json={"username": username, "password": password, "device_id": device_id})
    return r


def session(client, **kw):
    r = device_login(client, **kw)
    assert r.status_code == 200, r.text
    body = r.json()
    return {"Authorization": f"Bearer {body['access_token']}"}, body


def enc_op(key, entity_id, data, base_version=0, op_id=None):
    o = op("patient", entity_id, None, base_version=base_version, op_id=op_id)
    o["data_enc"] = transport.encrypt(key, data, o["op_id"])
    return o


def test_login_issues_session_key_and_stable_device_key(client):
    _, a = session(client)
    _, b = session(client, username="doctor", password="doctor123")
    assert len(base64.b64decode(a["transport_key"])) == 32
    assert a["transport_key"] != b["transport_key"]  # per session
    assert a["device_key"] == b["device_key"]  # per device: any authorised user can unlock the tablet
    _, other = session(client, device_id="tablet-2")
    assert other["device_key"] != a["device_key"]


def test_encrypted_push_and_pull_round_trip(client):
    headers, s = session(client)
    key = s["transport_key"]
    pid = new_id()
    r = client.post("/sync/push", json={"device_id": "tablet-1", "ops": [enc_op(key, pid, patient_data(name="Secret Name"))]}, headers=headers)
    assert r.json()["results"][0]["status"] == "applied"

    pulled = client.get("/sync/pull?since=0", headers={**headers, "X-Payload-Encryption": "v1"}).json()["changes"]
    change = next(c for c in pulled if c["id"] == pid)
    assert change["data"] is None and "Secret Name" not in str(change)
    assert transport.decrypt(key, change["data_enc"], f"patient:{pid}:1")["name"] == "Secret Name"


def test_tampered_or_replayed_payloads_are_rejected(client):
    headers, s = session(client)
    key = s["transport_key"]
    good = enc_op(key, new_id(), patient_data())

    tampered = {**good, "op_id": new_id()}  # same ciphertext replayed under another op_id
    flipped = enc_op(key, new_id(), patient_data())
    ct = bytearray(base64.b64decode(flipped["data_enc"]["ct"]))
    ct[0] ^= 1
    flipped["data_enc"]["ct"] = base64.b64encode(bytes(ct)).decode()
    _, other = session(client, username="doctor", password="doctor123")
    wrong_key = enc_op(other["transport_key"], new_id(), patient_data())

    results = client.post("/sync/push", json={"device_id": "tablet-1", "ops": [tampered, flipped, wrong_key, good]}, headers=headers).json()["results"]
    assert [r["status"] for r in results] == ["rejected", "rejected", "rejected", "applied"]
    assert "could not be decrypted" in results[0]["error"]


def test_conflict_copies_are_encrypted_in_responses(client, doctor):
    headers, s = session(client)
    key = s["transport_key"]
    pid = new_id()
    push(client, doctor, [op("patient", pid, patient_data())])
    push(client, doctor, [op("patient", pid, patient_data(phone="1"), base_version=1)])
    [r] = client.post("/sync/push", json={"device_id": "tablet-1", "ops": [enc_op(key, pid, patient_data(phone="2"), base_version=1)]}, headers=headers).json()["results"]
    assert r["status"] == "conflict"
    c = client.get(f"/sync/conflicts/{r['conflict_id']}", headers={**headers, "X-Payload-Encryption": "v1"}).json()
    assert c["local_data"] is None and c["current_data"] is None
    assert transport.decrypt(key, c["enc"]["local_data"], f"conflict:{c['id']}:local_data")["phone"] == "2"


def test_required_mode_rejects_plaintext(tmp_path):
    app = create_app(f"sqlite:///{tmp_path / 'req.db'}", seed_demo_users=True, require_encrypted_payloads=True)
    with TestClient(app) as c:
        headers, s = session(c)
        plain = op("patient", new_id(), patient_data())
        [r] = c.post("/sync/push", json={"device_id": "tablet-1", "ops": [plain]}, headers=headers).json()["results"]
        assert r["status"] == "rejected" and "unencrypted" in r["error"]
        [ok] = c.post("/sync/push", json={"device_id": "tablet-1", "ops": [enc_op(s["transport_key"], new_id(), patient_data())]}, headers=headers).json()["results"]
        assert ok["status"] == "applied"
        # Responses are encrypted even without the opt-in header.
        assert all(ch["data"] is None for ch in c.get("/sync/pull", headers=headers).json()["changes"])


def test_logout_revokes_the_token(client):
    headers, _ = session(client)
    assert client.get("/auth/me", headers=headers).status_code == 200
    assert client.post("/auth/logout", headers=headers).status_code == 204
    assert client.get("/auth/me", headers=headers).status_code == 401


def test_remote_wipe_of_a_lost_device(client, admin):
    lost, _ = session(client, device_id="lost-phone")
    other, _ = session(client, device_id="clinic-tablet")
    devices = {d["id"]: d for d in client.get("/admin/devices", headers=admin).json()}
    assert devices["lost-phone"]["status"] == "active" and devices["lost-phone"]["last_user"] == "asha"

    assert client.post("/admin/devices/lost-phone/wipe", headers=admin).json() == {"status": "wipe_requested"}
    # Next contact from the lost phone: told to wipe; its sessions are revoked.
    r = client.post("/sync/push", json={"device_id": "lost-phone", "ops": []}, headers=lost)
    assert r.status_code == 410 and r.json()["detail"] == "device_wipe"
    assert client.get("/auth/me", headers=lost).status_code == 401  # session revoked
    assert device_login(client, device_id="lost-phone").status_code == 410  # stays wiped
    # Other devices are unaffected.
    assert client.get("/auth/me", headers=other).status_code == 200

    actions = [e["action"] for e in client.get("/audit", headers=admin).json() if e["device_id"] == "lost-phone"]
    assert "device_wipe_requested" in actions and "device_wipe_delivered" in actions
    assert client.get("/audit/verify", headers=admin).json()["ok"] is True


def test_only_admins_can_wipe_devices(client, asha):
    session(client, device_id="x")
    assert client.post("/admin/devices/x/wipe", headers=asha).status_code == 403
    assert client.get("/admin/devices", headers=asha).status_code == 403


def test_tokens_without_a_session_are_refused(client):
    import jwt

    from app.config import settings

    forged = jwt.encode({"sub": "anyone", "role": "admin"}, settings.jwt_secret, algorithm="HS256")
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
