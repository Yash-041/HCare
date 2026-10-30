import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../app/AppContext";
import { useConnectivity, useOutboxSummary } from "../app/hooks";
import { SyncChip } from "../components/StatusBar";
import type { SearchFilters, SearchHit } from "../lib/search/search";
import type { ConsultationData, DocumentData, EntityName, LocalRecord, PatientData } from "../lib/types";

const TYPES: [EntityName | "all", string][] = [
  ["all", "All"],
  ["patient", "Patients"],
  ["consultation", "Visits"],
  ["document", "Documents"],
];

function patientLine(d: PatientData) {
  return [d.age_years != null ? `${d.age_years} y` : null, d.sex !== "unknown" ? d.sex : null, d.village].filter(Boolean).join(" · ");
}

export function PatientsPage() {
  const { db, search } = useApp();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<EntityName | "all">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const patients = useLiveQuery(() => db.patients.orderBy("updated_at").reverse().toArray(), [db]);
  const { conflicts } = useOutboxSummary();

  // Re-run the search when the index changes (new visit saved, records synced).
  useEffect(() => search.onIndexed(() => setRevision((r) => r + 1)), [search]);

  const q = query.trim();
  useEffect(() => {
    if (!q && !dateFrom && !dateTo) {
      setHits(null);
      return;
    }
    const filters: SearchFilters = {
      types: type === "all" ? undefined : [type],
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    };
    let cancelled = false;
    const t = setTimeout(async () => {
      const started = performance.now();
      const result = await search.query(q, filters);
      if (!cancelled) {
        setHits(result);
        setTook(performance.now() - started);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, type, dateFrom, dateTo, search, revision]);

  return (
    <main className="page">
      <div className="page-head">
        <h2>Patients</h2>
        <Link to="/patients/new" className="button">
          + New patient
        </Link>
      </div>
      {conflicts > 0 && (
        <div className="banner banner-conflict" role="status">
          <span aria-hidden>⚠</span> {conflicts} record{conflicts === 1 ? " was" : "s were"} changed on two devices at once.{" "}
          <Link to="/sync">Review and resolve</Link>
        </div>
      )}
      <div className="search-bar">
        <input
          className="search"
          type="search"
          placeholder="Search name, village, ID, symptom, medicine, date… (any language)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
        <button type="button" className={`secondary ${showFilters ? "active" : ""}`} onClick={() => setShowFilters((s) => !s)}>
          Filters
        </button>
      </div>
      {showFilters && <Filters {...{ type, setType, dateFrom, setDateFrom, dateTo, setDateTo }} />}

      {hits ? (
        <SearchResults hits={hits} took={took} />
      ) : patients === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <PatientList patients={patients.filter((p) => !p.deleted && p.data)} />
      )}
    </main>
  );
}

function Filters(p: {
  type: EntityName | "all";
  setType: (t: EntityName | "all") => void;
  dateFrom: string;
  setDateFrom: (s: string) => void;
  dateTo: string;
  setDateTo: (s: string) => void;
}) {
  const { search } = useApp();
  const connectivity = useConnectivity();
  const [semantic, setSemantic] = useState(search.semantic);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggleSemantic(on: boolean) {
    setError(null);
    if (!on) {
      await search.disableSemantic();
      setSemantic(false);
      return;
    }
    setBusy(0);
    setSemantic(true); // respond to the tap immediately; roll back if the model can't load
    try {
      await search.enableSemantic((f) => setBusy(f));
    } catch (e) {
      setSemantic(false);
      setError(connectivity === "offline" ? "Connect once to download the smart-search model (22 MB)." : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card filters">
      <div className="chips" role="radiogroup" aria-label="Record type">
        {TYPES.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={p.type === v} className={`chip-btn ${p.type === v ? "on" : ""}`} onClick={() => p.setType(v)}>
            {l}
          </button>
        ))}
      </div>
      <div className="date-range">
        <label>
          From
          <input type="date" value={p.dateFrom} onChange={(e) => p.setDateFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={p.dateTo} onChange={(e) => p.setDateTo(e.target.value)} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={semantic} disabled={busy !== null} onChange={(e) => void toggleSemantic(e.target.checked)} />
        Smart search: also find related wording (e.g. "breathing problem" → breathlessness). Uses a 22 MB on-device model.
      </label>
      {busy !== null && (
        <div className="processing">
          <span className="spinner" /> Preparing smart search… <progress max={1} value={busy} />
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}

function PatientList({ patients }: { patients: LocalRecord<PatientData>[] }) {
  if (patients.length === 0) return <p className="empty">No patients yet. Add the first one.</p>;
  return (
    <ul className="list">
      {patients.map((p) => (
        <li key={p.id}>
          <Link to={`/patients/${p.id}`} className="list-item">
            <div>
              <strong>{p.data!.name}</strong>
              <div className="muted small">{patientLine(p.data!)}</div>
            </div>
            <SyncChip status={p.sync_status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SearchResults({ hits, took }: { hits: SearchHit[]; took: number | null }) {
  const { db } = useApp();
  // Group by patient, keeping the order of each patient's best hit.
  const groups = new Map<string, SearchHit[]>();
  for (const h of hits) groups.set(h.entry.patient_id, [...(groups.get(h.entry.patient_id) ?? []), h]);
  const patientIds = [...groups.keys()];
  const records = useLiveQuery(async () => {
    const ids = hits.filter((h) => h.entry.entity !== "patient").map((h) => h.entry.entity_id);
    const [patients, consultations, documents] = await Promise.all([
      db.patients.bulkGet(patientIds),
      db.consultations.bulkGet(ids),
      db.documents.bulkGet(ids),
    ]);
    return new Map<string, LocalRecord | undefined>([
      ...patientIds.map((id, i) => [id, patients[i]] as [string, LocalRecord | undefined]),
      ...ids.map((id, i) => [id, (consultations[i] ?? documents[i]) as LocalRecord | undefined] as [string, LocalRecord | undefined]),
    ]);
  }, [db, hits]);

  if (hits.length === 0) return <p className="empty">No matching records.</p>;
  return (
    <>
      <p className="muted small">
        {hits.length} result{hits.length === 1 ? "" : "s"} for {groups.size} patient{groups.size === 1 ? "" : "s"}
        {took != null && ` · ${Math.max(1, Math.round(took))} ms, on this device`}
      </p>
      <ul className="list">
        {[...groups].map(([patientId, group]) => {
          const p = records?.get(patientId) as LocalRecord<PatientData> | undefined;
          return (
            <li key={patientId} className="result-group">
              <Link to={`/patients/${patientId}`} className="list-item">
                <div>
                  <strong>{p?.data?.name ?? "…"}</strong>
                  <div className="muted small">{p?.data ? patientLine(p.data) : ""}</div>
                </div>
                {group.some((h) => h.entry.entity === "patient") && <Reasons hit={group.find((h) => h.entry.entity === "patient")!} />}
              </Link>
              {group
                .filter((h) => h.entry.entity !== "patient")
                .map((h) => (
                  <Link
                    key={h.entry.entity_id}
                    className="sub-hit"
                    to={
                      h.entry.entity === "consultation"
                        ? `/patients/${patientId}/consultations/${h.entry.entity_id}`
                        : `/patients/${patientId}/consultations/${(records?.get(h.entry.entity_id)?.data as DocumentData | undefined)?.consultation_id ?? ""}`
                    }
                  >
                    <span>
                      {h.entry.entity === "consultation" ? "Visit" : "Document"} · {h.entry.date ?? "—"}
                      <span className="muted small"> {summary(records?.get(h.entry.entity_id))}</span>
                    </span>
                    <Reasons hit={h} />
                  </Link>
                ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function summary(r: LocalRecord | undefined): string {
  if (!r?.data) return "";
  if (r.entity === "consultation") {
    const d = r.data as ConsultationData;
    return d.chief_complaint ?? (d.raw_transcript ?? "").replace(/\[[^\]]*\]/g, "").trim().slice(0, 80);
  }
  const d = r.data as DocumentData;
  return `${d.kind.replace(/_/g, " ")}: ${(d.ocr_text ?? "").slice(0, 60)}`;
}

function Reasons({ hit }: { hit: SearchHit }) {
  return (
    <span className="reasons">
      {hit.reasons.slice(0, 3).map((r) => (
        <span key={r} className={`chip ${r.startsWith("related") ? "chip-related" : "chip-match"}`}>
          {r}
        </span>
      ))}
    </span>
  );
}
