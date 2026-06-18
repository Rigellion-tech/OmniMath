import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { createLatexValidationResult, createMathNode, mathNodeToLatex, normalizeLatexTransport, safeMathString, traceMathStage } from "@/lib/mathNode";

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

export function normalizeMathRendererInput(value = "") {
  return normalizeLatexTransport(value);
}

export function sanitizeLatex(input = "") {
  const node = createMathNode(input, { stage: "frontend-renderer-sanitize" });
  const validation = createLatexValidationResult(node.latex);
  traceMathStage(
    "KaTeX rendering",
    input,
    validation.output,
    validation.repaired ? `pre-KaTeX repair: ${validation.issues.join(",") || "clean"}` : node.normalization
  );
  return validation.output;
}

export function sanitizeKatexInput(input = "") {
  return mathNodeToLatex(input);
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
  const node = createMathNode(latex, { idHint });
  if (!node.latex) return;
  blocks.push({
    type: "math",
    idHint,
    latex: node.latex,
    mathNode: node,
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
    const node = createMathNode(source, { idHint: "math" });
    return [{ type: "math", idHint: "math", latex: node.latex, mathNode: node }];
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

  if (blocks.length > 0) return blocks;
  const node = createMathNode(source, { idHint: "math" });
  return [{ type: "math", idHint: "math", latex: node.latex, mathNode: node }];
}

export function MathRenderShell({
  children,
  className = "",
  displayMode = true,
  role = "math",
}) {
  const Tag = displayMode ? "div" : "span";
  return (
    <Tag
      className={[
        "math-render-shell",
        displayMode ? "math-render-shell-block" : "math-render-shell-inline",
        className,
      ].filter(Boolean).join(" ")}
      data-math-shell={role}
    >
      {children}
    </Tag>
  );
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
    () => (shouldRenderKatex ? sanitizeKatexInput(sanitizedMath) : sanitizedMath),
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
      katex.renderToString(renderMath, {
        throwOnError: true,
        strict: "ignore",
        displayMode,
      });
      katex.render(renderMath, host, {
        throwOnError: true,
        strict: "ignore",
        displayMode,
      });
      host.removeAttribute("data-math-fallback");
    } catch (error) {
      const message = error?.message || "Unknown KaTeX error";
      setRenderError(message);
      host.textContent = "";
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
      data-math-render-error={renderError ? "true" : undefined}
    />
  );
}
