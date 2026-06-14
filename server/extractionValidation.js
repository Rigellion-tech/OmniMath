const SUPERSCRIPT_DIGITS = new Map([
  ["⁰", "0"],
  ["¹", "1"],
  ["²", "2"],
  ["³", "3"],
  ["⁴", "4"],
  ["⁵", "5"],
  ["⁶", "6"],
  ["⁷", "7"],
  ["⁸", "8"],
  ["⁹", "9"],
]);

const SUBSCRIPT_DIGITS = new Map([
  ["₀", "0"],
  ["₁", "1"],
  ["₂", "2"],
  ["₃", "3"],
  ["₄", "4"],
  ["₅", "5"],
  ["₆", "6"],
  ["₇", "7"],
  ["₈", "8"],
  ["₉", "9"],
]);

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUnicodeScripts(value) {
  let output = "";
  for (const char of safeString(value)) {
    if (SUPERSCRIPT_DIGITS.has(char)) {
      output += `^${SUPERSCRIPT_DIGITS.get(char)}`;
    } else if (SUBSCRIPT_DIGITS.has(char)) {
      output += `_${SUBSCRIPT_DIGITS.get(char)}`;
    } else {
      output += char;
    }
  }
  return output;
}

function normalizeForScan(value) {
  return normalizeUnicodeScripts(value)
    .replace(/\\left|\\right/g, "")
    .replace(/\\mathrm\{e\}/g, "e")
    .replace(/\\operatorname\{([^{}]+)\}/g, "\\$1")
    .replace(/\\ /g, " ")
    .replace(/\s+/g, "");
}

function readScriptAt(source, index) {
  let cursor = index + 1;
  if (source[cursor] === "{") {
    let depth = 1;
    let value = "";
    cursor += 1;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "{") {
        depth += 1;
        value += char;
      } else if (char === "}") {
        depth -= 1;
        if (depth > 0) value += char;
      } else {
        value += char;
      }
      cursor += 1;
    }
    return value;
  }

  if (source[cursor] === "\\") {
    const command = source.slice(cursor).match(/^\\[a-zA-Z]+/u)?.[0];
    if (command) return command;
  }

  return source[cursor] || "";
}

function readBaseBefore(source, index) {
  let cursor = index - 1;
  if (source[cursor] === "}") {
    let depth = 1;
    cursor -= 1;
    let value = "";
    while (cursor >= 0 && depth > 0) {
      const char = source[cursor];
      if (char === "}") {
        depth += 1;
        value = char + value;
      } else if (char === "{") {
        depth -= 1;
        if (depth > 0) value = char + value;
      } else {
        value = char + value;
      }
      cursor -= 1;
    }
    return value;
  }

  if (/[a-zA-Z0-9]/u.test(source[cursor] || "")) {
    let value = "";
    while (cursor >= 0 && /[a-zA-Z0-9]/u.test(source[cursor])) {
      value = source[cursor] + value;
      cursor -= 1;
    }
    return value;
  }

  return source[cursor] || "";
}

function compactScript(value) {
  return normalizeForScan(value)
    .replace(/[{}]/g, "")
    .replace(/\\cdot|\\,/g, "")
    .toLowerCase();
}

function extractScripts(value, marker) {
  const source = normalizeForScan(value);
  const scripts = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== marker) continue;
    const script = readScriptAt(source, index);
    scripts.push({
      base: compactScript(readBaseBefore(source, index)),
      value: compactScript(script),
      raw: script,
    });
  }
  return scripts.filter((item) => item.value);
}

function countParentheses(value) {
  const source = normalizeForScan(value);
  return {
    open: (source.match(/\(/g) || []).length,
    close: (source.match(/\)/g) || []).length,
  };
}

function normalizeForDistance(value) {
  return normalizeForScan(value)
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\([a-zA-Z]+)/g, "$1")
    .replace(/[{}()[\],.;:]/g, "")
    .toLowerCase();
}

function levenshteinRatio(a, b) {
  const left = normalizeForDistance(a);
  const right = normalizeForDistance(b);
  if (!left && !right) return 0;
  if (!left || !right) return 1;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }

  return previous[right.length] / Math.max(left.length, right.length);
}

function scriptKey(item) {
  return `${item.base}:${item.value}`;
}

function compareScripts(textScripts, latexScripts, type) {
  const latexKeys = new Set(latexScripts.map(scriptKey));
  const latexValuesByBase = new Map(latexScripts.map((item) => [item.base, item.value]));
  const issues = [];

  for (const item of textScripts) {
    if (latexKeys.has(scriptKey(item))) continue;
    const latexValue = latexValuesByBase.get(item.base);
    issues.push({
      type,
      severity: "high",
      critical: true,
      message: latexValue
        ? `${type === "exponent_loss" ? "Exponent" : "Subscript"} changed near ${item.base || "a term"}: expected ${item.value}, saw ${latexValue}.`
        : `${type === "exponent_loss" ? "Exponent" : "Subscript"} may have been removed near ${item.base || "a term"}.`,
    });
  }

  return issues;
}

function countVectorComponents(value) {
  const source = normalizeForScan(value);
  const vectorMatch = source.match(/(?:\\langle|<|\()([^<>()]+,[^<>()]+)(?:\\rangle|>|\))/u);
  if (!vectorMatch) return null;
  return vectorMatch[1].split(",").filter(Boolean).length;
}

function hasIntegralBounds(value) {
  const source = normalizeForScan(value);
  return /\\int(?:_\{?[^{}\s]+\}?|[^^])*\^\{?[^{}\s]+\}?|\\int_\{?[^{}\s]+\}?/u.test(source);
}

function hasFunctionArgumentGroup(value) {
  const source = normalizeForScan(value);
  return /\\(?:sin|cos|tan|sec|csc|cot|ln|log|exp)\(/u.test(source);
}

function hasTheoremSensitiveTerms(value) {
  return /\b(boundary|orientation|oriented|normal|outward|inward|clockwise|counterclockwise|surface|flux|curl|divergence|closed)\b/iu.test(value);
}

function parseOcrConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null;
}

export function validateExtraction({
  extractedProblemText = "",
  extractedProblemLatex = "",
  ocrConfidence = null,
  modelConfidence = null,
  modelIssues = [],
} = {}) {
  const text = safeString(extractedProblemText);
  const latex = safeString(extractedProblemLatex);
  const textExponents = extractScripts(text, "^");
  const latexExponents = extractScripts(latex, "^");
  const textSubscripts = extractScripts(text, "_");
  const latexSubscripts = extractScripts(latex, "_");
  const textParens = countParentheses(text);
  const latexParens = countParentheses(latex);
  const differenceRatio = levenshteinRatio(text, latex);
  const confidenceInput = parseOcrConfidence(ocrConfidence);
  const modelConfidenceInput = parseOcrConfidence(modelConfidence);
  const issues = [
    ...(Array.isArray(modelIssues) ? modelIssues.map((issue) => ({
      type: safeString(issue?.type) || "ocr_unclear",
      severity: ["low", "medium", "high"].includes(issue?.severity) ? issue.severity : "medium",
      critical: issue?.severity === "high",
      message: safeString(issue?.message) || "Review this extraction before solving.",
    })) : []),
    ...compareScripts(textExponents, latexExponents, "exponent_loss"),
    ...compareScripts(textSubscripts, latexSubscripts, "subscript_loss"),
  ];

  if ((textParens.open > latexParens.open) || (textParens.close > latexParens.close)) {
    issues.push({
      type: "parentheses_loss",
      severity: "high",
      critical: true,
      message: "Parentheses in the text transcription may be missing from the LaTeX extraction.",
    });
  }

  if (hasFunctionArgumentGroup(text) && !hasFunctionArgumentGroup(latex)) {
    issues.push({
      type: "function_argument_changed",
      severity: "high",
      critical: true,
      message: "A function argument group may have changed or lost parentheses.",
    });
  }

  const textVectorComponents = countVectorComponents(text);
  const latexVectorComponents = countVectorComponents(latex);
  if (textVectorComponents !== null && latexVectorComponents !== null && textVectorComponents !== latexVectorComponents) {
    issues.push({
      type: "vector_component_count_mismatch",
      severity: "high",
      critical: true,
      message: `Vector component count may have changed: expected ${textVectorComponents}, saw ${latexVectorComponents}.`,
    });
  }

  if (hasIntegralBounds(text) && !hasIntegralBounds(latex)) {
    issues.push({
      type: "integral_bounds_unclear",
      severity: "high",
      critical: true,
      message: "Integral bounds are present in the text transcription but unclear in the LaTeX extraction.",
    });
  }

  if (hasTheoremSensitiveTerms(text) && !hasTheoremSensitiveTerms(latex)) {
    issues.push({
      type: "theorem_sensitive_structure_unclear",
      severity: "high",
      critical: true,
      message: "Boundary, orientation, or theorem-sensitive structure may be missing from the extraction.",
    });
  }

  const totalSuperscripts = Math.max(textExponents.length, latexExponents.length);
  if (totalSuperscripts >= 3) {
    issues.push({
      type: "many_superscripts",
      severity: "medium",
      critical: false,
      message: "This extraction contains several superscripts; review powers before trusting the solution.",
    });
  }

  if (confidenceInput !== null && confidenceInput < 70) {
    issues.push({
      type: "low_ocr_confidence",
      severity: confidenceInput < 45 ? "high" : "medium",
      critical: confidenceInput < 60,
      message: `OCR confidence is ${Math.round(confidenceInput)}%.`,
    });
  }

  if (differenceRatio > 0.34) {
    issues.push({
      type: "text_latex_mismatch",
      severity: differenceRatio > 0.5 ? "high" : "medium",
      critical: differenceRatio > 0.5,
      message: "The plain-text transcription and LaTeX extraction differ significantly.",
    });
  }

  const penalty = issues.reduce((total, issue) => total + (issue.severity === "high" ? 28 : 14), 0);
  const baseConfidence = Math.min(
    confidenceInput ?? 100,
    modelConfidenceInput ?? 100,
    92
  );
  const confidence = Math.max(0, Math.min(100, Math.round(baseConfidence - penalty)));
  const hasHighIssue = issues.some((issue) => issue.severity === "high");
  const hasCriticalIssue = issues.some((issue) => issue.critical);
  const tier = hasCriticalIssue || confidence < 60
    ? "low"
    : confidence < 85
      ? "medium"
      : "high";

  return {
    status: hasHighIssue ? "danger" : issues.length > 0 ? "warning" : "ok",
    tier,
    critical: hasCriticalIssue,
    confidence,
    issues,
    metrics: {
      ocrConfidence: confidenceInput,
      modelConfidence: modelConfidenceInput,
      textSuperscripts: textExponents.length,
      latexSuperscripts: latexExponents.length,
      textSubscripts: textSubscripts.length,
      latexSubscripts: latexSubscripts.length,
      differenceRatio: Number(differenceRatio.toFixed(3)),
    },
  };
}
