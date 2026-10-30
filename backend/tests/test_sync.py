"""Sync engine scenarios: idempotency, versioning, conflicts, ordering, integrity."""

from conftest import consultation_data, new_id, op, patient_data, push


def get_record(client, headers, entity_id):
    changes = client.get("/sync/pull?since=0", headers=headers).json()["changes"]
    return next(c for c in changes if c["id"] == entity_id)


def history(client, headers, entity, entity_id):
    return client.get(f"/records/{entity}/{entity_id}/history", headers=headers).json()


# ---------------------------------------------------------------- basic apply


def test_create_then_update_bumps_version(client, asha):
    pid = new_id()
    [r1] = push(client, asha, [op("patient", pid, patient_data())])
    assert r1["status"] == "applied" and r1["version"] == 1

    [r2] = push(client, asha, [op("patient", pid, patient_data(village="Sitapur"), base_version=1)])
    assert r2["status"] == "applied" and r2["version"] == 2

    rec = get_record(client, asha, pid)
    assert rec["version"] == 2 and rec["data"]["village"] == "Sitapur"


# ---------------------------------------------------------------- idempotency


def test_duplicate_op_is_not_reapplied(client, asha):
    pid = new_id()
    create = op("patient", pid, patient_data())
    [first] = push(client, asha, [create])
    [again] = push(client, asha, [create])

    assert again["replayed"] is True
    assert {**again, "replayed": False} == first
    assert len(history(client, asha, "patient", pid)) == 1


def test_lost_ack_retry_returns_original_result(client, asha):
    """The server applied the batch but the response never reached the device.
    Re-sending the whole batch must not create new versions."""
    pid = new_id()
    batch = [
        op("patient", pid, patient_data()),
        op("consultation", new_id(), consultation_data(pid)),
    ]
    first = push(client, asha, batch)  # response "lost"
    retry = push(client, asha, batch)

    assert [r["status"] for r in retry] == ["applied", "applied"]
    assert all(r["replayed"] for r in retry)
    assert [r["version"] for r in retry] == [r["version"] for r in first]
    pulled = client.get("/sync/pull?since=0", headers=asha).json()["changes"]
    assert len(pulled) == 2


def test_partial_batch_retry_applies_only_missing_ops(client, asha):
    """Connection dropped mid-batch: the first op reached the server, the second did not."""
    pid = new_id()
    o1 = op("patient", pid, patient_data())
    o2 = op("consultation", new_id(), consultation_data(pid))
    push(client, asha, [o1])

    r1, r2 = push(client, asha, [o1, o2])
    assert r1["replayed"] is True and r2["replayed"] is False
    assert r2["status"] == "applied"


def test_reused_op_id_for_different_record_is_rejected(client, asha):
    o = op("patient", new_id(), patient_data())
    push(client, asha, [o])
    [r] = push(client, asha, [{**o, "entity_id": new_id()}])
    assert r["status"] == "rejected" and "different record" in r["error"]


def test_retry_of_rejected_op_returns_same_rejection(client, asha):
    bad = op("patient", new_id(), {"name": ""})
    [r1] = push(client, asha, [bad])
    [r2] = push(client, asha, [bad])
    assert r1["status"] == r2["status"] == "rejected"
    assert r2["replayed"] is True


# ---------------------------------------------------------------- conflicts


def test_concurrent_offline_edits_create_conflict_without_overwrite(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())], device_id="device-A")

    # Both devices pulled v1, then edited offline.
    [a] = push(client, asha, [op("patient", pid, patient_data(phone="9000000001"), base_version=1)], "device-A")
    [b] = push(client, doctor, [op("patient", pid, patient_data(village="Kheri"), base_version=1)], "device-B")

    assert a["status"] == "applied" and a["version"] == 2
    assert b["status"] == "conflict" and b["conflict_id"]

    rec = get_record(client, asha, pid)
    assert rec["version"] == 2 and rec["data"]["phone"] == "9000000001"
    assert rec["data"]["village"] == "Rampur"  # B's edit was NOT applied

    c = client.get(f"/sync/conflicts/{b['conflict_id']}", headers=doctor).json()
    assert c["status"] == "open"
    assert c["base_version"] == 1 and c["base_data"]["village"] == "Rampur"
    assert c["local_data"]["village"] == "Kheri"
    assert c["server_data"]["phone"] == "9000000001"


def test_field_merge_resolution_is_new_version_and_closes_conflict(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="9000000001"), base_version=1)])
    [b] = push(client, doctor, [op("patient", pid, patient_data(village="Kheri"), base_version=1)], "device-B")

    merged = patient_data(phone="9000000001", village="Kheri")
    resolution = op("patient", pid, merged, base_version=2, resolves_conflict_id=b["conflict_id"])
    [r] = push(client, doctor, [resolution], "device-B")
    assert r["status"] == "applied" and r["version"] == 3

    c = client.get(f"/sync/conflicts/{b['conflict_id']}", headers=doctor).json()
    assert c["status"] == "resolved" and c["resolution_op_id"] == resolution["op_id"]
    assert client.get("/sync/conflicts", headers=doctor).json() == []
    assert get_record(client, asha, pid)["data"]["village"] == "Kheri"


def test_field_decisions_of_a_resolution_are_audited_and_visible(client, asha, doctor, admin):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="9000000001"), base_version=1)])
    [b] = push(client, doctor, [op("patient", pid, patient_data(village="Kheri"), base_version=1)], "device-B")

    decisions = {"phone": "theirs", "village": "mine"}
    resolution = op(
        "patient", pid, patient_data(phone="9000000001", village="Kheri"), base_version=2,
        resolves_conflict_id=b["conflict_id"], resolution=decisions,
    )
    [r] = push(client, doctor, [resolution], "device-B")
    assert r["status"] == "applied"

    c = client.get(f"/sync/conflicts/{b['conflict_id']}", headers=asha).json()
    assert c["status"] == "resolved"
    assert c["resolution"] == decisions
    assert c["resolved_by"]  # who decided
    entry = next(e for e in client.get(f"/audit?entity_id={pid}", headers=admin).json() if e["action"] == "resolve_conflict")
    assert entry["details"]["resolution"] == decisions
    assert entry["details"]["resolved_conflict_id"] == b["conflict_id"]
    assert client.get("/audit/verify", headers=admin).json()["ok"] is True


def test_resolution_decisions_are_validated(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    r = client.post(
        "/sync/push",
        json={"device_id": "d", "ops": [op("patient", pid, patient_data(), base_version=1, resolution={"village": "whatever"})]},
        headers=doctor,
    )
    assert r.status_code == 422


def test_stale_resolution_supersedes_conflict(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="1"), base_version=1)])
    [b] = push(client, doctor, [op("patient", pid, patient_data(village="X"), base_version=1)], "device-B")
    # Server moves on while the doctor is resolving.
    push(client, asha, [op("patient", pid, patient_data(phone="2"), base_version=2)])

    [r] = push(
        client, doctor, [op("patient", pid, patient_data(village="X"), base_version=2, resolves_conflict_id=b["conflict_id"])], "device-B"
    )
    assert r["status"] == "conflict" and r["conflict_id"] != b["conflict_id"]
    old = client.get(f"/sync/conflicts/{b['conflict_id']}", headers=doctor).json()
    assert old["status"] == "superseded" and old["superseded_by"] == r["conflict_id"]


def test_resolving_closed_conflict_is_rejected(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="1"), base_version=1)])
    [b] = push(client, doctor, [op("patient", pid, patient_data(village="X"), base_version=1)], "device-B")
    push(client, doctor, [op("patient", pid, patient_data(), base_version=2, resolves_conflict_id=b["conflict_id"])], "device-B")

    [r] = push(client, doctor, [op("patient", pid, patient_data(), base_version=3, resolves_conflict_id=b["conflict_id"])], "device-B")
    assert r["status"] == "rejected" and "already resolved" in r["error"]


def test_two_devices_creating_same_id_conflict(client, asha, doctor):
    pid = new_id()
    [a] = push(client, asha, [op("patient", pid, patient_data())], "device-A")
    [b] = push(client, doctor, [op("patient", pid, patient_data(name="Other"))], "device-B")
    assert a["status"] == "applied"
    assert b["status"] == "conflict"


def test_delete_vs_edit_conflict(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    push(client, asha, [op("patient", pid, patient_data(phone="1"), base_version=1)])
    [d] = push(client, doctor, [op("patient", pid, op_type="delete", base_version=1)], "device-B")
    assert d["status"] == "conflict"
    c = client.get(f"/sync/conflicts/{d['conflict_id']}", headers=doctor).json()
    assert c["local_deleted"] is True and c["server_deleted"] is False
    assert get_record(client, asha, pid)["deleted"] is False


def test_conflict_on_one_record_does_not_block_others(client, asha, doctor):
    p1, p2 = new_id(), new_id()
    push(client, asha, [op("patient", p1, patient_data()), op("patient", p2, patient_data())])
    push(client, asha, [op("patient", p1, patient_data(phone="1"), base_version=1)])

    r1, r2 = push(
        client,
        doctor,
        [op("patient", p1, patient_data(phone="2"), base_version=1), op("patient", p2, patient_data(phone="3"), base_version=1)],
        "device-B",
    )
    assert r1["status"] == "conflict"
    assert r2["status"] == "applied"


# ---------------------------------------------------------------- deletes, ordering, pull


def test_delete_is_tombstone_visible_in_pull(client, asha):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    [r] = push(client, asha, [op("patient", pid, op_type="delete", base_version=1)])
    assert r["status"] == "applied" and r["version"] == 2
    rec = get_record(client, asha, pid)
    assert rec["deleted"] is True and rec["data"]["name"] == "Ramesh Kumar"


def test_pull_cursor_pagination_returns_each_change_once(client, asha):
    ids = [new_id() for _ in range(5)]
    push(client, asha, [op("patient", i, patient_data()) for i in ids])
    push(client, asha, [op("patient", ids[0], patient_data(phone="1"), base_version=1)])

    seen, cursor = [], 0
    while True:
        page = client.get(f"/sync/pull?since={cursor}&limit=2", headers=asha).json()
        seen += page["changes"]
        cursor = page["next_cursor"]
        if not page["has_more"]:
            break
    # ids[0] was updated last, so it appears once, at its newest version, at the end.
    assert [c["id"] for c in seen] == ids[1:] + [ids[0]]
    assert seen[-1]["version"] == 2
    seqs = [c["seq"] for c in seen]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert client.get(f"/sync/pull?since={cursor}", headers=asha).json()["changes"] == []


def test_batch_applies_in_order_parent_before_child(client, asha):
    pid, cid = new_id(), new_id()
    rp, rc = push(client, asha, [op("patient", pid, patient_data()), op("consultation", cid, consultation_data(pid))])
    assert rp["status"] == rc["status"] == "applied"
    assert get_record(client, asha, pid)["seq"] < get_record(client, asha, cid)["seq"]


def test_update_of_unknown_record_is_rejected(client, asha):
    [r] = push(client, asha, [op("patient", new_id(), patient_data(), base_version=3)])
    assert r["status"] == "rejected" and "not found" in r["error"]


# ---------------------------------------------------------------- validation & clinician verification


def test_out_of_range_vitals_rejected(client, asha):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    bad = consultation_data(pid, vitals={"temperature_c": 98.6})  # Fahrenheit slipped into a Celsius field
    [r] = push(client, asha, [op("consultation", new_id(), bad)])
    assert r["status"] == "rejected" and "temperature_c" in r["error"]


def test_unknown_fields_rejected(client, asha):
    [r] = push(client, asha, [op("patient", new_id(), patient_data(hallucinated_field="x"))])
    assert r["status"] == "rejected"


def test_verified_case_file_requires_reviewer(client, asha, doctor):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    unsigned = consultation_data(pid, review={"status": "verified"})
    [r] = push(client, doctor, [op("consultation", new_id(), unsigned)])
    assert r["status"] == "rejected" and "reviewed_by" in r["error"]

    signed = consultation_data(
        pid, review={"status": "verified", "reviewed_by": "doctor", "reviewed_at": "2026-10-30T10:00:00Z"}
    )
    [r] = push(client, doctor, [op("consultation", new_id(), signed)])
    assert r["status"] == "applied"


def test_lab_results_from_scanned_reports_are_stored(client, asha):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    cid = new_id()
    data = consultation_data(pid, lab_results=[{"name": "Haemoglobin", "value": "9.8", "unit": "g/dL"}])
    [r] = push(client, asha, [op("consultation", cid, data)])
    assert r["status"] == "applied"
    assert get_record(client, asha, cid)["data"]["lab_results"][0]["value"] == "9.8"


def test_field_provenance_round_trips(client, asha):
    pid = new_id()
    push(client, asha, [op("patient", pid, patient_data())])
    cid = new_id()
    data = consultation_data(
        pid,
        sources=[{"id": "audio-1", "kind": "audio", "language": "hi", "excerpt": "teen din se bukhar"}],
        field_meta={"chief_complaint": {"source": "llm", "confidence": 0.82, "source_ref": "audio-1"}},
    )
    push(client, asha, [op("consultation", cid, data)])
    rec = get_record(client, asha, cid)
    assert rec["data"]["field_meta"]["chief_complaint"]["source_ref"] == "audio-1"
