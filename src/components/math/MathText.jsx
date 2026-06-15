import React from "react";
import InlineMath from "./InlineMath";
import { normalizeDisplayText } from "@/lib/mathAnnotator";

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
  if (GREEK_WORDS[value]) return true;
  if (MATH_FUNCTIONS.has(value)) return true;
  if (SINGLE_VARIABLES.has(value)) return true;
  if (/[=<>^_+\-*/\u2264\u2265\u00b7\u2212\u222b\u221a]/.test(value)) return true;
  if (/^[A-Za-z]'?\([^)]*\)$/.test(value)) return true;
  if (/^(vec|frac)\([^)]+\)$/.test(value)) return true;
  if (/^(dx|dy|dz|dV|du|dv)$/.test(value)) return true;
  return false;
}

function renderAutoMathText(text, keyPrefix) {
  return text.split(/(\s+)/).map((token, index) => {
    if (/^\s+$/.test(token)) return token;

    const { leading, core, trailing } = splitAffixes(token);
    if (!isMathToken(core)) return token;

    return (
      <React.Fragment key={`${keyPrefix}-auto-${index}`}>
        {leading}
        <InlineMath math={normalizeMathToken(core)} className="omni-inline-math" />
        {trailing}
      </React.Fragment>
    );
  });
}

function renderSegment(segment, index) {
  if (segment.type === "math") {
    return (
      <InlineMath
        key={`math-${index}`}
        math={segment.value}
        className={segment.displayMode ? "omni-block-math" : "omni-inline-math"}
        displayMode={segment.displayMode}
      />
    );
  }

  return renderAutoMathText(normalizeDisplayText(segment.value), `text-${index}`);
}

function parseExplicitMath(text) {
  const segments = [];
  const pattern = /(\\\[((?:.|\n)*?)\\\]|\\\(((?:.|\n)*?)\\\)|\$\$((?:.|\n)*?)\$\$|\$([^$\n]+?)\$)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }

    segments.push({
      type: "math",
      value: match[2] || match[3] || match[4] || match[5] || "",
      displayMode: Boolean(match[2] || match[4]),
    });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", value: text.slice(lastIndex) });
  }

  return segments;
}

export default function MathText({ children, className = "" }) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const segments = parseExplicitMath(text);

  return (
    <span className={className}>
      {segments.map(renderSegment)}
    </span>
  );
}
