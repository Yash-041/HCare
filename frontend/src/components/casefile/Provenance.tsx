import { useState } from "react";
import type { FieldMeta, SourceRef } from "../../lib/types";

export const LOW_CONFIDENCE = 0.6;

const SOURCE_LABEL: Record<FieldMeta["source"], string> = {
  rule: "Rule",
  llm: "AI",
  voice: "Voice",
  ocr: "Scan",
  manual: "Edited",
};

export function needsConfirmation(meta: FieldMeta | undefined): boolean {
  return !!meta && meta.source !== "manual" && !meta.verified && (meta.confidence ?? 0) < LOW_CONFIDENCE;
}

export function sourceName(sources: SourceRef[], id: string | null | undefined): string {
  const audio = sources.filter((s) => s.kind === "audio");
  const images = sources.filter((s) => s.kind === "image");
  const a = audio.findIndex((s) => s.id === id);
  if (a >= 0) return `Voice note ${a + 1}`;
  const i = images.findIndex((s) => s.id === id);
  if (i >= 0) return `Document ${i + 1}`;
  return "Notes";
}

/**
 * Shows where a field's value came from and how sure the system is. Clicking reveals the
 * source excerpt so the clinician can check it against the real record.
 */
export function Provenance({
  meta,
  sources,
  onConfirm,
}: {
  meta: FieldMeta | undefined;
  sources: SourceRef[];
  onConfirm?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  const c = meta.confidence;
  const level = meta.source === "manual" ? "manual" : c == null ? "mid" : c >= 0.8 ? "high" : c >= LOW_CONFIDENCE ? "mid" : "low";
  const source = sources.find((s) => s.id === meta.source_ref);

  return (
    <span className="prov-wrap">
      <button
        type="button"
        className={`prov prov-${level}`}
        onClick={() => setOpen((o) => !o)}
        title="Where did this come from?"
        aria-expanded={open}
      >
        {SOURCE_LABEL[meta.source]}
        {meta.source !== "manual" && c != null && ` · ${Math.round(c * 100)}%`}
        {meta.source !== "manual" && meta.source_ref && ` · ${sourceName(sources, meta.source_ref)}`}
        {meta.verified && meta.source !== "manual" && " ✓"}
      </button>
      {needsConfirmation(meta) && onConfirm && (
        <button type="button" className="prov-confirm" onClick={onConfirm}>
          Confirm
        </button>
      )}
      {open && (
        <span className="prov-pop" role="note">
          {meta.source === "manual" ? (
            "Entered or corrected by the clinician."
          ) : (
            <>
              <strong>{sourceName(sources, meta.source_ref)}</strong>
              {source?.excerpt ? <q>{source.excerpt.slice(0, 400)}</q> : " (source text not available)"}
              <em>
                {meta.source === "llm"
                  ? "Suggested by the on-device AI and checked against this text."
                  : "Read by a pattern rule from this text."}
              </em>
            </>
          )}
        </span>
      )}
    </span>
  );
}
