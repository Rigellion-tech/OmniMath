import katex from "katex";
import { splitEquationChainLatex } from "../src/lib/equationChains.js";

const LOST_COMMAND_NAMES = [
  "frac",
  "dfrac",
  "tfrac",
  "sqrt",
  "int",
  "iint",
  "iiint",
  "oint",
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "ln",
  "log",
  "arctan",
  "theta",
  "phi",
  "rho",
  "pi",
  "delta",
  "alpha",
  "beta",
  "gamma",
  "lambda",
  "mu",
  "sigma",
  "omega",
];

const LOST_COMMAND_PATTERN = new RegExp(
  `(^|[^\\\\A-Za-z])\\{?\\s*(?:${LOST_COMMAND_NAMES.join("|")})\\s*\\}?(?=$|[^A-Za-z])`,
  "iu"
);

export const FINAL_ANSWER_FIELD_STRUCTURE_ISSUES = new Set([
  "final_answer_contains_multiple_physical_lines",
  "final_answer_contains_line_break_command",
  "final_answer_contains_derivation_arrow",
  "final_answer_contains_prose",
  "final_answer_contains_multiple_unrelated_equations",
  "detached_final_answer_fragment",
  "final_answer_splits_into_multiple_unrelated_fragments",
]);

const FINAL_ANSWER_ALLOWED_TEXT_WORDS = new Set(["or", "and"]);

export function isFinalAnswerFieldStructureIssue(issue = "") {
  return FINAL_ANSWER_FIELD_STRUCTURE_ISSUES.has(String(issue || "").split(":").pop());
}

function stripTextCommands(value = "") {
  let text = String(value || "");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!text.startsWith("\\text{", index) && !text.startsWith("\\mathrm{", index)) {
      output += text[index];
      continue;
    }
    const commandLength = text.startsWith("\\mathrm{", index) ? "\\mathrm".length : "\\text".length;
    let depth = 0;
    let end = index + commandLength;
    for (; end < text.length; end += 1) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    output += " ";
    index = end;
  }
  return output;
}

function hasBalancedBraces(value = "") {
  let depth = 0;
  let escaped = false;
  for (const char of String(value || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function hasBalancedPlainDelimiters(value = "") {
  const text = stripTextCommands(value)
    .replace(/\\[A-Za-z]+(?:\s*\{[^{}]*\})?/g, " ")
    .replace(/\\[,;! ]/g, " ");
  const stack = [];
  const pairs = new Map([[")", "("], ["]", "["]]);
  for (const char of text) {
    if (char === "(" || char === "[") stack.push(char);
    if (char === ")" || char === "]") {
      if (stack.pop() !== pairs.get(char)) return false;
    }
  }
  return stack.length === 0;
}

function isEscapedAt(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function readTexGroup(text, openIndex, maxDepth = 12) {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{" && !isEscapedAt(text, index)) {
      depth += 1;
      if (depth > maxDepth) return null;
    } else if (text[index] === "}" && !isEscapedAt(text, index)) {
      depth -= 1;
      if (depth === 0) {
        const body = text.slice(openIndex + 1, index).trim();
        return body ? { start: openIndex, end: index + 1, body } : null;
      }
      if (depth < 0) return null;
    }
  }
  return null;
}

function readTexAtom(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  if (index >= text.length) return null;

  const char = text[index];
  if (char === "{") return readTexGroup(text, index);
  if ("}])=,+*/^_|&".includes(char)) return null;
  if (char === "-") return null;

  if (char === "\\") {
    if (/[ ,;:!]/u.test(text[index + 1] || "")) return null;
    const command = text.slice(index).match(/^\\[A-Za-z]+/u);
    if (command) {
      if (["left", "right", "begin", "end"].includes(command[0].slice(1))) return null;
      return { start: index, end: index + command[0].length, body: command[0] };
    }
    return text[index + 1] ? { start: index, end: index + 2, body: text.slice(index, index + 2) } : null;
  }

  return { start: index, end: index + 1, body: char };
}

function fractionCommandIssues(value = "") {
  const text = stripTextCommands(value);
  const issues = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\" || isEscapedAt(text, index)) continue;
    const match = text.slice(index).match(/^\\(?:frac|dfrac|tfrac)(?![A-Za-z])/u);
    if (!match) continue;
    const numerator = readTexAtom(text, index + match[0].length);
    if (!numerator) {
      issues.push("incomplete_fraction_command");
      continue;
    }
    const denominator = readTexAtom(text, numerator.end);
    if (!denominator) {
      issues.push("incomplete_fraction_command");
      continue;
    }
    index = denominator.end - 1;
  }
  return issues;
}

function commandIssues(value = "") {
  const text = stripTextCommands(value);
  const issues = [];
  issues.push(...fractionCommandIssues(text));
  if (/(^|[^\\])\\sqrt(?!\s*(?:\[[^\]]+\]\s*)?\{)/u.test(text)) issues.push("incomplete_sqrt_command");
  if (/\\(?:left|right|begin|end|text|mathrm|mathbf|vec|hat)\s*$/u.test(text)) issues.push("incomplete_command");
  if (/(^|[^\\])\\\s*$/u.test(text)) issues.push("trailing_backslash");
  if (LOST_COMMAND_PATTERN.test(text)) issues.push("lost_latex_command_backslash");
  if (/\{(?:frac|sqrt|int|iint|iiint|oint|sin|cos|tan|ln|log|pi|delta)\}/iu.test(text)) {
    issues.push("malformed_command_remnant");
  }
  return issues;
}

function katexParses(value = "") {
  try {
    katex.renderToString(value, {
      throwOnError: true,
      strict: "error",
      trust: false,
      displayMode: /\\begin\s*\{(?:aligned|align|alignat|gathered|split|array|matrix|pmatrix|bmatrix)\}/u.test(value),
    });
    return null;
  } catch (error) {
    return error?.message || "KaTeX parse failed";
  }
}

function splitGeneratedLines(value = "") {
  return String(value || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripTextCommandBodies(value = "") {
  let text = String(value || "");
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!text.startsWith("\\text{", index) && !text.startsWith("\\mathrm{", index)) {
      output += text[index];
      continue;
    }
    const commandLength = text.startsWith("\\mathrm{", index) ? "\\mathrm".length : "\\text".length;
    let depth = 0;
    let end = index + commandLength;
    let body = "";
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (char === "{") {
        depth += 1;
        if (depth > 1) body += char;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
        body += char;
      } else if (depth > 0) {
        body += char;
      }
    }
    const words = body.match(/[A-Za-z]+/g) || [];
    const allowedText = words.length > 0
      && words.every((word) => FINAL_ANSWER_ALLOWED_TEXT_WORDS.has(word.toLowerCase()));
    output += allowedText ? ` ${body} ` : " ";
    index = end;
  }
  return output;
}

function finalAnswerContractIssues(value = "") {
  const source = String(value || "").trim();
  const issues = [];
  if (splitGeneratedLines(source).length > 1) {
    issues.push("final_answer_contains_multiple_physical_lines");
  }
  if (/\\\\(?=\s|$|\[)|\\\\(?:Rightarrow|Longrightarrow|rightarrow|implies)\b/u.test(source)) {
    issues.push("final_answer_contains_line_break_command");
  }
  if (/\\(?:Rightarrow|Longrightarrow|rightarrow|implies)\b|⇒|⟹/u.test(source)) {
    issues.push("final_answer_contains_derivation_arrow");
  }

  const proseProbe = stripTextCommandBodies(source)
    .replace(/\\[A-Za-z]+(?:\s*\{[^{}]*\})?/g, " ")
    .replace(/\\[,;! ]/g, " ")
    .replace(/[{}_^0-9=+\-*\/(),.\[\]<>|]/g, " ");
  if (/\b(?:therefore|hence|answer|final|equals|equal|is|gives|yields|so)\b/iu.test(proseProbe)) {
    issues.push("final_answer_contains_prose");
  }

  const equationLikeParts = source
    .split(/(?:,|;|\\quad|\\qquad|\\;|\\,)/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const equationPartCount = equationLikeParts.filter((part) => /[=<>]|\\le|\\ge|\\approx/u.test(part)).length;
  if (
    equationPartCount > 1
    && !/(?:\\text\{\s*(?:or|and)\s*\}|\bor\b|\band\b)/iu.test(source)
  ) {
    issues.push("final_answer_contains_multiple_unrelated_equations");
  }

  return issues;
}

function detachedFinalAnswerIssue(value = "") {
  const lines = splitGeneratedLines(value);
  if (lines.length > 1) return "final_answer_contains_multiple_physical_lines";

  const segments = splitEquationChainLatex(String(value || "").trim()).filter(Boolean);
  if (segments.length <= 1) return "";
  const first = segments[0].replace(/\s+/g, "");
  const tail = segments.slice(1).join(" ").trim();
  if (/^[A-Za-z]\\?=*-?\d+(?:\.\d+)?$/u.test(first) && tail && !/[=<>]|\\le|\\ge|\\approx/u.test(tail)) {
    return "detached_final_answer_fragment";
  }
  return "final_answer_splits_into_multiple_unrelated_fragments";
}

export function validateGeneratedLatex(value = "", {
  fieldPath = "latex",
  finalAnswer = false,
  strictFinalAnswerContract = false,
  allowEmpty = false,
  strictParse = true,
} = {}) {
  const source = String(value || "").trim();
  const issues = [];
  if (!source) {
    if (!allowEmpty) issues.push("empty_latex");
    return { valid: issues.length === 0, fieldPath, value: source, issues };
  }

  if (!hasBalancedBraces(source)) issues.push("unmatched_braces");
  if (/(^|[^\\])\\left\b/u.test(source) || /(^|[^\\])\\right\b/u.test(source)) {
    const leftCount = (source.match(/\\left\b/g) || []).length;
    const rightCount = (source.match(/\\right\b/g) || []).length;
    if (leftCount !== rightCount) issues.push("unmatched_left_right");
  }
  if (!hasBalancedPlainDelimiters(source)) issues.push("unmatched_delimiters");
  issues.push(...commandIssues(source));
  if (finalAnswer && strictFinalAnswerContract) {
    issues.push(...finalAnswerContractIssues(source));
  }
  if (finalAnswer) {
    const detached = detachedFinalAnswerIssue(source);
    if (detached) issues.push(detached);
  }

  if (strictParse) {
    for (const [index, line] of splitGeneratedLines(source).entries()) {
      const parseError = katexParses(line);
      if (parseError) {
        issues.push(`katex_parse_failed:${index + 1}:${parseError}`);
        break;
      }
    }
  }

  return {
    valid: issues.length === 0,
    fieldPath,
    value: source,
    issues: [...new Set(issues)],
  };
}

export function collectGeneratedLatexValidationIssues(fields = []) {
  return fields
    .map((field) => validateGeneratedLatex(field.value, field))
    .filter((result) => !result.valid);
}
