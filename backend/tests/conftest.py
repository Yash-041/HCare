import os
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.db import Base, make_engine
from app.main import create_app


@pytest.fixture
def app(tmp_path):
    # Set TEST_DATABASE_URL to run the suite against a real PostgreSQL (it is wiped).
    url = os.getenv("TEST_DATABASE_URL")
    if url:
        engine = make_engine(url)
        Base.metadata.drop_all(engine)
        engine.dispose()
    else:
        url = f"sqlite:///{tmp_path / 'test.db'}"
    return create_app(url, seed_demo_users=True)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


def login(client, username, password):
    r = client.post("/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def asha(client):
    return login(client, "asha", "asha1234")


@pytest.fixture
def doctor(client):
    return login(client, "doctor", "doctor123")


@pytest.fixture
def admin(client):
    return login(client, "admin", "admin123")


def new_id() -> str:
    return str(uuid.uuid4())


def patient_data(**overrides):
    return {"name": "Ramesh Kumar", "sex": "male", "age_years": 54, "village": "Rampur", **overrides}


def consultation_data(patient_id: str, **overrides):
    return {
        "patient_id": patient_id,
        "visit_date": date(2026, 10, 30).isoformat(),
        "chief_complaint": "fever for 3 days",
        "vitals": {"temperature_c": 38.6, "pulse": 96},
        **overrides,
    }


def op(entity, entity_id, data=None, base_version=0, op_type="upsert", op_id=None, **extra):
    return {
        "op_id": op_id or new_id(),
        "entity": entity,
        "entity_id": entity_id,
        "op_type": op_type,
        "base_version": base_version,
        "data": data,
        **extra,
    }


def push(client, headers, ops, device_id="device-A"):
    r = client.post("/sync/push", json={"device_id": device_id, "ops": ops}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["results"]
