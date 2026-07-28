import assert from "node:assert/strict";
import test from "node:test";
import { collectGeneratedMath } from "../server/generatedMathCollector.js";

test("collects inline math fragments with offsets and extraction reasons", () => {
  const result = {
    steps: [
      {
        heading: "Use \\(t=\\arctan x\\)",
        summary: "Then \\(G\\) appears only as a symbol in prose.",
        latex: "t=\\arctan x",
      },
    ],
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2+G",
  };

  const fields = collectGeneratedMath(result);
  const heading = fields.find((field) => field.fieldPath === "steps[0].heading");
  const summary = fields.find((field) => field.fieldPath === "steps[0].summary");
  const final = fields.find((field) => field.fieldPath === "finalAnswerLatex");

  assert.equal(heading.value, "t=\\arctan x");
  assert.equal(heading.extractionReason, "inline_math_parentheses");
  assert.equal(heading.fragmentStart, "Use \\(".length);
  assert.equal(heading.fragmentEnd, heading.fragmentStart + "t=\\arctan x".length);
  assert.equal(summary.value, "G");
  assert.equal(summary.extractionReason, "inline_math_parentheses");
  assert.equal(final.extractionReason, null);
});

test("does not collect ordinary prose letters as generated math", () => {
  const fields = collectGeneratedMath({
    steps: [
      {
        label: "Now compare constants",
        title: "No generated variables",
        summary: "An ordinary sentence contains t and G but no math delimiters.",
        plainExplanation: "Nothing here defines a symbol.",
        latex: "1",
      },
    ],
    finalAnswerLatex: "1",
  });

  assert.equal(fields.some((field) => /label|title|summary|plainExplanation/u.test(field.fieldPath)), false);
  assert.deepEqual(fields.map((field) => field.fieldPath), ["steps[0].latex", "finalAnswerLatex"]);
});
