const INTERNAL_TITLE_MAP = new Map([
  ["curldivergenceidentityselfzerocurl", "Divergence of a Curl"],
  ["trigpythagoreanidentity", "Pythagorean Trigonometric Identity"],
  ["integrationbypartsselection", "Integration by Parts"],
]);

const INTERNAL_PREFIX_PATTERN = /^(expression|reasoning|classifier|semantic|debug|metadata|prompt|node|internal)[_-]/i;
const INTERNAL_WORD_PATTERN = /\b(reasoningKey|classifierTag|semanticTag|debugLabel|internalName|nodeId|metadata|promptArtifact)\b/i;
const GENERIC_SEMANTIC_TITLE_PATTERN = /^(number|variable|constant|operator|equality|term|factor|function|function name|function argument|argument|component|differential|coefficient|base|numerator|denominator|lower bound|upper bound|left side|right side)$/i;

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
    .replace(/\\left\s*/g, "")
    .replace(/\\right\s*/g, "")
    .replace(/\\langle/g, "⟨")
    .replace(/\\rangle/g, "⟩")
    .replace(/\\mathbf\{([^}]*)\}/g, "$1")
    .replace(/\\mathbf\s*([a-zA-Z])/g, "$1")
    .replace(/\\theta/g, "θ")
    .replace(/\\phi/g, "φ")
    .replace(/\\rho/g, "ρ")
    .replace(/\\pi/g, "π")
    .replace(/\\nabla/g, "∇")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\\le/g, "≤")
    .replace(/\\ge/g, "≥")
    .replace(/\\,/g, " ")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeBrokenMathLabel(value = "") {
  const text = latexToCompactDisplay(value);
  if (!text) return true;
  if (/^[()[\]{}.,;:|\\/\s]+$/.test(text)) return true;
  if (/\(\s*\)/.test(text)) return true;
  return false;
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
  const selected = latexToCompactDisplay(selectedText || display || latex);
  if (selected && candidate && GENERIC_SEMANTIC_TITLE_PATTERN.test(candidate)) return selected;
  if (candidate && !looksLikeInternalTitle(candidate)) return candidate;

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
