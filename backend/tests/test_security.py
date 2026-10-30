"""Auth, role-based access and the tamper-evident audit log."""

from sqlalchemy import update

from app.models import AuditLog, User
from conftest import login, new_id, op, patient_data, push


def test_push_requires_auth(client):
    r = client.post("/sync/push", json={"device_id": "d", "ops": []})
    assert r.status_code == 401


def test_bad_password_rejected(client):
    r = client.post("/auth/login", json={"username": "asha", "password": "wrong"})
    assert r.status_code == 401


def test_admin_cannot_modify_clinical_records(client, admin):
    [r] = push(client, admin, [op("patient", new_id(), patient_data())])
    assert r["status"] == "rejected" and "cannot modify" in r["error"]


def test_revoked_user_is_refused_even_with_valid_token(app, client, asha):
    with app.state.sessionmaker() as db, db.begin():
        db.execute(update(User).where(User.username == "asha").values(active=False))
    r = client.post("/sync/push", json={"device_id": "d", "ops": []}, headers=asha)
    assert r.status_code == 401


def test_health_worker_cannot_read_audit(client, asha):
    assert client.get("/audit", headers=asha).status_code == 403


def test_admin_can_create_user(client, admin):
    r = client.post(
        "/admin/users",
        json={"username": "nurse1", "password": "nurse-pass-1", "role": "health_worker"},
        headers=admin,
    )
    assert r.status_code == 201
    login(client, "nurse1", "nurse-pass-1")


def test_admin_manages_staff_accounts(client, admin):
    r = client.post("/admin/users", json={"username": "dr.sharma", "password": "secret-pass-1", "role": "doctor", "full_name": "Dr. A. Sharma"}, headers=admin)
    assert r.status_code == 201
    uid = r.json()["id"]
    assert client.post("/admin/users", json={"username": "dr.sharma", "password": "another-pass", "role": "doctor"}, headers=admin).status_code == 409

    users = {u["username"]: u for u in client.get("/admin/users", headers=admin).json()}
    assert users["dr.sharma"] == {**users["dr.sharma"], "role": "doctor", "active": True, "full_name": "Dr. A. Sharma"}

    doc = login(client, "dr.sharma", "secret-pass-1")
    assert client.get("/auth/me", headers=doc).status_code == 200

    # Deactivating takes effect immediately, even for an existing session.
    assert client.patch(f"/admin/users/{uid}", json={"active": False}, headers=admin).json()["active"] is False
    assert client.get("/auth/me", headers=doc).status_code == 401
    assert client.post("/auth/login", json={"username": "dr.sharma", "password": "secret-pass-1"}).status_code == 401

    # Reactivate + password reset: the old password stops working.
    client.patch(f"/admin/users/{uid}", json={"active": True}, headers=admin)
    assert client.post(f"/admin/users/{uid}/password", json={"password": "new-secret-2"}, headers=admin).status_code == 204
    assert client.post("/auth/login", json={"username": "dr.sharma", "password": "secret-pass-1"}).status_code == 401
    login(client, "dr.sharma", "new-secret-2")

    actions = [e["action"] for e in client.get(f"/audit?entity_id={uid}", headers=admin).json()]
    assert sorted(actions) == ["password_reset", "user_created", "user_updated", "user_updated"]
    assert client.get("/audit/verify", headers=admin).json()["ok"] is True


def test_admin_cannot_lock_themselves_out(client, admin):
    me = client.get("/auth/me", headers=admin).json()
    assert client.patch(f"/admin/users/{me['id']}", json={"active": False}, headers=admin).status_code == 400
    assert client.patch(f"/admin/users/{me['id']}", json={"role": "doctor"}, headers=admin).status_code == 400


def test_staff_cannot_manage_accounts(client, asha, doctor):
    for h in (asha, doctor):
        assert client.get("/admin/users", headers=h).status_code == 403
        assert client.post("/admin/users", json={"username": "x-user", "password": "password-1", "role": "admin"}, headers=h).status_code == 403


def test_every_operation_is_audited(client, asha, admin):
    pid = new_id()
    create = op("patient", pid, patient_data())
    push(client, asha, [create])
    push(client, asha, [create])  # duplicate
    push(client, asha, [op("patient", pid, {"name": ""}, base_version=1)])  # rejected

    entries = client.get(f"/audit?entity_id={pid}", headers=admin).json()
    assert [e["action"] for e in reversed(entries)] == ["create", "duplicate_ignored", "rejected"]
    assert all(e["device_id"] == "device-A" for e in entries)


def test_audit_chain_detects_tampering(app, client, asha, admin):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="1"), base_version=1)])
    assert client.get("/audit/verify", headers=admin).json() == {"ok": True, "checked": 2, "first_bad_id": None}

    with app.state.sessionmaker() as db, db.begin():
        first = db.query(AuditLog).order_by(AuditLog.id).first()
        db.execute(update(AuditLog).where(AuditLog.id == first.id).values(user_id="someone-else"))

    result = client.get("/audit/verify", headers=admin).json()
    assert result["ok"] is False and result["first_bad_id"] == first.id
