import {
  createCanonicalProblemPayload,
  getCanonicalDisplayText,
  getCanonicalDisplayTextSource,
  getCanonicalMathInput,
  getCanonicalMathInputSource,
  getCanonicalSolverInput,
  logCanonicalProblem,
} from "../src/lib/canonicalProblem.js";

export {
  getCanonicalDisplayText,
  getCanonicalDisplayTextSource,
  getCanonicalMathInput,
  getCanonicalMathInputSource,
  getCanonicalSolverInput,
  logCanonicalProblem,
};

export function normalizeCanonicalProblem(body = {}, fallback = {}) {
  const raw = body.canonicalProblem && typeof body.canonicalProblem === "object" ? body.canonicalProblem : {};
  return createCanonicalProblemPayload({
    canonicalText: raw.canonicalText || fallback.canonicalText || body.problem || body.prompt || body.problemLatex || "",
    canonicalLatex: raw.canonicalLatex || fallback.canonicalLatex || body.problemLatex || "",
    source: raw.source || fallback.source || "typed",
    extractionWarnings: raw.extractionWarnings || fallback.extractionWarnings || [],
    extractionConfidence: raw.extractionConfidence ?? fallback.extractionConfidence,
  });
}
