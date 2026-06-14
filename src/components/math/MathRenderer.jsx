import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { renderMathLatex } from "@/lib/mathAnnotator";

const LATEX_COMMAND_PATTERN = /\\(?:iiint|iint|int|nabla|cdot|times|mathbf|frac|left|right|sqrt|sum|lim|sin|cos|tan|ln|log|rho|phi|theta|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega)\b/;
const MATH_SYMBOL_PATTERN = /[=<>^_+\-*/]|\d\s*[a-zA-Z]|[a-zA-Z]\s*\(|\b(?:dV|dx|dy|dz)\b/;
const PROBLEM_PREAMBLE_PATTERN = /^(?:start\s+with\s+(?:the\s+)?problem|write\s+down\s+the\s+(?:integral|problem)(?:\s+and\s+vector\s+field)?|evaluate|compute|calculate|find|solve|determine)\s*:?\s*/i;
const PROSE_BOUNDARY_PATTERNS = [
  /\\text\{\s*where\s*\}/i,
  /\\text\{\s*and\s*\}/i,
  /where(?=(?:\\mathbf\{?F|F)\b)/i,
  /and(?=V\b)/i,
  /\bwhere(?=(?:\\mathbf\{?F|F)\b|\s)/i,
  /\band(?=V\b|\s)/i,
];

export function safeMathString(math, fallback = "") {
  if (math === null || math === undefined) return "";
  if (typeof math === "string" || typeof math === "number" || typeof math === "boolean") {
    return String(math);
  }
  if (typeof math === "object") {
    return String(math.latex || math.math || math.display || math.text || math.fallbackDisplay || fallback);
  }
  return String(math);
}

export function normalizeMathRendererInput(value = "") {
  let text = safeMathString(value).trim();
  let previous = "";

  while (text !== previous) {
    previous = text;
    text = text.trim();
    const wrappers = [
      { pattern: /^```(?:latex|tex|math)?\s*([\s\S]*?)\s*```$/iu, replacement: "$1" },
      { pattern: /^\\\(([\s\S]*)\\\)$/u, replacement: "$1" },
      { pattern: /^\\\[([\s\S]*)\\\]$/u, replacement: "$1" },
      { pattern: /^\$\$([\s\S]*)\$\$$/u, replacement: "$1" },
      { pattern: /^\$([\s\S]*)\$$/u, replacement: "$1" },
    ];
    for (const { pattern, replacement } of wrappers) {
      if (pattern.test(text)) {
        text = text.replace(pattern, replacement).trim();
        break;
      }
    }
  }

  return text.replace(/^\\displaystyle\s*/, "").trim();
}

function ensureVectorBrackets(text) {
  let output = String(text || "");
  output = output
    .replace(/(?<!\\left)\\langle/g, "\\left\\langle")
    .replace(/(?<!\\right)\\rangle/g, "\\right\\rangle");

  const leftCount = (output.match(/\\left\\langle/g) || []).length;
  const rightCount = (output.match(/\\right\\rangle/g) || []).length;
  if (leftCount > rightCount) {
    output = `${output}${"\\right\\rangle".repeat(leftCount - rightCount)}`;
  }
  if (rightCount > leftCount) {
    output = `${"\\left\\langle".repeat(rightCount - leftCount)}${output}`;
  }
  return output;
}

export function sanitizeLatex(input = "") {
  let text = normalizeMathRendererInput(input);

  text = text
    .replace(PROBLEM_PREAMBLE_PATTERN, "")
    .replace(/\\\\(?=([a-zA-Z]+|[,;!]))/g, () => "\\")
    .replace(/∭/g, "\\iiint")
    .replace(/∬/g, "\\iint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/⋅|·/g, "\\cdot")
    .replace(/×/g, "\\times")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/≠/g, "\\ne")
    .replace(/∞/g, "\\infty")
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/\\([xyz])\b/g, "$1")
    .replace(/\\mathbf\s*([A-Za-z])/g, "\\mathbf{$1}")
    .replace(/(?<!\\)\bln(?=\s*\()/gi, "\\ln")
    .replace(/(?<!\\)\bsin(?=\s*\()/gi, "\\sin")
    .replace(/(?<!\\)\bcos(?=\s*\()/gi, "\\cos")
    .replace(/(?<!\\)\btan(?=\s*\()/gi, "\\tan")
    .replace(/(?<!\\)\barctan(?=\s*\()/gi, "\\arctan")
    .replace(/(?<!\\)\bfrac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gi, "\\frac{$1}{$2}")
    .replace(/(?<!\\)\bint_/gi, "\\int_")
    .replace(/(?<!\\)\biiint_/gi, "\\iiint_")
    .replace(/(?<!\\)\biint_/gi, "\\iint_")
    .replace(/\\text\{\s*(where|and)\s*\}/gi, (_, word) => `\\quad \\text{${word.toLowerCase()} } \\quad`)
    .replace(/where(?=(?:\\mathbf\{?F|F)\b)/gi, "\\quad \\text{where } ")
    .replace(/and(?=V\b)/gi, "\\quad \\text{and } ")
    .replace(/\bwhere(?=(?:\\mathbf\{?F|F)\b)/gi, "\\quad \\text{where } ")
    .replace(/\band(?=V\b)/gi, "\\quad \\text{and } ")
    .replace(/\s+/g, " ")
    .trim();

  return ensureVectorBrackets(text);
}

export function sanitizeKatexInput(input = "") {
  return String(input || "")
    .replace(/\\(langle|rangle)(?=[A-Za-z0-9\\])/g, "\\$1 ")
    .replace(/\\le(?=(?!ft)[A-Za-z0-9\\])/g, "\\le ")
    .replace(/\\ge(?=(?!q)[A-Za-z0-9\\])/g, "\\ge ")
    .replace(/\\to(?=(?!p)[A-Za-z0-9\\])/g, "\\to ")
    .replace(/\\notin(?=[A-Za-z0-9\\])/g, "\\notin ")
    .replace(/\\in(?=(?!t|fty)[A-Za-z0-9\\])/g, "\\in ")
    .replace(/\\text\{([^}]*)\}(?=[A-Za-z0-9\\])/g, "\\text{$1} ")
    .trim();
}

export function containsLatexCommand(value = "") {
  return LATEX_COMMAND_PATTERN.test(normalizeMathRendererInput(value));
}

export function looksLikeMathExpression(value = "") {
  const normalized = normalizeMathRendererInput(value);
  return containsLatexCommand(normalized) || MATH_SYMBOL_PATTERN.test(normalized);
}

function findFirstProseBoundary(text) {
  let best = null;
  for (const pattern of PROSE_BOUNDARY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index) best = { index: match.index, match };
  }
  return best;
}

function stripLeadingBoundary(text) {
  return String(text || "")
    .replace(/^(?:\\text\{\s*where\s*\}|where)\s*/i, "")
    .replace(/^(?:\\text\{\s*and\s*\}|and)\s*/i, "")
    .trim();
}

function cleanProse(text) {
  return String(text || "")
    .replace(/\\quad/g, " ")
    .replace(/\\,/g, " ")
    .replace(/\\text\{\s*(where|and)\s*\}/gi, "$1")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findFieldAssignment(text) {
  const startMatch = /(?:\\mathbf\{?F\}?|F)\s*\([^)]*\)\s*=/.exec(text);
  if (!startMatch) return null;

  const start = startMatch.index;
  const afterStart = text.slice(start);
  const rightMatch = /\\right\\rangle|\\rangle/.exec(afterStart);
  const regionMatch = /\bV\s*=/.exec(afterStart);
  let end = text.length;

  if (rightMatch) {
    end = start + rightMatch.index + rightMatch[0].length;
  } else if (regionMatch) {
    end = start + regionMatch.index;
  }

  return {
    start,
    end,
    latex: text.slice(start, end).trim(),
  };
}

function findRegionAssignment(text) {
  const match = /\bV\s*=/.exec(text);
  if (!match) return null;
  return {
    start: match.index,
    end: text.length,
    latex: text.slice(match.index).trim(),
  };
}

function pushMathBlock(blocks, latex, idHint) {
  const sanitized = sanitizeLatex(latex);
  if (!sanitized) return;
  blocks.push({
    type: "math",
    idHint,
    latex: sanitized,
  });
}

function pushProseBlock(blocks, text, idHint) {
  const prose = cleanProse(text);
  if (!prose) return;
  blocks.push({
    type: "text",
    idHint,
    text: prose,
  });
}

export function splitLatexRenderBlocks(value = "") {
  const source = normalizeMathRendererInput(value).replace(PROBLEM_PREAMBLE_PATTERN, "").trim();
  if (!source) return [];

  const boundary = findFirstProseBoundary(source);
  if (!boundary && !(source.length > 160 && /\\text\{/.test(source))) {
    return [{ type: "math", idHint: "math", latex: sanitizeLatex(source) }];
  }

  const blocks = [];
  const firstMath = boundary ? source.slice(0, boundary.index).trim() : source;
  if (firstMath) pushMathBlock(blocks, firstMath, "primary");

  let tail = boundary ? stripLeadingBoundary(source.slice(boundary.index + boundary.match[0].length)) : "";
  tail = tail
    .replace(/where(?=(?:\\mathbf\{?F|F)\b)/i, "")
    .replace(/and(?=V\b)/i, "")
    .replace(/\bwhere(?=(?:\\mathbf\{?F|F)\b)/i, "")
    .replace(/\band(?=V\b)/i, "")
    .trim();

  const field = findFieldAssignment(tail);
  if (field) {
    pushProseBlock(blocks, tail.slice(0, field.start), "context");
    pushMathBlock(blocks, field.latex, "field");
    tail = tail.slice(field.end).trim();
  }

  tail = tail
    .replace(/^(?:\\quad\s*)?(?:\\text\{\s*and\s*\}|and)\s*/i, "")
    .replace(/and(?=V\b)/i, "")
    .replace(/\band(?=V\b)/i, "")
    .trim();

  const region = findRegionAssignment(tail);
  if (region) {
    pushProseBlock(blocks, tail.slice(0, region.start), "region-context");
    pushMathBlock(blocks, region.latex, "region");
    pushProseBlock(blocks, tail.slice(region.end), "after-region");
  } else {
    pushProseBlock(blocks, tail, "tail");
  }

  return blocks.length > 0 ? blocks : [{ type: "math", idHint: "math", latex: sanitizeLatex(source) }];
}

function logMathRender(details) {
  console.info("[omnimath:math-render]", details);
}

export default function MathRenderer({
  math,
  className = "",
  displayMode = false,
  fallbackText = "",
  componentName = "MathRenderer",
  forceMath = true,
}) {
  const hostRef = useRef(null);
  const rawMath = safeMathString(math);
  const fallback = safeMathString(fallbackText || math, rawMath);
  const normalizedMath = useMemo(() => normalizeMathRendererInput(rawMath), [rawMath]);
  const sanitizedMath = useMemo(() => sanitizeLatex(normalizedMath), [normalizedMath]);
  const shouldRenderKatex = forceMath || looksLikeMathExpression(normalizedMath);
  const renderMath = useMemo(
    () => (shouldRenderKatex ? sanitizeKatexInput(renderMathLatex(sanitizedMath)) : sanitizedMath),
    [sanitizedMath, shouldRenderKatex]
  );
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    setRenderError("");

    logMathRender({
      componentName,
      rawEquation: rawMath,
      normalizedEquation: normalizedMath,
      sanitizedEquation: sanitizedMath,
      katexInput: renderMath,
      sentToKatex: shouldRenderKatex,
      displayMode,
    });

    if (!shouldRenderKatex) {
      host.textContent = fallback;
      return undefined;
    }

    console.debug("[omnimath:katex-input]", renderMath);

    try {
      katex.render(renderMath, host, {
        throwOnError: true,
        displayMode,
      });
      host.removeAttribute("data-math-fallback");
    } catch (error) {
      const message = error?.message || "Unknown KaTeX error";
      setRenderError(message);
      host.textContent = renderMath || sanitizedMath || fallback;
      host.setAttribute("data-math-fallback", "true");
      console.error("[omnimath:math-render-error]", {
        componentName,
        originalInput: rawMath,
        rawEquation: rawMath,
        normalizedEquation: normalizedMath,
        sanitizedEquation: sanitizedMath,
        katexInput: renderMath,
        displayMode,
        message,
        error,
      });
    }

    return () => {
      host.replaceChildren();
    };
  }, [componentName, displayMode, fallback, normalizedMath, rawMath, renderMath, sanitizedMath, shouldRenderKatex]);

  const Tag = displayMode ? "div" : "span";

  return (
    <Tag
      ref={hostRef}
      className={[
        className,
        renderError ? "font-mono not-italic text-sm leading-6 text-amber-100/90 whitespace-pre-wrap break-words" : "",
      ].filter(Boolean).join(" ")}
      data-math-renderer="katex"
      data-math-render-error={renderError || undefined}
      title={renderError || undefined}
    />
  );
}
