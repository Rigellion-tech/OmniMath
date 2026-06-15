import katex from "katex";

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

function normalizeParenthesizedScripts(value) {
  const source = safeString(value);
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const marker = source[index];
    if ((marker !== "^" && marker !== "_") || source[index + 1] !== "(") {
      output += marker;
      continue;
    }

    let cursor = index + 2;
    let depth = 1;
    let script = "";
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "(") {
        depth += 1;
        script += char;
      } else if (char === ")") {
        depth -= 1;
        if (depth > 0) script += char;
      } else {
        script += char;
      }
      cursor += 1;
    }

    if (depth === 0) {
      output += `${marker}{${script}}`;
      index = cursor - 1;
    } else {
      output += marker;
    }
  }

  return output;
}

function normalizeForScan(value) {
  return normalizeParenthesizedScripts(normalizeUnicodeScripts(value))
    .replace(/∭/g, "\\iiint")
    .replace(/∬/g, "\\iint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/×/g, "\\times")
    .replace(/⋅|·/g, "\\cdot")
    .replace(/(?<!\\)\b(sin|cos|tan|sec|csc|cot|ln|log|exp)\s*\(/gi, "\\$1(")
    .replace(/\\left|\\right/g, "")
    .replace(/\\langle/g, "<")
    .replace(/\\rangle/g, ">")
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

function countDelimiters(value, open, close) {
  const source = normalizeForScan(value);
  return {
    open: (source.match(new RegExp(`\\${open}`, "g")) || []).length,
    close: (source.match(new RegExp(`\\${close}`, "g")) || []).length,
  };
}

function getDelimiterBalanceIssues(value) {
  const source = normalizeForScan(value);
  const checks = [
    { type: "unbalanced_parentheses", label: "parentheses", open: "(", close: ")" },
    { type: "unbalanced_brackets", label: "brackets", open: "[", close: "]" },
    { type: "unbalanced_braces", label: "braces", open: "{", close: "}" },
  ];

  return checks.flatMap((check) => {
    const counts = countDelimiters(source, check.open, check.close);
    if (counts.open === counts.close) return [];
    return [{
      type: check.type,
      severity: "high",
      critical: true,
      message: `The extracted LaTeX has unbalanced ${check.label}.`,
    }];
  });
}

function getLatexRenderIssue(latex) {
  if (!latex) return null;
  try {
    katex.renderToString(latex, {
      throwOnError: true,
      strict: "ignore",
      displayMode: true,
    });
    return null;
  } catch (error) {
    return {
      type: "malformed_latex",
      severity: "high",
      critical: true,
      message: `The extracted LaTeX could not render cleanly: ${error.message}`,
    };
  }
}

function hasUncertaintyMarker(value) {
  return /(?:\[\?\]|<\s*unclear\s*>|\bunclear\b|\bunreadable\b|\billegible\b|\bmissing\b|\?\?\?|\[blank\]|\[missing\])/iu.test(value);
}

function looksTruncated(value) {
  const source = safeString(value);
  return /(?:\.\.\.|…)$/.test(source)
    || /(?:where|with|and|=|,|:|;|\\frac|\\sqrt|\\left|\\right)\s*$/iu.test(source);
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

function extractFunctionCalls(value) {
  const source = normalizeForScan(value);
  const calls = [];
  const pattern = /\\(sin|cos|tan|sec|csc|cot|ln|log|exp)\(/gu;
  let match;

  while ((match = pattern.exec(source))) {
    let cursor = pattern.lastIndex;
    let depth = 1;
    let argument = "";
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === "(") {
        depth += 1;
        argument += char;
      } else if (char === ")") {
        depth -= 1;
        if (depth > 0) argument += char;
      } else {
        argument += char;
      }
      cursor += 1;
    }
    if (depth === 0) {
      calls.push(`${match[1].toLowerCase()}:${compactScript(argument)}`);
    }
  }

  return calls;
}

function compareFunctionCalls(text, latex) {
  const latexCalls = new Set(extractFunctionCalls(latex));
  return extractFunctionCalls(text)
    .filter((call) => !latexCalls.has(call))
    .map((call) => ({
      type: "parentheses_loss",
      severity: "high",
      critical: true,
      message: `A function argument may have changed or lost parentheses near ${call.split(":")[0]}.`,
    }));
}

function extractLatexCommands(value) {
  const source = normalizeParenthesizedScripts(normalizeUnicodeScripts(value))
    .replace(/∭/g, "\\iiint")
    .replace(/∬/g, "\\iint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/×/g, "\\times")
    .replace(/⋅|·/g, "\\cdot")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/(?<!\\)\b(sin|cos|tan|sec|csc|cot|ln|log|exp)\s*\(/gi, "\\$1(")
    .replace(/\\operatorname\{([^{}]+)\}/g, "\\$1");
  return Array.from(source.matchAll(/\\[a-zA-Z]+/gu), (match) => match[0]);
}

function compareLatexCommands(text, latex) {
  const latexCommands = new Set(extractLatexCommands(latex));
  const strippedLatex = normalizeForScan(latex).replace(/\\/g, "");
  return extractLatexCommands(text)
    .filter((command) => !latexCommands.has(command))
    .map((command) => ({
      type: "command_stripping",
      severity: "high",
      critical: true,
      message: strippedLatex.includes(command.slice(1).toLowerCase())
        ? `LaTeX command ${command} appears to have lost its backslash.`
        : `LaTeX command ${command} is missing from the extracted LaTeX.`,
    }));
}

function getMalformedCommandIssues(value) {
  const source = safeString(value);
  const malformed = source.match(/\\(?:iiint|iint|oint|int|quad|langle|rangle|sin|cos|tan|sec|csc|cot|log|ln|exp|notin|to)(?=[A-Za-z0-9])|\\le(?=(?!ft)[A-Za-z0-9])|\\ge(?=(?!q)[A-Za-z0-9])|\\in(?=(?!t|fty)[A-Za-z0-9])/gu) || [];
  return [...new Set(malformed)].map((command) => ({
    type: "malformed_command",
    severity: "high",
    critical: true,
    message: `LaTeX command ${command} is merged with the following token.`,
  }));
}

function hasTheoremSensitiveTerms(value) {
  return /\b(boundary|orientation|oriented|normal|outward|inward|clockwise|counterclockwise|surface|flux|curl|divergence|closed)\b/iu.test(value);
}

function parseOcrConfidence(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : null;
}

function getOcrReviewThreshold() {
  const threshold = Number(process.env.OCR_REVIEW_CONFIDENCE_THRESHOLD);
  return Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 35;
}

export function validateExtraction({
  extractedProblemText = "",
  extractedProblemLatex = "",
  ocrConfidence = null,
  modelConfidence = null,
  modelIssues = [],
  textCleanup = null,
} = {}) {
  const text = safeString(extractedProblemText);
  const latex = safeString(extractedProblemLatex);
  const textExponents = extractScripts(text, "^");
  const latexExponents = extractScripts(latex, "^");
  const textSubscripts = extractScripts(text, "_");
  const latexSubscripts = extractScripts(latex, "_");
  const differenceRatio = levenshteinRatio(text, latex);
  const confidenceInput = parseOcrConfidence(ocrConfidence);
  const modelConfidenceInput = parseOcrConfidence(modelConfidence);
  const reviewThreshold = getOcrReviewThreshold();
  const issues = [
    ...(Array.isArray(modelIssues) ? modelIssues.map((issue) => ({
      type: safeString(issue?.type) || "ocr_unclear",
      severity: ["low", "medium", "high"].includes(issue?.severity) ? issue.severity : "medium",
      critical: issue?.severity === "high",
      message: safeString(issue?.message) || "Review this extraction before solving.",
    })) : []),
    ...compareScripts(textExponents, latexExponents, "exponent_loss"),
    ...compareScripts(textSubscripts, latexSubscripts, "subscript_loss"),
    ...compareLatexCommands(text, latex),
    ...getMalformedCommandIssues(latex),
  ];
  const renderIssue = getLatexRenderIssue(latex);

  if (!latex || latex.length < 3) {
    issues.push({
      type: "empty_extraction",
      severity: "high",
      critical: true,
      message: "The extracted LaTeX is empty or too short to solve.",
    });
  }

  if (renderIssue) issues.push(renderIssue);
  issues.push(...getDelimiterBalanceIssues(latex));

  if (hasUncertaintyMarker(text) || hasUncertaintyMarker(latex)) {
    issues.push({
      type: "explicit_uncertainty",
      severity: "high",
      critical: true,
      message: "The extraction contains an explicit uncertainty or unreadable marker.",
    });
  }

  if (looksTruncated(text) || looksTruncated(latex)) {
    issues.push({
      type: "truncated_extraction",
      severity: "high",
      critical: true,
      message: "The extracted problem appears incomplete or truncated.",
    });
  }

  if (textCleanup?.substantial) {
    issues.push({
      type: "ocr_text_cleanup_review",
      severity: "medium",
      critical: false,
      message: "OCR spacing was repaired before solving; review the cleaned text if anything looks off.",
    });
  }

  issues.push(...compareFunctionCalls(text, latex));

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

  if (confidenceInput !== null && confidenceInput < reviewThreshold) {
    issues.push({
      type: "low_ocr_confidence",
      severity: "high",
      critical: true,
      message: `OCR confidence is ${Math.round(confidenceInput)}%.`,
    });
  }

  if (differenceRatio > 0.62 && !renderIssue) {
    issues.push({
      type: "text_latex_mismatch",
      severity: "medium",
      critical: false,
      message: "The plain-text transcription and rendered LaTeX may describe different structures.",
    });
  }

  const penalty = issues.reduce((total, issue) => total + (issue.severity === "high" ? 28 : 14), 0);
  const effectiveOcrConfidence = confidenceInput !== null && confidenceInput < 35
    ? confidenceInput
    : 100;
  const baseConfidence = Math.min(
    effectiveOcrConfidence,
    modelConfidenceInput ?? 100,
    92
  );
  const mathIntegrityScore = Math.max(0, Math.min(100, Math.round(baseConfidence - penalty)));
  const hasHighIssue = issues.some((issue) => issue.severity === "high");
  const hasCriticalIssue = issues.some((issue) => issue.critical);
  const tier = hasCriticalIssue || mathIntegrityScore < 60
    ? "low"
    : mathIntegrityScore < 85
      ? "medium"
      : "high";

  return {
    status: hasHighIssue ? "danger" : issues.length > 0 ? "warning" : "ok",
    tier,
    critical: hasCriticalIssue,
    confidence: mathIntegrityScore,
    ocrConfidence: confidenceInput,
    mathIntegrityScore,
    issues,
    metrics: {
      ocrConfidence: confidenceInput,
      modelConfidence: modelConfidenceInput,
      textSuperscripts: textExponents.length,
      latexSuperscripts: latexExponents.length,
      textSubscripts: textSubscripts.length,
      latexSubscripts: latexSubscripts.length,
      differenceRatio: Number(differenceRatio.toFixed(3)),
      textCleanup: textCleanup
        ? {
            changed: Boolean(textCleanup.changed),
            substantial: Boolean(textCleanup.substantial),
            changedCharacters: Number(textCleanup.changedCharacters || 0),
            changeRatio: Number(textCleanup.changeRatio || 0),
          }
        : null,
    },
  };
}
