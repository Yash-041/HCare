# On-device AI pipeline (Phases 3–4)

All AI runs in the browser, on the device. No patient data is sent to a cloud AI service. Every model is downloaded once while online and then works in airplane mode.

```
voice note ──► Whisper (speech-to-text, Web Worker) ──► transcript (+ English translation) ─┐
                                                                                            ├─► clinician corrects text
photo ──► clean-up (Web Worker) ──► Tesseract OCR ──► text + per-word confidence ──────────┘
                                                                                            │
          ┌─────────────────────────────────────────────────────────────────────────────────┘
          ▼
   rule-based extractor (always runs, instant)  +  optional on-device LLM (Qwen2.5-1.5B)
          │                                              │
          │                                    grounding check: every item must appear in the notes
          ▼                                              ▼
                  merge ──► schema validation ──► DRAFT case file with per-field provenance
                                                          │
                                                          ▼
                     clinician review: edit / confirm low-confidence fields / verify or reject
```

## Speech: Whisper via transformers.js

| Model | Download | Use |
|---|---|---|
| Whisper Tiny | ~45 MB | Fastest. English is usable; Indian languages are weak. |
| Whisper Base (default) | ~80 MB | Low-end phones. Hindi is fair. |
| Whisper Small | ~250 MB | Best for Hindi and regional languages. Needs about 4 GB RAM. |

- Runs on WebGPU when the device has it, otherwise on the CPU (WASM). It switches to the CPU automatically if WebGPU fails.
- Languages: English plus 10 Indian languages. Odia has no Whisper model, so Odia is supported for documents only.
- Translation is a second Whisper pass with `task: "translate"`. Whisper can only translate *into English*.

## Documents: clean-up and Tesseract

The photo is cleaned up in a Web Worker before OCR:

1. Stretch the contrast.
2. Remove speckle noise (a 3×3 median filter).
3. Straighten the page. The tilt is found by testing angles and picking the one where the text lines line up best.
4. Convert to black and white with Sauvola adaptive thresholding, which copes with shadows and uneven lighting.

Tesseract then reads the text, using the local script plus English (e.g. `eng+hin`). Words below 65% confidence are highlighted for review. Handwriting gets an explicit warning, because Tesseract handles it poorly.

## Structuring

**Rules** ([rules.ts](../frontend/src/ai/extract/rules.ts)) work in English, romanized Hindi and Devanagari. They extract:

- vitals, with °F→°C conversion and range checks
- symptoms, with their duration and severity
- medicines, with dose, frequency, course length and route, including common Indian brand names
- allergies
- lab values from scanned reports
- diagnoses, but only when explicitly stated
- follow-up timing

They understand negation such as "no fever, but cough" and "bukhar nahi hai". Every value records the exact text it was read from.

**The on-device LLM** is optional and off by default. It adds items the rules missed. These guard rails apply to everything it produces:

- **Prompting:** the schema contains type placeholders only, and the reply is prefilled with `{`. Small models copied example values from a concrete schema, and wrote prose without the prefill.
- **Grounding:** every symptom, medicine, allergy and vital must appear in the notes, matched across languages ("fever" ↔ "bukhar" ↔ "बुखार"). A diagnosis needs every word present.
- **Allergy and medicine conflicts:** anything the patient is allergic to is never added as a medicine.
- **Schema and range validation**, mirroring the server's schema.
- Anything dropped is reported to the clinician. Nothing is removed silently.

### Model choice: measured, not assumed

Test notes: an English note (fever, cough, penicillin allergy), a Hinglish note, and a gastroenteritis note.

| Model | Result |
|---|---|
| Qwen2.5-0.5B, 8-bit | Often not JSON. Listed the **penicillin allergy as a medication**. Copied example values from the prompt. |
| Qwen2.5-0.5B, 4-bit | Valid JSON, but **invented vitals** (BP 95/70, pulse 130) and a hypertension diagnosis. |
| **Qwen2.5-1.5B, 4-bit** | Exact on the English notes with nothing invented. On Hinglish it invented "cold" and confused durations; the grounding check removes both. |

These real outputs are kept as regression tests in [structure.test.ts](../frontend/tests/structure.test.ts).

**The model is GPU-only in the browser.** In the CPU (WASM) runtime, the 1.5B model failed to load with `std::bad_alloc`, because WASM can address at most 4 GB. So the model is offered only when the browser has WebGPU with fp16 shaders. Every other device uses the rule-based extractor and sees a short explanation. We deliberately don't fall back to the 0.5B model, because it invented values.

## Search (Phase 5)

All search runs locally on the device ([lib/search](../frontend/src/lib/search)).

- **Index:** one entry per patient, visit or document, holding normalized words plus clinical tags (`sym:fever`, `med:paracetamol`, `dx:…`, `lab:…`, `all:…`, `date:…`). Free text such as transcripts and OCR is scanned with the same lexicon. As a result, a Hinglish transcript saying "bukhar" is tagged `sym:fever`.
- **Upkeep:** Dexie hooks on the record tables re-index on every write, whatever its source: a local save, a sync pull or a conflict resolution. The index is rebuilt automatically if the tokenizer version changes.
- **Queries:** query phrases go through the same lexicon. "fever", "bukhar" and "बुखार" all match, and brand names find their generics ("dolo" → paracetamol). Every word must match (AND). Prefixes match. Typos are tolerated within 1–2 edits. Dates can be typed in the query (`2026-10-15`, `15/10/2026`) or set as a range filter.
- **Speed:** 6,000 records are indexed in about 190 ms. Queries take about 6 ms. An early version took 8 s per query because of Dexie `anyOf()` on a multi-entry index; it now runs one `equals()` per token, fetches keys only, and has a regression test.
- **Smart search (optional, 22 MB):** `all-MiniLM-L6-v2` embeddings of an English summary of each record, ranked by cosine similarity.
  - The threshold is calibrated on the real model: unrelated clinical pairs scored ≤ 0.30, related ones 0.48–0.60. The cutoff is 0.40.
  - Example: "breathing problem" finds a Hinglish "saans phoolna" visit at 58%.
  - Colloquial phrases the small model can't link (e.g. "high temperature" → fever, 0.25) are added to the lexicon instead.
  - An English model is enough here because records and queries are first mapped to canonical English terms. A multilingual model would be 5× larger (113 MB).

## Extraction accuracy (rule-based)

Run `npx vitest run tests/extraction-eval.test.ts --silent=false`. Scores are field-level, against 10 hand-labeled notes (English, Hinglish, Devanagari and OCR):

| Field | Precision | Recall | F1 |
|---|---|---|---|
| Overall | 100% | 100% | 100% |

**Caveat:** the samples were written while the rules were being developed, so these scores are optimistic. A fair measurement needs notes from real health workers that the rules have never seen. Phase 10 will add a held-out set. The test enforces precision ≥ 95% and recall ≥ 85% to catch regressions.

## Patient-history summary (Phase 6, RAG)

[lib/history](../frontend/src/lib/history) builds the summary entirely on the device, with no AI model required.

- **Retrieval:**
  - All of the patient's earlier visits are candidates; one patient's history is small.
  - For "most relevant earlier visits", they are ranked by shared clinical tags from the search index (symptom, medicine, diagnosis, lab, allergy) plus a recency decay (`e^(-days/180)`). An earlier fever visit ranks first when today's complaint is fever.
  - Rejected case files are excluded.
- **Summary:** deterministic aggregation into statements:
  - allergies, from the profile and from visits
  - conditions, with when they were recorded
  - medicines, with brand and generic names merged and the latest details
  - trends: BP, weight, glucose, SpO₂, pulse and lab values, with the exact values and dates
- **Every statement links to its source records.** Facts from visits not yet verified are marked "draft", so nobody mistakes them for confirmed facts.
- **Safety alerts** are deterministic, never generated. Examples: "a drug prescribed today is on the patient's allergy list", "systolic BP ≥ 140 at the last two visits". Each alert links to its evidence.
- **Optional AI narrative** (GPU devices only):
  - The model sees only the numbered statements, never the raw notes, and must cite them as `[n]`.
  - A sentence is dropped if it has no citation, cites a statement that doesn't exist, or contains a number or wording not found in the statements it cites. The clinician sees how many sentences were removed.
  - Tests include an invented "iron deficiency anaemia needing transfusion" sentence, which is rejected.
- **Charts:**
  - Inline SVG sparklines: 2px lines, 8px end dots with a ring in the background colour, crosshair and tooltip on hover or tap, and a hidden value table for screen readers.
  - Colours: teal `#0d9488` and orange `#eb6834`, checked with the palette validator (colour-blind ΔE 10.7, contrast ≥ 3:1). The brand teal `#0f766e` failed the chroma check, so the charts use a more saturated teal.

## Safety principles

- AI output is always a **draft**. A case file can only become `verified` through a clinician action, which records who verified it and when. The server enforces this too.
- Low-confidence fields (below 60%) must be confirmed or edited before **Verify** is enabled.
- Fields the clinician has edited are never overwritten by a re-extraction.
- No inference: the system never suggests a diagnosis that the clinician didn't state.
