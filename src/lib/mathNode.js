const LATEX_WRAPPERS = [
  { pattern: /^```(?:latex|tex|math)?\s*([\s\S]*?)\s*```$/iu, replacement: "$1" },
  { pattern: /^\\\(([\s\S]*)\\\)$/u, replacement: "$1" },
  { pattern: /^\\\[([\s\S]*)\\\]$/u, replacement: "$1" },
  { pattern: /^\$\$([\s\S]*)\$\$$/u, replacement: "$1" },
  { pattern: /^\$([\s\S]*)\$$/u, replacement: "$1" },
];

export function safeMathString(value, fallback = "") {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return String(value.latex || value.math || value.display || value.text || value.fallbackDisplay || fallback);
  }
  return String(value);
}

export function normalizeLatexTransport(value = "") {
  let text = safeMathString(value);
  let previous = "";

  while (text !== previous) {
    previous = text;
    text = text.trim();
    for (const { pattern, replacement } of LATEX_WRAPPERS) {
      if (pattern.test(text)) {
        text = text.replace(pattern, replacement);
        break;
      }
    }
  }

  return text.replace(/^\\displaystyle\s*/, "").trim();
}

export function createMathNode(latex, metadata = {}) {
  const normalizedLatex = normalizeLatexTransport(latex);
  return Object.freeze({
    type: "math",
    immutable: true,
    latex: normalizedLatex,
    sourceLatex: safeMathString(latex),
    normalizedLatex,
    normalization: "strip wrappers, displaystyle, and outer whitespace only",
    ...metadata,
  });
}

export function isMathNode(value) {
  return Boolean(value && typeof value === "object" && value.type === "math" && value.immutable === true);
}

export function mathNodeToLatex(value = "") {
  const candidate = value;
  if (
    candidate !== null
    && candidate !== undefined
    && typeof candidate === "object"
    && Reflect.get(candidate, "type") === "math"
    && Reflect.get(candidate, "immutable") === true
  ) {
    return String(Reflect.get(candidate, "latex") || "");
  }
  return normalizeLatexTransport(value);
}

export function canonicalLatexForKatex(value = "") {
  return createMathNode(value, { stage: "canonical-katex-input" }).latex;
}

export function hasMalformedLatexCommandSpacing(value = "") {
  const text = normalizeLatexTransport(value);
  return /\\(?:iiint|iint|oint|int|quad|langle|rangle|sinh|cosh|tanh|sin(?!h\b)|cos(?!h\b)|tan(?!h\b)|sec|csc|cot|log|ln|exp|notin|to)(?=[A-Za-z0-9])|\\le(?=(?!ft)[A-Za-z0-9])|\\ge(?=(?!q)[A-Za-z0-9])|\\in(?=(?!t|fty)[A-Za-z0-9])/.test(text);
}

export function shouldPreserveLatex(value = "") {
  const text = normalizeLatexTransport(value);
  if (hasMalformedLatexCommandSpacing(text)) return false;
  if (/[^\\]\//.test(text) && !/\\(?:frac|left|right)\b/.test(text)) return false;
  return /\\(?:arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|log|ln|exp)\s*\(/.test(text)
    || /\\(?:oint|int|iint|iiint)_/.test(text)
    || /\\(?:frac|sqrt|left|right|langle|rangle|quad|nabla|cdot|times|mathbf)\b/.test(text)
    || /\^\{|_\{/.test(text);
}

function countMatches(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

export function normalizeAngleBracketDelimiters(value = "") {
  return normalizeLatexTransport(value)
    .replace(/\\left\s*\\langle/g, "\\langle")
    .replace(/\\right\s*\\rangle/g, "\\rangle")
    .replace(/\\left\s*</g, "\\langle")
    .replace(/\\right\s*>/g, "\\rangle")
    .replace(/(?<!\\)<\s*/g, "\\langle ")
    .replace(/\s*(?<!\\)>/g, " \\rangle");
}

function balanceBraces(value = "") {
  let text = String(value || "");
  let depth = 0;
  let output = "";

  for (const char of text) {
    if (char === "{") {
      depth += 1;
      output += char;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        output += char;
      }
    } else {
      output += char;
    }
  }

  return `${output}${"}".repeat(depth)}`;
}

export function balanceLatexDelimiters(value = "") {
  let text = normalizeAngleBracketDelimiters(value);
  const leftCount = countMatches(text, /\\left\b/g);
  const rightCount = countMatches(text, /\\right\b/g);

  if (leftCount !== rightCount) {
    text = text.replace(/\\left\s*/g, "").replace(/\\right\s*/g, "");
  }

  const langleCount = countMatches(text, /\\langle\b/g);
  const rangleCount = countMatches(text, /\\rangle\b/g);
  if (langleCount > rangleCount) {
    text = `${text}${"\\rangle".repeat(langleCount - rangleCount)}`;
  } else if (rangleCount > langleCount) {
    text = `${"\\langle".repeat(rangleCount - langleCount)}${text}`;
  }

  return text.trim();
}

function repairCommandSpacing(value = "") {
  return String(value || "")
    .replace(/\\(quad|qquad)(?=[A-Za-z0-9\\])/g, "\\$1 ")
    .replace(/\\(sinh|cosh|tanh|sin(?!h\b)|cos(?!h\b)|tan(?!h\b)|sec|csc|cot|log|ln|exp)(?=[A-Za-z0-9])/g, "\\$1 ")
    .replace(/\\(oint|iint|iiint|int)(?=[A-Za-z0-9\\])/g, "\\$1 ")
    .replace(/\\le(?=(?!ft)[A-Za-z0-9\\])/g, "\\le ")
    .replace(/\\ge(?=(?!q)[A-Za-z0-9\\])/g, "\\ge ")
    .replace(/\\to(?=(?!p)[A-Za-z0-9\\])/g, "\\to ");
}

function repairMissingCommands(value = "") {
  return String(value || "")
    .replace(/(?<!\\)\b(oint|iint|iiint|int)(?=\s*_|[({\s])/g, "\\$1")
    .replace(/(?<!\\)\b(sin|cos|tan|sec|csc|cot|ln|log|exp)\s*\(/gi, (_, fn) => `\\${fn.toLowerCase()}(`)
    .replace(/(?<!\\)\b(dot)\b/gi, "\\cdot")
    .replace(/(?<!\\)\b(times)\b/gi, "\\times")
    .replace(/(?<!\\)\b(nabla)\b/gi, "\\nabla")
    .replace(/\\nabla\s*x\s*([A-Za-z\\])/g, "\\nabla \\times $1")
    .replace(/\bnabla\s*x\s*([A-Za-z\\])/gi, "\\nabla \\times $1");
}

function repairScripts(value = "") {
  return String(value || "")
    .replace(/\be\^([A-Za-z])\^([0-9A-Za-z])/g, "e^{$1^$2}")
    .replace(/\be\^\{?([A-Za-z])\^([0-9A-Za-z])\}?/g, "e^{$1^$2}")
    .replace(/\^([A-Za-z0-9])(?=\^)/g, "^{$1}")
    .replace(/_([A-Za-z0-9])(?=[A-Za-z0-9])/g, "_{$1}");
}

export function repairLatexForKatex(value = "") {
  const original = normalizeLatexTransport(value);
  let text = original
    .replace(/\\right\s+\\rangle/g, "\\rangle")
    .replace(/\\left\s+\\langle/g, "\\langle");

  text = repairMissingCommands(text);
  text = repairCommandSpacing(text);
  text = repairScripts(text);
  text = balanceLatexDelimiters(text);
  text = balanceBraces(text)
    .replace(/\\mathbf\s+([A-Za-z])/g, "\\mathbf{$1}")
    .replace(/\\mathbf([A-Za-z])\b/g, "\\mathbf{$1}")
    .replace(/\\vec\s+([A-Za-z])/g, "\\vec{$1}")
    .replace(/\\hat\s+([A-Za-z])/g, "\\hat{$1}")
    .replace(/\\cdotd(?=\\?[A-Za-z])/g, "\\cdot d")
    .replace(/(?<![\\,{])\bd([xyz])\b/g, "\\,d$1")
    .trim();

  return {
    input: original,
    output: text,
    repaired: text !== original,
  };
}

export function normalizeLatexForKatex(value = "") {
  return repairLatexForKatex(value).output;
}

export function createLatexValidationResult(value = "") {
  const repair = repairLatexForKatex(value);
  const issues = [];

  if (repair.repaired) issues.push("repaired");
  if (hasMalformedLatexCommandSpacing(repair.output)) issues.push("merged_command");
  if (countMatches(repair.output, /\{/g) !== countMatches(repair.output, /\}/g)) issues.push("unmatched_braces");
  if (countMatches(repair.output, /\\left\b/g) !== countMatches(repair.output, /\\right\b/g)) issues.push("unmatched_left_right");
  if (/\\right\b/.test(repair.output) && !/\\left\b/.test(repair.output)) issues.push("unmatched_right");

  return {
    input: repair.input,
    output: repair.output,
    valid: issues.every((issue) => issue === "repaired"),
    repaired: repair.repaired,
    issues,
  };
}

function mathPipelineDebugEnabled() {
  const nodeEnv = globalThis?.["process"]?.["env"] || {};
  const viteEnv = import.meta?.["env"] || {};
  return nodeEnv["OMNIMATH_DEBUG_SOLVE"] === "1"
    || nodeEnv["OMNIMATH_DEBUG_MATH_PIPELINE"] === "1"
    || nodeEnv["DEBUG_MATH_PIPELINE"] === "1"
    || viteEnv["VITE_DEBUG_MATH_PIPELINE"] === "1"
    || viteEnv["VITE_DEBUG_MATH_HOVER"] === "1";
}

export function traceMathStage(stage, input, output, transformation = "none", extra = {}) {
  const inputString = safeMathString(input);
  const outputString = safeMathString(output);
  const details = {
    stage,
    input: inputString,
    output: outputString,
    transformation,
    changed: inputString !== outputString,
    ...extra,
  };

  if (mathPipelineDebugEnabled() && typeof console !== "undefined") {
    console.info("[omnimath:math-pipeline]", details);
  }

  return details;
}
