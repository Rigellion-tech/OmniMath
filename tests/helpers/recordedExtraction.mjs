import crypto from "node:crypto";
import { imageIngestionRegistry } from "../../server/imageIngestionRegistry.js";
import { assessOcrSolveDecision } from "../../server/ocrSolvePolicy.js";
import { createCanonicalProblemPayload } from "../../src/lib/canonicalProblem.js";

let fixtureSequence = 0;

export function productionClerkOwner(userId, salt) {
  return crypto.createHmac("sha256", salt).update(`clerk:${userId}`).digest("hex");
}

export async function recordExtraction({
  owner = "local-dev-solve-extracted-problem",
  problem,
  latex = problem,
  imageHash = `fixture-image-${++fixtureSequence}`,
  extractionValidation = null,
  extraction: extractionOverrides = {},
  scopeId = `fixture-scope-${fixtureSequence}-${crypto.randomUUID()}`,
  uploadId = `fixture-upload-${fixtureSequence}`,
  uploadRevision = 0,
  ingestionRequestId = `fixture-ingestion-${fixtureSequence}`,
} = {}) {
  const validation = extractionValidation || {
    status: "success",
    tier: "high",
    critical: false,
    confidence: 91,
    ocrConfidence: 91,
    mathIntegrityScore: 91,
    issues: [],
    metrics: {},
  };
  const claimed = await imageIngestionRegistry.begin({
    owner,
    scopeId,
    uploadId,
    uploadRevision,
    ingestionRequestId,
    imageHash,
    promptHash: `fixture-prompt-${fixtureSequence}`,
  });
  const extraction = {
    extractedProblemText: problem,
    extractedProblemLatex: latex,
    rawExtractedText: problem,
    rawExtractedLatex: latex,
    normalizedText: problem,
    validationText: problem,
    confidence: validation.confidence,
    ocrConfidence: validation.ocrConfidence ?? validation.confidence,
    mathIntegrityScore: validation.mathIntegrityScore ?? validation.confidence,
    confidenceTier: validation.tier,
    issues: validation.issues || [],
    extractionValidation: validation,
    imageSource: { imageHash },
    ...extractionOverrides,
  };
  extraction.ocrSolveDecision = assessOcrSolveDecision({
    solveDecision: "direct",
    extractionValidation: validation,
  });
  return imageIngestionRegistry.extracted({ owner, record: claimed.record, extraction });
}

export function recordedSolvePayload(extraction, {
  problem = extraction.extractedProblemText,
  latex = extraction.extractedProblemLatex || "",
  solveDecision = "direct",
  reviewRevision = 0,
  reviewRevisionId = `${extraction.ingestion.extractionId}:review:${reviewRevision}`,
  canonicalProblem = null,
  body = {},
} = {}) {
  const canonical = canonicalProblem || createCanonicalProblemPayload({
    canonicalText: problem,
    canonicalLatex: latex,
    source: solveDecision === "direct" ? "ocr-direct" : "ocr-reviewed",
    extractionWarnings: extraction.issues || extraction.extractionValidation?.issues || [],
    extractionConfidence: extraction.confidence ?? extraction.extractionValidation?.confidence,
  });
  const reviewAction = solveDecision === "direct" ? null : {
    kind: solveDecision === "edited" ? "edited" : "confirmed_unchanged",
    canonicalInputHash: canonical.hash,
    extractionId: extraction.ingestion.extractionId,
    reviewRevision,
    reviewRevisionId,
  };
  return {
    ...body,
    problem,
    problemText: problem,
    canonicalProblem: canonical,
    extraction,
    extractionReceipt: extraction.extractionReceipt,
    reviewRevision,
    reviewRevisionId,
    solveDecision,
    reviewAction,
  };
}
