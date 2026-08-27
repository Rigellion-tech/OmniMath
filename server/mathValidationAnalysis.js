import { collectGeneratedMath } from "./generatedMathCollector.js";

const MAX_RECURSION_DEPTH = 24;
const MAX_NUMERICAL_EVALUATIONS = 50000;
const MAX_EXPRESSION_TOKENS = 500;
const MAX_IDENTITY_CHECKS = 12;
const DEFAULT_ABS_TOLERANCE = 1e-5;
const DEFAULT_REL_TOLERANCE = 2e-5;

function safeString(value = "") {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value = "") {
  return safeString(value)
    .replace(/\\left|\\right/g, "")
    .replace(/\\[,;!]/g, "")
    .replace(/\s+/g, "");
}

function stripBox(value = "") {
  let text = safeString(value);
  let changed = true;
  while (changed) {
    changed = false;
    const next = text
      .replace(/^\\boxed\s*\{([\s\S]*)\}$/u, "$1")
      .replace(/^\\displaystyle\s+/u, "")
      .replace(/^\\\(([\s\S]*)\\\)$/u, "$1")
      .replace(/^\\\[([\s\S]*)\\\]$/u, "$1")
      .replace(/^\$\$([\s\S]*)\$\$$/u, "$1")
      .replace(/^\$([\s\S]*)\$$/u, "$1")
      .trim();
    if (next !== text) {
      text = next;
      changed = true;
    }
  }
  return text;
}

function normalizeIdentifier(value = "") {
  return safeString(value).replace(/^\\/, "").replace(/^theta$/i, "theta").toLowerCase();
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readLatexFractionAtom(text, startIndex) {
  let index = startIndex;
  while (index < text.length && /\s/u.test(text[index])) index += 1;
  if (index >= text.length) return null;
  if (text[index] === "{") {
    const close = findMatchingBrace(text, index);
    if (close < 0) return null;
    const body = text.slice(index + 1, close).trim();
    return body ? { raw: body, end: close + 1 } : null;
  }
  if (text[index] === "\\") {
    const command = text.slice(index).match(/^\\[A-Za-z]+(?![A-Za-z])/u);
    if (command && !["\\left", "\\right", "\\begin", "\\end"].includes(command[0])) {
      return { raw: command[0], end: index + command[0].length };
    }
    return null;
  }
  if ("}])=,+*/^_|&-".includes(text[index])) return null;
  return { raw: text[index], end: index + 1 };
}

function replaceLatexFractions(value = "") {
  let text = safeString(value)
    .replace(/\\(?:dfrac|tfrac)\b/g, "\\frac")
    .trim();
  let index = text.search(/\\frac(?![A-Za-z])/u);
  while (index >= 0) {
    const numeratorAtom = readLatexFractionAtom(text, index + "\\frac".length);
    if (!numeratorAtom) break;
    const denominatorAtom = readLatexFractionAtom(text, numeratorAtom.end);
    if (!denominatorAtom) break;
    const numerator = replaceLatexFractions(numeratorAtom.raw);
    const denominator = replaceLatexFractions(denominatorAtom.raw);
    text = `${text.slice(0, index)}((${numerator})/((${denominator})))${text.slice(denominatorAtom.end)}`;
    const nextIndex = text.slice(index + 1).search(/\\frac(?![A-Za-z])/u);
    index = nextIndex >= 0 ? index + 1 + nextIndex : -1;
  }
  return text;
}

function normalizeFunctionPowers(value = "") {
  const text = safeString(value);
  let output = "";
  let index = 0;

  function findMatchingDelimiter(openIndex, open, close) {
    let depth = 0;
    for (let cursor = openIndex; cursor < text.length; cursor += 1) {
      if (text[cursor] === open) depth += 1;
      else if (text[cursor] === close) {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return -1;
  }

  function readPoweredFunction(startIndex) {
    const prefix = text.slice(startIndex);
    const match = prefix.match(/^\\?(ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*\^\s*/iu);
    if (!match) return null;
    const name = match[1].toLowerCase();
    let cursor = startIndex + match[0].length;
    let exponent = "";

    if (text[cursor] === "{" || text[cursor] === "(") {
      const open = text[cursor];
      const close = open === "{" ? "}" : ")";
      const end = findMatchingDelimiter(cursor, open, close);
      if (end < 0) return null;
      exponent = text.slice(cursor + 1, end).trim();
      cursor = end + 1;
    } else {
      const exponentMatch = text.slice(cursor).match(/^[0-9]+/u);
      if (!exponentMatch) return null;
      exponent = exponentMatch[0];
      cursor += exponent.length;
    }

    if (!/^[0-9]+$/u.test(exponent)) return null;
    while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
    let argument = "";
    let argumentEnd = cursor;
    if (text[cursor] === "(") {
      argumentEnd = findMatchingDelimiter(cursor, "(", ")");
      if (argumentEnd < 0) return null;
      argument = text.slice(cursor + 1, argumentEnd).trim();
      argumentEnd += 1;
    } else {
      // TeX permits a single unbraced function argument, including the compact
      // form \ln^{2}2. Accept only one numeric literal or named constant here;
      // the safe expression parser still validates the completed expression.
      const bareArgument = text.slice(cursor).match(/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+|pi|e)(?![A-Za-z_])/u);
      if (!bareArgument) return null;
      argument = bareArgument[0];
      argumentEnd = cursor + argument.length;
    }
    if (!argument) return null;
    return {
      end: argumentEnd,
      replacement: `(${name}(${argument}))^${exponent}`,
    };
  }

  while (index < text.length) {
    const poweredFunction = readPoweredFunction(index);
    if (poweredFunction) {
      output += poweredFunction.replacement;
      index = poweredFunction.end;
    } else {
      output += text[index];
      index += 1;
    }
  }
  return output;
}

function normalizeLatexExpression(value = "") {
  let text = stripBox(value)
    .replace(/−/g, "-")
    .replace(/×/g, "*")
    .replace(/∞/g, "\\infty")
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/\\(?:dfrac|tfrac)\b/g, "\\frac")
    .replace(/\\(?:bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|bigg|Bigg|big|Big)\b/g, "")
    .replace(/\\operatorname\s*\{\s*(ln|log|sin|cos|tan|cot|sec|arctan|atan|sqrt|exp|psi|Gamma)\s*\}/giu, "\\$1")
    .replace(/\\operatorname\s*\{\s*arctan\s*\}/giu, "\\arctan")
    .replace(/\\operatorname\s*\{\s*atan\s*\}/giu, "\\arctan")
    .replace(/\\operatorname\s*\{\s*sech?\s*\}/giu, "\\sec")
    .replace(/\\psi\s*\\left\s*\(/giu, "\\psi(")
    .replace(/\\(ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*\^\s*\{?([0-9]+)\}?\s+([A-Za-z0-9\\]+)\b/giu, "(\\$1($3))^{$2}")
    .replace(/\\(ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*(\\theta|[A-Za-z])\b/giu, "\\$1($2)")
    .replace(/\\(ln|log|sin|cos|tan|cot|sec|arctan|atan)\s+([A-Za-z0-9\\]+)\b/giu, "\\$1($2)")
    .replace(/\\(ln|log|sin|cos|tan|cot|sec|arctan|atan)\s*([0-9]+(?:\.[0-9]+)?)/giu, "\\$1($2)")
    .replace(/\\pi\s*(?=\\(?:ln|log|sin|cos|tan|cot|sec|arctan|atan|sqrt|exp|psi)\b)/giu, "\\pi*")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:,|;|:|!| )/g, "")
    .replace(/\\cdot|\\times/g, "*")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")");
  text = replaceLatexFractions(text)
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\\pi\b/g, "pi")
    .replace(/\\theta\b/g, "theta")
    .replace(/\\ln\b/g, "ln")
    .replace(/\\log\b/g, "log")
    .replace(/\\arctan\b/g, "atan")
    .replace(/\\tan\b/g, "tan")
    .replace(/\\cot\b/g, "cot")
    .replace(/\\sec\b/g, "sec")
    .replace(/\\sin\b/g, "sin")
    .replace(/\\cos\b/g, "cos")
    .replace(/\\sqrt\b/g, "sqrt")
    .replace(/\\exp\b/g, "exp")
    .replace(/\\psi\b/g, "psi")
    .replace(/\\Gamma\b/g, "Gamma")
    .replace(/\\zeta\b/g, "zeta")
    .replace(/\\infty\b/g, "Infinity")
    .replace(/\s+/g, "");
  return normalizeFunctionPowers(text);
}

function splitTopLevelEquality(value = "") {
  const text = safeString(value);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "=" && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function topLevelApproximationTail(value = "") {
  const text = safeString(value);
  let depth = 0;
  let tail = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      const approx = text.slice(index).match(/^\\approx(?![A-Za-z])/u);
      if (approx && depth === 0) {
        tail = text.slice(index + approx[0].length).trim();
        index += approx[0].length - 1;
        continue;
      }
      const command = text.slice(index).match(/^\\[A-Za-z]+/u);
      if (command) {
        index += command[0].length - 1;
      }
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === "≈" && depth === 0) {
      tail = text.slice(index + 1).trim();
    }
  }
  return tail;
}

function splitTopLevelCommas(value = "") {
  const text = safeString(value);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && /[,;:! ]/u.test(text[index + 1] || "")) {
      index += 1;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

export function finalValueExpression(value = "") {
  const source = stripBox(value);
  const parts = splitTopLevelEquality(source);
  return parts.length > 1 ? parts[parts.length - 1] : source;
}

function numericExpressionCandidate(value = "") {
  const equalityValue = finalValueExpression(value);
  const approximationTail = topLevelApproximationTail(equalityValue);
  if (!approximationTail) {
    return {
      expression: equalityValue,
      extractedNumericApproximation: null,
      symbolicPrefixNumericAnalysis: null,
    };
  }
  const prefix = equalityValue.slice(0, equalityValue.length - approximationTail.length).replace(/(?:\\approx(?![A-Za-z])|≈)\s*$/u, "").trim();
  return {
    expression: approximationTail,
    extractedNumericApproximation: approximationTail,
    symbolicPrefixNumericAnalysis: prefix ? analyzeNumericExpression(prefix) : null,
  };
}

function tokenizeExpression(value = "") {
  const text = normalizeLatexExpression(value);
  const tokens = [];
  function pushToken(token) {
    tokens.push(token);
    if (tokens.length > MAX_EXPRESSION_TOKENS) {
      const error = new Error(`Expression token limit exceeded (${tokens.length}/${MAX_EXPRESSION_TOKENS})`);
      error.code = "VALIDATION_RESOURCE_LIMIT";
      error.resourceLimit = {
        limitType: "expression_tokens",
        configuredLimit: MAX_EXPRESSION_TOKENS,
        observedValue: tokens.length,
        validationStage: "numeric_expression_parser",
      };
      throw error;
    }
  }
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/u.test(char)) {
      const match = text.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u);
      if (!match) throw new Error(`Malformed number at ${index}`);
      pushToken({ type: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z]/u.test(char)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_]/u.test(text[end])) end += 1;
      pushToken({ type: "identifier", value: text.slice(index, end) });
      index = end;
      continue;
    }
    if ("+-*/^(),".includes(char)) {
      pushToken({ type: char, value: char });
      index += 1;
      continue;
    }
    throw new Error(`Unsupported token '${char}'`);
  }
  return tokens;
}

const FUNCTION_NAMES = new Set(["ln", "log", "atan", "arctan", "tan", "cot", "sec", "sin", "cos", "sqrt", "exp", "psi", "Gamma", "zeta"]);

function parseExpressionAst(value = "") {
  const tokens = tokenizeExpression(value);
  let index = 0;

  function peek() {
    return tokens[index] || null;
  }

  function consume(type = null) {
    const token = tokens[index] || null;
    if (!token || (type && token.type !== type)) {
      throw new Error(`Expected ${type || "token"}`);
    }
    index += 1;
    return token;
  }

  function startsPrimary(token) {
    return token && (
      token.type === "number"
      || token.type === "identifier"
      || token.type === "("
    );
  }

  function parsePrimary() {
    const token = peek();
    if (!token) throw new Error("Unexpected end of expression");
    if (token.type === "number") {
      consume();
      return { type: "number", value: token.value };
    }
    if (token.type === "identifier") {
      consume();
      const name = token.value;
      if (FUNCTION_NAMES.has(name)) {
        let argument;
        if (peek()?.type === "(") {
          consume("(");
          argument = parseAddSub();
          consume(")");
        } else {
          argument = parseUnary();
        }
        return { type: "call", name: name === "arctan" ? "atan" : name, argument };
      }
      if (name === "pi") return { type: "number", value: Math.PI };
      if (name === "e") return { type: "number", value: Math.E };
      if (name === "Infinity") return { type: "number", value: Infinity };
      return { type: "variable", name: normalizeIdentifier(name) };
    }
    if (token.type === "(") {
      consume("(");
      const node = parseAddSub();
      consume(")");
      return node;
    }
    throw new Error(`Unexpected token ${token.type}`);
  }

  function parseUnary() {
    if (peek()?.type === "+") {
      consume("+");
      return parseUnary();
    }
    if (peek()?.type === "-") {
      consume("-");
      return { type: "neg", argument: parseUnary() };
    }
    return parsePower();
  }

  function parsePower() {
    let node = parsePrimary();
    if (peek()?.type === "^") {
      consume("^");
      node = { type: "binary", op: "^", left: node, right: parseUnary() };
    }
    return node;
  }

  function parseMulDiv() {
    let node = parseUnary();
    while (true) {
      const token = peek();
      if (token?.type === "*" || token?.type === "/") {
        consume();
        node = { type: "binary", op: token.type, left: node, right: parseUnary() };
        continue;
      }
      if (startsPrimary(token)) {
        node = { type: "binary", op: "*", left: node, right: parseUnary() };
        continue;
      }
      break;
    }
    return node;
  }

  function parseAddSub() {
    let node = parseMulDiv();
    while (peek()?.type === "+" || peek()?.type === "-") {
      const token = consume();
      node = { type: "binary", op: token.type, left: node, right: parseMulDiv() };
    }
    return node;
  }

  const ast = parseAddSub();
  if (index !== tokens.length) throw new Error("Unexpected trailing tokens");
  return ast;
}

function psiKnown(value) {
  const gamma = 0.5772156649015329;
  if (Math.abs(value - 1) < 1e-10) return -gamma;
  if (Math.abs(value - 0.5) < 1e-10) return -gamma - 2 * Math.log(2);
  if (Math.abs(value - 1.5) < 1e-10) return 2 - gamma - 2 * Math.log(2);
  if (Math.abs(value - 2) < 1e-10) return 1 - gamma;
  return NaN;
}

function zetaKnown(value) {
  if (Math.abs(value - 2) < 1e-10) return Math.PI ** 2 / 6;
  if (Math.abs(value - 3) < 1e-10) return 1.2020569031595942;
  if (Math.abs(value - 4) < 1e-10) return Math.PI ** 4 / 90;
  return NaN;
}

function evaluateAst(ast, variables = {}) {
  switch (ast?.type) {
    case "number":
      return ast.value;
    case "variable": {
      const key = normalizeIdentifier(ast.name);
      if (!(key in variables)) return NaN;
      return Number(variables[key]);
    }
    case "neg":
      return -evaluateAst(ast.argument, variables);
    case "binary": {
      const left = evaluateAst(ast.left, variables);
      const right = evaluateAst(ast.right, variables);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
      if (ast.op === "+") return left + right;
      if (ast.op === "-") return left - right;
      if (ast.op === "*") return left * right;
      if (ast.op === "/") return left / right;
      if (ast.op === "^") return left ** right;
      return NaN;
    }
    case "call": {
      const argument = evaluateAst(ast.argument, variables);
      if (!Number.isFinite(argument)) return NaN;
      if (ast.name === "ln" || ast.name === "log") return Math.log(argument);
      if (ast.name === "atan") return Math.atan(argument);
      if (ast.name === "tan") return Math.tan(argument);
      if (ast.name === "cot") return 1 / Math.tan(argument);
      if (ast.name === "sec") return 1 / Math.cos(argument);
      if (ast.name === "sin") return Math.sin(argument);
      if (ast.name === "cos") return Math.cos(argument);
      if (ast.name === "sqrt") return Math.sqrt(argument);
      if (ast.name === "exp") return Math.exp(argument);
      if (ast.name === "psi") return psiKnown(argument);
      if (ast.name === "zeta") return zetaKnown(argument);
      return NaN;
    }
    default:
      return NaN;
  }
}

function collectAstVariables(ast, variables = new Set()) {
  switch (ast?.type) {
    case "variable":
      variables.add(normalizeIdentifier(ast.name));
      break;
    case "neg":
      collectAstVariables(ast.argument, variables);
      break;
    case "binary":
      collectAstVariables(ast.left, variables);
      collectAstVariables(ast.right, variables);
      break;
    case "call":
      collectAstVariables(ast.argument, variables);
      break;
    default:
      break;
  }
  return variables;
}

function looksLikeNumericConstantExpression(value = "") {
  const text = safeString(value);
  if (!text) return false;
  if (looksLikeSetValuedAnswer(text)) return false;
  if (/\\(?:int|sum|prod|lim|mathbf|vec|begin|end)\b|∫|Σ|Π/iu.test(text)) return false;
  const withoutKnownCommands = text
    .replace(/\\(?:frac|dfrac|tfrac|left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|bigg|Bigg|big|Big|operatorname|ln|log|sin|cos|tan|cot|sec|arctan|atan|sqrt|exp|psi|Gamma|pi|infty|boxed|displaystyle)\b/giu, "")
    .replace(/\\[,;:! ]/g, "")
    .replace(/\\[()\[\]]/g, "")
    .replace(/\{(?:ln|log|sin|cos|tan|cot|sec|arctan|atan|sqrt|exp|psi|Gamma)\}/giu, "")
    .replace(/[0-9+\-*/^().,{}\[\]\sπ∞×−eE]/gu, "");
  return withoutKnownCommands.length === 0 && /[0-9πeE]|\\(?:pi|frac|dfrac|tfrac|ln|log|sqrt|psi|Gamma)\b/iu.test(text);
}

function normalizeSetValuedSyntax(value = "") {
  return stripBox(value)
    .replace(/\\left|\\right/g, "")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\\[,;:! ]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function delimiterIssue(value = "") {
  const stack = [];
  const pairs = new Map([["}", "{"], [")", "("], ["]", "["]]);
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      const command = value.slice(index).match(/^\\[A-Za-z]+/u);
      if (command) {
        index += command[0].length - 1;
      }
      continue;
    }
    if (char === "{" || char === "(" || char === "[") stack.push(char);
    else if (char === "}" || char === ")" || char === "]") {
      const open = stack.pop();
      if (!open) return "unbalanced_delimiter";
      const expected = pairs.get(char);
      const intervalClose = (open === "(" && char === "]") || (open === "[" && char === ")");
      if (open !== expected && !intervalClose) return "unbalanced_delimiter";
    }
  }
  return stack.length === 0 ? "" : "unbalanced_delimiter";
}

function hasTopLevelComma(value = "") {
  return splitTopLevelCommas(value).length > 1;
}

function stripOuterDelimiter(value = "", open, close) {
  const text = safeString(value);
  if (!text.startsWith(open) || !text.endsWith(close)) return null;
  const inner = text.slice(1, -1);
  return delimiterIssue(inner) ? null : inner;
}

function isNonEmptySetElement(value = "") {
  const text = safeString(value);
  if (!text) return false;
  if (/^(?:\\pm|\\mp)$/u.test(text)) return false;
  if (/^[,;:=+\-*/\\{}()[\]\s]*$/u.test(text)) return false;
  return true;
}

function validateElementList(value = "", { expectedCount = null } = {}) {
  const parts = splitTopLevelCommas(value);
  if (parts.length === 0 || !safeString(value)) return { ok: false, reason: "empty_element" };
  if (parts.some((part) => !isNonEmptySetElement(part))) {
    const hasAdjacentSeparator = /(^|,)\s*(,|$)/u.test(value);
    return { ok: false, reason: hasAdjacentSeparator ? "repeated_separator" : "empty_element" };
  }
  if (expectedCount !== null && parts.length !== expectedCount) {
    return { ok: false, reason: "arity_mismatch" };
  }
  return { ok: true, parts };
}

function validateDelimitedList(value = "", open, close, options = {}) {
  const inner = stripOuterDelimiter(value, open, close);
  if (inner === null) return { ok: false, reason: "unbalanced_delimiter" };
  if (!safeString(inner)) return { ok: false, reason: options.emptyReason || "empty_element" };
  return validateElementList(inner, options);
}

function validatePlusMinusOperand(value = "") {
  const text = safeString(value);
  const matches = [...text.matchAll(/\\(?:pm|mp)(?![A-Za-z])/gu)];
  if (matches.length === 0) return { ok: true };
  for (const match of matches) {
    const tail = text.slice(match.index + match[0].length);
    if (!isNonEmptySetElement(tail.replace(/^[=({[]+/u, ""))) {
      return { ok: false, reason: "missing_plus_minus_operand" };
    }
  }
  return { ok: true };
}

function looksLikeSetValuedCandidate(value = "") {
  const text = normalizeSetValuedSyntax(value);
  if (!text) return false;
  if (/\\(?:pm|mp)(?![A-Za-z])|\\(?:cup|union)\b|\\text\{?\s*or\s*\}?|\bor\b/iu.test(value)) return true;
  if (/eigenvalues?:/iu.test(value)) return true;
  if (/\\in\s*\{/u.test(text)) return true;
  if (/^\{/u.test(text)) return true;
  if (/^\{[\s\S]*\}$/u.test(text)) return true;
  if (/^\(?\\?[A-Za-z]\s*,\s*\\?[A-Za-z]\)?\s*=/.test(text)) return true;
  if (/^[\[(].*[\])]$/u.test(text) && hasTopLevelComma(text.slice(1, -1))) return true;
  const equalityParts = splitTopLevelEquality(text);
  if (equalityParts.length === 2 && hasTopLevelComma(equalityParts[1])) return true;
  if (hasTopLevelComma(text)) return true;
  return false;
}

export function analyzeSetValuedAnswer(value = "") {
  const raw = stripBox(value);
  const text = normalizeSetValuedSyntax(raw);
  const candidate = looksLikeSetValuedCandidate(raw);
  const base = {
    candidate,
    wellFormed: false,
    setValued: false,
    normalized: text,
    reason: candidate ? "" : "not_set_valued",
  };
  if (!candidate) return base;
  if (!text) return { ...base, reason: "empty_element" };

  const balance = delimiterIssue(text);
  if (balance) return { ...base, reason: balance };

  const plusMinus = validatePlusMinusOperand(text);
  if (!plusMinus.ok) return { ...base, reason: plusMinus.reason };

  const membership = text.match(/^(.+?)\\in\s*(\{[\s\S]*\})$/u);
  if (membership) {
    if (!isNonEmptySetElement(membership[1])) return { ...base, reason: "empty_element" };
    const setResult = validateDelimitedList(membership[2], "{", "}", { emptyReason: "empty_set" });
    return setResult.ok
      ? { ...base, wellFormed: true, setValued: true, reason: "membership_set" }
      : { ...base, reason: setResult.reason };
  }

  if (/^\{[\s\S]*\}$/u.test(text)) {
    const setResult = validateDelimitedList(text, "{", "}", { emptyReason: "empty_set" });
    return setResult.ok
      ? { ...base, wellFormed: true, setValued: true, reason: "finite_set" }
      : { ...base, reason: setResult.reason };
  }

  const equalityParts = splitTopLevelEquality(text);
  if (equalityParts.length === 2) {
    const [left, right] = equalityParts;
    const tupleLeft = left.match(/^\(?\s*(\\?[A-Za-z])\s*,\s*(\\?[A-Za-z])\s*\)?$/u);
    if (tupleLeft) {
      const rightTuple = validateDelimitedList(right, "(", ")", { expectedCount: 2, emptyReason: "empty_tuple" });
      return rightTuple.ok
        ? { ...base, wellFormed: true, setValued: true, reason: "tuple_assignment" }
        : { ...base, reason: rightTuple.reason };
    }
    if (!isNonEmptySetElement(left)) return { ...base, reason: "empty_element" };
    if (/\\(?:pm|mp)(?![A-Za-z])/u.test(right)) {
      return { ...base, wellFormed: true, setValued: true, reason: "plus_minus_assignment" };
    }
    if (hasTopLevelComma(right)) {
      const list = validateElementList(right);
      return list.ok
        ? { ...base, wellFormed: true, setValued: true, reason: "multi_value_assignment" }
        : { ...base, reason: list.reason };
    }
  }

  if (/\\(?:cup|union)\b/u.test(text)) {
    const parts = text.split(/\\(?:cup|union)\b/u);
    if (parts.some((part) => !isNonEmptySetElement(part))) return { ...base, reason: "empty_element" };
    return { ...base, wellFormed: true, setValued: true, reason: "union" };
  }

  if (/\\text\{?\s*or\s*\}?|\bor\b/iu.test(raw)) {
    const parts = raw.split(/\\text\{?\s*or\s*\}?|\bor\b/iu).map((part) => normalizeSetValuedSyntax(part));
    if (parts.length < 2 || parts.some((part) => !isNonEmptySetElement(part))) return { ...base, reason: "empty_element" };
    return { ...base, wellFormed: true, setValued: true, reason: "or_list" };
  }

  const parenInner = stripOuterDelimiter(text, "(", ")");
  const bracketInner = stripOuterDelimiter(text, "[", "]");
  const intervalInner = parenInner ?? bracketInner;
  if (intervalInner !== null && hasTopLevelComma(intervalInner)) {
    const list = validateElementList(intervalInner, { expectedCount: 2 });
    return list.ok
      ? { ...base, wellFormed: true, setValued: true, reason: "tuple_or_interval" }
      : { ...base, reason: list.reason };
  }

  if (hasTopLevelComma(text)) {
    const list = validateElementList(text);
    return list.ok
      ? { ...base, wellFormed: true, setValued: true, reason: "top_level_list" }
      : { ...base, reason: list.reason };
  }

  if (/\\(?:pm|mp)(?![A-Za-z])/u.test(text)) {
    return { ...base, wellFormed: true, setValued: true, reason: "plus_minus" };
  }

  if (/eigenvalues?:/iu.test(raw)) {
    const [, tail = ""] = raw.split(/eigenvalues?:/iu);
    const list = validateElementList(normalizeSetValuedSyntax(tail));
    return list.ok
      ? { ...base, wellFormed: true, setValued: true, reason: "labeled_eigenvalues" }
      : { ...base, reason: list.reason };
  }

  return { ...base, reason: "unsupported_set_valued_shape" };
}

export function looksLikeSetValuedAnswer(value = "") {
  const analysis = analyzeSetValuedAnswer(value);
  return analysis.candidate && analysis.wellFormed;
}

export function analyzeNumericExpression(value = "", variables = {}) {
  const rawExpression = stripBox(value);
  const setValuedAnalysis = analyzeSetValuedAnswer(rawExpression);
  if (setValuedAnalysis.candidate && setValuedAnalysis.wellFormed) {
    return {
      status: "symbolic",
      value: null,
      normalized: normalizeLatexExpression(rawExpression),
      reason: "set-valued or multi-valued answer is not a scalar numeric expression",
      numericIntent: false,
      setValued: true,
    };
  }
  if (setValuedAnalysis.candidate && !setValuedAnalysis.wellFormed) {
    return {
      status: "malformed",
      value: null,
      normalized: setValuedAnalysis.normalized,
      reason: `malformed set-valued answer: ${setValuedAnalysis.reason}`,
      numericIntent: false,
      setValued: true,
      malformedSetValued: true,
    };
  }
  const {
    expression,
    extractedNumericApproximation,
    symbolicPrefixNumericAnalysis,
  } = numericExpressionCandidate(value);
  let normalized = "";
  const numericIntent = looksLikeNumericConstantExpression(expression);
  try {
    normalized = normalizeLatexExpression(expression);
    const ast = parseExpressionAst(expression);
    const normalizedVariables = Object.fromEntries(
      Object.entries(variables).map(([key, item]) => [normalizeIdentifier(key), item])
    );
    const missingVariables = [...collectAstVariables(ast)].filter((variable) => !(variable in normalizedVariables));
    if (missingVariables.length > 0) {
      return {
        status: "symbolic",
        value: null,
        normalized,
        reason: `unresolved variable(s): ${missingVariables.join(", ")}`,
        numericIntent: false,
        variables: missingVariables,
        extractedNumericApproximation,
        symbolicPrefixNumericAnalysis,
      };
    }
    const result = evaluateAst(ast, normalizedVariables);
    if (!Number.isFinite(result)) {
      return {
        status: numericIntent ? "unsupported_numeric_syntax" : "symbolic",
        value: null,
        normalized,
        reason: "expression did not evaluate to a finite real number",
        numericIntent,
        extractedNumericApproximation,
        symbolicPrefixNumericAnalysis,
      };
    }
    return {
      status: "evaluable",
      value: result,
      normalized,
      reason: "",
      numericIntent,
      extractedNumericApproximation,
      symbolicPrefixNumericAnalysis,
    };
  } catch (error) {
    if (error?.code === "VALIDATION_RESOURCE_LIMIT") {
      return {
        status: "resource_limit",
        value: null,
        normalized,
        reason: error.message,
        numericIntent,
        extractedNumericApproximation,
        symbolicPrefixNumericAnalysis,
        resourceLimit: error.resourceLimit || {
          limitType: "numeric_expression",
          configuredLimit: null,
          observedValue: null,
          validationStage: "numeric_expression_parser",
        },
      };
    }
    return {
      status: numericIntent ? "malformed" : "symbolic",
      value: null,
      normalized,
      reason: error.message,
      numericIntent,
      extractedNumericApproximation,
      symbolicPrefixNumericAnalysis,
    };
  }
}

export function evaluateLatexExpression(value = "", variables = {}) {
  const analysis = analyzeNumericExpression(value, variables);
  if (analysis.status !== "evaluable") {
    throw new Error(analysis.reason || "Expression did not evaluate to a finite real number");
  }
  return analysis.value;
}

function parseBound(value = "") {
  const text = normalizeLatexExpression(value)
    .replace(/^\((.*)\)$/u, "$1")
    .replace(/Infinity/i, "Infinity");
  if (/^-?Infinity$/iu.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  return evaluateLatexExpression(text);
}

function readScript(text, markerIndex) {
  let index = markerIndex + 1;
  if (text[index] === "{") {
    const close = findMatchingBrace(text, index);
    if (close < 0) return null;
    return { value: text.slice(index + 1, close), end: close + 1 };
  }
  if (text[index] === "\\") {
    let end = index + 1;
    while (end < text.length && /[A-Za-z]/u.test(text[end])) end += 1;
    return { value: text.slice(index, end), end };
  }
  let end = index;
  while (end < text.length && !/[\s^_]/u.test(text[end])) end += 1;
  return { value: text.slice(index, end), end };
}

function parseLatexIntegral(source = "") {
  const text = safeString(source).replace(/\\limits/g, "");
  const integralIndex = text.search(/\\int(?![A-Za-z])/u);
  if (integralIndex < 0) return null;
  let cursor = integralIndex + "\\int".length;
  let lower = null;
  let upper = null;
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  for (let count = 0; count < 2; count += 1) {
    const char = text[cursor];
    if (char !== "_" && char !== "^") break;
    const script = readScript(text, cursor);
    if (!script) break;
    if (char === "_") lower = script.value;
    else upper = script.value;
    cursor = script.end;
  }
  if (lower == null || upper == null) return null;
  const tail = text.slice(cursor);
  const differential = tail.match(/\\,?\s*d\s*\\?([A-Za-z]+|theta)\b/u);
  if (!differential || differential.index == null) return null;
  const integrand = tail.slice(0, differential.index).trim();
  const variable = normalizeIdentifier(differential[1]);
  if (!integrand || !variable) return null;
  try {
    return {
      source: "latex",
      integrand,
      variable,
      lower: parseBound(lower),
      upper: parseBound(upper),
      lowerRaw: lower,
      upperRaw: upper,
    };
  } catch {
    return null;
  }
}

function normalizeTextIntegrand(value = "") {
  return safeString(value)
    .replace(/natural logarithm of/giu, "ln")
    .replace(/the natural logarithm of/giu, "ln")
    .replace(/\bln\s+of\b/giu, "ln")
    .replace(/\barctan\s+([a-z])\b/giu, "atan($1)")
    .replace(/\bln\s*\(/giu, "ln(")
    .replace(/\btimes\b/giu, "*")
    .replace(/\bdivided by\b/giu, "/")
    .replace(/\bone\b/giu, "1")
    .replace(/\bplus\b/giu, "+")
    .replace(/\binfinity\b/giu, "Infinity")
    .replace(/\s+/g, "");
}

function parseTextIntegral(source = "") {
  const text = safeString(source);
  const match = text.match(/integral\s+from\s+(.+?)\s+to\s+(.+?)\s+of\s+(.+?)\s+with\s+respect\s+to\s+([A-Za-z]+)/iu);
  if (!match) return null;
  try {
    return {
      source: "text",
      lower: parseBound(match[1]),
      upper: parseBound(match[2]),
      lowerRaw: match[1],
      upperRaw: match[2],
      integrand: normalizeTextIntegrand(match[3]),
      variable: normalizeIdentifier(match[4]),
    };
  } catch {
    return null;
  }
}

export function parseDefiniteIntegral(problem = "", result = {}) {
  const candidates = [
    problem,
    result?.expression,
    result?.problemLatex,
    result?.originalProblem,
    result?.extractedProblemLatex,
  ].map(safeString).filter(Boolean);
  for (const candidate of candidates) {
    const parsed = parseLatexIntegral(candidate) || parseTextIntegral(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function combineSigns(op, left, right) {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (op === "*") {
    if (left === "zero" || right === "zero") return "zero";
    const leftNegative = left === "negative" || left === "nonpositive";
    const rightNegative = right === "negative" || right === "nonpositive";
    const strictly = (left === "positive" || left === "negative") && (right === "positive" || right === "negative");
    if (leftNegative === rightNegative) return strictly ? "positive" : "nonnegative";
    return strictly ? "negative" : "nonpositive";
  }
  if (op === "/") {
    if (right === "zero" || right === "nonnegative" || right === "nonpositive") return "unknown";
    return combineSigns("*", left, right === "positive" ? "positive" : "negative");
  }
  if (op === "+") {
    if (left === "zero") return right;
    if (right === "zero") return left;
    if ((left === "positive" || left === "nonnegative") && (right === "positive" || right === "nonnegative")) {
      return left === "positive" || right === "positive" ? "positive" : "nonnegative";
    }
    if ((left === "negative" || left === "nonpositive") && (right === "negative" || right === "nonpositive")) {
      return left === "negative" || right === "negative" ? "negative" : "nonpositive";
    }
  }
  if (op === "-") return combineSigns("+", left, invertSign(right));
  return "unknown";
}

function invertSign(sign) {
  if (sign === "positive") return "negative";
  if (sign === "negative") return "positive";
  if (sign === "nonnegative") return "nonpositive";
  if (sign === "nonpositive") return "nonnegative";
  return sign;
}

function relationToOne(ast, context) {
  if (ast?.type === "number") {
    if (ast.value > 1) return "greater";
    if (ast.value === 1) return "equal";
    return "unknown";
  }
  if (ast?.type === "binary" && ast.op === "+") {
    if (ast.left?.type === "number" && ast.left.value >= 1) {
      const rightSign = inferSign(ast.right, context);
      if (rightSign === "positive") return "greater";
      if (rightSign === "nonnegative" && ast.left.value > 1) return "greater";
      if (rightSign === "nonnegative" && ast.left.value === 1) return "greater";
    }
    if (ast.right?.type === "number" && ast.right.value >= 1) {
      const leftSign = inferSign(ast.left, context);
      if (leftSign === "positive") return "greater";
      if (leftSign === "nonnegative" && ast.right.value > 1) return "greater";
      if (leftSign === "nonnegative" && ast.right.value === 1) return "greater";
    }
  }
  return "unknown";
}

function inferSign(ast, context) {
  switch (ast?.type) {
    case "number":
      if (ast.value > 0) return "positive";
      if (ast.value < 0) return "negative";
      return "zero";
    case "variable": {
      const variable = normalizeIdentifier(context.variable);
      if (normalizeIdentifier(ast.name) !== variable) return "unknown";
      if (context.lower >= 0 && context.upper > context.lower) return "positive";
      if (context.upper <= 0 && context.lower < context.upper) return "negative";
      return "unknown";
    }
    case "neg":
      return invertSign(inferSign(ast.argument, context));
    case "binary": {
      if (ast.op === "^") {
        const exponent = ast.right?.type === "number" ? ast.right.value : NaN;
        const baseSign = inferSign(ast.left, context);
        if (Number.isInteger(exponent) && exponent > 0 && exponent % 2 === 0) {
          if (baseSign === "positive" || baseSign === "negative") return "positive";
          if (baseSign === "zero") return "zero";
          return "nonnegative";
        }
        if (Number.isInteger(exponent) && exponent > 0 && exponent % 2 === 1) return baseSign;
        return "unknown";
      }
      return combineSigns(ast.op, inferSign(ast.left, context), inferSign(ast.right, context));
    }
    case "call": {
      const argSign = inferSign(ast.argument, context);
      if (ast.name === "exp") return "positive";
      if (ast.name === "sqrt") {
        if (argSign === "positive") return "positive";
        if (argSign === "nonnegative" || argSign === "zero") return "nonnegative";
      }
      if (ast.name === "ln" || ast.name === "log") {
        return relationToOne(ast.argument, context) === "greater" ? "positive" : "unknown";
      }
      if (ast.name === "atan") {
        if (argSign === "positive") return "positive";
        if (argSign === "negative") return "negative";
      }
      return "unknown";
    }
    default:
      return "unknown";
  }
}

function shouldSkipRealIntegralAnalysis(problem = "") {
  return /principal\s+value|\\operatorname\s*\{\s*PV\s*\}|\\mathrm\s*\{\s*PV\s*\}|\bPV\b|complex|contour|branch\s+cut|residue/iu.test(safeString(problem));
}

export function analyzePositiveIntegralSign(problem = "", result = {}) {
  const integral = parseDefiniteIntegral(problem, result);
  const finalAnswer = safeString(result?.finalAnswerLatex || result?.finalAnswer);
  const base = {
    applicable: false,
    issue: null,
    integral,
    finalAnswer,
    finalAnswerNumericAnalysis: null,
    finalValue: null,
    integrandSign: "unknown",
    orientation: "unknown",
    confidence: "none",
    inconclusiveReason: "",
  };
  if (!integral) return { ...base, inconclusiveReason: "no supported one-dimensional definite integral found" };
  if (shouldSkipRealIntegralAnalysis(`${problem} ${result?.expression || ""}`)) {
    return { ...base, applicable: false, inconclusiveReason: "principal-value, complex, or branch-sensitive integral" };
  }
  if (!Number.isFinite(integral.lower) && !Number.isFinite(integral.upper)) {
    return { ...base, applicable: false, inconclusiveReason: "two infinite bounds are not handled by sign analysis" };
  }
  let ast;
  try {
    ast = parseExpressionAst(integral.integrand);
  } catch (error) {
    return { ...base, applicable: false, integral, inconclusiveReason: `integrand parse failed: ${error.message}` };
  }
  const ordered = integral.upper > integral.lower;
  const reversed = integral.upper < integral.lower;
  if (!ordered && !reversed) return { ...base, applicable: false, integral, inconclusiveReason: "bounds are not ordered" };
  const context = {
    variable: integral.variable,
    lower: Math.min(integral.lower, integral.upper),
    upper: Math.max(integral.lower, integral.upper),
  };
  const integrandSign = inferSign(ast, context);
  const finalAnalysis = analyzeNumericExpression(finalAnswer);
  if (finalAnalysis.status !== "evaluable") {
    return {
      ...base,
      applicable: false,
      integral,
      integrandSign,
      finalAnswerNumericAnalysis: finalAnalysis,
      inconclusiveReason: finalAnalysis.numericIntent
        ? `final answer numeric evaluation failed: ${finalAnalysis.status}`
        : "final answer is not a supported real number",
    };
  }
  const finalValue = finalAnalysis.value;
  const expectedSign = ordered ? integrandSign : invertSign(integrandSign);
  const issue = expectedSign === "positive" && finalValue < -1e-10
    ? "sign_contradiction_positive_integrand_negative_answer"
    : expectedSign === "negative" && finalValue > 1e-10
      ? "sign_contradiction_reversed_positive_integrand_positive_answer"
      : null;
  return {
    applicable: integrandSign === "positive" || expectedSign === "positive" || expectedSign === "negative",
    issue,
    integral,
    finalAnswer,
    finalAnswerNumericAnalysis: finalAnalysis,
    finalValue,
    integrandSign,
    orientation: ordered ? "ordered" : "reversed",
    expectedIntegralSign: expectedSign,
    confidence: issue ? "high" : integrandSign === "positive" ? "high" : "inconclusive",
    inconclusiveReason: integrandSign === "unknown" ? "integrand sign is ambiguous" : "",
  };
}

function transformedFunction(integral) {
  const ast = parseExpressionAst(integral.integrand);
  const variable = integral.variable;
  if (Number.isFinite(integral.lower) && Number.isFinite(integral.upper)) {
    return {
      a: integral.lower,
      b: integral.upper,
      method: "adaptive_simpson_finite",
      f: (x) => evaluateAst(ast, { [variable]: x }),
    };
  }
  if (Number.isFinite(integral.lower) && integral.upper === Infinity) {
    const lower = integral.lower;
    return {
      a: 1e-8,
      b: 1 - 1e-8,
      method: "adaptive_simpson_upper_infinite_transform",
      f: (t) => {
        const x = lower + t / (1 - t);
        return evaluateAst(ast, { [variable]: x }) / ((1 - t) ** 2);
      },
    };
  }
  if (integral.lower === -Infinity && Number.isFinite(integral.upper)) {
    const upper = integral.upper;
    return {
      a: 1e-8,
      b: 1 - 1e-8,
      method: "adaptive_simpson_lower_infinite_transform",
      f: (t) => {
        const x = upper - (1 - t) / t;
        return evaluateAst(ast, { [variable]: x }) / (t ** 2);
      },
    };
  }
  throw new Error("unsupported infinite interval");
}

function safeFinite(f, x) {
  const value = f(x);
  if (!Number.isFinite(value)) throw new Error(`non-finite integrand at ${x}`);
  return value;
}

function simpson(fa, fm, fb, a, b) {
  return ((b - a) / 6) * (fa + 4 * fm + fb);
}

function adaptiveSimpson(f, a, b, eps, maxDepth, maxEvaluations = MAX_NUMERICAL_EVALUATIONS) {
  const fa = safeFinite(f, a);
  const fb = safeFinite(f, b);
  const m = (a + b) / 2;
  const fm = safeFinite(f, m);
  const whole = simpson(fa, fm, fb, a, b);
  let evaluations = 3;
  let maxDepthReached = false;
  let evaluationLimitReached = false;

  function recurse(left, right, fLeft, fMid, fRight, area, depth) {
    if (evaluations + 2 > maxEvaluations) {
      evaluationLimitReached = true;
      return area;
    }
    const mid = (left + right) / 2;
    const leftMid = (left + mid) / 2;
    const rightMid = (mid + right) / 2;
    const fLeftMid = safeFinite(f, leftMid);
    const fRightMid = safeFinite(f, rightMid);
    evaluations += 2;
    const leftArea = simpson(fLeft, fLeftMid, fMid, left, mid);
    const rightArea = simpson(fMid, fRightMid, fRight, mid, right);
    const delta = leftArea + rightArea - area;
    if (Math.abs(delta) <= 15 * eps) {
      return leftArea + rightArea + delta / 15;
    }
    if (depth <= 0) {
      maxDepthReached = true;
      return leftArea + rightArea + delta / 15;
    }
    return recurse(left, mid, fLeft, fLeftMid, fMid, leftArea, depth - 1)
      + recurse(mid, right, fMid, fRightMid, fRight, rightArea, depth - 1);
  }

  const estimate = recurse(a, b, fa, fm, fb, whole, maxDepth);
  return {
    estimate,
    evaluations,
    converged: !maxDepthReached && !evaluationLimitReached,
    maxDepthReached,
    evaluationLimitReached,
  };
}

function sampleFunctionSigns(f, a, b, count = 41) {
  const signs = [];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const x = a + ((b - a) * index) / (count - 1);
    let value;
    try {
      value = safeFinite(f, x);
    } catch {
      continue;
    }
    values.push(value);
    if (Math.abs(value) > 1e-10) signs.push(Math.sign(value));
  }
  let signChanges = 0;
  for (let index = 1; index < signs.length; index += 1) {
    if (signs[index] !== signs[index - 1]) signChanges += 1;
  }
  return { signChanges, values };
}

function detectOscillation(integral, transformed) {
  const source = normalizeLatexExpression(integral.integrand);
  const trigOscillator = /(?:^|[^A-Za-z])(sin|cos)\s*\(/u.test(source);
  if (!trigOscillator) return { oscillationDetected: false, reason: "" };
  if (!Number.isFinite(integral.lower) || !Number.isFinite(integral.upper)) {
    return { oscillationDetected: true, reason: "oscillatory_integrand" };
  }
  const width = Math.abs(integral.upper - integral.lower);
  const samples = sampleFunctionSigns(transformed.f, transformed.a, transformed.b, 81);
  if (samples.signChanges >= 8 || width >= 50) {
    return { oscillationDetected: true, reason: "oscillatory_integrand" };
  }
  return { oscillationDetected: false, reason: "" };
}

function detectDivergentTail(integral) {
  if (!(Number.isFinite(integral.lower) && integral.upper === Infinity)) {
    return { divergentTailSuspected: false, tailDecayDetected: null, reason: "" };
  }
  let ast;
  try {
    ast = parseExpressionAst(integral.integrand);
  } catch (error) {
    return { divergentTailSuspected: false, tailDecayDetected: null, reason: `tail parse failed: ${error.message}` };
  }
  const variable = integral.variable;
  const xs = [16, 64, 256, 1024].map((offset) => integral.lower + offset);
  const scaled = [];
  for (const x of xs) {
    const value = evaluateAst(ast, { [variable]: x });
    if (!Number.isFinite(value)) {
      return { divergentTailSuspected: true, tailDecayDetected: false, reason: "non-finite tail sample" };
    }
    scaled.push(Math.abs(x * value));
  }
  const last = scaled.at(-1) ?? 0;
  const previous = scaled.at(-2) ?? 0;
  const divergentTailSuspected = last > 0.05 && previous > 0.05 && last >= previous * 0.75;
  return {
    divergentTailSuspected,
    tailDecayDetected: !divergentTailSuspected,
    reason: divergentTailSuspected ? "divergent_tail_suspected" : "",
    tailSamples: xs.map((x, index) => ({ x, scaledValue: scaled[index] })),
  };
}

function estimatesAgree(left, right, tolerance) {
  const diff = Math.abs(left - right);
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return {
    agree: diff <= Math.max(tolerance, scale * 5e-5),
    difference: diff,
  };
}

export function numericalFinalAnswerCheck(problem = "", result = {}) {
  const integral = parseDefiniteIntegral(problem, result);
  const finalAnswer = safeString(result?.finalAnswerLatex || result?.finalAnswer);
  const base = {
    applicable: false,
    issue: null,
    diagnosticIssue: null,
    integral,
    finalAnswer,
    finalAnswerNumericAnalysis: null,
    numericalEstimate: null,
    proposedValue: null,
    absoluteDifference: null,
    relativeDifference: null,
    tolerance: null,
    converged: false,
    maxDepthReached: false,
    evaluationCount: 0,
    evaluationLimitReached: false,
    refinementStable: false,
    oscillationDetected: false,
    tailDecayDetected: null,
    divergentTailSuspected: false,
    transformAgreement: null,
    confidence: "none",
    method: "",
    inconclusiveReason: "",
  };
  if (!integral) return { ...base, inconclusiveReason: "no supported one-dimensional definite integral found" };
  if (shouldSkipRealIntegralAnalysis(`${problem} ${result?.expression || ""}`)) {
    return { ...base, inconclusiveReason: "principal-value, complex, or branch-sensitive integral" };
  }
  const inferredConstants = /\\zeta\s*\(\s*3\s*\)/u.test(finalAnswer)
    && /(^|[^A-Za-z])G(?![A-Za-z])/u.test(finalAnswer)
    ? { G: 0.915965594177219 }
    : {};
  const proposedAnalysis = analyzeNumericExpression(finalAnswer, inferredConstants);
  if (proposedAnalysis.status !== "evaluable") {
    return {
      ...base,
      finalAnswerNumericAnalysis: proposedAnalysis,
      applicable: false,
      diagnosticIssue: proposedAnalysis.numericIntent ? "numerical_check_inconclusive" : null,
      inconclusiveReason: proposedAnalysis.numericIntent
        ? `final answer numeric evaluation failed: ${proposedAnalysis.status}`
        : "final answer is not numerically evaluable",
    };
  }
  const proposedValue = proposedAnalysis.value;
  try {
    const transformed = transformedFunction(integral);
    const probePoints = [transformed.a, (transformed.a + transformed.b) / 2, transformed.b];
    for (const point of probePoints) safeFinite(transformed.f, point);

    const oscillation = detectOscillation(integral, transformed);
    if (oscillation.oscillationDetected) {
      return {
        ...base,
        applicable: false,
        diagnosticIssue: "numerical_check_inconclusive",
        finalAnswerNumericAnalysis: proposedAnalysis,
        proposedValue,
        oscillationDetected: true,
        confidence: "inconclusive",
        inconclusiveReason: oscillation.reason || "oscillatory_integrand",
      };
    }

    const tail = detectDivergentTail(integral);
    if (tail.divergentTailSuspected) {
      return {
        ...base,
        applicable: false,
        diagnosticIssue: "numerical_check_inconclusive",
        finalAnswerNumericAnalysis: proposedAnalysis,
        proposedValue,
        divergentTailSuspected: true,
        tailDecayDetected: false,
        confidence: "inconclusive",
        inconclusiveReason: tail.reason || "divergent_tail_suspected",
        tailDiagnostics: tail,
      };
    }

    const primary = adaptiveSimpson(
      transformed.f,
      transformed.a,
      transformed.b,
      DEFAULT_ABS_TOLERANCE / 8,
      MAX_RECURSION_DEPTH
    );
    const refined = adaptiveSimpson(
      transformed.f,
      transformed.a,
      transformed.b,
      DEFAULT_ABS_TOLERANCE / 32,
      MAX_RECURSION_DEPTH
    );
    const midpoint = (transformed.a + transformed.b) / 2;
    const left = adaptiveSimpson(
      transformed.f,
      transformed.a,
      midpoint,
      DEFAULT_ABS_TOLERANCE / 16,
      MAX_RECURSION_DEPTH
    );
    const right = adaptiveSimpson(
      transformed.f,
      midpoint,
      transformed.b,
      DEFAULT_ABS_TOLERANCE / 16,
      MAX_RECURSION_DEPTH
    );
    const splitEstimate = left.estimate + right.estimate;
    const estimate = refined.estimate;
    const evaluationCount = primary.evaluations + refined.evaluations + left.evaluations + right.evaluations;
    const tolerance = Math.max(DEFAULT_ABS_TOLERANCE * 20, Math.abs(estimate) * DEFAULT_REL_TOLERANCE * 20);
    const refinementAgreement = estimatesAgree(primary.estimate, refined.estimate, tolerance / 2);
    const splitAgreement = estimatesAgree(splitEstimate, refined.estimate, tolerance / 2);
    const maxDepthReached = primary.maxDepthReached || refined.maxDepthReached || left.maxDepthReached || right.maxDepthReached;
    const evaluationLimitReached = primary.evaluationLimitReached || refined.evaluationLimitReached || left.evaluationLimitReached || right.evaluationLimitReached;
    const converged = primary.converged && refined.converged && left.converged && right.converged;
    const refinementStable = refinementAgreement.agree;
    const transformAgreement = splitAgreement.agree;
    const unstableReason = maxDepthReached
      ? "max_depth_reached"
      : evaluationLimitReached || evaluationCount > MAX_NUMERICAL_EVALUATIONS
        ? "excessive_evaluation_count"
        : !refinementStable
          ? "unstable_refinement"
          : !transformAgreement
            ? "independent_estimates_disagree"
            : "";
    if (unstableReason) {
      return {
        ...base,
        applicable: false,
        diagnosticIssue: "numerical_check_inconclusive",
        finalAnswerNumericAnalysis: proposedAnalysis,
        numericalEstimate: estimate,
        proposedValue,
        tolerance,
        converged,
        maxDepthReached,
        evaluationCount,
        evaluationLimitReached,
        refinementStable,
        oscillationDetected: false,
        tailDecayDetected: tail.tailDecayDetected,
        divergentTailSuspected: false,
        transformAgreement,
        confidence: "inconclusive",
        method: `${transformed.method}; evaluations=${evaluationCount}`,
        inconclusiveReason: unstableReason,
        refinementDiagnostics: {
          primaryEstimate: primary.estimate,
          refinedEstimate: refined.estimate,
          splitEstimate,
          refinementDifference: refinementAgreement.difference,
          splitDifference: splitAgreement.difference,
        },
      };
    }
    const absoluteDifference = Math.abs(estimate - proposedValue);
    const relativeDifference = absoluteDifference / Math.max(1, Math.abs(estimate), Math.abs(proposedValue));
    const mismatch = absoluteDifference > tolerance && relativeDifference > 5e-5;
    return {
      ...base,
      applicable: true,
      issue: mismatch ? "numerical_final_answer_mismatch" : null,
      diagnosticIssue: null,
      finalAnswerNumericAnalysis: proposedAnalysis,
      numericalEstimate: estimate,
      proposedValue,
      absoluteDifference,
      relativeDifference,
      tolerance,
      converged,
      maxDepthReached,
      evaluationCount,
      evaluationLimitReached,
      refinementStable,
      oscillationDetected: false,
      tailDecayDetected: tail.tailDecayDetected,
      divergentTailSuspected: false,
      transformAgreement,
      confidence: mismatch ? "high" : "agreement",
      method: `${transformed.method}; evaluations=${evaluationCount}`,
    };
  } catch (error) {
    return {
      ...base,
      finalAnswerNumericAnalysis: proposedAnalysis,
      applicable: false,
      proposedValue,
      diagnosticIssue: "numerical_check_inconclusive",
      confidence: "inconclusive",
      inconclusiveReason: error.message,
    };
  }
}

function expressionValuesClose(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Math.max(1e-5, scale * 1e-5);
}

function stepId(step = {}, index = 0) {
  return safeString(step.id || step.label || step.title || step.heading) || `step-${index + 1}`;
}

function stepText(step = {}) {
  return [
    step.label,
    step.title,
    step.heading,
    step.math,
    step.latex,
    step.equationLatex,
    step.summary,
    step.reasoning,
    step.plainExplanation,
  ].map(safeString).filter(Boolean).join(" ");
}

function stepMath(step = {}) {
  return safeString(step.math || step.latex || step.equationLatex);
}

function lastEvaluableEquationValue(latex = "") {
  const parts = splitTopLevelEquality(latex);
  if (parts.length < 2) return null;
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    try {
      return {
        expression: parts[index],
        value: evaluateLatexExpression(parts[index]),
      };
    } catch {
      // Keep searching earlier RHS fragments.
    }
  }
  return null;
}

function firstEquationPart(latex = "") {
  const parts = splitTopLevelEquality(latex);
  return parts.length > 1 ? parts[0] : "";
}

function targetFingerprint(value = "") {
  return compactText(value)
    .replace(/^\\boxed/, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\s+/g, "");
}

export function analyzeFinalAnswerConsistency(result = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const finalAnswer = safeString(result?.finalAnswerLatex || result?.finalAnswer);
  const base = {
    applicable: false,
    issue: null,
    finalAnswer,
    finalValue: null,
    supportingStepId: null,
    supportingStepLatex: "",
    supportingValue: null,
    evidence: "",
    supportStatus: "unavailable",
  };
  const finalAnalysis = analyzeNumericExpression(finalAnswer);
  if (finalAnalysis.status !== "evaluable") {
    return {
      ...base,
      finalAnswerNumericAnalysis: finalAnalysis,
      inconclusiveReason: "final answer is not numerically evaluable",
    };
  }
  const finalValue = finalAnalysis.value;
  const finalTarget = targetFingerprint(firstEquationPart(finalAnswer));

  const candidates = [];
  steps.forEach((step, index) => {
    const math = stepMath(step);
    const value = lastEvaluableEquationValue(math);
    if (value) {
      const lhs = firstEquationPart(math);
      candidates.push({
        step,
        index,
        stepId: stepId(step, index),
        latex: math,
        lhs,
        target: targetFingerprint(lhs),
        ...value,
        isFinalish: /final\s+answer|answer$/iu.test(stepText(step)),
      });
    }
  });

  if (candidates.length === 0) {
    return {
      ...base,
      finalAnswerNumericAnalysis: finalAnalysis,
      finalValue,
      supportStatus: "unavailable",
      inconclusiveReason: "no evaluable derivation equality found",
    };
  }
  const sameTarget = finalTarget
    ? candidates.filter((candidate) => candidate.target && candidate.target === finalTarget)
    : [];
  const supportingCandidates = candidates.filter((candidate) => expressionValuesClose(candidate.value, finalValue));
  const chosenSupport = [
    ...supportingCandidates.filter((candidate) => sameTarget.includes(candidate) && candidate.isFinalish),
    ...supportingCandidates.filter((candidate) => candidate.isFinalish),
    ...supportingCandidates.filter((candidate) => sameTarget.includes(candidate)),
    ...supportingCandidates,
  ][0] || null;
  if (chosenSupport) {
    return {
      ...base,
      finalAnswerNumericAnalysis: finalAnalysis,
      applicable: true,
      finalValue,
      supportingStepId: chosenSupport.stepId,
      supportingStepLatex: chosenSupport.latex,
      supportingValue: chosenSupport.value,
      supportStatus: "supported",
    };
  }

  const relevantCandidates = [
    ...candidates.filter((candidate) => sameTarget.includes(candidate) && candidate.isFinalish),
    ...candidates.filter((candidate) => candidate.isFinalish),
    ...candidates.filter((candidate) => sameTarget.includes(candidate)),
  ];
  const lastCandidate = relevantCandidates.at(-1) || candidates[candidates.length - 1];
  const issue = /\\psi|digamma|\\Gamma|Gamma|Beta|\\mathrm\{?B\}?/iu.test(lastCandidate.latex + finalAnswer)
    ? "unsupported_special_function_simplification"
    : Math.sign(lastCandidate.value) !== 0
      && Math.sign(finalValue) !== 0
      && Math.sign(lastCandidate.value) !== Math.sign(finalValue)
      ? "final_answer_sign_inconsistent_with_steps"
      : "final_answer_not_supported_by_steps";
  return {
    ...base,
    finalAnswerNumericAnalysis: finalAnalysis,
    applicable: true,
    issue,
    finalValue,
    supportingStepId: lastCandidate.stepId,
    supportingStepLatex: lastCandidate.latex,
    supportingValue: lastCandidate.value,
    supportStatus: "contradicted",
    evidence: `${lastCandidate.stepId}: ${lastCandidate.expression} ≈ ${lastCandidate.value}; final ${finalAnswer} ≈ ${finalValue}`,
  };
}

function extractAntiderivativeClaims(result = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const claims = [];
  const pattern = /\\int(?!\s*[_^])\s*([\s\S]{1,180}?)\\,?\s*d\s*\\?([A-Za-z]+|theta)\s*=\s*([\s\S]{1,180}?)(?=$|[,;.]|\\quad|\\qquad|\s+(?:and|then|so|where|with)\b)/giu;
  steps.forEach((step, index) => {
    const sources = [stepMath(step)];
    const reasoning = safeString(step.reasoning || step.summary || step.plainExplanation);
    if (/\\int[\s\S]{1,220}=/u.test(reasoning)) sources.push(reasoning);
    const nextMath = stepMath(steps[index + 1] || {});
    if (/\\int(?!\s*[_^])[\s\S]{1,180}\\,?\s*d\s*\\?[A-Za-z]+/u.test(stepMath(step)) && /^\s*=/.test(nextMath)) {
      sources.push(`${stepMath(step)}${nextMath}`);
    }
    for (const text of sources.filter(Boolean)) {
      for (const match of text.matchAll(pattern)) {
        const integrand = safeString(match[1]);
        const variable = normalizeIdentifier(match[2]);
        const antiderivative = safeString(match[3])
          .replace(/\s*\+?\s*C\s*$/u, "")
          .trim();
        if (integrand && antiderivative) {
          claims.push({
            stepId: stepId(step, index),
            stepIndex: index,
            stepLatex: stepMath(step),
            integrand,
            variable,
            antiderivative,
          });
        }
      }
    }
  });
  return claims;
}

function derivativeMatchesClaim(claim) {
  const integrandAst = parseExpressionAst(claim.integrand);
  const antiderivativeAst = parseExpressionAst(claim.antiderivative);
  const samples = claim.variable === "theta"
    ? [0.25, 0.5, 0.9]
    : [0.25, 0.7, 1.4];
  const mismatches = [];
  let checked = 0;
  for (const sample of samples) {
    const h = Math.max(1e-5, Math.abs(sample) * 1e-5);
    const vars = { [claim.variable]: sample };
    const left = evaluateAst(integrandAst, vars);
    const plus = evaluateAst(antiderivativeAst, { [claim.variable]: sample + h });
    const minus = evaluateAst(antiderivativeAst, { [claim.variable]: sample - h });
    const derivative = (plus - minus) / (2 * h);
    if (!Number.isFinite(left) || !Number.isFinite(derivative)) continue;
    checked += 1;
    const scale = Math.max(1, Math.abs(left), Math.abs(derivative));
    if (Math.abs(left - derivative) > scale * 2e-3) {
      mismatches.push({ sample, expected: left, derivative });
    }
  }
  if (checked < 2) return { status: "inconclusive", checked, mismatches };
  return {
    status: mismatches.length >= Math.ceil(checked / 2) ? "mismatch" : "match",
    checked,
    mismatches,
  };
}

function hasSupportedIntermediateBetaDerivative(text = "") {
  const compact = safeString(text)
    .replace(/\\left|\\right/g, "")
    .replace(/\\[,;!]/g, "")
    .replace(/\s+/g, "");
  const logarithmicIntegral = compact.match(/([A-Z]):?=\\int_0\^\{?\\pi\/2\}?\\ln\(\\sin([A-Za-z])\)\\ln\(\\cos\2\)d\2/u);
  const betaFamily = compact.match(/([A-Z])\(([A-Za-z]),([A-Za-z])\):?=\\int_0\^\{?\\pi\/2\}?\\sin\^\{?\2-1\}?([A-Za-z])\\cos\^\{?\3-1\}?\4d\4/u);
  if (!logarithmicIntegral || !betaFamily) return false;
  const [, target] = logarithmicIntegral;
  const [, family, firstParameter, secondParameter] = betaFamily;
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedFamily = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedFirst = firstParameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedSecond = secondParameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mixedDerivative = new RegExp(
    `${escapedTarget}=.*\\\\frac\\{\\\\partial\\^2${escapedFamily}\\}\\{\\\\partial${escapedFirst}\\\\partial${escapedSecond}\\}`,
    "u"
  );
  return mixedDerivative.test(compact);
}

export function verifyCriticalIdentities(result = {}, problem = "") {
  const identityResults = [];
  const claims = extractAntiderivativeClaims(result);
  if (claims.length > MAX_IDENTITY_CHECKS) {
    return {
      applicable: true,
      issue: null,
      diagnosticIssue: "validation_resource_limit_reached",
      identityResults,
      inconclusiveReason: "identity check limit reached",
      resourceLimit: {
        limitType: "identity_checks",
        configuredLimit: MAX_IDENTITY_CHECKS,
        observedValue: claims.length,
        validationStage: "critical_identity_verification",
      },
    };
  }
  for (const claim of claims) {
    try {
      const verification = derivativeMatchesClaim(claim);
      identityResults.push({ ...claim, verification });
      if (verification.status === "mismatch") {
        return {
          applicable: true,
          issue: "invalid_antiderivative",
          firstFailingStepId: claim.stepId,
          relevantStepLatex: claim.stepLatex,
          identityResults,
          evidence: `${claim.stepId}: derivative of ${claim.antiderivative} does not match ${claim.integrand}`,
        };
      }
    } catch (error) {
      identityResults.push({
        ...claim,
        verification: { status: "inconclusive", reason: error.message },
      });
    }
  }

  const text = [
    problem,
    result?.expression,
    result?.finalAnswerLatex,
    ...(Array.isArray(result?.steps) ? result.steps.map(stepText) : []),
  ].map(safeString).join(" ");
  const compact = compactText(text);
  if (
    /(?:\\psi|digamma|Beta|\\Beta|\\Gamma|Gamma|B\([^)]*,[^)]*\))/iu.test(text)
    && /differentiat|parameter|F'\(|I'\(|d\/d[a-z]|\\frac\{d\}\{d[a-z]\}/iu.test(text)
    && /arctan|\\arctan|theta|\\theta/iu.test(`${problem} ${result?.expression || ""}`)
    && !/(?:arctan|\\arctan|theta|\\theta).{0,120}(?:parameter|Beta|\\Beta|\\Gamma|Gamma|\\psi|digamma)/iu.test(text)
    && !hasSupportedIntermediateBetaDerivative(text)
  ) {
    return {
      applicable: true,
      issue: "unverified_critical_identity",
      firstFailingStepId: Array.isArray(result?.steps) && result.steps[0] ? stepId(result.steps[0], 0) : null,
      relevantStepLatex: Array.isArray(result?.steps) ? stepMath(result.steps.find((step) => /\\psi|digamma|Beta|\\Gamma|Gamma/iu.test(stepText(step))) || {}) : "",
      identityResults,
      evidence: "special-function parameter identity is asserted without showing a family whose derivative reproduces the target integrand",
    };
  }

  if (/x\\?lnx|x\\lnx|x\*?ln\(x\)/iu.test(compact) && /F'\(0\)|I'\(0\)|at\s*a\s*=\s*0/iu.test(text) && /x\^a|x\^\{a\}/iu.test(text)) {
    return {
      applicable: true,
      issue: "parameter_derivative_mismatch",
      firstFailingStepId: Array.isArray(result?.steps) && result.steps[0] ? stepId(result.steps[0], 0) : null,
      relevantStepLatex: Array.isArray(result?.steps) ? stepMath(result.steps[0]) : "",
      identityResults,
      evidence: "F'(0) for F(a)=∫x^a dx produces ln(x), not x ln(x)",
    };
  }

  return {
    applicable: identityResults.length > 0,
    issue: null,
    identityResults,
  };
}

export function analyzeSubstitutionConsistency(result = {}, problem = "") {
  const generatedFields = collectGeneratedMath(result);
  const generatedMathFieldPaths = generatedFields.map((field) => field.fieldPath);
  const stepGeneratedText = new Map();
  for (const field of generatedFields) {
    if (!Number.isInteger(field.stepIndex)) continue;
    const previous = stepGeneratedText.get(field.stepIndex) || "";
    stepGeneratedText.set(field.stepIndex, `${previous} ${field.normalized}`.trim());
  }
  const stepTextAt = (index) => stepGeneratedText.get(index) || "";
  const stepMathAt = (index) => {
    const field = generatedFields.find((item) => (
      item.stepIndex === index
      && ["math", "latex", "equationLatex", "lines[].latex", "lines[].math", "lines[].equationLatex"].includes(item.sourceType)
    ));
    return field?.normalized || "";
  };
  const firstStepMatching = (pattern, extraPattern = null) => {
    for (const [stepIndex, textValue] of stepGeneratedText.entries()) {
      pattern.lastIndex = 0;
      if (!pattern.test(textValue)) continue;
      if (extraPattern) {
        extraPattern.lastIndex = 0;
        if (!extraPattern.test(textValue)) continue;
      }
      return stepIndex;
    }
    return null;
  };
  const text = [
    problem,
    result?.expression,
    ...generatedFields.map((field) => field.normalized),
  ].map(safeString).join(" ");
  const compact = compactText(text);
  if (!/(?:x=\\tan|x=tan|x\s*=\\tan|x\s*=\s*tan)/iu.test(text)) {
    return { applicable: false, issue: null, inconclusiveReason: "no x=tan substitution found", generatedMathFieldPaths };
  }
  if (!/(?:\\frac\{\\ln\(1\+x\^2\)\\arctanx\}\{x\(1\+x\^2\)\}|ln\(1\+x\^2\).*arctanx.*x\(1\+x\^2\))/iu.test(compact)) {
    return { applicable: false, issue: null, inconclusiveReason: "not the guarded tan-substitution quotient pattern", generatedMathFieldPaths };
  }
  const tanStepIndex = firstStepMatching(/x\s*=\s*\\?tan/iu, /\\int|∫/u);
  if (/(?:dx|d\s*x)\s*=\s*(?:d\\theta|dtheta|d\s*t|dt)\b/iu.test(text)) {
    const matchingStepIndex = firstStepMatching(/(?:dx|d\s*x)\s*=\s*(?:d\\theta|dtheta|d\s*t|dt)\b/iu);
    return {
      applicable: true,
      issue: "incorrect_substitution_jacobian",
      verificationStatus: "failed",
      firstFailingStepId: Number.isInteger(matchingStepIndex) ? stepId(result.steps?.[matchingStepIndex], matchingStepIndex) : null,
      relevantStepLatex: Number.isInteger(matchingStepIndex) ? stepMathAt(matchingStepIndex) : "",
      evidence: "x=tan substitution explicitly states dx=dtheta instead of dx=sec^2(theta)dtheta",
      generatedMathFieldPaths,
    };
  }
  if (/\\infty|infinity/iu.test(text) && /(?:\\theta|theta|t)\s*=\s*\\?pi\b/iu.test(text)) {
    const matchingStepIndex = firstStepMatching(/\\infty|infinity/iu, /(?:\\theta|theta|t)\s*=\s*\\?pi\b/iu);
    return {
      applicable: true,
      issue: "incorrect_substitution_jacobian",
      verificationStatus: "failed",
      firstFailingStepId: Number.isInteger(matchingStepIndex) ? stepId(result.steps?.[matchingStepIndex], matchingStepIndex) : null,
      relevantStepLatex: Number.isInteger(matchingStepIndex) ? stepMathAt(matchingStepIndex) : "",
      evidence: "x=infinity under x=tan(theta) maps to theta=pi/2, not theta=pi",
      generatedMathFieldPaths,
    };
  }
  if (!Number.isInteger(tanStepIndex)) {
    return {
      applicable: true,
      issue: null,
      verificationStatus: "inconclusive",
      firstFailingStepId: null,
      relevantStepLatex: "",
      inconclusiveReason: "x=tan substitution evidence is incomplete or split across steps",
      evidence: "",
      generatedMathFieldPaths,
    };
  }
  const step = stepTextAt(tanStepIndex);
  const integralIndex = step.search(/\\int|∫/u);
  const transformedPart = integralIndex >= 0 ? step.slice(integralIndex) : step;
  const transformedCompact = compactText(transformedPart);
  const failingStepId = stepId(result.steps?.[tanStepIndex], tanStepIndex);
  const failingStepLatex = stepMathAt(tanStepIndex);
  if (/(?:dx|d\s*x)\s*=\s*(?:d\\theta|dtheta|d\s*t|dt)\b/iu.test(step)) {
    return {
      applicable: true,
      issue: "incorrect_substitution_jacobian",
      verificationStatus: "failed",
      firstFailingStepId: failingStepId,
      relevantStepLatex: failingStepLatex,
      evidence: "x=tan substitution explicitly states dx=dtheta instead of dx=sec^2(theta)dtheta",
      generatedMathFieldPaths,
    };
  }
  if (/\\infty|infinity/iu.test(step) && /(?:\\theta|theta|t)\s*=\s*\\?pi\b/iu.test(step)) {
    return {
      applicable: true,
      issue: "incorrect_substitution_jacobian",
      verificationStatus: "failed",
      firstFailingStepId: failingStepId,
      relevantStepLatex: failingStepLatex,
      evidence: "x=infinity under x=tan(theta) maps to theta=pi/2, not theta=pi",
      generatedMathFieldPaths,
    };
  }
  const hasThetaFactor = /\\theta|\btheta\b|\bt\b/iu.test(transformedPart);
  const hasReciprocalTangent = /\\cot|\bcot\b|\\tan|\btan\b|\\frac\{\\cos|cos.*sin|\/\s*(?:\\tan|tan)/iu.test(transformedPart);
  const hasCosLog = /(?:\\ln|ln).*(?:\\cos|cos)|(?:\\ln|ln).*(?:\\sec|sec)/iu.test(transformedPart);
  const visiblyMissingReciprocalFactor = hasThetaFactor
    && hasCosLog
    && !hasReciprocalTangent
    && /\\int|∫/u.test(transformedPart);
  if (visiblyMissingReciprocalFactor && !/\\sec\^?\{?2\}?|sec\^?2/iu.test(transformedPart)) {
    return {
      applicable: true,
      issue: "incorrect_substitution_jacobian",
      verificationStatus: "failed",
      firstFailingStepId: failingStepId,
      relevantStepLatex: failingStepLatex,
      evidence: "x=tan substitution transformed integral lacks the reciprocal tan/cot factor and shows no sec^2 cancellation evidence",
      generatedMathFieldPaths,
    };
  }
  const validEquivalentForm = hasThetaFactor
    && hasCosLog
    && hasReciprocalTangent
    && /0.*(?:\\pi\/2|\\frac\{\\pi\}\{2\}|pi\/2)/iu.test(transformedCompact);
  if (validEquivalentForm) {
    return {
      applicable: true,
      issue: null,
      verificationStatus: "supported",
      firstFailingStepId: null,
      relevantStepLatex: "",
      evidence: "",
      generatedMathFieldPaths,
    };
  }
  return {
    applicable: true,
    issue: null,
    verificationStatus: "inconclusive",
    firstFailingStepId: null,
    relevantStepLatex: "",
    inconclusiveReason: "x=tan substitution evidence is incomplete or split across steps",
    evidence: "",
    generatedMathFieldPaths,
  };
}

export function createMethodFingerprint(result = {}, error = null) {
  const text = [
    result?.title,
    result?.expression,
    result?.finalAnswerLatex,
    ...(Array.isArray(result?.steps) ? result.steps.map(stepText) : []),
  ].map(safeString).join(" ");
  const compact = compactText(text).toLowerCase();
  const signals = [];
  if (/integrationbyparts|u=|dv=|\\int.*=.*d/u.test(compact)) signals.push("integration_by_parts");
  if (/differentiat|parameter|f'\(|i'\(|d\/d[a-z]|\\frac\{d\}\{d[a-z]\}/u.test(compact)) signals.push("parameter_differentiation");
  if (/beta|\\beta|gamma|\\gamma|digamma|\\psi/u.test(compact)) signals.push("beta_gamma_digamma");
  if (/contour|residue|branchcut/u.test(compact)) signals.push("contour_integration");
  if (/x=\\?tan|x\\mapsto\\?tan/u.test(compact)) signals.push("substitution_x_tan");
  if (/\\int(?![_^]).{0,160}=.{0,160}(?:\+c|c$)/u.test(compact)) signals.push("claimed_antiderivative");
  if (/series|taylor|fourier|power\s*series/u.test(text)) signals.push("series_expansion");
  const failedEvidence = Array.isArray(error?.solutionRuleEvaluations)
    ? error.solutionRuleEvaluations
      .filter((evaluation) => evaluation?.result === "fail" && evaluation.failureEvidence)
      .map((evaluation) => compactText(evaluation.failureEvidence).toLowerCase())
      .join("|")
    : "";
  const primaryMethod = signals[0] || "unknown";
  return {
    primaryMethod,
    signals: [...new Set(signals)],
    failingIdentity: failedEvidence.slice(0, 240),
    fingerprint: `${primaryMethod}:${[...new Set(signals)].join(",")}:${failedEvidence.slice(0, 120)}`,
  };
}
