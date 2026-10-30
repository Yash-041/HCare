import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { generate, llmSupported } from "../../ai/llm";
import { useApp } from "../../app/AppContext";
import { writeNarrative, type NarrativeSentence } from "../../lib/history/narrative";
import { summarizeHistory, type SourceLink, type Statement } from "../../lib/history/summary";
import { entryFor } from "../../lib/search/indexer";
import { Sparkline } from "./Sparkline";

const SERIES_COLORS = ["#0d9488", "#eb6834"]; // validated: CVD ΔE 10.7, contrast >= 3:1

const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });

function Sources({ sources, patientId }: { sources: SourceLink[]; patientId: string }) {
  return (
    <span className="src-links">
      {sources.map((s) =>
        s.entity === "patient" ? (
          <Link key={`p-${s.id}`} to={`/patients/${patientId}`} className="src-link">
            profile
          </Link>
        ) : (
          <Link
            key={s.id}
            to={`/patients/${patientId}/consultations/${s.id}`}
            className={`src-link ${s.unverified ? "src-unverified" : ""}`}
            title={s.unverified ? "From a visit not yet verified by a clinician" : "Verified visit"}
          >
            {s.date ? short(s.date) : "visit"}
            {s.unverified && " · draft"}
          </Link>
        ),
      )}
    </span>
  );
}

function Lines({ title, items, patientId }: { title: string; items: Statement[]; patientId: string }) {
  if (!items.length) return null;
  return (
    <div className="hist-section">
      <h4>{title}</h4>
      <ul>
        {items.map((s) => (
          <li key={s.text}>
            {s.text} <Sources sources={s.sources} patientId={patientId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Patient history built from this device's records (works offline, no AI model needed).
 * Every line links to the records it came from; facts from unverified drafts are marked.
 */
export function HistoryPanel({ patientId, currentId }: { patientId: string; currentId?: string }) {
  const { db } = useApp();
  const data = useLiveQuery(async () => {
    const [patient, consultations] = await Promise.all([db.patients.get(patientId), db.consultations.where("patient_id").equals(patientId).toArray()]);
    // Plain clinical tags straight from the (decrypted) records: the stored index is hashed.
    const index = consultations.map((c) => entryFor(c)).filter((e) => !!e);
    return { patient, consultations, index };
  }, [db, patientId]);

  const summary = useMemo(() => {
    if (!data?.patient?.data) return null;
    return summarizeHistory({
      patient: data.patient,
      consultations: data.consultations,
      index: data.index,
      current: data.consultations.find((c) => c.id === currentId),
    });
  }, [data, currentId]);

  const [gpu, setGpu] = useState(false);
  const [narrative, setNarrative] = useState<{ sentences: NarrativeSentence[]; dropped: number } | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void llmSupported().then(setGpu);
  }, []);

  if (!summary) return null;
  const empty = summary.visitCount === 0 && !summary.allergies.length && !summary.conditions.length;

  return (
    <details className="card history" open>
      <summary>
        <strong>Patient history</strong>{" "}
        <span className="muted small">
          {summary.visitCount
            ? `${summary.visitCount} earlier visit${summary.visitCount === 1 ? "" : "s"}, ${short(summary.firstVisit!)} – ${short(summary.lastVisit!)}`
            : "no earlier visits"}
        </span>
      </summary>

      {summary.alerts.map((a) => (
        <div key={a.text} className="banner banner-error hist-alert" role="alert">
          <span aria-hidden>⚠</span> <strong>Check:</strong> {a.text} <Sources sources={a.sources} patientId={patientId} />
        </div>
      ))}

      {empty ? (
        <p className="muted small">Nothing recorded yet for this patient.</p>
      ) : (
        <>
          <Lines title="Allergies" items={summary.allergies} patientId={patientId} />
          <Lines title="Conditions" items={summary.conditions} patientId={patientId} />
          <Lines title="Medicines" items={summary.medications} patientId={patientId} />

          {summary.trends.length > 0 && (
            <div className="hist-section">
              <h4>Trends</h4>
              <div className="trend-grid">
                {summary.trends.map((t) => (
                  <div key={t.key} className="trend">
                    <Sparkline
                      title={t.label}
                      unit={t.unit}
                      decimals={t.key === "weight" || t.key.startsWith("lab:") ? 1 : 0}
                      series={t.series.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i], points: s.points }))}
                    />
                    <p className="small">
                      {t.statement.text} <Sources sources={t.statement.sources} patientId={patientId} />
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentId && summary.relevant.length > 0 && (
            <div className="hist-section">
              <h4>Most relevant earlier visits</h4>
              <ul>
                {summary.relevant.slice(0, 3).map((r) => (
                  <li key={r.source.id}>
                    <Link to={`/patients/${patientId}/consultations/${r.source.id}`}>{short(r.source.date!)}</Link>: {r.summary}
                    {r.source.unverified && <span className="muted small"> (draft)</span>}
                    {r.shared.length > 0 && (
                      <span className="reasons">
                        {" "}
                        {r.shared.slice(0, 3).map((s) => (
                          <span key={s} className="chip chip-match">
                            {s}
                          </span>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {gpu && (
            <div className="hist-section">
              {narrative ? (
                <>
                  <h4>AI summary</h4>
                  {narrative.sentences.map((s) => (
                    <p key={s.text} className="small">
                      {s.text} <Sources sources={s.sources} patientId={patientId} />
                    </p>
                  ))}
                  <p className="muted small">
                    Written by the on-device AI from the facts above only.
                    {narrative.dropped > 0 && ` ${narrative.dropped} sentence(s) without support in the records were removed.`}
                  </p>
                </>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={writing}
                  onClick={async () => {
                    setWriting(true);
                    setError(null);
                    try {
                      setNarrative(await writeNarrative(summary, (m, prefill) => generate(m, prefill, { maxNewTokens: 160 })));
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setWriting(false);
                    }
                  }}
                >
                  {writing ? "Writing summary…" : "Write a plain-language summary (on-device AI)"}
                </button>
              )}
              {error && <p className="error small">{error}</p>}
            </div>
          )}
        </>
      )}
    </details>
  );
}
