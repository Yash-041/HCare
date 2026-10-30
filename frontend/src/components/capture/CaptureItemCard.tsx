import { useEffect, useRef, useState } from "react";
import { languageLabel } from "../../ai/languages";
import { speechModel } from "../../ai/models";
import { useApp } from "../../app/AppContext";
import { useBlobUrl } from "../../app/useBlobUrl";
import { removeItem, retryItem, updateItem } from "../../lib/capture";
import type { AudioCaptureItem, CaptureItem, ImageCaptureItem } from "../../lib/types";

/** Textarea that writes through to IndexedDB (debounced) so corrections survive a reload. */
function EditableText({ item, rows }: { item: CaptureItem; rows: number }) {
  const { db } = useApp();
  const [value, setValue] = useState(item.edited_text ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <textarea
      rows={rows}
      value={value}
      aria-label="Corrected text"
      onChange={(e) => {
        const v = e.target.value;
        setValue(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void updateItem(db, item.id, { edited_text: v }), 400);
      }}
      onBlur={() => void updateItem(db, item.id, { edited_text: value })}
    />
  );
}

function Status({ item }: { item: CaptureItem }) {
  const { db } = useApp();
  if (item.status === "done") return null;
  if (item.status === "error") {
    return (
      <div className="banner banner-error">
        {item.error}{" "}
        <button type="button" className="link" onClick={() => void retryItem(db, item.id)}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="processing">
      <span className="spinner" />
      <span>{item.status === "queued" ? "Waiting…" : (item.stage ?? "Processing…")}</span>
      {item.progress != null && <progress max={1} value={item.progress} />}
    </div>
  );
}

function RemoveButton({ item }: { item: CaptureItem }) {
  const { db } = useApp();
  return (
    <button
      type="button"
      className="link danger-link"
      onClick={() => {
        if (confirm("Remove this item from the consultation?")) void removeItem(db, item.id);
      }}
    >
      Remove
    </button>
  );
}

export function AudioItemCard({ item, index }: { item: AudioCaptureItem; index: number }) {
  const url = useBlobUrl(item.blob_id);
  return (
    <div className="capture-item">
      <div className="page-head">
        <strong>Voice note {index}</strong>
        <span className="muted small">
          {languageLabel(item.language)} · {speechModel(item.model).label}
          {item.duration_s ? ` · ${Math.round(item.duration_s)}s` : ""}
        </span>
        <RemoveButton item={item} />
      </div>
      {url && <audio controls src={url} preload="metadata" />}
      <Status item={item} />
      {item.status === "done" && (
        <>
          <label>
            Transcript <span className="muted small">(check and correct before saving)</span>
            <EditableText item={item} rows={4} />
          </label>
          {item.translation && (
            <div className="translation">
              <span className="muted small">English translation (machine)</span>
              <p>{item.translation}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HighlightedOcr({ item }: { item: ImageCaptureItem }) {
  const text = item.ocr_text ?? "";
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const span of item.low_confidence_spans) {
    if (span.start < cursor) continue;
    parts.push(text.slice(cursor, span.start));
    parts.push(
      <mark key={span.start} title={`Confidence ${Math.round(span.confidence * 100)}%`}>
        {text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return <pre className="ocr-text">{parts}</pre>;
}

const DOC_KIND_LABEL: Record<ImageCaptureItem["doc_kind"], string> = {
  lab_report: "Lab report",
  prescription: "Prescription",
  handwritten_note: "Handwritten note",
  discharge_summary: "Discharge summary",
  other: "Other document",
};

export function ImageItemCard({ item, index }: { item: ImageCaptureItem; index: number }) {
  const [showProcessed, setShowProcessed] = useState(false);
  const originalUrl = useBlobUrl(item.blob_id);
  const processedUrl = useBlobUrl(item.processed_blob_id);
  const url = showProcessed && processedUrl ? processedUrl : originalUrl;
  const flagged = item.low_confidence_spans.length;
  const lowOverall = item.confidence != null && item.confidence < 0.6;

  return (
    <div className="capture-item">
      <div className="page-head">
        <strong>
          {DOC_KIND_LABEL[item.doc_kind]} {index}
        </strong>
        <span className="muted small">
          OCR: {item.ocr_langs}
          {item.skew_deg ? ` · straightened ${item.skew_deg}°` : ""}
        </span>
        <RemoveButton item={item} />
      </div>
      <div className="doc-view">
        {url && (
          <figure>
            <img src={url} alt={`Scan of ${DOC_KIND_LABEL[item.doc_kind]}`} />
            {processedUrl && (
              <button type="button" className="link small" onClick={() => setShowProcessed((s) => !s)}>
                {showProcessed ? "Show photo" : "Show cleaned image"}
              </button>
            )}
          </figure>
        )}
        <div className="doc-text">
          <Status item={item} />
          {item.status === "done" && (
            <>
              <p className="muted small">
                Confidence {Math.round((item.confidence ?? 0) * 100)}%
                {flagged > 0 && (
                  <>
                    {" · "}
                    <mark>{flagged} uncertain word{flagged === 1 ? "" : "s"}</mark> highlighted
                  </>
                )}
              </p>
              {(lowOverall || item.doc_kind === "handwritten_note") && (
                <div className="banner banner-conflict">
                  {item.doc_kind === "handwritten_note"
                    ? "Handwriting recognition is limited. Compare carefully with the photo."
                    : "Low recognition quality. Retake the photo in better light or correct the text."}
                </div>
              )}
              {flagged > 0 && <HighlightedOcr item={item} />}
              <label>
                Extracted text <span className="muted small">(correct anything wrong)</span>
                <EditableText item={item} rows={8} />
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
