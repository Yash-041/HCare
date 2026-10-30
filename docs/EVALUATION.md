# Evaluation

This covers what was measured, how, and the caveats. Raw numbers are in [eval/results.json](eval/results.json). Commands to reproduce each result are at the end.

**Test machine:** Intel Core Ultra 5 225H laptop, 16 GB RAM, Chromium. **CPU only:** headless Chromium has no GPU, so this is the slower WASM path. A low-end phone will be slower than this laptop. We have not yet measured one.

## Summary

| Area | Metric | Result |
|---|---|---|
| Speech to text (Whisper Base, the app's default) | Word error rate (WER) | **3.6 %** (3 errors in 83 words) |
| Speech to text (Whisper Tiny) | WER | **2.4 %** |
| OCR on document photos, 4 conditions | Character error rate (CER) | **2.1 %** overall; 0.0–0.9 % except the shadowed page (6.7 %) |
| Case-file extraction (rules) | Field-level precision / recall / F1 | **100 % / 100 % / 100 %** on 18 notes (74 fields), including real speech-recognition output |
| Sync reliability | Fault-injection scenarios | **All pass:** duplicates, lost acknowledgment, cut-off batch, retries, ordering, two-device conflicts, merges |
| Data integrity | Lost, duplicated or silently overwritten records | **None** in any test (asserted against server history) |
| Security | Ciphertext-only storage, tamper detection, remote wipe | **All pass** |
| Performance | Search over thousands of records | **2–15 ms** per query (6,000 records, or 2,000 encrypted patients) |
| Test suite | Automated tests | **131** frontend unit/integration · **44** backend · **11** browser (+ evaluation run, + 1 GPU-only), all passing |

## 1. Speech to text (WER)

- **Method:** the real app in a browser. Each labeled clip is uploaded on the capture screen, and the transcript is read back from the screen.
- **Scoring:** WER after normalization (lowercase, no punctuation, number words turned into digits, "milligrams" and "mg" treated as the same), so formatting differences don't count as errors.
- **Data:** 8 clinical sentences (83 words) spoken by the two Windows text-to-speech voices, at 16 kHz.

| Model | Download | WER | First use (incl. model load) | Per clip after that |
|---|---|---|---|---|
| Whisper Tiny | ~45 MB | 2.4 % | 31.5 s | 1.4 s |
| **Whisper Base** (default) | ~80 MB | 3.6 % | 19.2 s | 2.4 s |

**Errors found:** "complains" became "complaints" (both models), and **the drug name was misspelled**: Tiny wrote "paracetamal", Base wrote "para-setimal". Everything else, numbers included ("140 over 90", "500 mg"), was exact.

**Caveats:**
- Synthetic, clean, English speech.
- Real voices, background noise, Hindi and regional languages will do worse.
- With 83 words, Tiny vs Base is within noise.
- **To measure Hindi:** drop any `name.wav` + `name.txt` pairs into `frontend/e2e/eval-data/speech/` and run with `HCARE_EVAL_LANG=hi`.

## 2. OCR on document photos (CER)

- **Method:** documents are rendered and photographed as a phone would see them, under the four conditions below. Each is uploaded in the app; the app runs its cleanup steps (contrast, denoise, deskew, Sauvola threshold) and then Tesseract.

| Document | Condition | CER | App-reported confidence | Time |
|---|---|---|---|---|
| Lab report | Clean print, straight | 0.7 % | 93 %, 1 word flagged | 4.2 s (first use) |
| Prescription | Tilted 5° | 0.9 % | 92 %, 1 word flagged | 0.5 s |
| Discharge note | Tilted −8° **with a shadow across the page** | 6.7 % | **71 %, 5 words flagged** | 0.5 s |
| Kidney panel | Dim, blurred, low-contrast, tilted 3° | 0.0 % | 95 % | 0.3 s |

- The worst page was also the one the app flagged as least certain, with the uncertain words highlighted for the clinician. **The confidence signal tracks the actual error.**
- **Caveat:** these are printed documents. Handwriting is much worse with Tesseract, and the app shows an explicit warning for handwritten notes.

## 3. Case-file extraction (precision / recall / F1)

- **Data:** 18 hand-labeled notes:
  - 4 English
  - 2 Hinglish
  - 2 Devanagari
  - 2 OCR-style
  - **8 real Whisper transcripts**, including their mistakes
- **Scoring:** at field level, across symptoms, vitals, medicines, allergies, diagnoses and labs.

| Field | Precision | Recall | F1 |
|---|---|---|---|
| Symptoms | 100 % | 100 % | 100 % |
| Vitals | 100 % | 100 % | 100 % |
| Medicines | 100 % | 100 % | 100 % |
| Allergies | 100 % | 100 % | 100 % |
| Diagnoses | 100 % | 100 % | 100 % |
| Labs | 100 % | 100 % | 100 % |
| **Overall (74 fields)** | **100 %** | **100 %** | **100 %** |

**The evaluation found two real problems, both fixed:**
- **Misheard drug names were missed.** The extractor matched drug names exactly, so "para-setimal" produced no prescription at all. It now corrects near-misses of known drug and allergen names, and gives them **50 % confidence**, below the 60 % bar. **The clinician must confirm the field before Verify is enabled.** Ordinary words are not "corrected" into drugs; this is tested.
- **"3 times a day" in digits** wasn't recognized as a frequency. Fixed.

**Caveat:** the non-speech notes were written while the rules were being developed, so those scores are optimistic. A fair score needs real health workers' notes that the rules have never seen.

**Optional on-device LLM:**
- We compared models on the same notes. Qwen2.5-0.5B **invented vitals** and **listed a penicillin allergy as a medicine**. Qwen2.5-1.5B was exact on English and slipped on Hinglish.
- All of these outputs are kept as regression tests. The grounding guard rails block every one of them (see [AI_PIPELINE.md](AI_PIPELINE.md)).

## 4. Sync reliability and data integrity

These are automated tests against the real server ([SYNC_ENGINE.md](SYNC_ENGINE.md) maps each guarantee to its test):

| Scenario | Expected | Result |
|---|---|---|
| Same op sent twice | Applied once; the second gets the stored result | ✅ |
| Server applied it but the response was lost | The retry is recognized as a duplicate; no second version | ✅ |
| Connection cut mid-batch | Only the missing ops are applied | ✅ |
| Network down; retries with backoff | Nothing lost; sent once the connection returns | ✅ |
| Edit made while a push is in flight | Re-based on the new version; no false conflict | ✅ |
| Two devices edit the same record offline | Conflict detected; server copy untouched; both versions kept | ✅ |
| Field-level merge | One-sided changes auto-merged, clashes decided; decisions audited | ✅ |
| Create/create, delete/edit, stale resolution | Each detected and handled | ✅ |
| Pull pagination | Every change exactly once, in order | ✅ |
| All of the above with encryption on | Same results | ✅ |

## 5. Performance

| Operation | Measured |
|---|---|
| App download, precached for offline (code + AI workers; models are separate) | ~2.2 MB |
| Search: indexing 6,000 records | ~0.35 s |
| Search: query (symptom + date range, name) | 1–8 ms |
| Search over 2,000 **encrypted** patients | indexing ~0.4 s · broad query 15 ms · narrow 3 ms |
| Speech: first use / per clip | 19 s / 2.4 s (Base, CPU) |
| OCR per page | 0.3–0.5 s (4 s on first use) |
| AI workloads | All in Web Workers, so the interface stays responsive |

**On low-end phones:**
- The default models are small (Whisper Base, Tesseract).
- Models download once and load only when first used.
- The large LLM is offered only on devices with WebGPU. On CPU it ran out of memory.

## Reproduce

```bash
cd frontend
npx vitest run tests/extraction-eval.test.ts --silent=false     # extraction P/R/F1 table
HCARE_EVAL=1 npx playwright test e2e/evaluation.pw.ts            # speech WER + OCR CER, writes docs/eval/results.json
npm test && npm run test:e2e                                     # reliability, integrity, security
cd ../backend && pytest
```
