import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessOcrSolveDecision, assertOcrSolveAllowed } from "../server/ocrSolvePolicy.js";

const mediumMismatch = {
  tier: "medium",
  confidence: 64,
  critical: false,
  issues: [
    { type: "ocr_text_cleanup_review", severity: "medium" },
    { type: "text_latex_mismatch", severity: "medium" },
  ],
  metrics: {
    differenceRatio: 0.649,
    textCleanup: { substantial: true, changeRatio: 0.513 },
  },
};

describe("OCR solve decision policy", () => {
  it("blocks a medium-confidence structural mismatch from silent direct solve", () => {
    const decision = assessOcrSolveDecision({
      solveDecision: "direct",
      extractionValidation: mediumMismatch,
    });
    assert.equal(decision.reviewRequired, true);
    assert.equal(decision.structuralDisagreement, true);
    assert.throws(
      () => assertOcrSolveAllowed({ solveDecision: "direct", extractionValidation: mediumMismatch }),
      (error) => error.code === "OCR_REVIEW_REQUIRED" && error.statusCode === 409,
    );

    assert.throws(
      () => assertOcrSolveAllowed({
        solveDecision: "confirmed",
        extractionValidation: { tier: "high", confidence: 95, critical: false, issues: [] },
        reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: "revision-a" },
        canonicalInputHash: "revision-b",
      }),
      (error) => error.code === "OCR_REVIEW_REQUIRED"
        && error.ocrSolveDecision.reason === "ocr-review-action-input-mismatch",
    );
  });

  it("allows an explicit user review decision to proceed", () => {
    const decision = assertOcrSolveAllowed({
      solveDecision: "edited",
      extractionValidation: mediumMismatch,
      reviewAction: { kind: "edited", canonicalInputHash: "revision-a" },
      canonicalInputHash: "revision-a",
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "explicit-user-review-decision");
  });

  it("allows unchanged confirmation only for the acknowledged canonical revision", () => {
    const allowed = assertOcrSolveAllowed({
      solveDecision: "confirmed",
      extractionValidation: mediumMismatch,
      reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: "revision-a" },
      canonicalInputHash: "revision-a",
    });
    assert.equal(allowed.humanReviewAcknowledged, true);
    assert.equal(allowed.reviewActionValid, true);

    assert.throws(
      () => assertOcrSolveAllowed({
        solveDecision: "confirmed",
        extractionValidation: mediumMismatch,
        reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: "revision-a" },
        canonicalInputHash: "revision-b",
      }),
      (error) => error.code === "OCR_REVIEW_REQUIRED"
        && error.ocrSolveDecision.reviewActionValid === false,
    );
  });

  it("does not accept edited provenance without a revision-bound edit action", () => {
    assert.throws(
      () => assertOcrSolveAllowed({
        solveDecision: "edited",
        extractionValidation: mediumMismatch,
        canonicalInputHash: "revision-a",
      }),
      (error) => error.code === "OCR_REVIEW_REQUIRED",
    );
  });

  it("allows a high-confidence clean extraction", () => {
    const decision = assessOcrSolveDecision({
      solveDecision: "direct",
      extractionValidation: { tier: "high", confidence: 92, critical: false, issues: [] },
    });
    assert.equal(decision.reviewRequired, false);
    assert.equal(decision.reason, "ocr-no-structural-review-finding");
  });

  it("ignores review-like metadata on a direct clean submission", () => {
    const decision = assessOcrSolveDecision({
      solveDecision: "direct",
      extractionValidation: { tier: "high", confidence: 92, critical: false, issues: [] },
      reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: "revision-a" },
      canonicalInputHash: "revision-a",
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.humanReviewAcknowledged, false);
    assert.equal(decision.reviewActionValid, false);
  });

  it("does not invent review thresholds from confidence or unflagged raw metrics", () => {
    const decision = assessOcrSolveDecision({
      extractionValidation: {
        tier: "medium", confidence: 64, critical: false, issues: [],
        metrics: { differenceRatio: 0.7, textCleanup: { substantial: true, changeRatio: 0.513 } },
      },
    });
    assert.equal(decision.reviewRequired, false);
    assert.equal(decision.structuralDisagreement, false);
    assert.equal(decision.metrics.differenceRatio, 0.7);
  });

  it("honors an existing critical review independently of confidence", () => {
    const decision = assessOcrSolveDecision({
      extractionValidation: { tier: "high", confidence: 92, critical: true, issues: [] },
    });
    assert.equal(decision.reviewRequired, true);
  });

  it("keeps legacy requests with no extraction evidence compatible", () => {
    const decision = assessOcrSolveDecision({
      solveDecision: "direct",
      extractionValidation: { confidence: 0, tier: "", issues: [] },
    });
    assert.equal(decision.hasEvidence, false);
    assert.equal(decision.allowed, true);
  });
});
