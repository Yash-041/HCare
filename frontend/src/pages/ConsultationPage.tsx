import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { aiReadiness, downloadLlm, structure } from "../ai";
import { llmSupported } from "../ai/llm";
import { LLM_MODEL } from "../ai/models";
import { useApp } from "../app/AppContext";
import { useConnectivity } from "../app/hooks";
import { useBlobUrl } from "../app/useBlobUrl";
import { needsConfirmation, Provenance, sourceName } from "../components/casefile/Provenance";
import { RowsEditor } from "../components/casefile/RowsEditor";
import { HistoryPanel } from "../components/history/HistoryPanel";
import { SyncChip } from "../components/StatusBar";
import { saveRecord } from "../lib/repo";
import type { Allergy, ConsultationData, FieldMeta, LabResult, Medication, SourceRef, Symptom, Vitals } from "../lib/types";
import { validateConsultation, VITAL_RANGES } from "../lib/validation";

const SEVERITY: [string, string][] = [
  ["mild", "Mild"],
  ["moderate", "Moderate"],
  ["severe", "Severe"],
];
const USE_LLM_KEY = "use_llm";

export function ConsultationPage() {
  const { id: patientId = "", cid = "" } = useParams();
  const { db, actor, scheduler, session } = useApp();
  const connectivity = useConnectivity();
  // Wrapped so "still loading" (undefined) is distinguishable from "not on this device" ({rec: undefined}).
  const loaded = useLiveQuery(
    async () => ({ record: await db.consultations.get(cid), patient: await db.patients.get(patientId) }),
    [db, cid, patientId],
  );
  const record = loaded?.record;
  const patient = loaded?.patient;
  const ready = useLiveQuery(() => aiReadiness(db), [db]);
  const storedUseLlm = useLiveQuery(async () => (await db.getMeta<boolean>(USE_LLM_KEY)) ?? false, [db]);
  // Local state so the checkbox responds instantly; the preference is persisted for next time.
  const [useLlmLocal, setUseLlm] = useState<boolean | null>(null);
  const [gpuOk, setGpuOk] = useState<boolean | null>(null);
  useEffect(() => {
    void llmSupported().then(setGpuOk);
  }, []);
  const useLlm = gpuOk === true && (useLlmLocal ?? storedUseLlm ?? false);

  const [draft, setDraft] = useState<ConsultationData | null>(null);
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState<null | "rules" | "llm" | "download">(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ filled: string[]; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRan = useRef(false);

  // Show the stored record unless the clinician has unsaved edits.
  useEffect(() => {
    if (record?.data && !dirty) setDraft(record.data);
  }, [record, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function persist(data: ConsultationData) {
    await saveRecord(db, actor, "consultation", cid, data);
    scheduler.request();
    setDraft(data);
    setDirty(false);
  }

  async function runStructuring(withLlm: boolean) {
    if (!draft) return;
    setRunning(withLlm ? "llm" : "rules");
    setError(null);
    setTokens(null);
    try {
      const r = await structure(db, draft, withLlm, setTokens);
      setNotice({ filled: r.filled, warnings: r.warnings });
      await persist(r.data); // still a draft; saving just keeps the extraction across reloads
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  // First open of a fresh draft: run the instant rule-based extraction automatically.
  useEffect(() => {
    if (autoRan.current || !draft || dirty || running) return;
    if (draft.review.status === "draft" && Object.keys(draft.field_meta).length === 0 && draft.sources.length > 0) {
      autoRan.current = true;
      void runStructuring(false);
    }
  });

  if (loaded === undefined) return <main className="page muted">Loading…</main>;
  if (!record?.data || record.deleted) {
    return (
      <main className="page">
        <p>This visit is not on this device. If it was recorded on another device, connect to the internet so it can sync.</p>
        <Link to={`/patients/${patientId}`}>Back</Link>
      </main>
    );
  }
  if (!draft) return <main className="page muted">Loading…</main>;

  const d = draft;
  const editable = d.review.status === "draft";
  const errors = validateConsultation(d);
  const toConfirm = Object.entries(d.field_meta)
    .filter(([, m]) => needsConfirmation(m))
    .map(([p]) => p);
  const llmReady = ready?.llm.includes(LLM_MODEL.id) ?? false;

  /** Apply an edit; edited fields become "manual" (the clinician's own entry). */
  function edit(paths: string[], mutate: (x: ConsultationData) => void) {
    setDraft((cur) => {
      const next = structuredClone(cur!);
      mutate(next);
      for (const p of paths) next.field_meta[p] = { source: "manual", verified: true };
      return next;
    });
    setDirty(true);
  }

  function confirmField(path: string) {
    setDraft((cur) => ({ ...cur!, field_meta: { ...cur!.field_meta, [path]: { ...cur!.field_meta[path], verified: true } } }));
    setDirty(true);
  }

  async function verify() {
    const meta: Record<string, FieldMeta> = Object.fromEntries(Object.entries(d.field_meta).map(([k, m]) => [k, { ...m, verified: true }]));
    await persist({
      ...d,
      field_meta: meta,
      review: { status: "verified", reviewed_by: session.user.id, reviewed_at: new Date().toISOString(), notes: d.review.notes ?? null },
    });
  }

  async function reject() {
    const reason = prompt("Why is this case file being rejected?");
    if (reason === null) return;
    await persist({
      ...d,
      review: { status: "rejected", reviewed_by: session.user.id, reviewed_at: new Date().toISOString(), notes: reason.slice(0, 2000) || null },
    });
  }

  function reopen() {
    setDraft({ ...d, review: { status: "draft" } });
    setDirty(true);
  }

  const field = (label: string, path: string, children: ReactNode, hint?: string) => (
    <div className={`cf-field ${errors[path] ? "has-error" : ""} ${needsConfirmation(d.field_meta[path]) ? "needs-confirm" : ""}`}>
      <div className="cf-label">
        <span>{label}</span>
        <Provenance meta={d.field_meta[path]} sources={d.sources} onConfirm={editable ? () => confirmField(path) : undefined} />
      </div>
      {children}
      {hint && <span className="muted small">{hint}</span>}
      {errors[path] && <span className="error small">{errors[path]}</span>}
    </div>
  );

  return (
    <main className="page">
      <div className="page-head">
        <Link to={`/patients/${patientId}`} className="link">
          ← {patient?.data?.name ?? "Patient"}
        </Link>
        <span className="row-gap">
          <span className={`chip review-${d.review.status}`}>
            {d.review.status === "draft" ? "Draft: needs review" : d.review.status === "verified" ? "Verified" : "Rejected"}
          </span>
          <SyncChip status={record.sync_status} />
        </span>
      </div>

      {d.review.status !== "draft" && (
        <div className={`banner ${d.review.status === "verified" ? "banner-ok" : "banner-error"}`}>
          {d.review.status === "verified" ? "Verified" : "Rejected"} by{" "}
          {d.review.reviewed_by === session.user.id ? "you" : "a clinician"} on{" "}
          {d.review.reviewed_at ? new Date(d.review.reviewed_at).toLocaleString() : "—"}
          {d.review.notes ? `: ${d.review.notes}` : ""}.{" "}
          <button type="button" className="link" onClick={reopen}>
            Edit (needs re-verification)
          </button>
        </div>
      )}

      <HistoryPanel patientId={patientId} currentId={cid} />

      {editable && (
        <section className="card ai-panel">
          <h3>AI structuring</h3>
          <p className="muted small">
            Fields are extracted from the voice notes and documents below. Every value shows its source and confidence. Check them:
            nothing is final until you verify.
          </p>
          {gpuOk === false && (
            <p className="muted small">
              Rule-based extraction is used on this device. The optional on-device AI model needs a browser with GPU support
              (WebGPU), which this one doesn't have.
            </p>
          )}
          {gpuOk === true && (
            <label className="check">
              <input
                type="checkbox"
                checked={useLlm}
                onChange={(e) => {
                  setUseLlm(e.target.checked);
                  void db.setMeta(USE_LLM_KEY, e.target.checked);
                }}
              />
              Also use the on-device AI model ({LLM_MODEL.label}, ~{LLM_MODEL.sizeMb} MB{llmReady ? ", downloaded ✓" : ""})
            </label>
          )}
          {useLlm && !llmReady && (
            <p className="muted small">
              {LLM_MODEL.note}{" "}
              {connectivity === "offline" ? (
                "Connect to the internet once to download it."
              ) : (
                <button
                  type="button"
                  className="link"
                  disabled={!!running}
                  onClick={async () => {
                    setRunning("download");
                    setError(null);
                    try {
                      await downloadLlm(db, setProgress);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setRunning(null);
                      setProgress(null);
                    }
                  }}
                >
                  Download now
                </button>
              )}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              disabled={!!running || (useLlm && !llmReady && connectivity === "offline")}
              onClick={() => void runStructuring(useLlm)}
            >
              {Object.keys(d.field_meta).length ? "Re-extract from notes" : "Extract from notes"}
            </button>
            <span className="muted small">Fields you edited are kept.</span>
          </div>
          {running && (
            <div className="processing">
              <span className="spinner" />
              {running === "download"
                ? "Downloading the on-device AI model…"
                : running === "llm"
                  ? tokens
                    ? `On-device AI is writing the case file… (${tokens} tokens)`
                    : "On-device AI is reading the notes (the first run warms up the GPU)…"
                  : "Extracting…"}
              {progress != null && <progress max={1} value={progress} />}
            </div>
          )}
          {notice && (
            <div className="notice">
              <strong>
                Filled {notice.filled.length} field{notice.filled.length === 1 ? "" : "s"}.
              </strong>
              {notice.warnings.map((w) => (
                <p key={w} className="small">
                  ⚠ {w}
                </p>
              ))}
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      )}

      <form className="card casefile" onSubmit={(e) => e.preventDefault()}>
        <h2>Case file · {d.visit_date}</h2>
        <fieldset disabled={!editable}>
          {field(
            "Chief complaint",
            "chief_complaint",
            <textarea
              rows={2}
              value={d.chief_complaint ?? ""}
              onChange={(e) => edit(["chief_complaint"], (x) => (x.chief_complaint = e.target.value || null))}
            />,
          )}

          {field(
            "Symptoms",
            "symptoms",
            <RowsEditor<Symptom & Record<string, unknown>>
              path="symptoms"
              rows={d.symptoms as (Symptom & Record<string, unknown>)[]}
              columns={[
                { key: "name", label: "Symptom" },
                { key: "duration", label: "Duration", placeholder: "e.g. 3 days" },
                { key: "severity", label: "Severity", options: SEVERITY },
              ]}
              blank={{ name: "", duration: null, severity: null }}
              onChange={(rows) => edit(["symptoms"], (x) => (x.symptoms = rows as Symptom[]))}
              disabled={!editable}
              addLabel="Add symptom"
              errors={errors}
            />,
          )}

          <div className="cf-field">
            <div className="cf-label">
              <span>Vitals</span>
            </div>
            <div className="vitals-grid">
              {(Object.keys(VITAL_RANGES) as (keyof Vitals)[]).map((key) => {
                const r = VITAL_RANGES[key];
                const path = `vitals.${key}`;
                return (
                  <label key={key} className={`${errors[path] ? "has-error" : ""} ${needsConfirmation(d.field_meta[path]) ? "needs-confirm" : ""}`}>
                    <span className="cf-label">
                      <span>
                        {r.label} <span className="muted small">{r.unit}</span>
                      </span>
                      <Provenance meta={d.field_meta[path]} sources={d.sources} onConfirm={editable ? () => confirmField(path) : undefined} />
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step={r.integer ? 1 : 0.1}
                      value={d.vitals[key] ?? ""}
                      onChange={(e) =>
                        edit([path], (x) => (x.vitals = { ...x.vitals, [key]: e.target.value === "" ? null : Number(e.target.value) }))
                      }
                    />
                    {errors[path] && <span className="error small">{errors[path]}</span>}
                  </label>
                );
              })}
            </div>
          </div>

          {field(
            "Diagnosis",
            "diagnosis",
            <RowsEditor<{ name: string }>
              path="diagnosis"
              rows={d.diagnosis.map((name) => ({ name }))}
              columns={[{ key: "name", label: "Diagnosis" }]}
              blank={{ name: "" }}
              onChange={(rows) => edit(["diagnosis"], (x) => (x.diagnosis = rows.map((r) => r.name ?? "")))}
              disabled={!editable}
              addLabel="Add diagnosis"
              errors={errors}
            />,
            "Only what the clinician has diagnosed. The AI never adds a diagnosis that is not in the notes.",
          )}

          {field(
            "Medications",
            "medications",
            <RowsEditor<Medication & Record<string, unknown>>
              path="medications"
              rows={d.medications as (Medication & Record<string, unknown>)[]}
              columns={[
                { key: "name", label: "Medicine" },
                { key: "dose", label: "Dose" },
                { key: "frequency", label: "Frequency" },
                { key: "duration", label: "Duration" },
                { key: "route", label: "Route" },
              ]}
              blank={{ name: "", dose: null, frequency: null, duration: null, route: null }}
              onChange={(rows) => edit(["medications"], (x) => (x.medications = rows as Medication[]))}
              disabled={!editable}
              addLabel="Add medicine"
              errors={errors}
            />,
          )}

          {field(
            "Allergies",
            "allergies",
            <RowsEditor<Allergy & Record<string, unknown>>
              path="allergies"
              rows={d.allergies as (Allergy & Record<string, unknown>)[]}
              columns={[
                { key: "substance", label: "Substance" },
                { key: "reaction", label: "Reaction" },
                { key: "severity", label: "Severity", options: SEVERITY },
              ]}
              blank={{ substance: "", reaction: null, severity: null }}
              onChange={(rows) => edit(["allergies"], (x) => (x.allergies = rows as Allergy[]))}
              disabled={!editable}
              addLabel="Add allergy"
              errors={errors}
            />,
          )}

          {field(
            "Lab results",
            "lab_results",
            <RowsEditor<LabResult & Record<string, unknown>>
              path="lab_results"
              rows={(d.lab_results ?? []) as (LabResult & Record<string, unknown>)[]}
              columns={[
                { key: "name", label: "Test" },
                { key: "value", label: "Value" },
                { key: "unit", label: "Unit" },
                { key: "reference_range", label: "Reference" },
              ]}
              blank={{ name: "", value: "", unit: null, reference_range: null }}
              onChange={(rows) => edit(["lab_results"], (x) => (x.lab_results = rows.map((r) => ({ ...r, name: r.name ?? "", value: r.value ?? "" }))))}
              disabled={!editable}
              addLabel="Add lab result"
              errors={errors}
            />,
          )}

          {field(
            "Follow-up",
            "follow_up",
            <div className="follow-up">
              <input
                type="date"
                aria-label="Follow-up date"
                value={d.follow_up?.due_date ?? ""}
                onChange={(e) => edit(["follow_up"], (x) => (x.follow_up = { ...x.follow_up, due_date: e.target.value || null }))}
              />
              <input
                aria-label="Follow-up instructions"
                placeholder="Instructions"
                value={d.follow_up?.instructions ?? ""}
                onChange={(e) => edit(["follow_up"], (x) => (x.follow_up = { ...x.follow_up, instructions: e.target.value || null }))}
              />
            </div>,
          )}

          {field(
            "Clinical notes",
            "notes",
            <textarea rows={3} value={d.notes ?? ""} onChange={(e) => edit(["notes"], (x) => (x.notes = e.target.value || null))} />,
          )}
        </fieldset>
      </form>

      <Sources sources={d.sources} />

      {editable && (
        <section className="card sticky-actions">
          {Object.keys(errors).length > 0 && <p className="error small">Fix {Object.keys(errors).length} invalid field(s) before verifying.</p>}
          {toConfirm.length > 0 && (
            <p className="small warn-text">
              {toConfirm.length} low-confidence field{toConfirm.length === 1 ? "" : "s"} must be confirmed or corrected before verifying.
            </p>
          )}
          <div className="actions">
            <button type="button" disabled={Object.keys(errors).length > 0 || toConfirm.length > 0} onClick={() => void verify()}>
              Verify &amp; save
            </button>
            <button type="button" className="secondary" disabled={!dirty} onClick={() => void persist(d)}>
              {dirty ? "Save draft" : "Saved"}
            </button>
            <button type="button" className="danger" onClick={() => void reject()}>
              Reject
            </button>
          </div>
        </section>
      )}
      {!editable && dirty && (
        <section className="card">
          <button type="button" onClick={() => void persist(d)}>
            Save
          </button>
        </section>
      )}
    </main>
  );
}

function SourceItem({ source, label }: { source: SourceRef; label: string }) {
  const url = useBlobUrl(source.kind === "image" ? (source.document_id ?? source.id) : source.id);
  return (
    <details className="source-item">
      <summary>
        {label}
        {source.language ? ` · ${source.language}` : ""}
      </summary>
      {url && source.kind === "audio" && <audio controls src={url} preload="metadata" />}
      {url && source.kind === "image" && <img src={url} alt={label} />}
      {!url && <p className="muted small">Original media is on the device that captured it.</p>}
      <pre className="ocr-text">{source.excerpt}</pre>
    </details>
  );
}

function Sources({ sources }: { sources: SourceRef[] }) {
  if (!sources.length) return null;
  return (
    <section className="card">
      <h3>Sources</h3>
      <p className="muted small">The original recordings and documents this case file was built from.</p>
      {sources.map((s) => (
        <SourceItem key={s.id} source={s} label={sourceName(sources, s.id)} />
      ))}
    </section>
  );
}
