/** Speech models offered to the user. Sizes are approximate download sizes (q8, WASM). */

export interface SpeechModel {
  id: string;
  label: string;
  sizeMb: number;
  note: string;
}

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: "onnx-community/whisper-tiny",
    label: "Whisper Tiny",
    sizeMb: 45,
    note: "Fastest; English is usable, Indian languages are weak.",
  },
  {
    id: "onnx-community/whisper-base",
    label: "Whisper Base",
    sizeMb: 80,
    note: "Good default for low-end phones; Hindi is fair.",
  },
  {
    id: "onnx-community/whisper-small",
    label: "Whisper Small",
    sizeMb: 250,
    note: "Best for Hindi and regional languages; needs ~4 GB RAM and is slower.",
  },
];

/** On-device LLM for structuring free text (optional; rules work without it). */
// Measured on our labeled notes: the 0.5B model invented vitals and listed allergies as
// medicines; 1.5B was accurate on English notes and only slipped on Hinglish (which the
// grounding checks catch). 1.5B only fits in a browser via WebGPU, so it is an opt-in for
// laptops / GPU phones; everything else uses the rule-based extractor.
export const LLM_MODEL = {
  id: "onnx-community/Qwen2.5-1.5B-Instruct",
  label: "Qwen2.5 1.5B Instruct",
  sizeMb: 1100,
  note: "Improves the wording of the chief complaint and catches phrasing the rules miss. Needs a browser with GPU support (WebGPU), e.g. Chrome on a laptop or recent phone.",
};

export const DEFAULT_SPEECH_MODEL = "onnx-community/whisper-base";

export function speechModel(id: string | null | undefined): SpeechModel {
  return SPEECH_MODELS.find((m) => m.id === id) ?? SPEECH_MODELS[1];
}
