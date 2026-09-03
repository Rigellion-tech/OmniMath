import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { splitEquationChainLatex } from "@/lib/equationChains";
import { canonicalLatexForKatex, createMathNode, mathNodeToLatex, normalizeLatexTransport, safeMathString, traceMathStage } from "@/lib/mathNode";
import { measureOmniSync } from "@/lib/performanceDiagnostics";
import { createSemanticKatexTrust } from "@/lib/semanticMathRenderer";

const LATEX_COMMAND_PATTERN = /\\(?:iiint|iint|int|nabla|cdot|times|mathbf|frac|left|right|sqrt|sum|lim|sin|cos|tan|ln|log|rho|phi|theta|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega)\b/;
const MATH_SYMBOL_PATTERN = /[=<>^_+\-*/]|\d\s*[a-zA-Z]|[a-zA-Z]\s*\(|\b(?:dV|dx|dy|dz)\b/;
const MALFORMED_COMMAND_REMNANT_PATTERN = /(?:^|[^\\A-Za-z])\{?\s*(?:frac|sqrt|int|iint|iiint|oint|sin|cos|tan|ln|log|pi|delta)\s*\}?(?=$|[^A-Za-z])/iu;
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
  traceMathStage(
    "KaTeX rendering",
    input,
    node.latex,
    node.normalization
  );
  return node.latex;
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

function pushEquationChainBlocks(blocks, source, idHint) {
  const segments = splitEquationChainLatex(source);
  if (segments.length <= 1) return false;
  segments.forEach((segment, index) => {
    if (index > 0) {
      blocks.push({
        type: "separator",
        idHint: `${idHint}-arrow-${index}`,
        text: "\\Rightarrow",
      });
    }
    pushMathBlock(blocks, segment, `${idHint}-${index + 1}`);
  });
  return true;
}

function readBracedGroup(text, startIndex) {
  if (text[startIndex] !== "{") return null;
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    if (depth === 0) {
      return {
        value: text.slice(startIndex + 1, index),
        end: index + 1,
      };
    }
  }
  return null;
}

function trimAlternativeMathSegment(value = "") {
  let text = String(value || "").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^(?:\\qquad|\\quad|\\[,;!]|~|\s)+/u, "")
      .replace(/(?:\\qquad|\\quad|\\[,;!]|~|\s)+$/u, "")
      .trim();
  }
  return text;
}

function separatorLabelFromTextCommand(value = "") {
  const label = cleanProse(value).toLowerCase();
  return /^(?:or|and)$/.test(label) ? label : "";
}

function splitTopLevelTextAlternatives(source = "") {
  const text = String(source || "");
  const blocks = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (braceDepth === 0 && parenDepth === 0) {
      const command = text.startsWith("\\text", index)
        ? "\\text"
        : text.startsWith("\\mathrm", index)
          ? "\\mathrm"
          : "";
      if (command) {
        const group = readBracedGroup(text, index + command.length);
        const separatorText = group ? separatorLabelFromTextCommand(group.value) : "";
        if (separatorText) {
          const math = trimAlternativeMathSegment(text.slice(start, index));
          if (math) pushMathBlock(blocks, math, `alternative-${blocks.length + 1}`);
          blocks.push({
            type: "separator",
            idHint: `alternative-separator-${blocks.length + 1}`,
            text: separatorText,
          });
          index = group.end - 1;
          start = group.end;
          continue;
        }
      }
    }

    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
  }

  if (blocks.length === 0) return [];
  const tail = trimAlternativeMathSegment(text.slice(start));
  if (tail) pushMathBlock(blocks, tail, `alternative-${blocks.length + 1}`);
  return blocks.filter((block, index, all) => (
    block.type !== "separator"
    || (all[index - 1]?.type === "math" && all[index + 1]?.type === "math")
  ));
}

export function splitLatexRenderBlocks(value = "") {
  const source = normalizeMathRendererInput(value).replace(PROBLEM_PREAMBLE_PATTERN, "").trim();
  if (!source) return [];

  const boundary = findFirstProseBoundary(source);
  if (!boundary && !(source.length > 160 && /\\text\{/.test(source))) {
    const alternativeBlocks = splitTopLevelTextAlternatives(source);
    if (alternativeBlocks.length > 1) return alternativeBlocks;
    const chainBlocks = [];
    if (pushEquationChainBlocks(chainBlocks, source, "chain")) return chainBlocks;
    const node = createMathNode(source, { idHint: "math" });
    return [{ type: "math", idHint: "math", latex: node.latex, mathNode: node }];
  }

  const blocks = [];
  const firstMath = boundary ? source.slice(0, boundary.index).trim() : source;
  if (firstMath && !pushEquationChainBlocks(blocks, firstMath, "primary")) {
    pushMathBlock(blocks, firstMath, "primary");
  }

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
  if (
    import.meta.env.DEV
    && (
      import.meta.env.VITE_DEBUG_MATH_RENDER === "true"
      || import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
      || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
    )
  ) {
    console.info("[omnimath:math-render]", details);
  }
}

function hasMalformedCommandRemnant(value = "") {
  return MALFORMED_COMMAND_REMNANT_PATTERN.test(normalizeMathRendererInput(value));
}

export default function MathRenderer({
  math,
  semanticLatex = "",
  semanticAnnotatedNodeCount = 0,
  className = "",
  displayMode = false,
  fallbackText = "",
  componentName = "MathRenderer",
  forceMath = true,
  interactive = false,
  diagnosticReasoningStepIndex = null,
  diagnosticReasoningSpanIndex = null,
}) {
  const hostRef = useRef(null);
  const rawMath = safeMathString(math);
  const fallback = safeMathString(fallbackText || math, rawMath);
  const normalizedMath = useMemo(() => normalizeMathRendererInput(rawMath), [rawMath]);
  const sanitizedMath = useMemo(() => sanitizeLatex(normalizedMath), [normalizedMath]);
  const shouldRenderKatex = forceMath || looksLikeMathExpression(normalizedMath);
  const plainRenderMath = useMemo(
    () => (shouldRenderKatex ? canonicalLatexForKatex(sanitizedMath) : sanitizedMath),
    [sanitizedMath, shouldRenderKatex]
  );
  const authoritativeSemanticLatex = safeMathString(semanticLatex);
  const hasAuthoritativeSemanticLatex = shouldRenderKatex && Boolean(authoritativeSemanticLatex);
  const renderMath = hasAuthoritativeSemanticLatex ? authoritativeSemanticLatex : plainRenderMath;
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    host.removeAttribute("data-semantic-render-fallback");
    setRenderError("");

    logMathRender({
      componentName,
      rawEquation: rawMath,
      normalizedEquation: normalizedMath,
      sanitizedEquation: sanitizedMath,
      katexInput: renderMath,
      sentToKatex: shouldRenderKatex,
      displayMode,
      interactive,
      semanticAnnotatedNodeCount: hasAuthoritativeSemanticLatex ? semanticAnnotatedNodeCount : 0,
      canonicalLatexPreserved: plainRenderMath === sanitizedMath,
    });

    if (
      import.meta.env.DEV
      && import.meta.env.VITE_DEBUG_REASONING_LATEX === "true"
      && Number.isInteger(diagnosticReasoningStepIndex)
    ) {
      console.info("[omnimath:reasoning-latex]", {
        stage: "7.final_katex_invocation",
        stepIndex: diagnosticReasoningStepIndex,
        stepNumber: diagnosticReasoningStepIndex + 1,
        spanIndex: diagnosticReasoningSpanIndex,
        exactString: renderMath,
        jsonString: JSON.stringify(renderMath),
        stringLength: renderMath.length,
        detectedMathSpans: [{
          source: rawMath,
          sourceJson: JSON.stringify(rawMath),
          normalized: renderMath,
          normalizedJson: JSON.stringify(renderMath),
          sourceLength: rawMath.length,
          normalizedLength: renderMath.length,
          dispatch: shouldRenderKatex ? "katex" : "prose",
        }],
        sentToKatex: shouldRenderKatex,
      });
    }

    if (!shouldRenderKatex) {
      host.textContent = fallback;
      return undefined;
    }

    if (
      import.meta.env.DEV
      && (
        import.meta.env.VITE_DEBUG_MATH_RENDER === "true"
        || import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
        || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
      )
    ) {
      console.debug("[omnimath:katex-input]", renderMath);
    }

    const malformedInput = hasMalformedCommandRemnant(rawMath) || hasMalformedCommandRemnant(sanitizedMath);

    try {
      if (malformedInput) {
        throw new Error("Malformed generated LaTeX command remnant.");
      }
      const katexOptions = {
        throwOnError: true,
        strict: /** @type {const} */ ("ignore"),
        displayMode,
        ...(hasAuthoritativeSemanticLatex ? { trust: createSemanticKatexTrust() } : {}),
      };
      const renderWithKatex = (latex, options) => {
        if (import.meta.env.DEV) {
          measureOmniSync("katex.renderToString.render-path", () => katex.renderToString(latex, options), {
            componentName,
            displayMode,
            interactive,
            latexLength: latex.length,
          });
          measureOmniSync("katex.render.dom", () => katex.render(latex, host, options), {
            componentName,
            displayMode,
            interactive,
            latexLength: latex.length,
          });
          return;
        }
        katex.renderToString(latex, options);
        katex.render(latex, host, options);
      };

      try {
        renderWithKatex(renderMath, katexOptions);
      } catch (semanticError) {
        if (!hasAuthoritativeSemanticLatex) throw semanticError;
        host.replaceChildren();
        host.setAttribute("data-semantic-render-fallback", "true");
        console.warn("[omnimath:semantic-render-fallback]", {
          componentName,
          semanticAnnotatedNodeCount,
          message: semanticError?.message || "Semantic KaTeX render failed",
        });
        renderWithKatex(plainRenderMath, {
          throwOnError: true,
          strict: /** @type {const} */ ("ignore"),
          displayMode,
        });
      }
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
        interactive,
        semanticAnnotatedNodeCount: hasAuthoritativeSemanticLatex ? semanticAnnotatedNodeCount : 0,
        message,
        error,
      });
    }

    return () => {
      host.replaceChildren();
    };
  }, [componentName, diagnosticReasoningSpanIndex, diagnosticReasoningStepIndex, displayMode, fallback, hasAuthoritativeSemanticLatex, interactive, normalizedMath, plainRenderMath, rawMath, renderMath, sanitizedMath, semanticAnnotatedNodeCount, shouldRenderKatex]);

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
