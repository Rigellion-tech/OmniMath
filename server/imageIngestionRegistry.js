import crypto from "node:crypto";
import { assertImageIngestionTransition, assertImageReviewRevision } from "../src/lib/imageIngestionLifecycle.js";
import { hashCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";

// Receipts are capabilities only inside an authenticated user's upload slot.
// A client hash is never used as evidence that the server extracted an image.
export const IMAGE_RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_LOCAL_SLOTS = 300;
const localSlots = new Map();
export const IMAGE_SLOT_CAS_SCRIPT = `local old = redis.call('GET', KEYS[1])
if (old or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;

function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, publicMessage: message, ingestionStage: "review" });
}

export function ingestionDigest(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function keyFor(owner, scopeId) {
  if (!owner || !scopeId) throw failure("OCR_IDENTITY_INVALID", "The image request is missing its upload identity.", 400);
  return `omnimath:ocr:v1:${ingestionDigest(`${owner}:${scopeId}`)}`;
}

function kvConfig() {
  const url = process.env.USAGE_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.USAGE_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/u, ""), token } : null;
}

async function kvCommand(config, command) {
  try {
    const response = await fetch(`${config.url}/pipeline`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify([command]), signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body) || body[0]?.error) throw new Error("Invalid lifecycle store response");
    return body[0]?.result;
  } catch {
    throw failure("OCR_LIFECYCLE_UNAVAILABLE", "Image review state is temporarily unavailable. Try again.", 503);
  }
}

function defaultStore() {
  const config = kvConfig();
  if (config) return {
    get: (key) => kvCommand(config, ["GET", key]),
    compareSet: (key, expected, next) => kvCommand(config, ["EVAL", IMAGE_SLOT_CAS_SCRIPT, "1", key, expected || "", next, String(IMAGE_RECEIPT_TTL_MS)]),
  };
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
    throw failure("OCR_LIFECYCLE_UNAVAILABLE", "Image review storage is not configured.", 503);
  }
  return {
    get: async (key) => localSlots.get(key) || null,
    compareSet: async (key, expected, next) => {
      if ((localSlots.get(key) || null) !== expected) return 0;
      localSlots.delete(key);
      localSlots.set(key, next);
      while (localSlots.size > MAX_LOCAL_SLOTS) localSlots.delete(localSlots.keys().next().value);
      return 1;
    },
  };
}

export function createImageIngestionRegistry({ store = null, now = Date.now, id = crypto.randomUUID } = {}) {
  async function transact(owner, scopeId, mutate) {
    const backing = store || defaultStore();
    const key = keyFor(owner, scopeId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await backing.get(key);
      const raw = typeof stored === "string" ? stored : null;
      let current;
      try { current = raw ? JSON.parse(raw) : null; } catch {
        throw failure("OCR_LIFECYCLE_UNAVAILABLE", "Image review state could not be loaded.", 503);
      }
      if (current?.expiresAt <= now()) current = null;
      const { next, value } = mutate(current);
      if (!next) return value;
      next.expiresAt = now() + IMAGE_RECEIPT_TTL_MS;
      if (Number(await backing.compareSet(key, raw, JSON.stringify(next))) === 1) return value;
    }
    throw failure("OCR_LIFECYCLE_CONFLICT", "The image changed during this request. Use the latest extraction.");
  }

  function selected(current, receipt, ingestion) {
    if (!current) throw failure("OCR_EXTRACTION_EXPIRED", "This extraction expired. Upload the image again.");
    if (!receipt || current.extractionReceipt !== receipt || current.ingestion.extractionId !== ingestion?.extractionId
      || current.ingestion.uploadId !== ingestion?.uploadId || current.ingestion.ingestionRequestId !== ingestion?.ingestionRequestId
      || current.ingestion.uploadRevision !== ingestion?.uploadRevision || current.ingestion.imageHash !== ingestion?.imageHash) {
      throw failure("OCR_EXTRACTION_STALE", "This extraction was replaced. Review the latest image.");
    }
    if (!current.extraction) throw failure("OCR_EXTRACTION_NOT_READY", "Image extraction has not completed.");
    return current;
  }

  return {
    async begin({ owner, scopeId, uploadId, uploadRevision, ingestionRequestId, imageHash, promptHash }) {
      if (!Number.isSafeInteger(uploadRevision) || uploadRevision < 0 || uploadRevision > 1000000
        || [scopeId, uploadId, ingestionRequestId, imageHash, promptHash].some((value) => typeof value !== "string" || !value || value.length > 160)) {
        throw failure("OCR_UPLOAD_IDENTITY_INVALID", "Image upload identity is invalid.", 400);
      }
      return transact(owner, scopeId, (current) => {
        const same = current && current.ingestion.uploadId === uploadId && current.ingestion.uploadRevision === uploadRevision
          && current.ingestion.ingestionRequestId === ingestionRequestId;
        if (same) {
          if (current.ingestion.imageHash !== imageHash || current.promptHash !== promptHash) throw failure("OCR_REQUEST_ID_CONFLICT", "An image request identity was reused for different input.");
          if (current.extraction) return { value: { kind: "completed", record: current } };
          if (current.failure) throw failure(current.failure.code, current.failure.message, current.failure.statusCode);
          throw failure("OCR_EXTRACTION_IN_PROGRESS", "This image is already being read. Wait for that request to finish.");
        }
        if (current && uploadRevision <= current.ingestion.uploadRevision) throw failure("OCR_UPLOAD_STALE", "This upload was replaced. Use the latest image.");
        const ingestion = { scopeId, ingestionScopeId: scopeId, uploadId, uploadRevision, ingestionRequestId, imageHash, extractionId: id(), state: "extracting", reviewRevision: 0 };
        const next = { ingestion, extractionReceipt: id(), promptHash, extraction: null, review: null, solve: null, createdAt: now() };
        return { next, value: { kind: "started", record: structuredClone(next) } };
      });
    },
    async extracted({ owner, record, extraction }) {
      return transact(owner, record.ingestion.scopeId, (current) => {
        if (!current || current.extractionReceipt !== record.extractionReceipt) throw failure("OCR_EXTRACTION_STALE", "This extraction was replaced while reading the image.");
        const state = extraction.ocrSolveDecision.allowed ? "ready" : "review_required";
        assertImageIngestionTransition(current.ingestion.state, state);
        const ingestion = { ...current.ingestion, state };
        const result = { ...extraction, ingestion, extractionReceipt: current.extractionReceipt };
        const next = { ...current, ingestion, extraction: result };
        return { next, value: result };
      });
    },
    async failed({ owner, record, error }) {
      return transact(owner, record.ingestion.scopeId, (current) => {
        if (!current || current.extractionReceipt !== record.extractionReceipt) return { value: null };
        const next = { ...current, ingestion: { ...current.ingestion, state: "extraction_failed" },
          failure: { code: error.code || "OCR_EXTRACTION_FAILED", message: error.publicMessage || "Image extraction failed.", statusCode: error.statusCode || 502 } };
        return { next, value: null };
      });
    },
    async get({ owner, receipt, ingestion }) {
      if (!receipt || !(ingestion?.scopeId || ingestion?.ingestionScopeId)) throw failure("OCR_EXTRACTION_RECEIPT_REQUIRED", "Upload and extract the image before solving it.");
      return transact(owner, ingestion.scopeId || ingestion.ingestionScopeId, (current) => ({ value: selected(current, receipt, ingestion) }));
    },
    async review({ owner, receipt, ingestion, revision, revisionId, canonicalProblem, solveSignature, requestId }) {
      return transact(owner, ingestion.scopeId || ingestion.ingestionScopeId, (current) => {
        selected(current, receipt, ingestion);
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > 1000000 || !revisionId) throw failure("OCR_REVIEW_IDENTITY_INVALID", "The reviewed text is missing its revision identity.", 400);
        const canonicalProblemId = ingestionDigest({ text: canonicalProblem.canonicalText, latex: canonicalProblem.canonicalLatex });
        if (canonicalProblem.hash !== hashCanonicalProblemPayload(canonicalProblem)) throw failure("OCR_CANONICAL_INPUT_MISMATCH", "The canonical input hash does not match its reviewed content.", 400);
        if (current.review && revision < current.review.revision) throw failure("OCR_REVIEW_STALE", "A newer reviewed version exists. Solve that version instead.");
        if (current.review && revision === current.review.revision && (revisionId !== current.review.revisionId || canonicalProblemId !== current.review.canonicalProblemId)) throw failure("OCR_REVIEW_REVISION_CONFLICT", "This review revision was reused for different text.");
        if (current.review && revision === current.review.revision && current.solve?.signature === solveSignature) {
          if (current.solve.status === "solved") return { value: { kind: "completed", record: current, response: current.solve.response } };
          if (current.solve.status === "solving") throw failure("OCR_SOLVE_IN_PROGRESS", "This reviewed version is already being solved. Wait for that request to finish.");
          if (current.solve.requestId === requestId) return { value: { kind: "completed", record: current, response: current.solve.response } };
        }
        if (current.solve?.status === "solving") throw failure("OCR_SOLVE_IN_PROGRESS", "This extraction is already being solved. Wait before submitting another revision.");
        if (current.solve?.status === "solved" && current.review?.revision === revision) throw failure("OCR_SOLVE_CONTEXT_CONFLICT", "This revision already has a solution. Submit a new review revision for a changed solve context.");
        const requestBinding = ingestionDigest({ revision, revisionId, canonicalProblemId, solveSignature });
        if (current.requestIds?.[requestId] && current.requestIds[requestId] !== requestBinding) throw failure("OCR_REQUEST_ID_CONFLICT", "A solve request id was reused for different reviewed input.");
        if (!current.requestIds?.[requestId] && Object.keys(current.requestIds || {}).length >= 100) throw failure("OCR_REVIEW_LIMIT_REACHED", "This extraction reached its review request limit. Upload the image again.");
        let fromState = current.ingestion.state;
        if (current.review && revision > current.review.revision) {
          assertImageReviewRevision({ currentState: fromState, currentRevision: current.review.revision, nextRevision: revision });
          fromState = "review_required";
        }
        assertImageIngestionTransition(fromState, "solving");
        const review = { revision, revisionId, canonicalProblemId, canonicalInputHash: canonicalProblem.hash, canonicalText: canonicalProblem.canonicalText };
        const next = { ...current, review, requestIds: { ...current.requestIds, [requestId]: requestBinding }, ingestion: { ...current.ingestion, state: "solving", reviewRevision: revision },
          solve: { signature: solveSignature, requestId, status: "solving" } };
        return { next, value: { kind: "started", record: next } };
      });
    },
    async finish({ owner, receipt, ingestion, revision, revisionId, requestId, response }) {
      return transact(owner, ingestion.scopeId || ingestion.ingestionScopeId, (current) => {
        selected(current, receipt, ingestion);
        if (current.review?.revision !== revision || current.review?.revisionId !== revisionId || current.solve?.requestId !== requestId) throw failure("OCR_REVIEW_STALE", "This solve belongs to an older reviewed version.");
        const solved = response.statusCode === 200;
        assertImageIngestionTransition(current.ingestion.state, solved ? "solved" : "solve_failed");
        const next = { ...current, ingestion: { ...current.ingestion, state: solved ? "solved" : "solve_failed" },
          solve: { ...current.solve, status: solved ? "solved" : "solve_failed", response } };
        return { next, value: next.ingestion };
      });
    },
  };
}

export const imageIngestionRegistry = createImageIngestionRegistry();
