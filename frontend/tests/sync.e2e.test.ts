import { describe, expect, it } from "vitest";
import { inject } from "vitest";
import { ApiClient, DeviceWipeError } from "../src/lib/api";
import { AuthError, lockoutSeconds, loginOffline, SLOWDOWN_AFTER, WIPE_AFTER } from "../src/lib/auth";
import { wipeDevice } from "../src/lib/crypto/wipe";
import { HCareDB } from "../src/lib/db";
import { applyMerge, decisionSummary, initialDecisions, planMerge } from "../src/lib/merge";
import { deleteRecord, resolveConflict, saveRecord } from "../src/lib/repo";
import type { ConflictOut, PatientData } from "../src/lib/types";
import { makeDevice, patient, serverHistory } from "./helpers";

describe("offline capture", () => {
  it("saves locally with an outbox op while offline, and coalesces unsent edits", async () => {
    const d = await makeDevice();
    d.net.mode = "down";

    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    await saveRecord(d.db, d.actor, "patient", id, patient({ phone: "9876543210" }));

    const rec = await d.db.patients.get(id);
    expect(rec?.sync_status).toBe("pending");
    expect(rec?.data?.phone).toBe("9876543210");
    const ops = await d.db.outbox.toArray();
    expect(ops).toHaveLength(1); // two edits, one op
    expect(ops[0]).toMatchObject({ base_version: 0, op_type: "upsert", sent_once: false });

    const report = await d.engine.sync();
    expect(report.error).toMatch(/fetch/);
    expect(d.engine.state.phase).toBe("backoff");
    expect(await d.db.outbox.count()).toBe(1); // nothing lost
    expect((await d.db.outbox.toArray())[0].status).toBe("pending");
  });

  it("syncs once connectivity returns and marks the record synced", async () => {
    const d = await makeDevice();
    d.net.mode = "down";
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    await d.engine.sync();

    d.net.mode = "up";
    const report = await d.engine.sync();
    expect(report).toMatchObject({ applied: 1, error: null });
    expect(await d.db.outbox.count()).toBe(0);
    expect(await d.db.patients.get(id)).toMatchObject({ version: 1, sync_status: "synced" });
    expect(d.engine.state.phase).toBe("idle");
  });

  it("deleting a never-synced record removes it without contacting the server", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    await deleteRecord(d.db, d.actor, "patient", id);
    expect(await d.db.patients.get(id)).toBeUndefined();
    expect(await d.db.outbox.count()).toBe(0);
  });
});

describe("retry safety", () => {
  it("lost acknowledgment: resend is deduplicated by op_id, no duplicate version", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());

    d.net.mode = "drop-response"; // server applies it, the device never hears back
    await d.engine.sync();
    const [op] = await d.db.outbox.toArray();
    expect(op).toMatchObject({ status: "pending", sent_once: true });

    d.net.mode = "up";
    const report = await d.engine.sync();
    expect(report.applied).toBe(1);
    expect(await d.db.outbox.count()).toBe(0);
    expect(await serverHistory("patient", id)).toHaveLength(1);
  });

  it("an edit made after a send attempt is not folded into the in-doubt op", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    d.net.mode = "drop-response";
    await d.engine.sync();

    // The first op may already be on the server; its payload is frozen.
    await saveRecord(d.db, d.actor, "patient", id, patient({ village: "Sitapur" }));
    expect(await d.db.outbox.count()).toBe(2);

    d.net.mode = "up";
    await d.engine.sync(); // first op (replayed), chained second op in the next batch
    const history = await serverHistory("patient", id);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect((history[1].data as PatientData).village).toBe("Sitapur");
    expect(await d.db.patients.get(id)).toMatchObject({ version: 2, sync_status: "synced" });
  });

  it("an edit made while a push is in flight is re-based on the new server version", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    d.net.beforeServer = async () => {
      await saveRecord(d.db, d.actor, "patient", id, patient({ phone: "1112223334" }));
    };
    const report = await d.engine.sync();
    expect(report.applied).toBe(2);
    expect(report.conflicts).toBe(0);
    expect(await d.db.patients.get(id)).toMatchObject({ version: 2, sync_status: "synced" });
  });

  it("ops are pushed oldest-first: a patient is created before its consultation", async () => {
    const d = await makeDevice();
    d.net.mode = "down";
    const pid = await saveRecord(d.db, d.actor, "patient", null, patient());
    const cid = await saveRecord(d.db, d.actor, "consultation", null, {
      patient_id: pid,
      visit_date: "2026-10-30",
      chief_complaint: "cough",
      symptoms: [],
      vitals: { temperature_c: 37.2 },
      diagnosis: [],
      medications: [],
      allergies: [],
      sources: [],
      field_meta: {},
      review: { status: "draft" },
    });
    d.net.mode = "up";
    await d.engine.sync();

    const reader = await makeDevice("doctor", "doctor123");
    await reader.engine.sync();
    expect(await reader.db.consultations.get(cid)).toMatchObject({ patient_id: pid, version: 1 });
  });

  it("server-side rejection blocks the record until the user fixes it", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient({ age_years: 400 }));
    const report = await d.engine.sync();
    expect(report.rejected).toBe(1);
    expect(await d.db.patients.get(id)).toMatchObject({ sync_status: "error" });
    expect((await d.db.outbox.toArray())[0].last_error).toMatch(/age_years/);

    await saveRecord(d.db, d.actor, "patient", id, patient({ age_years: 40 }));
    const fixed = await d.engine.sync();
    expect(fixed.applied).toBe(1);
    expect(await d.db.patients.get(id)).toMatchObject({ version: 1, sync_status: "synced" });
  });
});

describe("conflicts between two devices", () => {
  async function setupConflict() {
    const a = await makeDevice("asha", "asha1234");
    const b = await makeDevice("doctor", "doctor123");
    const id = await saveRecord(a.db, a.actor, "patient", null, patient());
    await a.engine.sync();
    await b.engine.sync(); // B now has v1

    a.net.mode = b.net.mode = "down"; // both go offline and edit the same patient
    await saveRecord(a.db, a.actor, "patient", id, patient({ phone: "9000000001" }));
    await saveRecord(b.db, b.actor, "patient", id, patient({ village: "Kheri" }));

    a.net.mode = b.net.mode = "up";
    await a.engine.sync();
    const report = await b.engine.sync();
    return { a, b, id, report };
  }

  it("detects the concurrent edit and keeps both versions", async () => {
    const { b, id, report } = await setupConflict();
    expect(report.conflicts).toBe(1);

    const rec = await b.db.patients.get(id);
    expect(rec?.sync_status).toBe("conflict");
    expect(rec?.data?.village).toBe("Kheri"); // local edit preserved on the device

    const [conflict] = await b.db.conflicts.toArray();
    expect((conflict.base_data as PatientData).village).toBe("Rampur");
    expect((conflict.local_data as PatientData).village).toBe("Kheri");
    expect((conflict.current_data as PatientData).phone).toBe("9000000001");

    const history = await serverHistory("patient", id);
    expect(history).toHaveLength(2); // server never overwritten by B
  });

  it("holds back further edits to the conflicted record", async () => {
    const { b, id } = await setupConflict();
    await saveRecord(b.db, b.actor, "patient", id, patient({ village: "Kheri", age_years: 33 }));
    b.net.requests = [];
    const report = await b.engine.sync();
    expect(report.sent).toBe(0);
    expect(await b.db.outbox.count()).toBe(2);
  });

  it("field-level merge resolves the conflict as a new version visible to the other device", async () => {
    const { a, b, id } = await setupConflict();
    const [conflict] = await b.db.conflicts.toArray();
    const merged = {
      ...(conflict.current_data as PatientData),
      village: (conflict.local_data as PatientData).village,
    };
    await resolveConflict(b.db, b.actor, conflict as ConflictOut, { kind: "data", data: merged });
    const report = await b.engine.sync();
    expect(report).toMatchObject({ applied: 1, conflicts: 0 });
    expect(await b.db.conflicts.count()).toBe(0);
    expect(await b.db.patients.get(id)).toMatchObject({ version: 3, sync_status: "synced" });

    await a.engine.sync();
    const onA = await a.db.patients.get(id);
    expect(onA?.version).toBe(3);
    expect(onA?.data).toMatchObject({ phone: "9000000001", village: "Kheri" });
  });

  it("three-way merge: automatic + decided fields, synced, decisions recorded on the server", async () => {
    const a = await makeDevice("asha", "asha1234");
    const b = await makeDevice("doctor", "doctor123");
    const id = await saveRecord(a.db, a.actor, "patient", null, patient({ known_allergies: [{ substance: "Penicillin" }] }));
    await a.engine.sync();
    await b.engine.sync();

    a.net.mode = b.net.mode = "down";
    // A: new phone + village; B: different village + age + an extra allergy.
    await saveRecord(a.db, a.actor, "patient", id, patient({ phone: "9000000001", village: "Kheri Kalan", known_allergies: [{ substance: "Penicillin" }] }));
    await saveRecord(b.db, b.actor, "patient", id, patient({ village: "Kheri Khurd", age_years: 33, known_allergies: [{ substance: "Penicillin" }, { substance: "Sulfa drugs" }] }));
    a.net.mode = b.net.mode = "up";
    await a.engine.sync();
    await b.engine.sync();

    const [conflict] = await b.db.conflicts.toArray();
    const mine = (await b.db.patients.get(id))!.data!;
    const plan = planMerge(conflict.base_data, mine, conflict.current_data);
    expect(plan[0]).toMatchObject({ path: "village", status: "clash" }); // clashes are listed first
    expect(Object.fromEntries(plan.map((p) => [p.path, p.status]))).toEqual({
      village: "clash",
      phone: "theirs",
      age_years: "mine",
      known_allergies: "mine", // adding an allergy drops nothing, so it merges automatically
    });
    const decisions = { ...initialDecisions(plan), village: "theirs" as const };
    const merged = applyMerge("patient", mine, conflict.current_data as PatientData, plan, decisions);
    await resolveConflict(b.db, b.actor, conflict, { kind: "data", data: merged }, decisionSummary(plan, decisions));
    expect(await b.engine.sync()).toMatchObject({ applied: 1, conflicts: 0 });

    await a.engine.sync();
    expect((await a.db.patients.get(id))!.data).toMatchObject({
      village: "Kheri Kalan",
      phone: "9000000001",
      age_years: 33,
      known_allergies: [{ substance: "Penicillin" }, { substance: "Sulfa drugs" }],
    });
    const resolved = await a.api.getConflict(conflict.id);
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: { village: "theirs", phone: "theirs", age_years: "mine", known_allergies: "mine" },
    });
  });

  it("pull does not overwrite a record that has unsynced local edits", async () => {
    const a = await makeDevice();
    const b = await makeDevice("doctor", "doctor123");
    const id = await saveRecord(a.db, a.actor, "patient", null, patient());
    await a.engine.sync();
    await b.engine.sync();

    await saveRecord(a.db, a.actor, "patient", id, patient({ phone: "1" }));
    await a.engine.sync();

    b.net.mode = "down";
    await saveRecord(b.db, b.actor, "patient", id, patient({ phone: "2" }));
    b.net.mode = "up";
    // B's push conflicts; the pull that follows must not replace B's edit with A's.
    await b.engine.sync();
    expect((await b.db.patients.get(id))?.data?.phone).toBe("2");
  });
});

describe("authentication and device security", () => {
  it("signs in offline by unlocking the data key with the password; rejects a wrong one", async () => {
    const d = await makeDevice();
    const id = await saveRecord(d.db, d.actor, "patient", null, patient());
    d.db.vault.lock();
    await expect(d.db.patients.get(id)).rejects.toThrow(/locked/i);

    const { session } = await loginOffline(d.db, "asha", "asha1234");
    expect(session.user.role).toBe("health_worker");
    expect((await d.db.patients.get(id))!.data!.name).toBe("Sunita Devi");

    d.db.vault.lock();
    await expect(loginOffline(d.db, "asha", "wrong")).rejects.toBeInstanceOf(AuthError);
    expect(d.db.vault.unlocked).toBe(false);
    await expect(loginOffline(d.db, "nobody", "x")).rejects.toThrow(/never signed in/);
  });

  it("a second user unlocks the same tablet's data via the server's device key", async () => {
    const asha = await makeDevice("asha", "asha1234");
    const id = await saveRecord(asha.db, asha.actor, "patient", null, patient({ name: "Shared Tablet Patient" }));
    asha.db.vault.lock();
    // Doctor signs in online on the same tablet (same database, same device id).
    const doctor = await makeDevice("doctor", "doctor123", asha.db);
    expect((await doctor.db.patients.get(id))!.data!.name).toBe("Shared Tablet Patient");
    // ...and can now also unlock it offline with their own password.
    doctor.db.vault.lock();
    await loginOffline(doctor.db, "doctor", "doctor123");
    expect(doctor.db.vault.unlocked).toBe(true);
  });

  it("slows down repeated wrong passwords, then erases the device's data", async () => {
    const d = await makeDevice();
    await saveRecord(d.db, d.actor, "patient", null, patient());
    d.db.vault.lock();
    for (let i = 1; i < SLOWDOWN_AFTER; i++) await expect(loginOffline(d.db, "asha", "bad")).rejects.toThrow("Invalid username or password");
    await expect(loginOffline(d.db, "asha", "bad")).rejects.toThrow(/5 attempts left/);
    await expect(loginOffline(d.db, "asha", "asha1234")).rejects.toThrow(/Try again in \d+ seconds/); // even the right one, during lockout
    expect(await lockoutSeconds(d.db)).toBeGreaterThan(0);

    // Skip the waits: pretend each lockout elapsed.
    for (let n = SLOWDOWN_AFTER; n < WIPE_AFTER; n++) {
      await d.db.setMeta("auth_failures", { count: n, last: 0 });
      await expect(loginOffline(d.db, "asha", "bad")).rejects.toThrow(n + 1 >= WIPE_AFTER ? /erased/ : /attempts? left/);
    }
    // Everything is gone.
    const reopened = new HCareDB(d.db.name);
    expect(await reopened.patients.count()).toBe(0);
    expect(await reopened.sessions.count()).toBe(0);
  });

  it("an admin's remote wipe reaches a lost device on its next sync", async () => {
    const d = await makeDevice();
    await saveRecord(d.db, d.actor, "patient", null, patient());
    await d.engine.sync();

    const admin = new ApiClient({ baseUrl: inject("apiUrl") });
    const { access_token } = await admin.login("admin", "admin123");
    const adminApi = new ApiClient({ baseUrl: inject("apiUrl"), getToken: () => access_token });
    await adminApi.requestWipe(d.deviceId);

    let wipeOrdered = false;
    const lost = new ApiClient({
      baseUrl: inject("apiUrl"),
      getToken: () => (d.api as unknown as { opts: { getToken: () => string } }).opts.getToken(),
      onDeviceWipe: () => (wipeOrdered = true),
    });
    await expect(lost.pull(0)).rejects.toBeInstanceOf(DeviceWipeError);
    expect(wipeOrdered).toBe(true);
    await wipeDevice(d.db);
    expect(await new HCareDB(d.db.name).patients.count()).toBe(0);
  });
});
