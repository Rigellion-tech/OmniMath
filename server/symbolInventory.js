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
  for (const match of source.matchAll(/\\sum_\{?\s*([A-Za-z])\s*=/gu)) {
    bound.add(normalizeSymbolName(match[1]));
  }
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
  for (const match of source.matchAll(/(?:^|[;\n,])\s*(\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|\\(?:mathbf|vec|hat)\s*\{?[A-Za-z]\}?|[A-Za-z])\s*(?:=|:)/giu)) {
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

function isContextualStandardSymbol(symbol = "", fieldValue = "") {
  if (!["P", "Q", "R"].includes(symbol)) return false;
  return /(?:\\nabla\s*\\times|curl|\\langle[\s\S]*(?:P|Q|R)_[xyz][\s\S]*\\rangle)/u.test(fieldValue);
}

export function analyzeSymbolOrigins(problem = "", result = {}) {
  const originalSymbols = extractSymbolInventory(problem);
  const fields = collectGeneratedMath(result);
  const explicitDefinitionsSeen = new Set();
  const allExplicitDefinitions = new Set();
  const generatedSymbols = new Set();
  const fieldReports = [];

  for (const field of fields) {
    const fieldSymbols = extractSymbolInventory(field.value);
    const boundSymbols = extractBoundSymbols(field.value);
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
      else if (boundSymbols.has(symbol)) classification = "bound_locally";
      else if (fieldDefinitions.has(symbol) || explicitDefinitionsSeen.has(symbol)) classification = "explicitly_introduced";
      else if (
        STANDARD_SYMBOLS.has(symbol)
        || FUNCTION_OR_OPERATOR_COMMANDS.has(symbol.replace(/^\\/, ""))
        || isContextualStandardSymbol(symbol, field.value)
      ) {
        classification = "standard_constant_or_operator";
      }
      symbols.push({ symbol, classification });
    }
    fieldReports.push({
      ...field,
      symbols,
      unexplainedSymbols: symbols
        .filter((item) => item.classification === "unexplained")
        .map((item) => item.symbol),
    });
    for (const symbol of fieldDefinitions) explicitDefinitionsSeen.add(symbol);
  }

  const newlyIntroducedSymbols = [...generatedSymbols].filter((symbol) => !originalSymbols.has(symbol));
  const unexplainedSymbols = [...new Set(fieldReports.flatMap((field) => field.unexplainedSymbols))];

  return {
    originalSymbols: [...originalSymbols].sort(),
    generatedSymbols: [...generatedSymbols].sort(),
    newlyIntroducedSymbols: newlyIntroducedSymbols.sort(),
    explicitDefinitions: [...allExplicitDefinitions].sort(),
    fieldReports,
    unexplainedSymbols: unexplainedSymbols.sort(),
  };
}
