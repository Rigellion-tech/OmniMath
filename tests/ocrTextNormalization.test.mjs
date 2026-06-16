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
  assert.ok(math.some((segment) => /\\mathbf\{F\}/.test(segment.latex) && /\\langle/.test(segment.latex)));
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

test("normalizes spoken OCR math phrases before display and solving", () => {
  const input = "Evaluate e to the x squared plus sin y where x squared plus y squared equals 9 and cos xy appears.";
  const result = normalizeExtractedProblemText(input);

  assert.equal(result.text.includes("x squared"), false);
  assert.equal(result.text.includes("y squared"), false);
  assert.match(result.text, /e\^\{x\^2\}/);
  assert.match(result.text, /\\sin\(y\)/);
  assert.match(result.text, /x\^2/);
  assert.match(result.text, /y\^2/);
  assert.match(result.text, /\\cos\(xy\)/);
});

test("normalizes spaced OCR relational operators before validation and solving", () => {
  const input = "z > = 0\nx^2/4 + y^2/9 < = 1\n0 < = r < = 1\n0 < = θ < = 2π";
  const result = normalizeExtractedProblemText(input);

  assert.equal(result.text, "z >= 0 x^2/4 + y^2/9 <= 1 0 <= r <= 1 0 <= θ <= 2π");
  assert.equal(result.changed, true);
  assert.equal(result.substantial, false);
});

test("uses canonical cleaned text as solver input when preview LaTeX is malformed", () => {
  const input = "Let C be the boundary where z > = 0 and x^2/4 + y^2/9 < = 1 with e^(x^2), e^(-z^2), theta, and 2pi.";
  const cleanup = normalizeExtractedProblemText(input);
  const display = buildExtractedProblemDisplay({
    rawOcrText: input,
    cleanedPlainText: cleanup.text,
    extractedProblemLatex: "\\frac{e^{x^2}}{",
  });

  assert.equal(display.solverInput, cleanup.text);
  assert.match(display.solverInput, /z >= 0/);
  assert.match(display.solverInput, /x\^2\/4 \+ y\^2\/9 <= 1/);
  assert.equal(display.solverInput.includes("\\frac{e^{x^2}}{"), false);
});
