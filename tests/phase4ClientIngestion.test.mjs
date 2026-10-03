import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildExtractionSubmissionPayload,
  extractImageProblem,
  extractionMetadataForSolve,
  solveExtractedProblem,
} from "../src/api/mathClient.js";
import {
  IMAGE_INGESTION_STATES,
  assertImageIngestionTransition,
  assertImageReviewRevision,
  assertMatchingIngestionIdentity,
  createImageUploadIdentity,
  createReviewRevisionId,
  imageSolveFailureMessage,
} from "../src/lib/imageIngestionLifecycle.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ingestion(overrides = {}) {
  return {
    ingestionRequestId: "ingestion-a",
    uploadId: "upload-a",
    ingestionScopeId: "scope-a",
    uploadRevision: 1,
    extractionId: "extraction-a",
    state: "review_required",
    ...overrides,
  };
}

describe("Phase 4 client image ingestion lifecycle", () => {
  it("distinguishes a solve timeout from transport unavailability after extraction succeeded", () => {
    assert.match(imageSolveFailureMessage({ code: "AI_SOLVE_TIMEOUT" }), /solving timed out/);
    assert.match(imageSolveFailureMessage({ code: "AI_REQUEST_TIMEOUT" }), /solving timed out/);
    assert.match(imageSolveFailureMessage({ code: "AI_SERVICE_UNAVAILABLE" }), /service is unavailable/);
    assert.doesNotMatch(imageSolveFailureMessage({ code: "AI_SERVICE_UNAVAILABLE" }), /timed out/);
  });
  it("rejects illegal and out-of-order lifecycle transitions", () => {
    assert.equal(
      assertImageIngestionTransition(IMAGE_INGESTION_STATES.EXTRACTING, IMAGE_INGESTION_STATES.REVIEW_REQUIRED),
      IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    );
    assert.throws(
      () => assertImageIngestionTransition(IMAGE_INGESTION_STATES.UPLOADED, IMAGE_INGESTION_STATES.SOLVING),
      (error) => error.code === "OCR_LIFECYCLE_TRANSITION_INVALID",
    );
    assert.equal(assertImageReviewRevision({
      currentState: IMAGE_INGESTION_STATES.SOLVED,
      currentRevision: 2,
      nextRevision: 3,
    }), 3);
    assert.throws(
      () => assertImageReviewRevision({
        currentState: IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
        currentRevision: 3,
        nextRevision: 3,
      }),
      (error) => error.code === "OCR_REVIEW_STALE",
    );
  });

  it("gives each upload a distinct identity and rejects a stale extraction response", () => {
    const first = createImageUploadIdentity({ ingestionScopeId: "scope-a", uploadRevision: 1 });
    const second = createImageUploadIdentity({ ingestionScopeId: "scope-a", uploadRevision: 2 });
    assert.notEqual(first.ingestionRequestId, second.ingestionRequestId);
    assert.notEqual(first.uploadId, second.uploadId);
    assert.throws(
      () => assertMatchingIngestionIdentity(second, first),
      (error) => error.code === "OCR_STALE_EXTRACTION" && error.identityField === "ingestionRequestId",
    );
  });

  it("keeps user-edited reviewed math exact and binds its revision to the extraction", () => {
    const reviewed = "Solve x > = 2 exactly as reviewed.";
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        extractionReceipt: "receipt-a",
        ingestion: ingestion(),
        extractedProblemText: "Solve x >= 1.",
        extractedProblemLatex: "x\\ge 1",
        extractionValidation: { status: "warning", issues: [] },
      },
      displayText: reviewed,
      rawText: "Solve x >= 1.",
      solveDecision: "edited",
      source: "ocr-reviewed",
      reviewRevision: 3,
      reviewRevisionId: createReviewRevisionId("extraction-a", 3),
    });

    assert.equal(payload.problem, reviewed);
    assert.equal(payload.problemText, reviewed);
    assert.equal(payload.canonicalProblem.canonicalLatex, "");
    assert.equal(payload.reviewAction.kind, "edited");
    assert.equal(payload.reviewAction.extractionId, "extraction-a");
    assert.equal(payload.reviewAction.reviewRevision, 3);
    assert.equal(payload.reviewAction.reviewRevisionId, "extraction-a:review:3");
    assert.equal(payload.extractionReceipt, "receipt-a");
  });

  it("allowlists solve provenance without carrying image data URLs or unknown fields", () => {
    const safe = extractionMetadataForSolve({
      extractionReceipt: "receipt-a",
      ingestion: ingestion(),
      extractedProblemText: "x=1",
      imageSource: {
        imageHash: "sha256-safe",
        filename: "problem.png",
        dataUrl: "data:image/png;base64,private",
      },
      uploadedImage: "data:image/png;base64,private",
      arbitraryProviderPayload: { private: true },
    });

    assert.equal(safe.imageHash, "sha256-safe");
    assert.equal(safe.filename, "problem.png");
    assert.equal(JSON.stringify(safe).includes("base64,private"), false);
    assert.equal("arbitraryProviderPayload" in safe, false);
  });

  it("sends upload identity in multipart and rejects a mismatched server echo", async () => {
    const expected = ingestion();
    globalThis.fetch = async (_url, options) => {
      const fields = Object.fromEntries(options.body.entries());
      assert.equal(fields.ingestionRequestId, expected.ingestionRequestId);
      assert.equal(fields.uploadId, expected.uploadId);
      assert.equal(fields.ingestionScopeId, expected.ingestionScopeId);
      assert.equal(fields.uploadRevision, "1");
      return new Response(JSON.stringify({ ingestion: expected }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await extractImageProblem({
      file: new Blob(["image"], { type: "image/png" }),
      prompt: "extract",
      ingestion: expected,
    });

    globalThis.fetch = async () => new Response(JSON.stringify({
      ingestion: ingestion({ ingestionRequestId: "stale-ingestion" }),
    }), { status: 200, headers: { "content-type": "application/json" } });
    await assert.rejects(
      extractImageProblem({ file: new Blob(["image"]), prompt: "extract", ingestion: expected }),
      (error) => error.code === "OCR_STALE_EXTRACTION",
    );
  });

  it("carries the receipt and reviewed revision through the canonical solve request", async () => {
    let body;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ steps: [{ id: "s1", math: "x=1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const payload = buildExtractionSubmissionPayload({
      extraction: {
        extractionReceipt: "receipt-a",
        ingestion: ingestion(),
        extractedProblemText: "x=1",
      },
      displayText: "x=2",
      rawText: "x=1",
      solveDecision: "edited",
      source: "ocr-reviewed",
      reviewRevision: 1,
      reviewRevisionId: "extraction-a:review:1",
    });

    await solveExtractedProblem(payload);

    assert.equal(body.problemInput.problemText, "x=2");
    assert.equal(body.extractionReceipt, "receipt-a");
    assert.equal(body.reviewRevision, 1);
    assert.equal(body.reviewRevisionId, "extraction-a:review:1");
    assert.equal(body.reviewAction.canonicalInputHash, body.canonicalProblem.hash);
  });
});
