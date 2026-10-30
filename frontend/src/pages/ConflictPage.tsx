import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApp } from "../app/AppContext";
import { formatValue } from "../lib/diff";
import { applyMerge, combine, decisionSummary, initialDecisions, planMerge, unresolved, type Choice, type Decisions, type FieldPlan } from "../lib/merge";
import { resolveConflict } from "../lib/repo";
import type { ConflictOut, ConsultationData, LocalRecord, PatientData } from "../lib/types";
import { validateConsultation } from "../lib/validation";

function recordLabel(c: ConflictOut, local: LocalRecord | undefined): string {
  const d = (local?.data ?? c.current_data ?? c.local_data) as { name?: string; visit_date?: string; kind?: string } | null;
  if (c.entity === "patient") return `Patient: ${d?.name ?? "—"}`;
  if (c.entity === "consultation") return `Visit on ${d?.visit_date ?? "—"}`;
  return `Document (${d?.kind ?? "—"})`;
}

function validate(entity: ConflictOut["entity"], data: unknown): string[] {
  if (entity === "consultation") return Object.values(validateConsultation(data as ConsultationData));
  if (entity === "patient" && !(data as PatientData).name?.trim()) return ["Name is required"];
  return [];
}

export function ConflictPage() {
  const { id = "" } = useParams();
  const { db, actor, scheduler } = useApp();
  const navigate = useNavigate();
  const conflict = useLiveQuery(() => db.conflicts.get(id), [db, id]);
  const local = useLiveQuery(() => (conflict ? db.records(conflict.entity).get(conflict.entity_id) : undefined), [db, conflict]);
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Mine" is this device's latest local state (it may include edits made after the conflict).
  const mine = local?.data ?? conflict?.local_data;
  const plan = useMemo(() => (conflict && mine ? planMerge(conflict.base_data, mine, conflict.current_data) : []), [conflict, mine]);
  const d = decisions ?? initialDecisions(plan);

  if (conflict === undefined) {
    return (
      <main className="page">
        <p>This conflict has been resolved or is no longer open.</p>
        <Link to="/sync">Back to Sync</Link>
      </main>
    );
  }

  const label = recordLabel(conflict, local);
  const mineDeleted = local?.deleted ?? conflict.local_deleted;
  const theirsDeleted = conflict.current_deleted;

  async function submit(resolution: Parameters<typeof resolveConflict>[3], summary: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      await resolveConflict(db, actor, conflict!, resolution, summary);
      void scheduler.syncNow();
      navigate("/sync");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // ---- record-level conflict: deleted on one side, edited on the other
  if (mineDeleted !== theirsDeleted) {
    return (
      <main className="page">
        <Header label={label} conflict={conflict} />
        <section className="card">
          <p className="banner banner-conflict">
            {mineDeleted
              ? "You deleted this record on this device, but it was edited on another device."
              : "This record was deleted on another device, but you edited it here."}
          </p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void submit({ kind: "delete" }, { record: "delete" })}>
              Delete it
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void submit(
                  { kind: "data", data: mineDeleted ? conflict.current_data : mine },
                  { record: mineDeleted ? "theirs" : "mine" },
                )
              }
            >
              Keep the {mineDeleted ? "other device's edited" : "edited"} record
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  // ---- field-level merge
  const clashes = plan.filter((p) => p.status === "clash");
  const auto = plan.filter((p) => p.status !== "clash");
  const open = unresolved(plan, d);
  let merged: unknown = null;
  let problems: string[] = [];
  if (open.length === 0 && mine && conflict.current_data) {
    merged = applyMerge(conflict.entity, mine as object, conflict.current_data as object, plan, d);
    problems = validate(conflict.entity, merged);
  }
  const lostVerification =
    conflict.entity === "consultation" &&
    !!merged &&
    (merged as ConsultationData).review.status === "draft" &&
    [mine, conflict.current_data].some((x) => (x as ConsultationData | null)?.review?.status === "verified");

  const choose = (path: string, c: Choice) => setDecisions({ ...d, [path]: c });
  const all = (c: "mine" | "theirs") => setDecisions(Object.fromEntries(plan.map((p) => [p.path, c])));

  return (
    <main className="page">
      <Header label={label} conflict={conflict} />

      <section className="card">
        <p className="muted small">
          {clashes.length
            ? `${clashes.length} field${clashes.length === 1 ? " was" : "s were"} changed on both devices and need${clashes.length === 1 ? "s" : ""} your decision.`
            : "No field was changed differently on both devices."}{" "}
          {auto.length > 0 && `${auto.length} other change${auto.length === 1 ? " was" : "s were"} merged automatically.`}
        </p>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => all("mine")}>
            Use everything from this device
          </button>
          <button type="button" className="secondary" onClick={() => all("theirs")}>
            Use everything from the server
          </button>
        </div>
      </section>

      {clashes.map((p) => (
        <FieldRow key={p.path} plan={p} choice={d[p.path]} onChoose={(c) => choose(p.path, c)} />
      ))}

      {auto.length > 0 && (
        <details className="card" open={clashes.length === 0}>
          <summary>
            <strong>Merged automatically ({auto.length})</strong> <span className="muted small">changed on one side only; you can still change these</span>
          </summary>
          {auto.map((p) => (
            <FieldRow key={p.path} plan={p} choice={d[p.path]} onChoose={(c) => choose(p.path, c)} compact />
          ))}
        </details>
      )}

      <section className="card sticky-actions">
        {lostVerification && (
          <p className="banner banner-conflict">This case file was verified. The merged version is different, so it will need to be verified again.</p>
        )}
        {open.length > 0 && <p className="warn-text small">Choose a value for: {open.map((p) => p.label).join(", ")}.</p>}
        {problems.length > 0 && <p className="error small">The merged record is not valid: {problems.join("; ")}</p>}
        {error && <p className="error small">{error}</p>}
        <div className="actions">
          <button
            type="button"
            disabled={busy || open.length > 0 || problems.length > 0}
            onClick={() => void submit({ kind: "data", data: merged }, decisionSummary(plan, d))}
          >
            Apply merge
          </button>
          <Link to="/sync" className="link">
            Cancel
          </Link>
          <span className="muted small">Saved as a new version on top of the server's. Your choices are recorded in the audit log.</span>
        </div>
      </section>
    </main>
  );
}

function Header({ label, conflict }: { label: string; conflict: ConflictOut }) {
  return (
    <div className="page-head">
      <div>
        <Link to="/sync" className="link">
          ← Sync
        </Link>
        <h2>Resolve conflict</h2>
        <p className="muted small">
          {label}. Your change was based on version {conflict.base_version}; meanwhile the server reached version {conflict.current_version}.
        </p>
      </div>
    </div>
  );
}

const SIDE_LABEL: Record<Choice, string> = { mine: "This device", theirs: "Server", both: "Combine both" };

function FieldRow({ plan: p, choice, onChoose, compact }: { plan: FieldPlan; choice: Choice | undefined; onChoose: (c: Choice) => void; compact?: boolean }) {
  const options: [Choice, unknown][] = [
    ["mine", p.mine],
    ["theirs", p.theirs],
    ...(p.combinable ? ([["both", combine(p.path, p.mine, p.theirs)]] as [Choice, unknown][]) : []),
  ];
  return (
    <fieldset className={`merge-row ${compact ? "compact" : "card"} ${p.status === "clash" && !choice ? "undecided" : ""}`}>
      <legend>
        <strong>{p.label}</strong>{" "}
        <span className={`chip ${p.status === "clash" ? "chip-conflict" : "chip-match"}`}>
          {p.status === "clash" ? "changed on both" : p.status === "mine" ? "changed on this device" : "changed on the server"}
        </span>
      </legend>
      {p.note && <p className="small warn-text">{p.note}</p>}
      <div className="merge-options" role="radiogroup" aria-label={p.label}>
        {options.map(([side, value]) => (
          <label key={side} className={`merge-opt ${choice === side ? "on" : ""}`}>
            <input type="radio" name={p.path} checked={choice === side} onChange={() => onChoose(side)} />
            <span className="merge-side">
              {SIDE_LABEL[side]}
              {p.suggestion === side && p.status === "clash" && <span className="muted"> · suggested</span>}
            </span>
            <span className="merge-value">{formatValue(value)}</span>
          </label>
        ))}
      </div>
      {!compact && <p className="muted small">Before both edits: {formatValue(p.base)}</p>}
    </fieldset>
  );
}
