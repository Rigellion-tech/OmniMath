import { normalizeDisplayText } from "./mathAnnotator.js";
import { normalizeLatexTransport } from "./mathNode.js";
import {
  parseExplicitMathSegments,
  segmentMixedTextMath,
} from "./mixedTextSegments.js";

export { parseExplicitMathSegments } from "./mixedTextSegments.js";

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

function normalizeMathToken(value) {
  const source = String(value ?? "");
  if (source.includes("\\")) return normalizeLatexTransport(source);
  let latex = normalizeDisplayText(source).trim();

  UNICODE_REPLACEMENTS.forEach(({ pattern, replacement }) => {
    latex = latex.replace(pattern, replacement);
  });

  return latex
    .replace(/<=/g, "\\le ")
    .replace(/>=/g, "\\ge ")
    .replace(/\bsqrt\(([^)]+)\)/g, "\\sqrt{$1}")
    .replace(/\bvec\(([^)]+)\)/g, "\\vec{$1}")
    .replace(/\bfrac\(([^,]+),([^)]+)\)/g, "\\frac{$1}{$2}")
    .replace(/(?<!\\)\b(sin|cos|tan|sec)(?=[a-zA-Z0-9])/g, "$1 ")
    .replace(/(?<!\\)\b(sin|cos|tan|sec)\b/g, "\\$1")
    .replace(/(?<!\\)\b(alpha|beta|gamma|delta|epsilon|lambda|mu|omega|phi|pi|rho|sigma|theta)\b/g, (match) => GREEK_WORDS[match])
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDisplayTextSegment(value = "") {
  const source = String(value ?? "");
  const normalized = normalizeDisplayText(source);
  if (!normalized) return /\s/.test(source) ? " " : "";

  const leading = /^\s/.test(source) ? " " : "";
  const trailing = /\s$/.test(source) ? " " : "";
  return `${leading}${normalized}${trailing}`;
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
  return inspectMathTextPipeline(text).parts;
}

export function inspectMathTextPipeline(text = "") {
  const source = String(text ?? "");
  const explicitSegments = parseExplicitMathSegments(text);
  const mixedSegments = segmentMixedTextMath(text);
  const detectedMathSpans = [];
  const parts = mixedSegments.map((segment, index) => {
    if (segment.type === "text") {
      return { type: "text", value: normalizeDisplayTextSegment(segment.value) };
    }

    const usesPlainTextNormalization = !segment.explicit && !segment.escaped;
    const normalizedValue = usesPlainTextNormalization
      ? normalizeMathToken(segment.value)
      : normalizeLatexTransport(segment.value);
    detectedMathSpans.push({
      source: segment.value,
      normalized: normalizedValue,
      displayMode: segment.displayMode,
      explicit: segment.explicit,
      escaped: segment.escaped,
      normalization: usesPlainTextNormalization ? "plain-ocr" : "transport-only",
    });
    return {
      type: "math",
      value: normalizedValue,
      displayMode: segment.displayMode,
      explicit: segment.explicit,
      key: `math-${index}`,
    };
  }).filter((part) => part.value);

  const renderParts = withInlineBoundarySpacing(parts);
  return {
    exactString: source,
    jsonString: JSON.stringify(source),
    stringLength: source.length,
    explicitSegments: explicitSegments.map((segment) => ({
      type: segment.type,
      exactString: segment.value,
      jsonString: JSON.stringify(segment.value),
      stringLength: segment.value.length,
      displayMode: Boolean(segment.displayMode),
      explicit: Boolean(segment.explicit),
    })),
    detectedMathSpans: detectedMathSpans.map((span) => ({
      ...span,
      sourceJson: JSON.stringify(span.source),
      normalizedJson: JSON.stringify(span.normalized),
      sourceLength: span.source.length,
      normalizedLength: span.normalized.length,
      dispatch: "katex",
    })),
    renderDecisions: renderParts.map((part) => ({
      type: part.type,
      exactString: part.value,
      jsonString: JSON.stringify(part.value),
      stringLength: part.value.length,
      dispatch: part.type === "math" ? "katex" : "prose",
      displayMode: Boolean(part.displayMode),
      explicit: Boolean(part.explicit),
    })),
    parts: renderParts,
  };
}
