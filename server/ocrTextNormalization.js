import katex from "katex";
import { renderMathLatex } from "./mathAnnotator.js";
import { createMathNode, shouldPreserveLatex, traceMathStage } from "../src/lib/mathNode.js";

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function countChangedCharacters(left, right) {
  const max = Math.max(left.length, right.length);
  let changed = Math.abs(left.length - right.length);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return { changed, max };
}

export function normalizeSpacedRelationalOperators(value = "") {
  return String(value || "")
    .replace(/>\s+=/g, ">=")
    .replace(/<\s+=/g, "<=")
    .replace(/!\s+=/g, "!=");
}

function normalizeOcrMathPhrases(value = "") {
  return String(value || "")
    .replace(/\be\s+to\s+the\s+([xyz])\s+squared\b/gi, (_, variable) => `e^{${variable.toLowerCase()}^2}`)
    .replace(/\b([xyz])\s+squared\b/gi, (_, variable) => `${variable.toLowerCase()}^2`)
    .replace(/\b([xyz])\s+cubed\b/gi, (_, variable) => `${variable.toLowerCase()}^3`)
    .replace(/\bsin\s+([A-Za-z][A-Za-z0-9]*)\b/gi, (_, argument) => `\\sin(${argument})`)
    .replace(/\bcos\s+([A-Za-z][A-Za-z0-9]*)\b/gi, (_, argument) => `\\cos(${argument})`)
    .replace(/\bln\s+([A-Za-z0-9]+)\b/gi, (_, argument) => `\\ln(${argument})`);
}

export function normalizeExtractedProblemText(value = "") {
  const original = safeString(value);
  if (!original) {
    return {
      text: "",
      changed: false,
      substantial: false,
      changedCharacters: 0,
      changeRatio: 0,
    };
  }

  let text = normalizeOcrMathPhrases(original)
    .replace(/\bLet([A-Z])be\b/g, "Let $1 be")
    .replace(/\bwhere([A-Z])\b/g, "where $1")
    .replace(/\b([Cc]urve\s+is)([A-Z])\b/g, "$1 $2")
    .replace(/\b(paraboloid|plane)([xyz])(?=\s*=|=)/gi, "$1 $2")
    .replace(/\b([A-Za-z]{3,})([xyz])(?=\s*=|=)/g, "$1 $2")
    .replace(/(dS|ds|dA|dV|dx|dy|dz)(?=where)/g, "$1 ")
    .replace(/\bwhere([A-Z])\b/g, "where $1")
    .replace(/([,;:])(?=[A-Za-z])/g, "$1 ")
    .replace(/(?<!\d)\.(?=[A-Za-z])/g, ". ")
    .replace(/([^\s([{<])(?=\bwhere\b)/g, "$1 ")
    .replace(/\b([A-Za-z]{2,})([A-Z])(?=\s*(?:=|\(|<))/g, "$1 $2")
    .replace(/\s*=\s*/g, " = ")
    .replace(/>\s+=/g, ">=")
    .replace(/<\s+=/g, "<=")
    .replace(/!\s+=/g, "!=")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/\bLet\s+S\s+be\b/g, "Let S be")
    .replace(/\bwhere\s+F\b/g, "where F")
    .replace(/\bcurve is\s+C\b/gi, (match) => match.replace(/\s+/g, " "));

  const comparableOriginal = normalizeSpacedRelationalOperators(original)
    .replace(/\s+/g, " ")
    .trim();
  const { changedCharacters, max } = (() => {
    const result = countChangedCharacters(comparableOriginal, text);
    return { changedCharacters: result.changed, max: result.max };
  })();
  const changeRatio = max > 0 ? changedCharacters / max : 0;
  const changed = text !== original;

  return {
    text,
    changed,
    substantial: changed && (changedCharacters >= 10 || changeRatio >= 0.04),
    changedCharacters,
    changeRatio: Number(changeRatio.toFixed(3)),
  };
}

function normalizeMathChunk(value = "") {
  let text = normalizeSpacedRelationalOperators(normalizeOcrMathPhrases(safeString(value)))
    .replace(/∬/g, "\\iint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/×/g, "\\times")
    .replace(/⋅|·/g, "\\cdot")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/<=/g, "\\le ")
    .replace(/>=/g, "\\ge ")
    .replace(/!=/g, "\\neq ")
    .replace(/\be\^\(([^()]+(?:\([^)]*\))?[^()]*)\)/g, "e^{$1}")
    .replace(/([A-Za-z0-9}])(sin|cos|tan|ln|log|exp)\s*\(/gi, (_, left, fn) => `${left} \\${fn.toLowerCase()}(`)
    .replace(/(?<!\\)\b(sin|cos|tan|ln|log|exp)\s*\(/gi, (_, fn) => `\\${fn.toLowerCase()}(`)
    .replace(/([A-Za-z0-9}])(?=\\(?:sin|cos|tan|ln|log|exp)\()/g, "$1 ")
    .replace(/\bz(?=\\cos\()/g, "z ")
    .replace(/\bF\s*\(/g, "\\mathbf{F}(")
    .replace(/\\nabla\s*\\times\s*F\b/g, "\\nabla \\times \\mathbf{F}")
    .replace(/\\cdot\s*n\b/g, "\\cdot \\mathbf{n}")
    .replace(/<\s*/g, "\\left\\langle ")
    .replace(/\s*>/g, " \\right\\rangle")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/\\iint\s*_\s*([A-Za-z])/g, "\\iint_{$1}")
    .replace(/\\int\s*_\s*([A-Za-z])/g, "\\int_{$1}")
    .replace(/\^([0-9A-Za-z])\b/g, "^{$1}");

  return text;
}

function validateLatex(latex) {
  if (!latex) return { latex, renderIssue: "Empty math chunk." };
  try {
    const rendered = renderMathLatex(latex);
    katex.renderToString(rendered, {
      throwOnError: true,
      strict: "ignore",
    });
    return { latex: rendered, renderIssue: "" };
  } catch (error) {
    return {
      latex,
      renderIssue: error?.message || "KaTeX render failed.",
    };
  }
}

function pushText(segments, text) {
  const cleaned = safeString(text).replace(/\s+/g, " ");
  if (!cleaned) return;
  segments.push({ type: "text", text: cleaned });
}

function pushMath(segments, text) {
  const source = safeString(text);
  if (!source) return;
  const normalized = shouldPreserveLatex(source)
    ? createMathNode(source, { stage: "ocr-normalization" }).latex
    : normalizeMathChunk(source);
  traceMathStage(
    "OCR normalization",
    source,
    normalized,
    shouldPreserveLatex(source) ? "preserved immutable LaTeX" : "unicode/plain OCR math repair"
  );
  const validation = validateLatex(normalized);
  segments.push({
    type: "math",
    text: source,
    latex: validation.latex,
    mathNode: createMathNode(validation.latex, { stage: "ocr-display" }),
    fallbackText: source,
    renderIssue: validation.renderIssue,
  });
}

function collectMathSpans(text) {
  const spans = [];
  const patterns = [
    /F\s*\([^)]*\)\s*=\s*<[^>]+>/giu,
    /(?:\\iint|∬)\s*_?\s*[A-Za-z]?\s*\([^]*?dS/giu,
    /\b[xyz]\s*=\s*(?:(?!\s+(?:lying|above|oriented|where)\b)[^,.])+/giu,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      spans.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }

  return spans
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((merged, span) => {
      const last = merged[merged.length - 1];
      if (last && span.start < last.end) {
        if (span.end > last.end) last.end = span.end;
        return merged;
      }
      merged.push({ ...span });
      return merged;
    }, []);
}

export function buildExtractedProblemDisplay({
  rawOcrText = "",
  cleanedPlainText = "",
  extractedProblemLatex = "",
} = {}) {
  const cleaned = safeString(cleanedPlainText || normalizeExtractedProblemText(rawOcrText).text);
  const spans = collectMathSpans(cleaned);
  const displaySegments = [];
  let cursor = 0;

  for (const span of spans) {
    pushText(displaySegments, cleaned.slice(cursor, span.start));
    pushMath(displaySegments, span.text);
    cursor = span.end;
  }
  pushText(displaySegments, cleaned.slice(cursor));

  if (displaySegments.length === 0 && extractedProblemLatex) {
    pushMath(displaySegments, extractedProblemLatex);
  }

  const latexMathChunks = displaySegments
    .filter((segment) => segment.type === "math")
    .map((segment) => ({
      latex: segment.latex,
      fallbackText: segment.fallbackText,
      renderIssue: segment.renderIssue,
    }));

  return {
    rawOcrText: safeString(rawOcrText),
    cleanedPlainText: cleaned,
    displaySegments,
    solverInput: cleaned,
    latexMathChunks,
  };
}
