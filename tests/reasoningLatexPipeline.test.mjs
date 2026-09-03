import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectReasoningValue } from "../src/lib/reasoningLatexDiagnostics.js";
import { normalizeMixedDisplayText } from "../src/lib/mathAnnotator.js";
import { canonicalLatexForKatex } from "../src/lib/mathNode.js";
import { convertFastSolveToMathExplanation } from "../server/mathExplanationSchema.js";

const mixedReasoning = String.raw`Substitute \(dx=\sec^2 t\,dt\), use \(0\le t\le\pi/2\), and simplify \(\ln(\sec^2 t)=-2\ln(\cos t)\).`;

describe("reasoning LaTeX pipeline diagnostics", () => {
  it("preserves explicit generated LaTeX through inline-math normalization", () => {
    const inspection = inspectReasoningValue(mixedReasoning);
    const spans = inspection.detectedMathSpans;

    assert.deepEqual(spans.map((span) => span.source), [
      String.raw`dx=\sec^2 t\,dt`,
      String.raw`0\le t\le\pi/2`,
      String.raw`\ln(\sec^2 t)=-2\ln(\cos t)`,
    ]);
    assert.deepEqual(spans.map((span) => span.normalized), [
      String.raw`dx=\sec^2 t\,dt`,
      String.raw`0\le t\le\pi/2`,
      String.raw`\ln(\sec^2 t)=-2\ln(\cos t)`,
    ]);
    assert.ok(spans.every((span) => span.dispatch === "katex"));
    assert.ok(spans.every((span) => span.normalization === "transport-only"));
    spans.forEach((span) => assert.doesNotMatch(span.normalized, /\\\\/u));
  });

  it("shows why a later reasoning span without rewritten command names stays intact", () => {
    const inspection = inspectReasoningValue(String.raw`The endpoint condition is \(\ln(x)=0\).`);

    assert.equal(inspection.detectedMathSpans.length, 1);
    assert.equal(inspection.detectedMathSpans[0].source, String.raw`\ln(x)=0`);
    assert.equal(inspection.detectedMathSpans[0].normalized, String.raw`\ln(x)=0`);
    assert.equal(inspection.detectedMathSpans[0].dispatch, "katex");
  });

  it("preserves valid mixed-prose LaTeX spans for the architectural fix", () => {
    const spans = inspectReasoningValue(mixedReasoning).detectedMathSpans;

    assert.deepEqual(spans.map((span) => span.normalized), [
      String.raw`dx=\sec^2 t\,dt`,
      String.raw`0\le t\le\pi/2`,
      String.raw`\ln(\sec^2 t)=-2\ln(\cos t)`,
    ]);
  });

  it("passes exact single-backslash strings into the canonical KaTeX input", () => {
    const spans = inspectReasoningValue(mixedReasoning).detectedMathSpans;
    const katexInputs = spans.map((span) => canonicalLatexForKatex(span.normalized));

    assert.deepEqual(katexInputs, [
      String.raw`dx=\sec^2 t\,dt`,
      String.raw`0\le t\le\pi/2`,
      String.raw`\ln(\sec^2 t)=-2\ln(\cos t)`,
    ]);
    katexInputs.forEach((value) => assert.doesNotMatch(value, /\\\\/u));
  });

  it("groups undelimited generated expressions without splitting at whitespace", () => {
    const reasoning = String.raw`Substitute dx=\sec^2 t\,dt, use 0\le t\le\pi/2, and simplify \ln(\sec^2 t)=-2\ln(\cos t).`;
    const inspection = inspectReasoningValue(reasoning);

    assert.deepEqual(inspection.detectedMathSpans.map((span) => span.source), [
      String.raw`dx=\sec^2 t\,dt`,
      String.raw`0\le t\le\pi/2`,
      String.raw`\ln(\sec^2 t)=-2\ln(\cos t)`,
    ]);
    assert.deepEqual(
      inspection.detectedMathSpans.map((span) => span.normalized),
      inspection.detectedMathSpans.map((span) => span.source),
    );
  });

  it("keeps backend prose cleanup outside explicit and undelimited LaTeX spans", () => {
    const explicit = String.raw`Use \(dx=\sec^2 t\,dt\) now.`;
    const undelimited = String.raw`Use dx=\sec^2 t\,dt now.`;

    assert.equal(normalizeMixedDisplayText(explicit), explicit);
    assert.equal(normalizeMixedDisplayText(undelimited), undelimited);
  });

  it("preserves reasoning LaTeX through the real backend conversion path", () => {
    const reasoning = String.raw`Substitute \(dx=\sec^2 t\,dt\) and use \(0\le t\le\pi/2\).`;
    const explanation = convertFastSolveToMathExplanation({
      title: "Reasoning preservation",
      problemLatex: "I=0",
      steps: [
        { id: "step-1", heading: "Substitute", latex: "I=0", reasoning, anchors: [] },
        { id: "step-2", heading: "Final Answer", latex: "0", reasoning: "State the result.", anchors: [] },
      ],
      finalAnswerLatex: "0",
      numericCheck: "0",
    });

    assert.equal(explanation.steps[0].summary, reasoning);
    assert.equal(explanation.steps[0].plainExplanation, reasoning);
  });

  it("continues normalizing unescaped OCR-style math", () => {
    const span = inspectReasoningValue("The discriminant is b² − 4ac.").detectedMathSpans[0];

    assert.equal(span.source, "b² − 4ac");
    assert.equal(span.normalized, "b^2 - 4ac");
    assert.equal(span.normalization, "plain-ocr");
  });

  it("preserves unrelated LaTeX commands through the same transport-only route", () => {
    const source = String.raw`Apply \(\operatorname{Li}_2(x)+\frac{1}{2}\Gamma(x)+\sum_{k=1}^n k\).`;
    const span = inspectReasoningValue(source).detectedMathSpans[0];
    const expected = String.raw`\operatorname{Li}_2(x)+\frac{1}{2}\Gamma(x)+\sum_{k=1}^n k`;

    assert.equal(span.source, expected);
    assert.equal(span.normalized, expected);
    assert.equal(span.normalization, "transport-only");
    assert.doesNotMatch(canonicalLatexForKatex(span.normalized), /\\\\/u);
  });

  it("keeps whitespace inside command arguments in the LaTeX span", () => {
    const source = String.raw`Explain \text{the substitution} using \operatorname{Li}_2(x).`;
    const inspection = inspectReasoningValue(source);

    assert.deepEqual(inspection.detectedMathSpans.map((span) => span.source), [
      String.raw`\text{the substitution}`,
      String.raw`\operatorname{Li}_2(x)`,
    ]);
    assert.deepEqual(
      inspection.detectedMathSpans.map((span) => span.normalized),
      inspection.detectedMathSpans.map((span) => span.source),
    );
    assert.equal(normalizeMixedDisplayText(source), source);
  });
});
