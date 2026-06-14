import assert from "node:assert/strict";
import test from "node:test";
import { buildExtractedProblemDisplay, normalizeExtractedProblemText } from "../server/ocrTextNormalization.js";
import { validateExtraction } from "../server/extractionValidation.js";

test("repairs common missing OCR spaces around statement boundaries and variables", () => {
  const input = "LetSbe the portion of the paraboloidz=9-x^2-y^2 lying above the planez=0,oriented upward. Its boundary curve isC. Evaluate dSwhereF is shown.";
  const result = normalizeExtractedProblemText(input);

  assert.match(result.text, /Let S be/);
  assert.match(result.text, /paraboloid z = 9/);
  assert.match(result.text, /plane z = 0, oriented/);
  assert.match(result.text, /curve is C/);
  assert.match(result.text, /dS where F/);
  assert.equal(result.changed, true);
  assert.equal(result.substantial, true);
});

test("builds display segments for the Stokes image problem without collapsed prose", () => {
  const input = "LetSbe the portion of the paraboloidz=9 - x^2 - y^2 lying above the planez=0,oriented upward. Its boundary curve isC. Evaluate ∬_S (∇ × F) · n dS where F(x,y,z)=<yz^2 + e^(x^2) sin(y), x^3z + ln(1+z^2), xy^2 + zcos(xy)>.";
  const cleanup = normalizeExtractedProblemText(input);
  const display = buildExtractedProblemDisplay({
    rawOcrText: input,
    cleanedPlainText: cleanup.text,
    extractedProblemLatex: "",
  });
  const plain = display.displaySegments.filter((segment) => segment.type === "text").map((segment) => segment.text).join(" ");
  const math = display.displaySegments.filter((segment) => segment.type === "math");

  assert.equal(/LetSbe|paraboloidz|planez|isC/.test(display.cleanedPlainText), false);
  assert.match(plain, /Let S be the portion of the paraboloid/);
  assert.ok(math.some((segment) => /z=9-x/.test(segment.latex.replace(/\s+/g, ""))));
  assert.ok(math.some((segment) => /\\iint/.test(segment.latex)));
  assert.ok(math.some((segment) => /\\mathbf\{F\}/.test(segment.latex) && /\\left\\langle/.test(segment.latex)));
  assert.equal(math.some((segment) => segment.renderIssue), false);
});

test("substantial OCR cleanup marks extraction as review suggested", () => {
  const cleanup = normalizeExtractedProblemText("LetSbe the portion of the paraboloidz=9-x^2-y^2,oriented upward.");
  const validation = validateExtraction({
    extractedProblemText: cleanup.text,
    extractedProblemLatex: "\\text{Let } S \\text{ be the portion of } z=9-x^2-y^2 \\text{, oriented upward.}",
    ocrConfidence: 96,
    textCleanup: cleanup,
  });

  assert.equal(validation.status, "warning");
  assert.equal(validation.tier, "medium");
  assert.ok(validation.issues.some((issue) => issue.type === "ocr_text_cleanup_review"));
});
