import { normalizeDisplayText } from "./mathAnnotator.js";

const GREEK_WORDS = {
  alpha: "\\alpha",
  beta: "\\beta",
  gamma: "\\gamma",
  delta: "\\delta",
  epsilon: "\\epsilon",
  lambda: "\\lambda",
  mu: "\\mu",
  omega: "\\omega",
  phi: "\\phi",
  pi: "\\pi",
  rho: "\\rho",
  sigma: "\\sigma",
  theta: "\\theta",
};

const UNICODE_REPLACEMENTS = [
  { pattern: /\u00b2/g, replacement: "^2" },
  { pattern: /\u00b3/g, replacement: "^3" },
  { pattern: /\u2074/g, replacement: "^4" },
  { pattern: /\u2075/g, replacement: "^5" },
  { pattern: /\u2076/g, replacement: "^6" },
  { pattern: /\u2077/g, replacement: "^7" },
  { pattern: /\u2078/g, replacement: "^8" },
  { pattern: /\u2079/g, replacement: "^9" },
  { pattern: /\u2070/g, replacement: "^0" },
  { pattern: /\u207f/g, replacement: "^n" },
  { pattern: /\u207b/g, replacement: "^-" },
  { pattern: /\u2264/g, replacement: "\\le " },
  { pattern: /\u2265/g, replacement: "\\ge " },
  { pattern: /\u00b7/g, replacement: "\\cdot " },
  { pattern: /\u2212/g, replacement: "-" },
  { pattern: /\u222b/g, replacement: "\\int " },
  { pattern: /\u03c0/g, replacement: "\\pi" },
  { pattern: /\u03c1/g, replacement: "\\rho" },
  { pattern: /\u03c6/g, replacement: "\\phi" },
  { pattern: /\u03b8/g, replacement: "\\theta" },
];

const MATH_FUNCTIONS = new Set(["cos", "sec", "sin", "sqrt", "tan"]);
const SINGLE_VARIABLES = new Set(["C", "r", "u", "v", "w", "x", "y", "z"]);
const EXPLICIT_MATH_PATTERN = /(\\\[((?:.|\n)*?)\\\]|\\\(((?:.|\n)*?)\\\)|\$\$((?:.|\n)*?)\$\$|\$([^$\n]+?)\$)/g;

function normalizeMathToken(value) {
  let latex = normalizeDisplayText(value).trim();

  UNICODE_REPLACEMENTS.forEach(({ pattern, replacement }) => {
    latex = latex.replace(pattern, replacement);
  });

  return latex
    .replace(/<=/g, "\\le ")
    .replace(/>=/g, "\\ge ")
    .replace(/\bsqrt\(([^)]+)\)/g, "\\sqrt{$1}")
    .replace(/\bvec\(([^)]+)\)/g, "\\vec{$1}")
    .replace(/\bfrac\(([^,]+),([^)]+)\)/g, "\\frac{$1}{$2}")
    .replace(/\\(sin|cos|tan|sec)(?=[a-zA-Z0-9])/g, "\\$1 ")
    .replace(/\b(sin|cos|tan|sec)(?=[a-zA-Z0-9])/g, "$1 ")
    .replace(/\b(sin|cos|tan|sec)\b/g, "\\$1")
    .replace(/\b(alpha|beta|gamma|delta|epsilon|lambda|mu|omega|phi|pi|rho|sigma|theta)\b/g, (match) => GREEK_WORDS[match])
    .replace(/\s+/g, " ")
    .trim();
}

function splitAffixes(token) {
  const leading = token.match(/^["'\u201c\u2018]+/)?.[0] || "";
  const withoutLeading = token.slice(leading.length);
  const trailing = withoutLeading.match(/[.,;:!?]+$/)?.[0] || "";
  const core = withoutLeading.slice(0, withoutLeading.length - trailing.length);

  return { leading, core, trailing };
}

function isMathToken(value) {
  if (!value) return false;
  if (value.includes("\\")) return true;
  if (MATH_FUNCTIONS.has(value)) return true;
  if (SINGLE_VARIABLES.has(value)) return true;
  if (/[=<>^_+\-*/\u00b2\u00b3\u2070-\u2079\u207f\u207b\u2264\u2265\u00b7\u2212\u222b\u221a]/.test(value)) return true;
  if (/^[A-Za-z]'?\([^)]*\)$/.test(value)) return true;
  if (/^(vec|frac)\([^)]+\)$/.test(value)) return true;
  if (/^(dx|dy|dz|dV|du|dv)$/.test(value)) return true;
  return false;
}

export function normalizeDisplayTextSegment(value = "") {
  const source = String(value ?? "");
  const normalized = normalizeDisplayText(source);
  if (!normalized) return /\s/.test(source) ? " " : "";

  const leading = /^\s/.test(source) ? " " : "";
  const trailing = /\s$/.test(source) ? " " : "";
  return `${leading}${normalized}${trailing}`;
}

export function parseExplicitMathSegments(text = "") {
  const segments = [];
  const source = String(text ?? "");
  let lastIndex = 0;
  let match;

  EXPLICIT_MATH_PATTERN.lastIndex = 0;
  while ((match = EXPLICIT_MATH_PATTERN.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: source.slice(lastIndex, match.index) });
    }

    segments.push({
      type: "math",
      value: match[2] || match[3] || match[4] || match[5] || "",
      displayMode: Boolean(match[2] || match[4]),
      explicit: true,
    });
    lastIndex = EXPLICIT_MATH_PATTERN.lastIndex;
  }

  if (lastIndex < source.length) {
    segments.push({ type: "text", value: source.slice(lastIndex) });
  }

  return segments;
}

function appendTextPart(parts, value) {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") {
    previous.value += value;
    return;
  }
  parts.push({ type: "text", value });
}

function textToAutoMathParts(text, keyPrefix) {
  const parts = [];
  const normalized = normalizeDisplayTextSegment(text);

  normalized.split(/(\s+)/).forEach((token, index) => {
    if (!token) return;
    if (/^\s+$/.test(token)) {
      appendTextPart(parts, token);
      return;
    }

    const { leading, core, trailing } = splitAffixes(token);
    if (!isMathToken(core)) {
      appendTextPart(parts, token);
      return;
    }

    appendTextPart(parts, leading);
    parts.push({
      type: "math",
      value: normalizeMathToken(core),
      displayMode: false,
      explicit: false,
      key: `${keyPrefix}-auto-${index}`,
    });
    appendTextPart(parts, trailing);
  });

  return parts;
}

function lastChar(value = "") {
  return String(value).match(/[^\s]$/u)?.[0] || "";
}

function firstChar(value = "") {
  return String(value).match(/[^\s]/u)?.[0] || "";
}

function isWordLike(char = "") {
  return /[\p{L}\p{N}\]}]/u.test(char);
}

function shouldInsertBeforeMath(left, right) {
  if (!left || right?.displayMode) return false;
  if (/\s$/.test(left.value)) return false;
  const char = lastChar(left.value);
  return isWordLike(char);
}

function shouldInsertAfterMath(left, right) {
  if (!right || left?.displayMode) return false;
  if (/^\s/.test(right.value)) return false;
  const char = firstChar(right.value);
  return /[\p{L}\p{N}]/u.test(char);
}

function withInlineBoundarySpacing(parts) {
  const spaced = [];

  parts.forEach((part) => {
    const previous = spaced[spaced.length - 1];
    if (previous?.type === "text" && part.type === "math" && shouldInsertBeforeMath(previous, part)) {
      appendTextPart(spaced, " ");
    } else if (previous?.type === "math" && part.type === "text" && shouldInsertAfterMath(previous, part)) {
      appendTextPart(spaced, " ");
    }

    if (part.type === "text") appendTextPart(spaced, part.value);
    else spaced.push(part);
  });

  return spaced;
}

export function getMathTextRenderParts(text = "") {
  const explicitSegments = parseExplicitMathSegments(text);
  const parts = explicitSegments.flatMap((segment, index) => (
    segment.type === "math"
      ? [{
        type: "math",
        value: normalizeMathToken(segment.value),
        displayMode: segment.displayMode,
        explicit: true,
        key: `math-${index}`,
      }]
      : textToAutoMathParts(segment.value, `text-${index}`)
  ));

  return withInlineBoundarySpacing(parts);
}
