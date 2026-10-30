import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../app/AppContext";
import { HistoryPanel } from "../components/history/HistoryPanel";
import { SyncChip } from "../components/StatusBar";
import { deleteRecord, saveRecord } from "../lib/repo";
import type { PatientData } from "../lib/types";

interface FormState {
  name: string;
  sex: PatientData["sex"];
  age_years: string;
  date_of_birth: string;
  phone: string;
  village: string;
  health_id: string;
  preferred_language: string;
  allergies: string;
  chronic_conditions: string;
}

const EMPTY: FormState = {
  name: "",
  sex: "unknown",
  age_years: "",
  date_of_birth: "",
  phone: "",
  village: "",
  health_id: "",
  preferred_language: "",
  allergies: "",
  chronic_conditions: "",
};

const LANGUAGES = [
  ["", "—"],
  ["en", "English"],
  ["hi", "Hindi"],
  ["bn", "Bengali"],
  ["mr", "Marathi"],
  ["ta", "Tamil"],
  ["te", "Telugu"],
  ["gu", "Gujarati"],
  ["kn", "Kannada"],
  ["ml", "Malayalam"],
  ["pa", "Punjabi"],
  ["or", "Odia"],
] as const;

const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const orNull = (s: string) => s.trim() || null;

function toForm(d: PatientData): FormState {
  return {
    name: d.name,
    sex: d.sex,
    age_years: d.age_years?.toString() ?? "",
    date_of_birth: d.date_of_birth ?? "",
    phone: d.phone ?? "",
    village: d.village ?? "",
    health_id: d.health_id ?? "",
    preferred_language: d.preferred_language ?? "",
    allergies: d.known_allergies.map((a) => a.substance).join(", "),
    chronic_conditions: d.chronic_conditions.join(", "),
  };
}

/** Client-side checks mirror the server schema so most mistakes are caught before sync. */
function toData(f: FormState, previous: PatientData | null): { data?: PatientData; error?: string } {
  if (!f.name.trim()) return { error: "Name is required." };
  const age = f.age_years.trim() ? Number(f.age_years) : null;
  if (age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) return { error: "Age must be 0–130." };
  if (f.phone && !/^[+\d][\d\s-]{5,19}$/.test(f.phone.trim())) return { error: "Phone number looks invalid." };

  // Keep reaction/severity details for allergies that are still listed.
  const previousAllergies = new Map((previous?.known_allergies ?? []).map((a) => [a.substance.toLowerCase(), a]));
  return {
    data: {
      name: f.name.trim(),
      sex: f.sex,
      age_years: age,
      date_of_birth: orNull(f.date_of_birth),
      phone: orNull(f.phone),
      village: orNull(f.village),
      health_id: orNull(f.health_id),
      preferred_language: orNull(f.preferred_language),
      known_allergies: splitList(f.allergies).map((s) => previousAllergies.get(s.toLowerCase()) ?? { substance: s }),
      chronic_conditions: splitList(f.chronic_conditions),
    },
  };
}

export function PatientPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const { db, actor, scheduler } = useApp();
  const navigate = useNavigate();

  const record = useLiveQuery(() => (id ? db.patients.get(id) : undefined), [db, id]);
  const consultations = useLiveQuery(
    () => (id ? db.consultations.where("patient_id").equals(id).reverse().sortBy("updated_at") : []),
    [db, id],
  );
  const draftItems = useLiveQuery(() => (id ? db.capture_items.where("draft_id").equals(id).count() : 0), [db, id]);
  const outboxError = useLiveQuery(
    async () => (id ? (await db.outbox.where("entity_id").equals(id).toArray()).find((o) => o.last_error)?.last_error : null),
    [db, id],
  );

  const [form, setForm] = useState<FormState>(EMPTY);
  const [editing, setEditing] = useState(isNew);
  const [error, setError] = useState<string | null>(null);

  // Load the record into the form when not actively editing (live updates from sync show through).
  useEffect(() => {
    if (record?.data && !editing) setForm(toForm(record.data));
  }, [record, editing]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function onSave(e: FormEvent) {
    e.preventDefault();
    const { data, error } = toData(form, record?.data ?? null);
    if (!data) return setError(error!);
    setError(null);
    const savedId = await saveRecord(db, actor, "patient", id ?? null, data);
    scheduler.request();
    setEditing(false);
    if (isNew) navigate(`/patients/${savedId}`, { replace: true });
  }

  async function onDelete() {
    if (!id || !confirm("Delete this patient record? This is synced to all devices.")) return;
    await deleteRecord(db, actor, "patient", id);
    scheduler.request();
    navigate("/");
  }

  if (!isNew && record === undefined) return <main className="page muted">Loading…</main>;
  if (!isNew && (!record || record.deleted)) {
    return (
      <main className="page">
        <p>This patient record was not found or has been deleted.</p>
        <Link to="/">Back to patients</Link>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <Link to="/" className="link">
          ← Patients
        </Link>
        {record && <SyncChip status={record.sync_status} />}
      </div>

      {record?.sync_status === "conflict" && (
        <div className="banner banner-conflict">
          This record was changed on another device too. <Link to="/sync">Review the conflict</Link>
        </div>
      )}
      {record?.sync_status === "error" && outboxError && (
        <div className="banner banner-error">Server rejected the last change: {outboxError}. Edit and save to fix it.</div>
      )}

      <form className="card form" onSubmit={onSave}>
        <h2>{isNew ? "New patient" : form.name || "Patient"}</h2>
        <fieldset disabled={!editing}>
          <label className="span-2">
            Full name *
            <input value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={200} />
          </label>
          <label>
            Sex
            <select value={form.sex} onChange={(e) => set("sex", e.target.value as FormState["sex"])}>
              <option value="unknown">—</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Age (years)
            <input type="number" min={0} max={130} value={form.age_years} onChange={(e) => set("age_years", e.target.value)} />
          </label>
          <label>
            Date of birth
            <input type="date" value={form.date_of_birth} onChange={(e) => set("date_of_birth", e.target.value)} />
          </label>
          <label>
            Phone
            <input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} maxLength={20} />
          </label>
          <label>
            Village
            <input value={form.village} onChange={(e) => set("village", e.target.value)} maxLength={200} />
          </label>
          <label>
            Health ID (ABHA)
            <input value={form.health_id} onChange={(e) => set("health_id", e.target.value)} maxLength={64} />
          </label>
          <label>
            Preferred language
            <select value={form.preferred_language} onChange={(e) => set("preferred_language", e.target.value)}>
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            Known allergies <span className="muted small">(comma separated)</span>
            <input value={form.allergies} onChange={(e) => set("allergies", e.target.value)} />
          </label>
          <label className="span-2">
            Chronic conditions <span className="muted small">(comma separated)</span>
            <input value={form.chronic_conditions} onChange={(e) => set("chronic_conditions", e.target.value)} />
          </label>
        </fieldset>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {/* Distinct keys: if React reused the Edit <button> as the Save button, its type would
              flip to "submit" mid-click and the browser would submit the form immediately. */}
          {editing ? (
            <>
              <button key="save" type="submit">
                Save
              </button>
              {!isNew && (
                <button key="cancel" type="button" className="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              )}
            </>
          ) : (
            <>
              <button key="edit" type="button" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button key="delete" type="button" className="danger" onClick={() => void onDelete()}>
                Delete
              </button>
            </>
          )}
        </div>
        {record && (
          <p className="muted small">
            Server version {record.version || "— (not yet synced)"} · last changed {new Date(record.updated_at).toLocaleString()}
          </p>
        )}
      </form>

      {!isNew && id && <HistoryPanel patientId={id} />}

      {!isNew && (
        <section className="card">
          <div className="page-head">
            <h3>Consultations</h3>
            <Link to={`/patients/${id}/capture`} className="button">
              {draftItems ? `Continue capture (${draftItems})` : "+ New consultation"}
            </Link>
          </div>
          {consultations?.length ? (
            <ul className="list">
              {consultations
                .filter((c) => !c.deleted)
                .map((c) => (
                  <li key={c.id}>
                    <Link to={`/patients/${id}/consultations/${c.id}`} className="list-item">
                      <div>
                        <strong>{c.data?.visit_date}</strong>
                        <div className="muted small">
                          {c.data?.chief_complaint ?? `${c.data?.sources.length ?? 0} voice note/document source(s)`}
                        </div>
                      </div>
                      <span className="row-gap">
                        <span className={`chip review-${c.data?.review.status}`}>
                          {c.data?.review.status === "verified" ? "Verified" : c.data?.review.status === "rejected" ? "Rejected" : "Needs review"}
                        </span>
                        <SyncChip status={c.sync_status} />
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">No consultations yet.</p>
          )}
        </section>
      )}
    </main>
  );
}
