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

  it("lowers confidence for low OCR confidence and superscript-heavy screenshots", () => {
    const validation = validateExtraction({
      extractedProblemText: "x^2+y^2+z^2",
      extractedProblemLatex: "x^2+y^2+z^2",
      ocrConfidence: 52,
    });

    assert.equal(validation.status, "warning");
    assert.ok(validation.issues.some((issue) => issue.type === "many_superscripts"));
    assert.ok(validation.issues.some((issue) => issue.type === "low_ocr_confidence"));
    assert.ok(validation.confidence < 52);
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
