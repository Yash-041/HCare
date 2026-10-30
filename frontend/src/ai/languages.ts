/**
 * Working languages. `whisper` = speech-to-text support; `tesseract` = OCR traineddata.
 * Indian-script documents usually mix in English (drug names, lab units), so OCR runs
 * the local script together with English.
 */
export interface Language {
  code: string;
  label: string;
  native: string;
  whisper: boolean;
  tesseract: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", label: "English", native: "English", whisper: true, tesseract: "eng" },
  { code: "hi", label: "Hindi", native: "हिन्दी", whisper: true, tesseract: "eng+hin" },
  { code: "bn", label: "Bengali", native: "বাংলা", whisper: true, tesseract: "eng+ben" },
  { code: "mr", label: "Marathi", native: "मराठी", whisper: true, tesseract: "eng+mar" },
  { code: "ta", label: "Tamil", native: "தமிழ்", whisper: true, tesseract: "eng+tam" },
  { code: "te", label: "Telugu", native: "తెలుగు", whisper: true, tesseract: "eng+tel" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી", whisper: true, tesseract: "eng+guj" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ", whisper: true, tesseract: "eng+kan" },
  { code: "ml", label: "Malayalam", native: "മലയാളം", whisper: true, tesseract: "eng+mal" },
  { code: "pa", label: "Punjabi", native: "ਪੰਜਾਬੀ", whisper: true, tesseract: "eng+pan" },
  { code: "ur", label: "Urdu", native: "اردو", whisper: true, tesseract: "eng+urd" },
  { code: "or", label: "Odia", native: "ଓଡ଼ିଆ", whisper: false, tesseract: "eng+ori" },
];

export function language(code: string | null | undefined): Language {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
}

export function languageLabel(code: string | null | undefined): string {
  if (!code) return "Auto-detect";
  const l = language(code);
  return l.code === "en" ? l.label : `${l.label} (${l.native})`;
}
