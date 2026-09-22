import "./helpers/noExternalNetwork.mjs";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildExtractionSubmissionPayload,
  solveExtractedProblem,
} from "../src/api/mathClient.js";
import { createPendingReviewedProblemState } from "../src/lib/solutionState.js";
import { assessOcrSolveDecision } from "../server/ocrSolvePolicy.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const structuralReview = {
  status: "warning",
  tier: "medium",
  critical: false,
  confidence: 64,
  issues: [
    { type: "ocr_text_cleanup_review", severity: "medium", critical: false },
    { type: "text_latex_mismatch", severity: "medium", critical: false },
  ],
  metrics: { differenceRatio: 0.649 },
};

function responseRecorder() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk = "") {
      this.body += chunk;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

describe("architecture OCR reconciliation", () => {
  it("carries unchanged acknowledgement and validation through canonical pending state and backend eligibility", async () => {
    const problem = "x^2 + 88x + 1936 = 0";
    const extraction = {
      extractedProblemText: problem,
      extractedProblemLatex: "x^2+88x+1936=0",
      confidenceTier: "medium",
      extractionValidation: structuralReview,
      imageSource: { imageHash: "same-image-content-hash" },
    };

    const payload = buildExtractionSubmissionPayload({
      extraction,
      displayText: problem,
      rawText: problem,
      solveDecision: "confirmed",
      source: "ocr-reviewed",
    });
    const pending = createPendingReviewedProblemState(payload);
    const eligibility = assessOcrSolveDecision({
      solveDecision: payload.solveDecision,
      extractionValidation: payload.extraction.extractionValidation,
      reviewAction: payload.reviewAction,
      canonicalInputHash: payload.canonicalProblem.hash,
    });

    assert.equal(payload.canonicalProblem.source, "ocr-reviewed");
    assert.equal(payload.reviewAction.kind, "confirmed_unchanged");
    assert.equal(payload.reviewAction.canonicalInputHash, payload.canonicalProblem.hash);
    assert.equal(pending.imageSource.solveDecision, "confirmed");
    assert.equal(pending.pendingSolve, true);
    assert.deepEqual(pending.extractionValidation, structuralReview);
    assert.deepEqual(pending.imageSource.extractionValidation, structuralReview);
    assert.deepEqual(pending.reviewAction, payload.reviewAction);
    assert.equal(eligibility.reviewRequired, false);
    assert.equal(eligibility.reviewActionValid, true);
    assert.equal(eligibility.reason, "explicit-user-review-decision");

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const app = await import(`../server/app.js?architecture-ocr-${Date.now()}-${Math.random()}`);
      const req = {
        method: "POST",
        url: "/api/solve-extracted-problem",
        headers: { "content-type": "application/json", host: "localhost:8787" },
        socket: { remoteAddress: "127.8.0.1" },
        body: { ...payload, debugRequestId: "canonical-solve-reviewed-unchanged" },
      };
      const res = responseRecorder();
      await app.handleSolveExtractedProblemRequest(req, res);
      assert.equal(res.statusCode, 200);
      const response = res.json();
      assert.equal(response.requestId, "canonical-solve-reviewed-unchanged");
      assert.deepEqual(response.reviewAction, payload.reviewAction);
      assert.deepEqual(response.imageSource.reviewAction, payload.reviewAction);
      assert.deepEqual(response.extractionValidation, structuralReview);

      const directReq = {
        ...req,
        body: {
          ...payload,
          solveDecision: "direct",
          reviewAction: null,
          debugRequestId: "canonical-solve-unreviewed-direct",
        },
      };
      const directRes = responseRecorder();
      await app.handleSolveExtractedProblemRequest(directReq, directRes);
      assert.equal(directRes.statusCode, 409);
      assert.equal(directRes.json().code, "OCR_REVIEW_REQUIRED");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("keeps direct structural submissions blocked and rejects an acknowledgement for another revision", () => {
    const direct = assessOcrSolveDecision({
      solveDecision: "direct",
      extractionValidation: structuralReview,
      canonicalInputHash: "revision-b",
    });
    const staleAcknowledgement = assessOcrSolveDecision({
      solveDecision: "confirmed",
      extractionValidation: structuralReview,
      reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: "revision-a" },
      canonicalInputHash: "revision-b",
    });

    assert.equal(direct.reviewRequired, true);
    assert.equal(staleAcknowledgement.reviewRequired, true);
    assert.equal(staleAcknowledgement.reviewActionValid, false);
  });

  it("assigns one canonical solve request ID per invocation, including a later retry of one image", async () => {
    const requests = [];
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        problem: "x+7=9",
        steps: [{ id: "s1", math: "x=2", summary: "Subtract seven." }],
        finalAnswerLatex: "x=2",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const options = {
      problem: "x+7=9",
      extraction: { imageSource: { imageHash: "same-image-content-hash" } },
      solveDecision: "edited",
      reviewAction: { kind: "edited", canonicalInputHash: "legacy-test-revision" },
      getToken: async () => "offline-token",
    };
    await solveExtractedProblem(options);
    assert.equal(requests.length, 1, "one client invocation emits one HTTP request");
    await solveExtractedProblem(options);

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(({ body }) => body.problemInput.sourceMetadata.extraction.imageSource.imageHash),
      ["same-image-content-hash", "same-image-content-hash"],
    );
    assert.ok(requests.every(({ body }) => /^canonical-solve-/u.test(body.debugRequestId)));
    assert.notEqual(requests[0].body.debugRequestId, requests[1].body.debugRequestId);
  });
});
