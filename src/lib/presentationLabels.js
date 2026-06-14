const INTERNAL_TITLE_MAP = new Map([
  ["curldivergenceidentityselfzerocurl", "Divergence of a Curl"],
  ["trigpythagoreanidentity", "Pythagorean Trigonometric Identity"],
  ["integrationbypartsselection", "Integration by Parts"],
]);

const INTERNAL_PREFIX_PATTERN = /^(expression|reasoning|classifier|semantic|debug|metadata|prompt|node|internal)[_-]/i;
const INTERNAL_WORD_PATTERN = /\b(reasoningKey|classifierTag|semanticTag|debugLabel|internalName|nodeId|metadata|promptArtifact)\b/i;

function normalizeIdentifier(value = "") {
  return String(value || "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

function compactSpaces(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function mappedInternalTitle(value = "") {
  const normalized = normalizeIdentifier(value);
  return INTERNAL_TITLE_MAP.get(normalized) || "";
}

export function looksLikeInternalTitle(value = "") {
  const text = compactSpaces(value);
  if (!text) return true;
  if (mappedInternalTitle(text)) return false;
  if (text.length > 60) return true;
  if (text.includes("_")) return true;
  if (INTERNAL_PREFIX_PATTERN.test(text) || INTERNAL_WORD_PATTERN.test(text)) return true;
  if (/[a-z][A-Z]/.test(text) && !/\s/.test(text)) return true;
  if (/^[A-Z][a-z]+(?:[A-Z][a-z0-9]*){2,}$/.test(text)) return true;
  return false;
}

export function latexToCompactDisplay(value = "") {
  return compactSpaces(value)
    .replace(/\\mathbf\{([^}]*)\}/g, "$1")
    .replace(/\\nabla/g, "∇")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\le/g, "≤")
    .replace(/\\ge/g, "≥")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function userFacingTooltipTitle({
  title = "",
  selectedText = "",
  display = "",
  latex = "",
  role = "",
  fallback = "Selected Token",
} = {}) {
  const mapped = mappedInternalTitle(title);
  if (mapped) return mapped;

  const candidate = compactSpaces(title);
  if (candidate && !looksLikeInternalTitle(candidate)) return candidate;

  const selected = latexToCompactDisplay(selectedText || display || latex);
  if (selected && !looksLikeInternalTitle(selected)) return selected;

  const roleTitle = compactSpaces(role)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (roleTitle && !looksLikeInternalTitle(roleTitle)) return roleTitle;

  return fallback;
}

export function userFacingText(value = "", fallback = "") {
  const text = compactSpaces(value);
  if (!text || looksLikeInternalTitle(text)) return fallback;
  return text;
}
