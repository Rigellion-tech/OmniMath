import { collectGeneratedMath } from "./generatedMathCollector.js";

const GREEK_COMMANDS = new Set([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "theta",
  "phi",
  "rho",
  "pi",
  "lambda",
  "mu",
  "sigma",
  "omega",
]);

const FUNCTION_OR_OPERATOR_COMMANDS = new Set([
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "ln",
  "log",
  "exp",
  "sqrt",
  "frac",
  "dfrac",
  "tfrac",
  "int",
  "iint",
  "iiint",
  "oint",
  "sum",
  "prod",
  "lim",
  "left",
  "right",
  "cdot",
  "times",
  "le",
  "ge",
  "lt",
  "gt",
  "approx",
  "sim",
  "to",
  "infty",
  "nabla",
  "partial",
  "quad",
  "qquad",
  "text",
  "mathrm",
]);

const STANDARD_SYMBOLS = new Set(["\\pi", "e", "i", "C", "\\infty"]);

function stripTextCommands(value = "") {
  return String(value || "").replace(/\\(?:text|mathrm)\s*\{([^{}]*)\}/g, " ");
}

function normalizeUnicodeSymbols(value = "") {
  return String(value || "")
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/δ/g, "\\delta")
    .replace(/α/g, "\\alpha")
    .replace(/β/g, "\\beta")
    .replace(/γ/g, "\\gamma")
    .replace(/λ/g, "\\lambda")
    .replace(/μ/g, "\\mu")
    .replace(/σ/g, "\\sigma")
    .replace(/ω/g, "\\omega")
    .replace(/∞/g, "\\infty");
}

function normalizeSymbolName(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const greek = text.match(/^\\?(alpha|beta|gamma|delta|epsilon|theta|phi|rho|pi|lambda|mu|sigma|omega)$/iu);
  if (greek) return `\\${greek[1].toLowerCase()}`;
  const styled = text.match(/^\\(?:mathbf|vec|hat)\s*\{?([A-Za-z])\}?$/u);
  if (styled) return styled[1];
  if (/^[A-Za-z]$/u.test(text)) return text;
  return text;
}

function isEscapedAt(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "{" && !isEscapedAt(text, index)) depth += 1;
    else if (text[index] === "}" && !isEscapedAt(text, index)) {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function readOperatorScript(text, markerIndex) {
  let cursor = markerIndex + 1;
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  if (text[cursor] === "{") {
    const end = findMatchingBrace(text, cursor);
    if (end < 0) return null;
    return {
      value: text.slice(cursor + 1, end),
      start: markerIndex,
      end: end + 1,
    };
  }
  if (text[cursor] === "\\") {
    const command = text.slice(cursor).match(/^\\[A-Za-z]+/u);
    if (!command) return null;
    return {
      value: command[0],
      start: markerIndex,
      end: cursor + command[0].length,
    };
  }
  const atom = text.slice(cursor).match(/^[^\s_^=,;]+/u);
  if (!atom) return null;
  return {
    value: atom[0],
    start: markerIndex,
    end: cursor + atom[0].length,
  };
}

function readOperatorScripts(text, cursor) {
  const scripts = {};
  let index = cursor;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    const marker = text[index];
    if (marker !== "_" && marker !== "^") break;
    const script = readOperatorScript(text, index);
    if (!script) break;
    scripts[marker === "_" ? "lower" : "upper"] = script;
    index = script.end;
  }
  return { ...scripts, end: index };
}

function boundSymbolFromOperatorLower(command = "", lower = "") {
  const variable = String.raw`(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])`;
  const source = String(lower || "").trim();
  if (command === "sum" || command === "prod") {
    const match = source.match(new RegExp(String.raw`^\s*${variable}\s*=`, "iu"));
    return normalizeSymbolName(match?.[1] || "");
  }
  if (command === "lim") {
    const match = source.match(new RegExp(String.raw`^\s*${variable}\s*(?:\\to|\\rightarrow|\\longrightarrow|->)`, "iu"));
    return normalizeSymbolName(match?.[1] || "");
  }
  return "";
}

function topLevelOperatorScopeEnd(text, start) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && !isEscapedAt(text, index)) {
      const command = text.slice(index).match(/^\\[A-Za-z]+/u);
      if (command) {
        index += command[0].length - 1;
        continue;
      }
    }
    if (char === "{" && !isEscapedAt(text, index)) braceDepth += 1;
    else if (char === "}" && !isEscapedAt(text, index)) braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && /[;\n]/u.test(char)) {
      return index;
    }
  }
  return text.length;
}

export function extractBoundSymbolProvenance(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  const bindings = [];
  for (const match of source.matchAll(/\\(sum|prod|lim)(?![A-Za-z])/gu)) {
    const command = match[1];
    const operatorStart = match.index;
    const scripts = readOperatorScripts(source, operatorStart + match[0].length);
    if (!scripts.lower) continue;
    const symbol = boundSymbolFromOperatorLower(command, scripts.lower.value);
    if (!symbol) continue;
    bindings.push({
      command,
      symbol,
      lower: scripts.lower.value.trim(),
      upper: scripts.upper?.value?.trim() || "",
      scopeStart: operatorStart,
      scopeEnd: topLevelOperatorScopeEnd(source, operatorStart),
    });
  }
  return bindings;
}

function symbolOccurrencePattern(symbol = "") {
  if (/^\\[A-Za-z]+$/u.test(symbol)) {
    return new RegExp(`${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gu");
  }
  if (/^[A-Za-z]$/u.test(symbol)) {
    return new RegExp(`(?<![A-Za-z])${symbol}(?![A-Za-z])`, "gu");
  }
  return null;
}

function maskScopedBoundOccurrences(source = "", bindings = []) {
  let output = String(source || "");
  for (const binding of bindings) {
    const pattern = symbolOccurrencePattern(binding.symbol);
    if (!pattern) continue;
    const start = Math.max(0, binding.scopeStart);
    const end = Math.min(output.length, binding.scopeEnd);
    const scoped = output.slice(start, end).replace(pattern, " ");
    output = `${output.slice(0, start)}${scoped}${output.slice(end)}`;
  }
  return output;
}

function collectCommandSymbols(source = "", symbols) {
  for (const match of source.matchAll(/\\([A-Za-z]+)(?:\s*\{([A-Za-z])\})?/g)) {
    const command = match[1];
    if (GREEK_COMMANDS.has(command)) {
      symbols.add(`\\${command}`);
      continue;
    }
    if (["mathbf", "vec", "hat"].includes(command) && match[2]) {
      symbols.add(match[2]);
    }
  }
}

function latexWithoutCommands(source = "") {
  return source
    .replace(/\\(?:mathbf|vec|hat)\s*\{([A-Za-z])\}/g, "$1")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/\\[,;! ]/g, " ");
}

const DERIVATIVE_SYMBOL_PATTERN = String.raw`(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)`;
const DERIVATIVE_ORDER_PATTERN = String.raw`(?:\s*\^\s*(?:\{\s*(?:\d+|[A-Za-z])\s*\}|(?:\d+|[A-Za-z])))?`;
const DERIVATIVE_VARIABLE_PATTERN = String.raw`\\?${DERIVATIVE_SYMBOL_PATTERN}`;
const ORDINARY_DERIVATIVE_FRACTION = new RegExp(
  String.raw`\\frac\s*\{\s*d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\}\s*\{\s*d\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\s*\}`,
  "giu"
);
const PARTIAL_DERIVATIVE_DENOMINATOR = String.raw`(?:\\partial\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\s*){1,4}`;
const PARTIAL_DERIVATIVE_FRACTION = new RegExp(
  String.raw`\\frac\s*\{\s*\\partial${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\}\s*\{\s*${PARTIAL_DERIVATIVE_DENOMINATOR}\}`,
  "giu"
);
const ORDINARY_DERIVATIVE_SLASH = new RegExp(
  String.raw`(^|[^A-Za-z\\])d${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\/\s*d\s*${DERIVATIVE_VARIABLE_PATTERN}${DERIVATIVE_ORDER_PATTERN}\b`,
  "giu"
);
const PARTIAL_DERIVATIVE_SLASH = new RegExp(
  String.raw`(^|[^A-Za-z\\])\\partial${DERIVATIVE_ORDER_PATTERN}\s*${DERIVATIVE_VARIABLE_PATTERN}?\s*\/\s*${PARTIAL_DERIVATIVE_DENOMINATOR}`,
  "giu"
);

function stripDerivativeOperators(source = "") {
  return String(source || "")
    .replace(ORDINARY_DERIVATIVE_FRACTION, " ")
    .replace(PARTIAL_DERIVATIVE_FRACTION, " ")
    .replace(ORDINARY_DERIVATIVE_SLASH, "$1 ")
    .replace(PARTIAL_DERIVATIVE_SLASH, "$1 ")
    .replace(/\\partial\s*\/\s*\\partial\s*\\?(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu, " ");
}

export function extractBoundSymbols(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  const bound = new Set();
  for (const match of source.matchAll(/(?:^|[^A-Za-z\\])d\s*\\(?:mathbf|vec|hat)\s*\{?([A-Za-z])\}?/gu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const match of source.matchAll(/(?:^|[^A-Za-z\\])d\s*\\?([A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const match of source.matchAll(/\\partial\s*\/\s*\\partial\s*\\?([A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
  for (const binding of extractBoundSymbolProvenance(source)) bound.add(binding.symbol);
  return bound;
}

export function extractExplicitDefinitions(latex = "") {
  const source = stripTextCommands(normalizeUnicodeSymbols(latex))
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, " ")
    .replace(/\\(?:quad|qquad|,|;|!| )/g, " ")
    .replace(/&/g, "");
  const definitions = new Set();
  for (const match of source.matchAll(/(?:^|[;\n])\s*(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|\\(?:mathbf|vec|hat)\s*\{?[A-Za-z]\}?|[A-Za-z])\s*\(\s*([A-Za-z])\s*\)\s*=/giu)) {
    definitions.add(normalizeSymbolName(match[1]));
    definitions.add(normalizeSymbolName(match[2]));
  }
  for (const match of source.matchAll(/(?:^|[;\n,]|\b(?:with|and|where)\s+)\s*(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|\\(?:mathbf|vec|hat)\s*\{?[A-Za-z]\}?|[A-Za-z])\s*(?:=|:)/giu)) {
    definitions.add(normalizeSymbolName(match[1]));
  }
  return definitions;
}

function extractSubstitutionIntroducedSymbols(latex = "") {
  const source = stripTextCommands(normalizeUnicodeSymbols(latex))
    .replace(/\\(?:begin|end)\s*\{[^{}]*\}/g, " ")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(?:quad|qquad|,|;|!| )/g, " ")
    .replace(/&/g, "");
  const definitions = new Set();
  const variablePattern = String.raw`(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])`;
  const relationPattern = new RegExp(
    String.raw`(?:^|[;\n,])\s*${variablePattern}\s*=\s*\\?(?:tan|sin|cos|sec|cot|ln|log|exp)\s*(?:\{\s*${variablePattern}\s*\}|\(\s*${variablePattern}\s*\)|\s+${variablePattern}\b|${variablePattern}\b)`,
    "giu"
  );
  for (const match of source.matchAll(relationPattern)) {
    const introduced = match[2] || match[3] || match[4] || match[5];
    if (introduced) definitions.add(normalizeSymbolName(introduced));
  }
  return definitions;
}

function unionSets(...sets) {
  const result = new Set();
  for (const set of sets) {
    for (const item of set || []) result.add(item);
  }
  return result;
}

const FULL_STEP_MATH_SOURCE_TYPES = new Set(["math", "latex", "equationLatex"]);
const PRESENTATION_FRAGMENT_SOURCE_TYPES = new Set([
  "label",
  "title",
  "heading",
  "summary",
  "reasoning",
  "plainExplanation",
  "lines[].latex",
  "lines[].math",
  "lines[].equationLatex",
]);

function compactForContainment(value = "") {
  return String(value || "").replace(/\s+/g, "");
}

function canInheritBoundSymbolFromStepMath(fieldReport = {}, contextReport = {}, symbol = "") {
  if (!PRESENTATION_FRAGMENT_SOURCE_TYPES.has(fieldReport.sourceType)) return false;
  if (!FULL_STEP_MATH_SOURCE_TYPES.has(contextReport.sourceType)) return false;
  if (fieldReport.stepIndex === null || fieldReport.stepIndex !== contextReport.stepIndex) return false;
  if (contextReport.unexplainedSymbols.includes(symbol)) return false;
  if (!contextReport.symbols.some((item) => item.symbol === symbol && item.classification === "bound_locally")) {
    return false;
  }
  const fieldValue = compactForContainment(fieldReport.value);
  const contextValue = compactForContainment(contextReport.value);
  return Boolean(fieldValue && contextValue.includes(fieldValue));
}

function applyStepMathBoundContext(fieldReports = []) {
  const fullStepMathReports = fieldReports.filter((field) => FULL_STEP_MATH_SOURCE_TYPES.has(field.sourceType));
  for (const fieldReport of fieldReports) {
    if (!PRESENTATION_FRAGMENT_SOURCE_TYPES.has(fieldReport.sourceType)) continue;
    const unexplainedSymbols = new Set(fieldReport.unexplainedSymbols);
    if (unexplainedSymbols.size === 0) continue;
    for (const symbol of [...unexplainedSymbols]) {
      const context = fullStepMathReports.find((candidate) => (
        canInheritBoundSymbolFromStepMath(fieldReport, candidate, symbol)
      ));
      if (!context) continue;
      unexplainedSymbols.delete(symbol);
      fieldReport.symbols = fieldReport.symbols.map((item) => (
        item.symbol === symbol && item.classification === "unexplained"
          ? {
              ...item,
              classification: "bound_by_step_math_context",
              contextFieldPath: context.fieldPath,
            }
          : item
      ));
    }
    fieldReport.unexplainedSymbols = [...unexplainedSymbols];
  }
}

export function extractSymbolInventory(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  const sourceWithoutDifferentials = source
    .replace(/(^|[^A-Za-z\\])d\s*\\(?:mathbf|vec|hat)\s*\{?[A-Za-z]\}?/gu, "$1 ")
    .replace(/(^|[^A-Za-z\\])d\s*\\?(?:[A-Za-z]|alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)\b/giu, "$1 ");
  const symbols = new Set();
  collectCommandSymbols(source, symbols);

  const commandless = latexWithoutCommands(sourceWithoutDifferentials)
    .replace(/\b(?:sin|cos|tan|sec|csc|cot|ln|log|exp|sqrt|frac|int|sum|lim)\b/giu, " ")
    .replace(/\b(?:dx|dy|dz|dt|du|dv|dw|dr|dV|dA|dS)\b/gu, " ");
  for (const match of commandless.matchAll(/(?<![A-Za-z])([A-Za-z])(?![A-Za-z])/gu)) {
    symbols.add(normalizeSymbolName(match[1]));
  }
  for (const symbol of extractBoundSymbols(source)) symbols.add(symbol);
  return symbols;
}

function extractFreeSymbolInventory(latex = "") {
  const source = stripDerivativeOperators(stripTextCommands(normalizeUnicodeSymbols(latex)));
  return extractSymbolInventory(maskScopedBoundOccurrences(source, extractBoundSymbolProvenance(source)));
}

function isContextualStandardSymbol(symbol = "", fieldValue = "") {
  if (!["P", "Q", "R"].includes(symbol)) return false;
  return /(?:\\nabla\s*\\times|curl|\\langle[\s\S]*(?:P|Q|R)_[xyz][\s\S]*\\rangle)/u.test(fieldValue);
}

function isIndexedSymbolOccurrence(symbol = "", fieldValue = "") {
  if (!/^[A-Za-z]$/u.test(symbol)) return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z])${escaped}\\s*_\\s*(?:\\{|[A-Za-z0-9]|\\\\[A-Za-z]+)`, "u")
    .test(fieldValue);
}

function isStandardSymbolInField(symbol = "", fieldValue = "") {
  if (!STANDARD_SYMBOLS.has(symbol)) return false;
  if (symbol === "C" && isIndexedSymbolOccurrence(symbol, fieldValue)) return false;
  return true;
}

export function analyzeSymbolOrigins(problem = "", result = {}) {
  const originalSymbols = extractSymbolInventory(problem);
  const fields = collectGeneratedMath(result);
  const explicitDefinitionsSeen = new Set();
  const allExplicitDefinitions = new Set();
  const generatedSymbols = new Set();
  const fieldReports = [];

  for (const field of fields) {
    const boundSymbolProvenance = extractBoundSymbolProvenance(field.value);
    const scopedBoundSymbols = new Set(boundSymbolProvenance.map((binding) => binding.symbol));
    const freeSymbols = extractFreeSymbolInventory(field.value);
    const fieldSymbols = unionSets(
      freeSymbols,
      new Set(boundSymbolProvenance.map((binding) => binding.symbol))
    );
    const boundSymbols = unionSets(
      extractBoundSymbols(field.value),
      new Set(boundSymbolProvenance.map((binding) => binding.symbol))
    );
    const fieldDefinitions = unionSets(
      extractExplicitDefinitions(field.value),
      extractSubstitutionIntroducedSymbols(field.value)
    );
    for (const symbol of fieldDefinitions) allExplicitDefinitions.add(symbol);
    const symbols = [];
    for (const symbol of fieldSymbols) {
      generatedSymbols.add(symbol);
      let classification = "unexplained";
      if (originalSymbols.has(symbol)) classification = "present_in_original_problem";
      else if (fieldDefinitions.has(symbol) || explicitDefinitionsSeen.has(symbol)) classification = "explicitly_introduced";
      else if (
        isStandardSymbolInField(symbol, field.value)
        || FUNCTION_OR_OPERATOR_COMMANDS.has(symbol.replace(/^\\/, ""))
        || isContextualStandardSymbol(symbol, field.value)
      ) {
        classification = "standard_constant_or_operator";
      } else if (boundSymbols.has(symbol) && (!scopedBoundSymbols.has(symbol) || !freeSymbols.has(symbol))) {
        classification = "bound_locally";
      }
      symbols.push({ symbol, classification });
    }
    fieldReports.push({
      ...field,
      boundSymbolProvenance,
      symbols,
      unexplainedSymbols: symbols
        .filter((item) => item.classification === "unexplained")
        .map((item) => item.symbol),
    });
    for (const symbol of fieldDefinitions) explicitDefinitionsSeen.add(symbol);
  }

  // Presentation slices from prose inline math or generated line fragments can
  // lose the operator that binds an index in the same step's full math field.
  // They may inherit only that local binding, never definitions or constants.
  applyStepMathBoundContext(fieldReports);

  const newlyIntroducedSymbols = [...generatedSymbols].filter((symbol) => !originalSymbols.has(symbol));
  const unexplainedSymbols = [...new Set(fieldReports.flatMap((field) => field.unexplainedSymbols))];

  return {
    originalSymbols: [...originalSymbols].sort(),
    generatedSymbols: [...generatedSymbols].sort(),
    newlyIntroducedSymbols: newlyIntroducedSymbols.sort(),
    explicitDefinitions: [...allExplicitDefinitions].sort(),
    fieldReports,
    boundSymbolProvenance: fieldReports.flatMap((field) => (
      field.boundSymbolProvenance.map((binding) => ({
        ...binding,
        fieldPath: field.fieldPath,
      }))
    )),
    unexplainedSymbols: unexplainedSymbols.sort(),
  };
}
