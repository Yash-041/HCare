/**
 * Optional plain-language narrative of a HistorySummary, written by the on-device LLM.
 * The model sees only numbered facts (already traceable to records), must cite them as
 * [n], and every sentence is validated: no citation, an unknown citation, or numbers /
 * words not present in the cited facts -> the sentence is dropped.
 */
import { normalize } from "../../ai/extract/rules";
import type { HistorySummary, SourceLink, Statement } from "./summary";

export type NarrativeGenerate = (messages: { role: "system" | "user"; content: string }[], prefill: string) => Promise<string>;

export interface NarrativeSentence {
  text: string;
  sources: SourceLink[];
}

export function factsOf(s: HistorySummary): Statement[] {
  return [
    ...s.alerts,
    ...s.allergies.map((a) => ({ ...a, text: `Allergy: ${a.text}` })),
    ...s.conditions.map((c) => ({ ...c, text: `Condition: ${c.text}` })),
    ...s.medications.map((m) => ({ ...m, text: `Medicine: ${m.text}` })),
    ...s.trends.map((t) => t.statement),
  ];
}

export function buildNarrativeMessages(facts: Statement[]) {
  return [
    {
      role: "system" as const,
      content:
        "You summarize a patient's history for a clinician in 2-4 short sentences. Use ONLY the numbered facts. " +
        "End every sentence with the fact numbers it uses, like [2][5]. Do not add diagnoses, advice or anything not in the facts.",
    },
    { role: "user" as const, content: `Facts:\n${facts.map((f, i) => `[${i + 1}] ${f.text}`).join("\n")}\n\nSummary:` },
  ];
}

const words = (s: string) => normalize(s).split(/[^\p{L}\p{N}.]+/u).filter((w) => w.length >= 4 && !/^\d/.test(w));
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !/^\d$/.test(n));

export function validateNarrative(raw: string, facts: Statement[]): { sentences: NarrativeSentence[]; dropped: number } {
  const sentences: NarrativeSentence[] = [];
  let dropped = 0;
  const parts = raw
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?](?:\s*\[\d+\])*)\s+(?=[A-Z])/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const cites = [...part.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const text = part.replace(/\s*\[\d+\]/g, "").trim();
    const cited = cites.map((n) => facts[n - 1]);
    if (!cites.length || cited.some((f) => !f)) {
      dropped++;
      continue;
    }
    const support = normalize(cited.map((f) => f.text).join(" "));
    // Numbers must be copied from the cited facts; most content words must appear there too.
    const nums = numbers(text);
    const ws = words(text);
    const wordSupport = ws.length ? ws.filter((w) => support.includes(w)).length / ws.length : 1;
    if (nums.some((n) => !support.includes(n)) || wordSupport < 0.5) {
      dropped++;
      continue;
    }
    const seen = new Set<string>();
    sentences.push({
      text,
      sources: cited.flatMap((f) => f.sources).filter((s) => !seen.has(s.id) && seen.add(s.id)),
    });
  }
  return { sentences, dropped };
}

export async function writeNarrative(summary: HistorySummary, generate: NarrativeGenerate) {
  const facts = factsOf(summary);
  if (facts.length === 0) return { sentences: [], dropped: 0 };
  const raw = await generate(buildNarrativeMessages(facts), "");
  return validateNarrative(raw, facts);
}
