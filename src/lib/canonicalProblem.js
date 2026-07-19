const CANONICAL_SOURCES = new Set(["ocr-reviewed", "ocr-direct", "typed"]);

function normalizeText(value = "") {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      return {
        type: String(item.type || "").trim(),
        severity: String(item.severity || "").trim(),
        message: String(item.message || "").trim(),
        critical: Boolean(item.critical),
      };
    })
    .filter(Boolean);
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonicalProblemPayload(payload = {}) {
  const input = stableStringify({
    canonicalText: normalizeText(payload.canonicalText),
    canonicalLatex: normalizeText(payload.canonicalLatex),
    source: CANONICAL_SOURCES.has(payload.source) ? payload.source : "typed",
    extractionWarnings: normalizeWarnings(payload.extractionWarnings),
    extractionConfidence: normalizeConfidence(payload.extractionConfidence),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createCanonicalProblemPayload(options = {}) {
  const canonicalText = normalizeText(options.canonicalText ?? options.problem ?? options.text ?? "");
  const canonicalLatex = normalizeText(options.canonicalLatex ?? options.problemLatex ?? "");
  const source = CANONICAL_SOURCES.has(options.source) ? options.source : "typed";
  const payload = {
    canonicalText,
    canonicalLatex,
    source,
    extractionWarnings: normalizeWarnings(options.extractionWarnings),
    extractionConfidence: normalizeConfidence(options.extractionConfidence),
  };
  return {
    ...payload,
    hash: hashCanonicalProblemPayload(payload),
  };
}

export function canonicalProblemFromExtraction({
  extraction = {},
  canonicalText = "",
  canonicalLatex = "",
  source = "ocr-reviewed",
} = {}) {
  /** @type {Record<string, any>} */
  const safeExtraction = extraction && typeof extraction === "object" && !Array.isArray(extraction) ? extraction : {};
  const validation = safeExtraction.extractionValidation || {};
  return createCanonicalProblemPayload({
    canonicalText,
    canonicalLatex: canonicalLatex || safeExtraction.extractedProblemLatex || safeExtraction.rawExtractedLatex || "",
    source,
    extractionWarnings: safeExtraction.issues || validation.issues || [],
    extractionConfidence: safeExtraction.confidence ?? validation.confidence ?? validation.ocrConfidence ?? safeExtraction.ocrConfidence,
  });
}

export function getCanonicalSolverInput(payload = {}, fallback = "") {
  return normalizeText(payload.canonicalText || payload.problem || fallback);
}

export function diffCanonicalProblemPayloads(left = {}, right = {}) {
  const keys = ["canonicalText", "canonicalLatex", "source", "extractionWarnings", "extractionConfidence"];
  return keys
    .filter((key) => stableStringify(left?.[key]) !== stableStringify(right?.[key]))
    .map((key) => ({
      path: key,
      left: left?.[key],
      right: right?.[key],
    }));
}

export function logCanonicalProblem(event, payload = {}, details = {}) {
  const logger = globalThis.console?.info;
  if (typeof logger !== "function") return;
  logger.call(globalThis.console, "[omnimath:canonical-problem]", {
    event,
    hash: payload?.hash || hashCanonicalProblemPayload(payload),
    source: payload?.source,
    textChars: String(payload?.canonicalText || "").length,
    hasLatex: Boolean(payload?.canonicalLatex),
    ...details,
  });
}
