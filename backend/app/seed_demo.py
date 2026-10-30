"""Seed demo data for a presentation: one patient with a realistic history.

    docker compose exec backend python -m app.seed_demo        (or: python -m app.seed_demo)

Goes through the normal server sync path (validation, versions, audit log), as if a
health worker's tablet had synced these visits. Safe to run twice: it skips if present.
"""

import uuid
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from .config import settings
from .db import Base, make_engine
from .main import _init_db
from .models import Record, User
from .schemas import SyncOp
from .sync import process_op

PATIENT_ID = "0f6a3c2e-9d41-4b7a-8a5e-6c1d2b3a4e5f"  # fixed, so the seed is idempotent


def visit(patient_id: str, days_ago: int, **data) -> dict:
    d = (date.today() - timedelta(days=days_ago)).isoformat()
    review = {"status": "verified", "reviewed_by": "seed", "reviewed_at": f"{d}T11:00:00Z"}
    return {"patient_id": patient_id, "visit_date": d, "sources": [], "field_meta": {}, "review": review, **data}


def main() -> None:
    engine = make_engine(settings.database_url)
    Base.metadata.create_all(engine)
    Session_ = sessionmaker(engine, expire_on_commit=False)
    _init_db(Session_, seed_demo_users=True)

    with Session_() as db:
        if db.get(Record, {"entity": "patient", "id": PATIENT_ID}):
            print("Demo patient already present; nothing to do.")
            return
        doctor = db.execute(select(User).where(User.username == "doctor")).scalar_one()

    patient = {
        "name": "Kamla Devi",
        "sex": "female",
        "age_years": 58,
        "village": "Rampur",
        "phone": "9876500011",
        "preferred_language": "hi",
        "known_allergies": [{"substance": "Penicillin", "reaction": "rash"}],
        "chronic_conditions": ["Hypertension"],
    }
    visits = [
        visit(PATIENT_ID, 200, chief_complaint="Headache and dizziness", symptoms=[{"name": "headache"}, {"name": "dizziness"}],
              vitals={"bp_systolic": 158, "bp_diastolic": 96, "pulse": 84, "weight_kg": 63},
              diagnosis=["Hypertension"], medications=[{"name": "Amlodipine", "dose": "5 mg", "frequency": "once daily"}],
              lab_results=[{"name": "Haemoglobin", "value": "11.4", "unit": "g/dL"}]),
        visit(PATIENT_ID, 120, chief_complaint="Fever and cough for 3 days", symptoms=[{"name": "fever", "duration": "3 days"}, {"name": "cough"}],
              vitals={"bp_systolic": 148, "bp_diastolic": 92, "pulse": 98, "temperature_c": 38.4, "weight_kg": 61.5},
              medications=[{"name": "Paracetamol", "dose": "500 mg", "frequency": "three times daily", "duration": "3 days"}]),
        visit(PATIENT_ID, 45, chief_complaint="Weakness, follow-up of blood pressure", symptoms=[{"name": "weakness"}],
              vitals={"bp_systolic": 144, "bp_diastolic": 90, "pulse": 88, "weight_kg": 60},
              medications=[{"name": "Amlodipine", "dose": "5 mg", "frequency": "once daily"}],
              lab_results=[{"name": "Haemoglobin", "value": "10.2", "unit": "g/dL"}]),
    ]
    ops = [SyncOp(op_id=uuid.uuid4(), entity="patient", entity_id=uuid.UUID(PATIENT_ID), op_type="upsert", base_version=0, data=patient)]
    ops += [SyncOp(op_id=uuid.uuid4(), entity="consultation", entity_id=uuid.uuid4(), op_type="upsert", base_version=0, data=v) for v in visits]
    results = [process_op(Session_, doctor, "demo-seed", o) for o in ops]
    print(f"Seeded Kamla Devi with {len(visits)} earlier visits: {[r.status for r in results]}")


if __name__ == "__main__":
    main()
