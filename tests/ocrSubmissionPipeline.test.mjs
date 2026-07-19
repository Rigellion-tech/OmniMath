import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExtractionSubmissionPayload, normalizeOcrTextForSubmission } from "../src/api/mathClient.js";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";
import { validateExtraction } from "../server/extractionValidation.js";

const OCR_EXAMPLE = "Let C be the positively oriented boundary of the surface. F(x,y,z) = < y^2 z + e^{x^2} sin(yz), ln(1+z^2), cos(xy)/(1+x^2+y^2), xy e^{-z^2}, arctan(x-y) >";
const OCR_EXAMPLE_LATEX = String.raw`\text{Let } C \text{ be the positively oriented boundary of the surface. } \mathbf{F}(x,y,z)=\left\langle y^2 z + e^{x^2}\sin(yz), \ln(1+z^2), \frac{\cos(xy)}{1+x^2+y^2}, xy e^{-z^2}, \arctan(x-y) \right\rangle`;
const TOKEN_PER_LINE_PREVIEW = "F\n(\nx\n,\ny\n,\nz\n)\n=\ny\n^\n2\nz\n+\ne\n^\n{\nx\n^\n2\n}";
const UPPER_ELLIPSOID_STOKES = "Let S be the upper half of the ellipsoid x^2/4 + y^2/9 + z^2 = 1, z >= 0, oriented upward. Use Stokes' theorem to evaluate the circulation of F(x,y,z)=<y^2 z + e^{x^2} sin(yz), ln(1+z^2), cos(xy)/(1+x^2+y^2)> around the boundary C.";

describe("OCR submission pipeline", () => {
  it("keeps the single-line OCR transcription as readable editable text", () => {
    const normalized = normalizeOcrTextForSubmission(OCR_EXAMPLE);

    assert.equal(normalized, OCR_EXAMPLE);
    assert.equal(/F\n\(/.test(normalized), false);
    assert.equal(/\ny\n\^\n2\n/.test(normalized), false);
  });

  it("repairs obvious token-per-line display text before solver submission", () => {
    const normalized = normalizeOcrTextForSubmission(TOKEN_PER_LINE_PREVIEW);

    assert.equal(normalized.includes("F(x,y,z)="), true);
    assert.equal(normalized.includes("\n"), false);
    assert.equal(/\ny\n/.test(normalized), false);
  });

  it("repairs spaced OCR relational operators before solver submission", () => {
    const input = "z > = 0\nx^2/4 + y^2/9 < = 1\n0 < = r < = 1\n0 < = θ < = 2π";
    const normalized = normalizeOcrTextForSubmission(input);

    assert.equal(normalized, "z >= 0\nx^2/4 + y^2/9 <= 1\n0 <= r <= 1\n0 <= θ <= 2π");
  });

  it("does not report exponent loss for preserved vector-field terms", () => {
    const validation = validateExtraction({
      extractedProblemText: OCR_EXAMPLE,
      extractedProblemLatex: OCR_EXAMPLE_LATEX,
      ocrConfidence: 96,
      modelConfidence: 96,
    });

    assert.equal(validation.status, "ok");
    assert.equal(validation.critical, false);
    assert.equal(validation.issues.some((issue) => issue.type === "exponent_loss"), false);
    assert.equal(validation.issues.some((issue) => /yz|near z/.test(issue.message || "")), false);
  });

  it("builds API payloads from canonical OCR state, not rendered preview content", () => {
    const extraction = {
      rawExtractedText: OCR_EXAMPLE,
      extractedProblemText: OCR_EXAMPLE,
      extractedProblemLatex: OCR_EXAMPLE_LATEX,
      displaySegments: [
        { type: "math", text: TOKEN_PER_LINE_PREVIEW, latex: "F(x,y,z)=y^2z+e^{x^2}" },
      ],
    };
    const payload = buildExtractionSubmissionPayload({
      extraction,
      displayText: OCR_EXAMPLE,
      rawText: OCR_EXAMPLE,
      solveDecision: "direct",
    });

    assert.equal(payload.problem, OCR_EXAMPLE);
    assert.equal(payload.problemText, OCR_EXAMPLE);
    assert.equal(payload.problem.includes(TOKEN_PER_LINE_PREVIEW), false);
    assert.equal(payload.problem.includes("F\n("), false);
    assert.equal(payload.problem.includes("y^2 z"), true);
    assert.equal(payload.problem.includes("e^{x^2}"), true);
    assert.equal(payload.problem.includes("xy e^{-z^2}"), true);
    assert.equal(payload.extraction.rawText, OCR_EXAMPLE);
    assert.equal(payload.extraction.displayText, OCR_EXAMPLE);
    assert.equal(payload.extraction.normalizedText, OCR_EXAMPLE);
    assert.equal(payload.extraction.validationText, OCR_EXAMPLE);
    assert.deepEqual(payload.extraction.previewMath, extraction.displaySegments);
  });

  it("builds solver payloads with repaired spaced OCR relational operators", () => {
    const input = "z > = 0\nx^2/4 + y^2/9 < = 1\n0 < = r < = 1\n0 < = θ < = 2π";
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        rawExtractedText: input,
        extractedProblemText: input,
      },
      displayText: input,
      rawText: input,
      solveDecision: "direct",
    });

    assert.equal(payload.problem, "z >= 0\nx^2/4 + y^2/9 <= 1\n0 <= r <= 1\n0 <= θ <= 2π");
    assert.equal(payload.extraction.normalizedText, payload.problem);
    assert.equal(payload.extraction.validationText, payload.problem);
  });

  it("builds solver payloads from canonical text instead of broken preview LaTeX", () => {
    const canonicalText = "Let C be the boundary where z >= 0 and x^2/4 + y^2/9 <= 1 with e^(x^2), e^(-z^2), theta, and 2pi.";
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        rawExtractedText: canonicalText,
        extractedProblemText: canonicalText,
        extractedProblemLatex: "\\frac{e^{x^2}}{",
        displaySegments: [
          { type: "math", text: "e^(x^2)", latex: "\\frac{e^{x^2}}{", renderIssue: "KaTeX parse error" },
        ],
      },
      displayText: canonicalText,
      rawText: canonicalText,
      solveDecision: "direct",
    });

    assert.equal(payload.problem, canonicalText);
    assert.equal(payload.problem.includes("\\frac{e^{x^2}}{"), false);
    assert.equal(payload.extraction.normalizedText, canonicalText);
    assert.equal(payload.extraction.validationText, canonicalText);
    assert.equal(payload.extraction.previewMath[0].renderIssue, "KaTeX parse error");
  });

  it("submits canonical reviewed text for low-confidence extractions", () => {
    const canonicalText = "Let C be the boundary where z >= 0 and x^2/4 + y^2/9 <= 1 with e^{x^2}, e^{-z^2}, theta, and 2pi.";
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        extractedProblemText: canonicalText,
        extractedProblemLatex: "\\frac{e^{x^2}}{",
        confidenceTier: "low",
        confidence: 50,
        mathIntegrityScore: 50,
        extractionValidation: {
          status: "danger",
          tier: "low",
          critical: true,
          confidence: 50,
          issues: [{ type: "low_confidence", severity: "high", message: "Review required before solving." }],
        },
        previewMath: [
          { type: "math", text: "e^{x^2}", latex: "\\frac{e^{x^2}}{", renderIssue: "KaTeX parse error" },
        ],
      },
      displayText: canonicalText,
      rawText: canonicalText,
      solveDecision: "direct",
      source: "ocr-reviewed",
    });

    assert.equal(payload.solveDecision, "direct");
    assert.equal(payload.problem, canonicalText);
    assert.equal(payload.problemLatex, undefined);
    assert.equal(payload.canonicalProblem.source, "ocr-reviewed");
    assert.equal(payload.extraction.normalizedText, canonicalText);
    assert.equal(payload.extraction.validationText, canonicalText);
    assert.equal(payload.problem.includes("\\frac{e^{x^2}}{"), false);
  });

  it("uses the same frozen canonical hash for normal and compare-methods solves", () => {
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        rawExtractedText: UPPER_ELLIPSOID_STOKES,
        extractedProblemText: UPPER_ELLIPSOID_STOKES,
        confidence: 96,
      },
      displayText: UPPER_ELLIPSOID_STOKES,
      rawText: UPPER_ELLIPSOID_STOKES,
      solveDecision: "direct",
    });
    const compareCanonical = createCanonicalProblemPayload({
      canonicalText: payload.canonicalProblem.canonicalText,
      canonicalLatex: payload.canonicalProblem.canonicalLatex,
      source: payload.canonicalProblem.source,
      extractionWarnings: payload.canonicalProblem.extractionWarnings,
      extractionConfidence: payload.canonicalProblem.extractionConfidence,
    });

    assert.equal(payload.problem, UPPER_ELLIPSOID_STOKES);
    assert.equal(payload.canonicalProblem.hash, compareCanonical.hash);
    assert.equal(payload.extraction.canonicalProblem.hash, payload.canonicalProblem.hash);
  });
});
