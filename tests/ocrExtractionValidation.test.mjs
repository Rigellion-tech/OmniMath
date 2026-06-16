import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateExtraction } from "../server/extractionValidation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const screenshotFixturePath = join(__dirname, "fixtures", "ocr-screenshots", "power-regressions.svg");
const screenshotRegressionFixtures = Array.from(
  readFileSync(screenshotFixturePath, "utf8").matchAll(/data-expected="([^"]+)"/gu),
  (match) => match[1]
);

describe("OCR extraction validation", () => {
  it("accepts screenshot fixture expressions when text and LaTeX preserve structure", () => {
    assert.deepEqual(screenshotRegressionFixtures, [
      "e^{x^2}",
      "e^{x^3}",
      "x^3z",
      "x^{10}",
      "y^2z^2",
      "\\cos(xy)",
    ]);

    for (const expression of screenshotRegressionFixtures) {
      const validation = validateExtraction({
        extractedProblemText: expression,
        extractedProblemLatex: expression,
        ocrConfidence: 96,
      });

      assert.equal(validation.status, "ok", expression);
      assert.equal(validation.issues.length, 0, expression);
      assert.ok(validation.confidence >= 90, expression);
    }
  });

  it("detects nested exponent loss before solving a screenshot extraction", () => {
    const validation = validateExtraction({
      extractedProblemText: "e^{x^2}",
      extractedProblemLatex: "e^x",
      ocrConfidence: 94,
    });

    assert.equal(validation.status, "danger");
    assert.ok(validation.issues.some((issue) => issue.type === "exponent_loss"));
  });

  it("accepts semantic Unicode operator normalization without lowering confidence", () => {
    const validation = validateExtraction({
      extractedProblemText: "z \\ge 0\nr \\le 1",
      extractedProblemLatex: "z ≥ 0\nr ≤ 1",
      ocrConfidence: 96,
      modelConfidence: 96,
    });

    assert.equal(validation.status, "ok");
    assert.equal(validation.tier, "high");
    assert.equal(validation.critical, false);
    assert.equal(validation.issues.length, 0);
    assert.ok(validation.confidence >= 90);
  });

  it("accepts common LaTeX operator commands represented as equivalent Unicode symbols", () => {
    const validation = validateExtraction({
      extractedProblemText: "x \\neq 0 \\pm 1 \\times 2",
      extractedProblemLatex: "x ≠ 0 ± 1 × 2",
      ocrConfidence: 96,
      modelConfidence: 96,
    });

    assert.equal(validation.status, "ok");
    assert.equal(validation.issues.some((issue) => issue.type === "command_stripping"), false);
    assert.ok(validation.confidence >= 90);
  });

  it("does not flag compact normalized inequalities as merged LaTeX commands", () => {
    const validation = validateExtraction({
      extractedProblemText: "z >= 0\nx^2/4 + y^2/9 <= 1\n0 <= r <= 1\n0 <= θ <= 2π",
      extractedProblemLatex: "z\\ge0\nx^2/4+y^2/9\\le1\n0\\le r\\le1\n0\\le θ\\le2π",
      ocrConfidence: 96,
      modelConfidence: 96,
    });

    assert.equal(validation.status, "ok");
    assert.equal(validation.tier, "high");
    assert.equal(validation.issues.some((issue) => issue.type === "malformed_command"), false);
    assert.ok(validation.confidence >= 90);
  });

  it("does not make malformed preview LaTeX blocking when canonical OCR text is usable", () => {
    const canonicalText = [
      "Let C be the boundary of the region z >= 0.",
      "x^2/4 + y^2/9 <= 1.",
      "The integrand includes e^(x^2) and e^(-z^2).",
      "Use 0 <= r <= 1 and 0 <= theta <= 2pi.",
    ].join(" ");
    const validation = validateExtraction({
      extractedProblemText: canonicalText,
      extractedProblemLatex: "\\frac{e^{x^2}}{",
      ocrConfidence: 96,
      modelConfidence: 96,
    });

    assert.notEqual(validation.status, "danger");
    assert.equal(validation.tier, "high");
    assert.equal(validation.critical, false);
    assert.equal(validation.issues.some((issue) => issue.type === "malformed_latex"), false);
    assert.equal(validation.issues.some((issue) => issue.type === "unbalanced_braces"), false);
    assert.ok(validation.confidence >= 90);
  });

  it("detects changed superscripts in adjacent-variable screenshot expressions", () => {
    const validation = validateExtraction({
      extractedProblemText: "x^3z",
      extractedProblemLatex: "x^2z",
      ocrConfidence: 91,
    });

    assert.equal(validation.status, "danger");
    assert.match(validation.issues.find((issue) => issue.type === "exponent_loss")?.message || "", /expected 3, saw 2/);
  });

  it("detects removed multi-digit superscripts and dropped subscripts", () => {
    const exponentValidation = validateExtraction({
      extractedProblemText: "x^{10}",
      extractedProblemLatex: "x",
      ocrConfidence: 89,
    });
    const subscriptValidation = validateExtraction({
      extractedProblemText: "a_1+b_2",
      extractedProblemLatex: "a+b",
      ocrConfidence: 89,
    });

    assert.ok(exponentValidation.issues.some((issue) => issue.type === "exponent_loss"));
    assert.ok(subscriptValidation.issues.some((issue) => issue.type === "subscript_loss"));
  });

  it("flags dropped parentheses around interpreted function arguments", () => {
    const validation = validateExtraction({
      extractedProblemText: "\\cos(xy)",
      extractedProblemLatex: "\\cos xy",
      ocrConfidence: 93,
    });

    assert.equal(validation.status, "danger");
    assert.equal(validation.tier, "low");
    assert.equal(validation.critical, true);
    assert.ok(validation.issues.some((issue) => issue.type === "parentheses_loss"));
  });

  it("does not lower confidence for superscript-heavy screenshots alone", () => {
    const validation = validateExtraction({
      extractedProblemText: "x^2+y^2+z^2",
      extractedProblemLatex: "x^2+y^2+z^2",
      ocrConfidence: 52,
    });

    assert.equal(validation.status, "ok");
    assert.equal(validation.tier, "high");
    assert.equal(validation.issues.some((issue) => issue.type === "many_superscripts"), false);
    assert.equal(validation.issues.some((issue) => issue.type === "low_ocr_confidence"), false);
  });

  it("gates very low OCR confidence before full solution generation", () => {
    const validation = validateExtraction({
      extractedProblemText: "e^x",
      extractedProblemLatex: "e^x",
      ocrConfidence: 26,
    });

    assert.equal(validation.tier, "low");
    assert.equal(validation.critical, true);
    assert.ok(validation.confidence < 60);
    assert.ok(validation.issues.some((issue) => issue.type === "low_ocr_confidence"));
  });
});
