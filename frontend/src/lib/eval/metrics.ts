/**
 * Evaluation metrics: word error rate (speech) and character error rate (OCR).
 * Text is normalized first, in the spirit of Whisper's English normalizer, so formatting
 * differences ("one hundred forty" vs "140", "mg" vs "milligrams") are not counted as errors.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SYNONYMS: Record<string, string> = {
  milligrams: "mg", milligram: "mg", millilitres: "ml", milliliters: "ml", ml: "ml",
  per: "per", over: "/", "o.r.s": "ors", okay: "ok", "x": "times",
};

/** "one hundred forty" -> "140"; leaves other words alone. */
function numberWords(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let value = 0;
    let current = 0;
    let used = 0;
    while (i + used < words.length) {
      const w = words[i + used];
      if (w in UNITS) current += UNITS[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred" && used > 0) current *= 100;
      else if (w === "thousand" && used > 0) {
        value += current * 1000;
        current = 0;
      } else if (w === "and" && used > 0 && i + used + 1 < words.length && (words[i + used + 1] in UNITS || words[i + used + 1] in TENS)) {
        /* "one hundred and five" */
      } else break;
      used++;
    }
    if (used > 0) {
      out.push(String(value + current));
      i += used;
    } else {
      out.push(words[i++]);
    }
  }
  return out;
}

export function normalizeText(s: string): string[] {
  const words = s
    .toLowerCase()
    .replace(/(\d)\s*\/\s*(\d)/g, "$1 / $2") // 140/90 -> 140 / 90
    .replace(/(\d)(mg|ml|kg|cm)\b/g, "$1 $2") // 500mg -> 500 mg
    .replace(/[^\p{L}\p{N}/.\s-]/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ") // drop sentence dots, keep 9.8
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w);
  return numberWords(words);
}

function editDistance<T>(a: T[], b: T[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wer(reference: string, hypothesis: string): { errors: number; words: number; rate: number } {
  const r = normalizeText(reference);
  const h = normalizeText(hypothesis);
  const errors = editDistance(r, h);
  return { errors, words: r.length, rate: r.length ? errors / r.length : 0 };
}

/** Character error rate on whitespace-normalized, case-insensitive text. */
export function cer(reference: string, hypothesis: string): { errors: number; chars: number; rate: number } {
  const norm = (s: string) => [...s.toLowerCase().replace(/\s+/g, " ").trim()];
  const r = norm(reference);
  const errors = editDistance(r, norm(hypothesis));
  return { errors, chars: r.length, rate: r.length ? errors / r.length : 0 };
}
