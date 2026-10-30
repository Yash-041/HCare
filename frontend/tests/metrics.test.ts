import { describe, expect, it } from "vitest";
import { cer, normalizeText, wer } from "../src/lib/eval/metrics";

describe("evaluation metrics", () => {
  it("normalizes spoken numbers, units and punctuation", () => {
    expect(normalizeText("Blood pressure is one hundred forty over ninety.")).toEqual(["blood", "pressure", "is", "140", "/", "90"]);
    expect(normalizeText("BP is 140/90")).toEqual(["bp", "is", "140", "/", "90"]);
    expect(normalizeText("Paracetamol 500mg, three times a day")).toEqual(["paracetamol", "500", "mg", "3", "times", "a", "day"]);
    expect(normalizeText("five hundred milligrams")).toEqual(["500", "mg"]);
    expect(normalizeText("Hb 9.8 g/dL.")).toEqual(["hb", "9.8", "g/dl"]);
    expect(normalizeText("ninety six")).toEqual(["96"]);
  });

  it("formatting differences are not errors; real word errors are", () => {
    expect(wer("Pulse is ninety six.", "pulse is 96").rate).toBe(0);
    expect(wer("She is allergic to penicillin", "She is allergic to penicillin.").rate).toBe(0);
    const r = wer("give paracetamol three times a day", "give paracetamol two times day");
    expect(r).toEqual({ errors: 2, words: 6, rate: 2 / 6 }); // one substitution, one deletion
  });

  it("character error rate", () => {
    expect(cer("Haemoglobin 9.8 g/dL", "Haemoglobin  9.8 g/dL").rate).toBe(0);
    expect(cer("Haemoglobin 9.8", "Haemoglobln 9.8").errors).toBe(1);
  });
});
