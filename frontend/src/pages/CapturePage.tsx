import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { captureRunner, selectedSpeechModel } from "../ai";
import { language, LANGUAGES } from "../ai/languages";
import { DEFAULT_SPEECH_MODEL } from "../ai/models";
import { useApp } from "../app/AppContext";
import { AudioItemCard, ImageItemCard } from "../components/capture/CaptureItemCard";
import { ModelPanel } from "../components/capture/ModelPanel";
import { VoiceRecorder } from "../components/capture/VoiceRecorder";
import { addAudio, addImage, discardDraft, DraftNotReadyError, openDraft, saveDraftAsConsultation } from "../lib/capture";
import type { DocumentData } from "../lib/types";

const DOC_KINDS: [DocumentData["kind"], string][] = [
  ["lab_report", "Lab report"],
  ["prescription", "Prescription"],
  ["handwritten_note", "Handwritten note"],
  ["discharge_summary", "Discharge summary"],
  ["other", "Other"],
];

export function CapturePage() {
  const { id: patientId = "" } = useParams();
  const { db, actor, scheduler } = useApp();
  const navigate = useNavigate();
  const runner = captureRunner(db);

  const patient = useLiveQuery(() => db.patients.get(patientId), [db, patientId]);
  const draft = useLiveQuery(() => db.capture_drafts.get(patientId), [db, patientId]);
  const items = useLiveQuery(() => db.capture_items.where("draft_id").equals(patientId).sortBy("created_at"), [db, patientId]);
  const model = useLiveQuery(() => selectedSpeechModel(db, DEFAULT_SPEECH_MODEL), [db]) ?? DEFAULT_SPEECH_MODEL;

  const [translate, setTranslate] = useState(true);
  const [docKind, setDocKind] = useState<DocumentData["kind"]>("lab_report");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (patient?.data && draft === undefined) void openDraft(db, patientId, patient.data.preferred_language || "en");
  }, [db, patient, patientId, draft]);

  // Resume anything queued before a reload.
  useEffect(() => {
    void runner.kick();
  }, [runner]);

  if (patient === undefined || draft === undefined) return <main className="page muted">Loading…</main>;
  if (!patient?.data || patient.deleted) {
    return (
      <main className="page">
        <p>Patient not found.</p>
        <Link to="/">Back</Link>
      </main>
    );
  }

  const lang = language(draft?.language);
  const busy = (items ?? []).some((i) => i.status === "queued" || i.status === "processing");
  let audioN = 0;
  let docN = 0;

  async function onRecorded(blob: Blob, durationS: number | null) {
    if (!draft) return;
    await addAudio(db, draft.id, blob, {
      durationS,
      language: lang.whisper ? lang.code : null,
      model,
      translate: translate && lang.code !== "en",
    });
    void runner.kick();
  }

  async function onPhotos(files: FileList | null) {
    if (!draft || !files) return;
    for (const file of Array.from(files)) await addImage(db, draft.id, file, { docKind, ocrLangs: lang.tesseract });
    void runner.kick();
  }

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const consultationId = await saveDraftAsConsultation(db, actor, draft.id);
      scheduler.request();
      // Straight to structuring + clinician review.
      navigate(`/patients/${patientId}/consultations/${consultationId}`);
    } catch (e) {
      setError(e instanceof DraftNotReadyError ? e.message : `Could not save: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  }

  async function onDiscard() {
    if (!draft || !confirm("Discard all recordings and photos from this visit?")) return;
    await discardDraft(db, draft.id);
    navigate(`/patients/${patientId}`);
  }

  return (
    <main className="page">
      <div className="page-head">
        <Link to={`/patients/${patientId}`} className="link">
          ← {patient.data.name}
        </Link>
        <span className="muted small">New consultation · nothing is final until reviewed</span>
      </div>

      <ModelPanel model={model} ocrLangs={lang.tesseract} />

      <section className="card">
        <div className="capture-settings">
          <label>
            Visit language
            <select
              value={draft?.language ?? "en"}
              onChange={(e) => draft && void db.capture_drafts.update(draft.id, { language: e.target.value })}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.code === "en" ? l.label : `${l.label} · ${l.native}`}
                  {l.whisper ? "" : " (documents only)"}
                </option>
              ))}
            </select>
          </label>
          {lang.code !== "en" && lang.whisper && (
            <label className="check">
              <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
              Also translate voice notes to English
            </label>
          )}
          {!lang.whisper && (
            <p className="muted small">Speech recognition is not available for {lang.label}; the spoken language will be auto-detected.</p>
          )}
        </div>
      </section>

      <section className="card">
        <h3>Voice notes</h3>
        <VoiceRecorder onRecorded={(blob, d) => void onRecorded(blob, d)} />
      </section>

      <section className="card">
        <h3>Documents</h3>
        <div className="capture-settings">
          <label>
            Document type
            <select value={docKind} onChange={(e) => setDocKind(e.target.value as DocumentData["kind"])}>
              {DOC_KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="file-btn primary">
            📷 Take photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhotos(e.target.files)} />
          </label>
          <label className="file-btn">
            Upload image
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              aria-label="Upload document image"
              onChange={(e) => {
                void onPhotos(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </section>

      {(items ?? []).map((item) =>
        item.kind === "audio" ? (
          <AudioItemCard key={item.id} item={item} index={++audioN} />
        ) : (
          <ImageItemCard key={item.id} item={item} index={++docN} />
        ),
      )}

      <section className="card sticky-actions">
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" disabled={saving || busy || !items?.length} onClick={() => void onSave()}>
            {busy ? "Processing…" : "Save & structure case file"}
          </button>
          <button type="button" className="secondary" onClick={() => void onDiscard()}>
            Discard
          </button>
          <span className="muted small">Saved drafts are structured by AI and verified in the next step.</span>
        </div>
      </section>
    </main>
  );
}
