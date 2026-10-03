export const IMAGE_INGESTION_STATES = Object.freeze({
  UPLOADED: "uploaded",
  CHECKING: "checking",
  READY_TO_EXTRACT: "ready_to_extract",
  EXTRACTING: "extracting",
  READY: "ready",
  REVIEW_REQUIRED: "review_required",
  SOLVING: "solving",
  SOLVED: "solved",
  EXTRACTION_FAILED: "extraction_failed",
  SOLVE_FAILED: "solve_failed",
  CANCELLED: "cancelled",
});

const ALLOWED_TRANSITIONS = Object.freeze({
  "": new Set([IMAGE_INGESTION_STATES.UPLOADED, IMAGE_INGESTION_STATES.CHECKING]),
  [IMAGE_INGESTION_STATES.UPLOADED]: new Set([
    IMAGE_INGESTION_STATES.CHECKING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.CHECKING]: new Set([
    IMAGE_INGESTION_STATES.READY_TO_EXTRACT,
    IMAGE_INGESTION_STATES.EXTRACTION_FAILED,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.READY_TO_EXTRACT]: new Set([
    IMAGE_INGESTION_STATES.EXTRACTING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.EXTRACTING]: new Set([
    IMAGE_INGESTION_STATES.READY,
    IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    IMAGE_INGESTION_STATES.EXTRACTION_FAILED,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.READY]: new Set([
    IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    IMAGE_INGESTION_STATES.SOLVING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.REVIEW_REQUIRED]: new Set([
    IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    IMAGE_INGESTION_STATES.SOLVING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.SOLVING]: new Set([
    IMAGE_INGESTION_STATES.SOLVED,
    IMAGE_INGESTION_STATES.SOLVE_FAILED,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.SOLVE_FAILED]: new Set([
    IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    IMAGE_INGESTION_STATES.SOLVING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.EXTRACTION_FAILED]: new Set([
    IMAGE_INGESTION_STATES.EXTRACTING,
    IMAGE_INGESTION_STATES.CANCELLED,
  ]),
  [IMAGE_INGESTION_STATES.SOLVED]: new Set(),
  [IMAGE_INGESTION_STATES.CANCELLED]: new Set(),
});

export function canTransitionImageIngestion(fromState = "", toState = "") {
  return ALLOWED_TRANSITIONS[fromState || ""]?.has(toState) === true;
}

export function assertImageIngestionTransition(fromState = "", toState = "") {
  if (fromState === toState) return toState;
  if (canTransitionImageIngestion(fromState, toState)) return toState;
  throw Object.assign(new Error(`Illegal image ingestion transition: ${fromState || "initial"} -> ${toState || "empty"}`), {
    code: "OCR_LIFECYCLE_TRANSITION_INVALID",
    fromState: fromState || null,
    toState: toState || null,
  });
}

export function transitionImageIngestion(workflow = {}, toState, patch = {}) {
  assertImageIngestionTransition(workflow.lifecycleState || "", toState);
  return { ...workflow, ...patch, lifecycleState: toState };
}

export function createImageLifecycleId(prefix = "image") {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

/** @param {{ ingestionScopeId?: string, uploadRevision?: number }} options */
export function createImageUploadIdentity({ ingestionScopeId, uploadRevision } = {}) {
  if (!ingestionScopeId || !Number.isInteger(uploadRevision) || uploadRevision < 1) {
    throw Object.assign(new Error("A scope and positive upload revision are required."), {
      code: "OCR_UPLOAD_IDENTITY_INVALID",
    });
  }
  return Object.freeze({
    ingestionRequestId: createImageLifecycleId("ingestion"),
    uploadId: createImageLifecycleId("upload"),
    ingestionScopeId,
    uploadRevision,
  });
}

export function createReviewRevisionId(extractionId, reviewRevision) {
  if (!extractionId || !Number.isInteger(reviewRevision) || reviewRevision < 0) return "";
  return `${extractionId}:review:${reviewRevision}`;
}

/** @param {{ currentState?: string, currentRevision?: number, nextRevision?: number }} options */
export function assertImageReviewRevision({ currentState = "", currentRevision = -1, nextRevision } = {}) {
  if (!Number.isInteger(nextRevision) || nextRevision <= currentRevision) {
    throw Object.assign(new Error("The reviewed extraction revision is stale."), {
      code: "OCR_REVIEW_STALE",
      currentRevision,
      nextRevision,
    });
  }
  /** @type {Set<string>} */
  const reviewableStates = new Set([
    IMAGE_INGESTION_STATES.READY,
    IMAGE_INGESTION_STATES.REVIEW_REQUIRED,
    IMAGE_INGESTION_STATES.SOLVE_FAILED,
    IMAGE_INGESTION_STATES.SOLVED,
  ]);
  if (!reviewableStates.has(currentState)) {
    throw Object.assign(new Error("The extraction is not ready for a new review revision."), {
      code: "OCR_LIFECYCLE_TRANSITION_INVALID",
      currentState,
    });
  }
  return nextRevision;
}

export function assertMatchingIngestionIdentity(expected = {}, received = {}) {
  const fields = ["ingestionRequestId", "uploadId", "ingestionScopeId", "uploadRevision"];
  const mismatch = fields.find((field) => expected[field] !== received[field]);
  if (!mismatch) return true;
  throw Object.assign(new Error("A newer image replaced this extraction before it completed."), {
    code: "OCR_STALE_EXTRACTION",
    identityField: mismatch,
  });
}

export function imageSolveFailureMessage(error) {
  const code = error?.body?.code || error?.code || "";
  if (code === "AI_SOLVE_TIMEOUT" || code === "AI_PROVIDER_TIMEOUT" || code === "AI_REQUEST_TIMEOUT") {
    return "Extraction succeeded, but solving timed out. Retry from the reviewed text.";
  }
  if (code === "AI_SERVICE_UNAVAILABLE") {
    return "Extraction succeeded, but the solving service is unavailable. Retry from the reviewed text.";
  }
  if (code === "AI_SOLUTION_QUALITY_INVALID") {
    return "Extraction succeeded, but the solution failed mathematical validation. Retry from the reviewed text.";
  }
  if (code === "OCR_EXTRACTION_EXPIRED") {
    return "This extraction expired before it could be solved. Re-upload the image to extract it again.";
  }
  if (["OCR_STALE_EXTRACTION", "OCR_EXTRACTION_STALE", "OCR_UPLOAD_STALE", "OCR_REVIEW_STALE"].includes(code)) {
    return "This reviewed version is stale. Use the latest extracted text before solving.";
  }
  return `Extraction succeeded, but solving failed. ${error?.message || "Retry from the reviewed text."}`;
}
