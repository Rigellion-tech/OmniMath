import assert from "node:assert/strict";
import { it } from "node:test";
import { createImageIngestionRegistry, IMAGE_RECEIPT_TTL_MS } from "../server/imageIngestionRegistry.js";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";

function fixture() {
  const values = new Map();
  let clock = 10000;
  let serial = 0;
  const store = {
    get: async (key) => values.get(key) || null,
    compareSet: async (key, expected, next) => {
      if ((values.get(key) || null) !== expected) return 0;
      values.set(key, next);
      return 1;
    },
  };
  const options = { store, now: () => clock, id: () => `fixture-${++serial}` };
  const registry = createImageIngestionRegistry(options);
  const otherProcess = createImageIngestionRegistry(options);
  const begin = (patch = {}, instance = registry) => instance.begin({ owner: "verified-user", scopeId: "scope-1", uploadId: "upload-1", uploadRevision: 1,
    ingestionRequestId: "ingestion-1", imageHash: "image-1", promptHash: "prompt-1", ...patch });
  const extract = async (patch = {}) => {
    const { record } = await begin(patch);
    const extraction = await registry.extracted({ owner: "verified-user", record, extraction: {
      extractedProblemText: "x+7=9", extractedProblemLatex: "x+7=9", ocrSolveDecision: { allowed: true },
      extractionValidation: { status: "ok", critical: false, issues: [] },
    } });
    return { owner: "verified-user", receipt: extraction.extractionReceipt, ingestion: extraction.ingestion };
  };
  const review = (identity, patch = {}, instance = registry) => instance.review({ ...identity, revision: 0, revisionId: "review-0",
    canonicalProblem: createCanonicalProblemPayload({ canonicalText: "x+7=9", source: "ocr-direct" }),
    solveSignature: "canonical-context-a", requestId: "solve-1", ...patch });
  const finish = (identity, patch = {}) => registry.finish({ ...identity, revision: 0, revisionId: "review-0", requestId: "solve-1",
    response: { statusCode: 200, body: '{"steps":[{"math":"x=2"}]}', headers: {} }, ...patch });
  return { registry, otherProcess, begin, extract, review, finish, advance: (ms) => { clock += ms; } };
}

it("duplicate extraction claim is atomic across registry instances and a completed identity replays", async () => {
  const f = fixture();
  const claims = await Promise.allSettled([f.begin(), f.begin({}, f.otherProcess)]);
  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  assert.equal(claims.find((claim) => claim.status === "rejected").reason.code, "OCR_EXTRACTION_IN_PROGRESS");
  const record = claims.find((claim) => claim.status === "fulfilled").value.record;
  await f.registry.extracted({ owner: "verified-user", record, extraction: { extractedProblemText: "x=2", ocrSolveDecision: { allowed: true } } });
  assert.equal((await f.begin({}, f.otherProcess)).kind, "completed");
});

it("reused upload identities cannot authorize different image bytes or prompts", async () => {
  const f = fixture();
  await f.begin();
  for (const patch of [{ imageHash: "different-image" }, { promptHash: "different-prompt" }]) {
    await assert.rejects(f.begin(patch), { code: "OCR_REQUEST_ID_CONFLICT" });
  }
  await assert.rejects(f.begin({ uploadRevision: -1 }), { code: "OCR_UPLOAD_IDENTITY_INVALID" });
  await assert.rejects(f.begin({ uploadRevision: 1.5 }), { code: "OCR_UPLOAD_IDENTITY_INVALID" });
});

it("newer uploads replace older extractions even if their mathematics are identical", async () => {
  const f = fixture();
  const a = await f.extract();
  const c = await f.extract({ uploadId: "upload-2", uploadRevision: 2, ingestionRequestId: "ingestion-2", imageHash: "image-2" });
  assert.notEqual(a.receipt, c.receipt);
  await assert.rejects(f.registry.get(a), { code: "OCR_EXTRACTION_STALE" });
  assert.equal((await f.otherProcess.get(c)).extraction.extractedProblemText, "x+7=9");
  await assert.rejects(f.begin({ uploadRevision: 1 }), { code: "OCR_UPLOAD_STALE" });
});

it("the same image uploaded twice still has distinct action and extraction identity", async () => {
  const f = fixture();
  const a = await f.extract();
  const b = await f.extract({ uploadId: "upload-2", uploadRevision: 2, ingestionRequestId: "ingestion-2" });
  assert.equal(a.ingestion.imageHash, b.ingestion.imageHash);
  assert.notEqual(a.ingestion.extractionId, b.ingestion.extractionId);
  assert.notEqual(a.ingestion.ingestionRequestId, b.ingestion.ingestionRequestId);
});

it("receipt ownership and every selected extraction identity field fail closed", async () => {
  const f = fixture();
  const identity = await f.extract();
  await assert.rejects(f.registry.get({ ...identity, owner: "another-user" }), { code: "OCR_EXTRACTION_EXPIRED" });
  for (const field of ["uploadId", "imageHash", "ingestionRequestId", "extractionId", "uploadRevision"]) {
    await assert.rejects(f.registry.get({ ...identity, ingestion: { ...identity.ingestion, [field]: "other" } }), { code: "OCR_EXTRACTION_STALE" });
  }
  await assert.rejects(f.registry.get({ ...identity, receipt: null }), { code: "OCR_EXTRACTION_RECEIPT_REQUIRED" });
});

it("out-of-order lifecycle transitions and expired extraction receipts are explicit", async () => {
  const f = fixture();
  const { record } = await f.begin();
  await assert.rejects(f.registry.review({ owner: "verified-user", receipt: record.extractionReceipt, ingestion: record.ingestion }), { code: "OCR_EXTRACTION_NOT_READY" });
  await f.registry.extracted({ owner: "verified-user", record, extraction: { ocrSolveDecision: { allowed: true } } });
  await assert.rejects(f.registry.finish({ owner: "verified-user", receipt: record.extractionReceipt, ingestion: record.ingestion,
    revision: 0, revisionId: "unregistered", requestId: "solve-1", response: { statusCode: 200 } }), { code: "OCR_REVIEW_STALE" });
  f.advance(IMAGE_RECEIPT_TTL_MS + 1);
  await assert.rejects(f.registry.get({ owner: "verified-user", receipt: record.extractionReceipt, ingestion: record.ingestion }), { code: "OCR_EXTRACTION_EXPIRED" });
});

it("edited revisions replace solved versions and stale client requests cannot roll them back", async () => {
  const f = fixture();
  const identity = await f.extract();
  await f.review(identity);
  await f.finish(identity);
  const edited = createCanonicalProblemPayload({ canonicalText: "x+7=10", source: "ocr-reviewed" });
  const next = await f.review(identity, { revision: 1, revisionId: "review-1", canonicalProblem: edited, requestId: "solve-2" });
  assert.equal(next.record.review.canonicalText, "x+7=10");
  await f.finish(identity, { revision: 1, revisionId: "review-1", requestId: "solve-2" });
  await assert.rejects(f.review(identity), { code: "OCR_REVIEW_STALE" });
  await assert.rejects(f.review(identity, { revision: 1, revisionId: "review-1", requestId: "solve-3" }), { code: "OCR_REVIEW_REVISION_CONFLICT" });
});

it("concurrent canonical solve claims suppress a second provider operation and replay completion", async () => {
  const f = fixture();
  const identity = await f.extract();
  const attempts = await Promise.allSettled([f.review(identity), f.review(identity, { requestId: "solve-duplicate" }, f.otherProcess)]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.find((item) => item.status === "rejected").reason.code, "OCR_SOLVE_IN_PROGRESS");
  const requestId = attempts.find((item) => item.status === "fulfilled").value.record.solve.requestId;
  await f.finish(identity, { requestId });
  const replay = await f.review(identity, { requestId: "solve-later" }, f.otherProcess);
  assert.equal(replay.kind, "completed");
  assert.equal(replay.response.statusCode, 200);
});

it("failed canonical solve replays one request id but an intentional retry can start", async () => {
  const f = fixture();
  const identity = await f.extract();
  await f.review(identity);
  await f.finish(identity, { response: { statusCode: 502, body: '{"code":"AI_REQUEST_REFUSED"}', headers: {} } });
  assert.equal((await f.review(identity)).kind, "completed");
  assert.equal((await f.review(identity, { requestId: "retry-2" })).kind, "started");
});

it("one revision cannot silently change solve context or reuse a request id for a different revision", async () => {
  const f = fixture();
  const identity = await f.extract();
  await f.review(identity);
  await f.finish(identity);
  await assert.rejects(f.review(identity, { solveSignature: "changed-history", requestId: "solve-2" }), { code: "OCR_SOLVE_CONTEXT_CONFLICT" });
  await assert.rejects(f.review(identity, { revision: 1, revisionId: "review-1" }), { code: "OCR_REQUEST_ID_CONFLICT" });
});

it("replacing an extraction during an in-flight solve prevents stale terminal publication", async () => {
  const f = fixture();
  const a = await f.extract();
  await f.review(a);
  await f.extract({ uploadId: "upload-c", uploadRevision: 2, ingestionRequestId: "ingestion-c", imageHash: "image-c" });
  await assert.rejects(f.finish(a), { code: "OCR_EXTRACTION_STALE" });
});

it("bounded CAS contention fails explicitly instead of starting uncontrolled operations", async () => {
  let calls = 0;
  const registry = createImageIngestionRegistry({ store: { get: async () => null, compareSet: async () => { calls += 1; return 0; } } });
  await assert.rejects(registry.begin({ owner: "u", scopeId: "s", uploadId: "a", uploadRevision: 1, ingestionRequestId: "r", imageHash: "i", promptHash: "p" }), { code: "OCR_LIFECYCLE_CONFLICT" });
  assert.equal(calls, 3);
});
