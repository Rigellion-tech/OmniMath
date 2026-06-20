import { normalizeLatexForKatex, normalizeLatexTransport, shouldPreserveLatex, traceMathStage } from "./mathNode.js";

const GREEK_COMMANDS = new Map([
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["delta", "\\delta"],
  ["epsilon", "\\epsilon"],
  ["theta", "\\theta"],
  ["phi", "\\phi"],
  ["rho", "\\rho"],
  ["pi", "\\pi"],
  ["lambda", "\\lambda"],
  ["mu", "\\mu"],
  ["sigma", "\\sigma"],
  ["omega", "\\omega"],
]);

const GREEK_LABELS = new Map([
  ["\\theta", "theta"],
  ["\\phi", "phi"],
  ["\\rho", "rho"],
  ["\\pi", "pi"],
  ["\\alpha", "alpha"],
  ["\\beta", "beta"],
  ["\\gamma", "gamma"],
  ["\\delta", "delta"],
  ["\\lambda", "lambda"],
  ["\\mu", "mu"],
  ["\\sigma", "sigma"],
  ["\\omega", "omega"],
]);

const FUNCTION_NAMES = new Set([
  "arcsin",
  "arccos",
  "arctan",
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
  "lim",
  "max",
  "min",
]);

const SORTED_FUNCTION_NAMES = [...FUNCTION_NAMES].sort((left, right) => right.length - left.length);
const FUNCTION_NAME_PATTERN = SORTED_FUNCTION_NAMES.join("|");
const DIFFERENTIAL_WORD_PATTERN = "theta|phi|rho|alpha|beta|gamma|delta|lambda|mu|sigma|omega|[a-zA-Z]";
const INTEGRAL_COMMAND_PATTERN = /^\\(?:iiint|iint|oint|int)/;
const SQUISHED_PROSE_REPLACEMENTS = new Map([
  ["sphericalsymmetry", "spherical symmetry"],
  ["rotationallysymmetric", "rotationally symmetric"],
  ["sphericalcoordinates", "spherical coordinates"],
  ["productrule", "product rule"],
  ["chainrule", "chain rule"],
  ["powerrule", "power rule"],
  ["dsointegrandbecomes", "so the integrand becomes"],
  ["sointegrandbecomes", "so the integrand becomes"],
  ["isthesolidregioninside", "is the solid region inside"],
  ["isthesolidregioninsi de", "is the solid region inside"],
  ["solidregioninside", "solid region inside"],
  ["solidregioninsi de", "solid region inside"],
  ["cosine", "cosine"],
]);

const explanationCache = new Map();

export function hierarchicalTokensEnabled(override) {
  if (override !== undefined) return override !== false && override !== "false";
  const viteFlag = typeof import.meta !== "undefined" ? import.meta.env?.VITE_ENABLE_HIERARCHICAL_TOKENS : undefined;
  const processFlag = globalThis.process?.env?.VITE_ENABLE_HIERARCHICAL_TOKENS;
  const flag = viteFlag ?? processFlag;
  return flag === undefined || flag === "" || flag === "true" || flag === true;
}

function cleanIdPart(value) {
  return String(value || "token")
    .replace(/\\/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    || "token";
}

function stripOuter(value, open = "{", close = "}") {
  const text = String(value || "").trim();
  if (!text.startsWith(open) || !text.endsWith(close)) return text;

  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0 && index < text.length - 1) return text;
  }

  return text.slice(1, -1).trim();
}

function stripWrapping(value) {
  let text = String(value || "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    const unbraced = stripOuter(text, "{", "}");
    if (unbraced !== text) {
      text = unbraced;
      changed = true;
      continue;
    }
    const unparened = stripOuter(text, "(", ")");
    if (unparened !== text) {
      text = unparened;
      changed = true;
    }
  }
  return text;
}

function readBraced(text, startIndex) {
  if (text[startIndex] !== "{") return null;
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return {
        value: text.slice(startIndex + 1, index),
        endIndex: index + 1,
      };
    }
  }
  return null;
}

function readParenthesized(text, startIndex) {
  if (text[startIndex] !== "(") return null;
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0) {
      return {
        value: text.slice(startIndex + 1, index),
        endIndex: index + 1,
      };
    }
  }
  return null;
}

function normalizeSqrt(text) {
  let output = text;
  let index = output.search(/sqrt\s*\(/i);
  while (index !== -1) {
    const openIndex = output.indexOf("(", index);
    const group = readParenthesized(output, openIndex);
    if (!group) break;
    output = `${output.slice(0, index)}\\sqrt{${group.value}}${output.slice(group.endIndex)}`;
    index = output.search(/sqrt\s*\(/i);
  }
  return output;
}

function normalizeEscapedLatexInput(value = "") {
  let text = String(value || "");
  let previous = "";

  while (text !== previous) {
    previous = text;
    text = text
      .replace(/\\\\(?=([a-zA-Z]+|[,;!]))/g, "\\")
      .replace(/\\\\(?=[{}_^])/g, "\\");
  }

  return text
    .replace(/∭/g, "\\iiint")
    .replace(/∬/g, "\\iint")
    .replace(/∮/g, "\\oint")
    .replace(/∫/g, "\\int")
    .replace(/∇/g, "\\nabla")
    .replace(/×/g, "\\times")
    .replace(/·/g, "\\cdot")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/π/g, "\\pi");
}

function normalizeLatexFunctionSpacing(text) {
  let output = String(text || "");
  for (const name of SORTED_FUNCTION_NAMES) {
    output = output
      .replace(new RegExp(`\\\\${name}(?=([a-zA-Z0-9]))`, "g"), `\\${name} `)
      .replace(new RegExp(`(?<!\\\\)\\b${name}(?=([a-zA-Z0-9]))`, "gi"), `${name} `);
  }
  return output;
}

function normalizeTextCommandContent(value = "") {
  let text = String(value || "")
    .replace(/\\[,;!]/g, " ")
    .replace(/\\quad/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [squished, readable] of SQUISHED_PROSE_REPLACEMENTS) {
    text = text.replace(new RegExp(squished, "gi"), readable);
  }

  if (/^(and|where)$/i.test(text)) return `${text.toLowerCase()} `;
  if (/^is the\b/i.test(text)) return ` ${text} `;
  return text;
}

function spaceAfterTextCommands(value = "") {
  return String(value || "").replace(/\\text\{([^}]*\s)\}(?=[A-Za-z0-9\\])/g, "\\text{$1} ");
}

function normalizeLatexSpacingCommands(value = "") {
  return String(value || "").replace(/\\\s+(?=\S)/g, "\\,");
}

function protectTextCommands(value = "") {
  let text = String(value || "");
  const replacements = [];
  let index = text.indexOf("\\text{");

  while (index !== -1) {
    const braced = readBraced(text, index + "\\text".length);
    if (!braced) break;
    const placeholder = `@@OMNI_TEXT_${replacements.length}@@`;
    replacements.push(`\\text{${normalizeTextCommandContent(braced.value)}}`);
    text = `${text.slice(0, index)}${placeholder}${text.slice(braced.endIndex)}`;
    index = text.indexOf("\\text{", index + placeholder.length);
  }

  return {
    text,
    restore(output = "") {
      return replacements.reduce(
        (current, replacement, replacementIndex) => current.replace(`@@OMNI_TEXT_${replacementIndex}@@`, replacement),
        String(output || "")
      );
    },
  };
}

export function normalizeDisplayText(value = "") {
  let text = normalizeEscapedLatexInput(value)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\\quad/g, " ")
    .replace(/\\,/g, " ")
    .trim();

  for (const [squished, readable] of SQUISHED_PROSE_REPLACEMENTS) {
    text = text.replace(new RegExp(`\\b${squished}\\b`, "gi"), readable);
  }

  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMathText(value = "") {
  const protectedText = protectTextCommands(normalizeEscapedLatexInput(value));
  let text = protectedText.text
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = normalizeSqrt(text);
  text = normalizeLatexFunctionSpacing(text);
  text = text
    .replace(/\bintegral\b/gi, "\\int")
    .replace(/≤|<=/g, "\\le")
    .replace(/≥|>=/g, "\\ge")
    .replace(/→/g, "\\to")
    .replace(/√\s*\(([^)]+)\)/g, "\\sqrt{$1}")
    .replace(/√\s*([a-zA-Z0-9]+)/g, "\\sqrt{$1}")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/π/g, "\\pi")
    .replace(/\\([xyz])\b/g, "$1")
    .replace(/\\mathbf\s*([A-Za-z])/g, "\\mathbf{$1}");

  for (const [word, command] of GREEK_COMMANDS) {
    text = text.replace(new RegExp(`(?<!\\\\)\\b${word}\\b`, "gi"), command);
  }

  text = normalizeLatexSpacingCommands(text.replace(/\^\(([^)]+)\)/g, "^{$1}"));
  return spaceAfterTextCommands(protectedText.restore(text.replace(/\s+/g, "")));
}

function displayText(latex) {
  return String(latex || "")
    .replace(/\\le/g, "≤")
    .replace(/\\ge/g, "≥")
    .replace(/\\to/g, "→")
    .replace(/\\cdot/g, "·")
    .replace(/\\times/g, "×")
    .replace(/\\iint/g, "∬")
    .replace(/\\iiint/g, "∭")
    .replace(/\\oint/g, "∮")
    .replace(/\\int/g, "∫")
    .replace(/\\sqrt/g, "√")
    .replace(/\\frac/g, "fraction")
    .replace(/\\([a-zA-Z]+)/g, (match) => GREEK_LABELS.get(match) || match.slice(1))
    .replace(/[{}]/g, "");
}

function readFunctionArgument(text, startIndex) {
  if (!text.slice(startIndex)) return null;

  if (text[startIndex] === "{") return readBraced(text, startIndex);
  if (text[startIndex] === "(") return readParenthesized(text, startIndex);
  if (text[startIndex] === "\\") {
    const command = text.slice(startIndex).match(/^\\[a-zA-Z]+/);
    if (command) {
      return {
        value: command[0],
        endIndex: startIndex + command[0].length,
      };
    }
  }
  if (/^[a-zA-Z0-9]/.test(text[startIndex])) {
    const powerMatch = text.slice(startIndex).match(/^[a-zA-Z0-9](\^\{[^}]+\}|\^[a-zA-Z0-9])?/);
    return {
      value: powerMatch?.[0] || text[startIndex],
      endIndex: startIndex + (powerMatch?.[0]?.length || 1),
    };
  }

  return null;
}

function readKnownFunctionCall(text) {
  const normalized = stripWrapping(text);
  const commandMatch = normalized.match(/^\\([a-zA-Z]+)(.*)$/);
  if (commandMatch && FUNCTION_NAMES.has(commandMatch[1])) {
    const argument = readFunctionArgument(normalized, commandMatch[1].length + 1);
    if (!argument) {
      return {
        token: normalized,
        name: `\\${commandMatch[1]}`,
        argument: "",
        endIndex: commandMatch[1].length + 1,
      };
    }

    return {
      token: normalized.slice(0, argument.endIndex),
      name: `\\${commandMatch[1]}`,
      argument: argument.value,
      endIndex: argument.endIndex,
    };
  }
  if (commandMatch) {
    const splitName = SORTED_FUNCTION_NAMES.find((name) => (
      commandMatch[1].startsWith(name)
      && commandMatch[1].length > name.length
    ));
    if (splitName) {
      const argumentText = `${commandMatch[1].slice(splitName.length)}${commandMatch[2] || ""}`;
      const argument = readFunctionArgument(argumentText, 0);
      if (argument) {
        return {
          token: `\\${splitName}${argument.value}`,
          name: `\\${splitName}`,
          argument: argument.value,
          endIndex: splitName.length + 1 + argument.endIndex,
        };
      }
    }
  }

  const functionName = SORTED_FUNCTION_NAMES.find((name) => normalized.startsWith(name));
  if (!functionName) return null;
  const argument = readFunctionArgument(normalized, functionName.length);
  if (!argument) return null;

  return {
    token: normalized.slice(0, argument.endIndex),
    name: `\\${functionName}`,
    argument: argument.value,
    endIndex: argument.endIndex,
  };
}

function inferConceptIds(role, latex) {
  const concepts = [];
  if (/\\theta|\\phi|\\rho|\\sin|\\cos|\\tan/.test(latex)) concepts.push("spherical-coordinates");
  if (/\\le|\\ge|=|<|>/.test(latex) || role === "bound") concepts.push("bounds");
  if (/2\\pi|\\pi/.test(latex)) concepts.push("symmetry");
  return concepts;
}

function explainToken(role, latex, expressionKey) {
  const key = `${expressionKey}:${latex}:${role}`;
  if (explanationCache.has(key)) return explanationCache.get(key);

  const plain = displayText(latex);
  let short = "Math token";
  let medium = `${plain} is a meaningful part of this expression.`;
  let deep = `${plain} helps determine how this step is interpreted in the solution.`;

  if (role === "bound") {
    short = "Complete bound";
    medium = `${plain} gives the full interval or constraint used in this step.`;
    deep = "A bound combines endpoints, variables, and comparison symbols to describe exactly which values are allowed.";
  } else if (role === "operator") {
    short = latex.includes("le") || latex === "≤" ? "Inequality relation" : "Operator";
    medium = `${plain} shows the relationship between neighboring quantities.`;
    deep = "Operators and relation symbols tell the solver how adjacent expressions are connected.";
  } else if (role === "variable") {
    short = `${plain} variable`;
    medium = `${plain} is a variable whose value changes within the problem.`;
    deep = "Variables represent unknowns, coordinates, or quantities that the solution tracks symbolically.";
    if (/theta/i.test(plain)) medium = "Theta is the angular coordinate around the z-axis.";
    if (/phi/i.test(plain)) medium = "Phi is the polar angle measured down from the positive z-axis.";
    if (/rho/i.test(plain)) medium = "Rho is the radial distance from the origin.";
  } else if (role === "constant") {
    short = `${plain} constant`;
    medium = `${plain} is a fixed value in this expression.`;
    deep = "Constants set exact endpoints, coefficients, or known quantities in a formula.";
    if (/pi/i.test(plain)) medium = "Pi is the circle constant used for angular measure in radians.";
  } else if (role === "coefficient") {
    short = "Coefficient";
    medium = `${plain} scales the variable or factor attached to it.`;
    deep = "A coefficient multiplies a neighboring variable or expression, setting how strongly that part contributes to the term.";
  } else if (role === "power") {
    short = "Power expression";
    medium = `${plain} uses an exponent to show repeated multiplication or growth.`;
    deep = "The base is the quantity being raised, and the exponent controls the power applied to it.";
  } else if (role === "exponent") {
    short = "Exponent";
    medium = `${plain} is the exponent applied to the base.`;
    deep = "An exponent changes the degree or repeated-multiplication structure of the base.";
  } else if (role === "radical") {
    short = "Radical";
    medium = `${plain} represents a square-root quantity.`;
    deep = "Radicals introduce root expressions, often from geometry, distance, or inverse power operations.";
  } else if (role === "fraction") {
    short = "Fraction";
    medium = `${plain} is a quotient with a numerator divided by a denominator.`;
    deep = "Fractions encode division, ratios, or solved forms where one quantity is scaled by another.";
  } else if (role === "function") {
    short = "Function";
    medium = `${plain} applies a function to an input quantity.`;
    deep = "Function notation tells us a rule is being evaluated at a particular argument.";
  } else if (role === "differential") {
    short = "Differential";
    medium = `${plain} tells which variable is being integrated or measured infinitesimally.`;
    deep = "Differentials specify the integration variable and the order of integration in multiple integrals.";
  } else if (role === "differential_group") {
    short = "Differential group";
    medium = `${plain} gives the group of differentials in this expression.`;
    deep = "A differential group identifies the variables and order used by a product of infinitesimal integration elements.";
  } else if (role === "integral") {
    short = "Integral";
    medium = `${plain} accumulates the integrand over the stated domain or variable.`;
    deep = "The integral sign, domain, integrand, and differential work together to describe what is being accumulated and where.";
  } else if (role === "domain") {
    short = "Domain";
    medium = `${plain} names the region or set over which the operation is performed.`;
    deep = "A domain label restricts the expression to a specific curve, surface, region, interval, or event space.";
  } else if (role === "vector_operation") {
    short = "Vector operation";
    medium = `${plain} combines vector quantities with an operation such as curl, dot product, or cross product.`;
    deep = "Vector operations encode geometric interaction between fields, directions, and oriented pieces of space.";
  } else if (role === "product") {
    short = "Product structure";
    medium = `${plain} is built from multiplied factors.`;
    deep = "Products combine factors, so each factor can influence size, sign, or geometric scaling.";
    if (/2\\pi/.test(latex)) {
      short = "Full rotation";
      medium = "2 pi radians is one complete rotation around an axis.";
      deep = "A full circle measures 2 pi radians, so this often marks a complete angular sweep.";
    }
  } else if (role === "sum") {
    short = "Sum structure";
    medium = `${plain} combines terms by addition or subtraction.`;
    deep = "Sums collect separate contributions that are evaluated together in the expression.";
  } else if (role === "factor") {
    short = "Factor";
    medium = `${plain} is one multiplied factor in the expression.`;
    deep = "A factor is a grouped piece of a product; changing one factor changes the whole product.";
  }

  const explanation = { short, medium, deep };
  explanationCache.set(key, explanation);
  return explanation;
}

function createNode({ latex, role, idPrefix, index, start = 0, end = null, expressionKey, children = [] }) {
  const normalizedLatex = normalizeMathValue(latex);
  const explanation = explainToken(role, normalizedLatex, expressionKey);
  const id = `${idPrefix}-${index}-${cleanIdPart(normalizedLatex || role)}`;
  const sourceEnd = end ?? start + normalizedLatex.length;
  return {
    id,
    kind: role,
    rawText: String(latex ?? ""),
    text: displayText(normalizedLatex),
    latex: normalizedLatex,
    display: normalizedLatex,
    role,
    start,
    end: sourceEnd,
    sourceRange: { start, end: sourceEnd },
    explanationId: `${id}:explanation`,
    explanation: explanation.medium,
    short: explanation.short,
    medium: explanation.medium,
    deep: explanation.deep,
    children,
    conceptIds: inferConceptIds(role, normalizedLatex),
    relatedTokenIds: [],
  };
}

function splitTopLevelRelations(text) {
  const pieces = [];
  let depth = 0;
  let tokenStart = 0;
  const operators = ["\\le", "\\ge", "<=", ">=", "≤", "≥", "=", "<", ">"];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth !== 0) continue;

    const operator = operators.find((item) => {
      if (!text.startsWith(item, index)) return false;
      if (item.startsWith("\\") && /[A-Za-z]/.test(text[index + item.length] || "")) return false;
      return true;
    });
    if (!operator) continue;

    if (tokenStart < index) pieces.push({ type: "expr", value: text.slice(tokenStart, index), start: tokenStart });
    pieces.push({ type: "operator", value: operator, start: index });
    index += operator.length - 1;
    tokenStart = index + 1;
  }

  if (pieces.length > 0 && tokenStart < text.length) {
    pieces.push({ type: "expr", value: text.slice(tokenStart), start: tokenStart });
  }
  return pieces;
}

function splitTopLevelAddends(text) {
  const pieces = [];
  let depth = 0;
  let tokenStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth !== 0 || index === 0) continue;
    if (char !== "+" && char !== "-") continue;
    if (text[index - 1] === "^") continue;
    if (tokenStart < index) pieces.push({ type: "expr", value: text.slice(tokenStart, index), start: tokenStart });
    pieces.push({ type: "operator", value: char, start: index });
    tokenStart = index + 1;
  }
  if (pieces.length > 0 && tokenStart < text.length) {
    pieces.push({ type: "expr", value: text.slice(tokenStart), start: tokenStart });
  }
  return pieces;
}

function nodesForAdditiveExpression(text, idPrefix, expressionKey, depth) {
  const addends = splitTopLevelAddends(text);
  if (addends.length === 0) return [];

  return addends.map((piece, index) => (
    piece.type === "operator"
      ? createNode({ latex: piece.value, role: "operator", idPrefix, index, start: piece.start, expressionKey })
      : parseNode(piece.value, "other", idPrefix, index, piece.start, expressionKey, depth + 1)
  ));
}

function splitTopLevelProducts(text) {
  const pieces = [];
  let depth = 0;
  let tokenStart = 0;
  let pendingSeparator = "";
  const separators = ["\\,", "\\;", "\\cdot", "·"];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth !== 0) continue;

    const separator = separators.find((item) => text.startsWith(item, index));
    if (!separator) continue;
    if (tokenStart < index) pieces.push({ value: text.slice(tokenStart, index), start: tokenStart, separator: pendingSeparator });
    pendingSeparator = separator;
    index += separator.length - 1;
    tokenStart = index + 1;
  }

  if (pieces.length > 0 && tokenStart < text.length) {
    pieces.push({ value: text.slice(tokenStart), start: tokenStart, separator: pendingSeparator });
  }

  return pieces;
}

function compactStructuralLatex(value = "") {
  const text = String(value || "").replace(/\\\s+/g, "\\,");
  if (/\\text\{/.test(text)) return text;
  return text
    .replace(/\s+/g, "")
    .replace(/\\(langle|rangle)(?=[A-Za-z0-9])/g, "\\$1 ")
    .replace(/\\(times|cdot)(?=[A-Za-z0-9\\])/g, "\\$1 ");
}

function splitTopLevelVectorOperations(text) {
  const pieces = [];
  let depth = 0;
  let tokenStart = 0;
  const operators = ["\\times"];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth !== 0) continue;

    const operator = operators.find((item) => text.startsWith(item, index));
    if (!operator) continue;
    if (tokenStart < index) pieces.push({ type: "expr", value: text.slice(tokenStart, index), start: tokenStart });
    pieces.push({ type: "operator", value: operator, start: index });
    index += operator.length - 1;
    tokenStart = index + 1;
  }

  if (pieces.length > 0 && tokenStart < text.length) {
    pieces.push({ type: "expr", value: text.slice(tokenStart), start: tokenStart });
  }

  return pieces;
}

function splitAdjacentMathTokens(text) {
  const patterns = [
    /^\\[a-zA-Z]+\^\{[^}]+\}/,
    /^\\[a-zA-Z]+\^[a-zA-Z0-9]/,
    /^d\\[a-zA-Z]+/,
    new RegExp(`^d(?:${DIFFERENTIAL_WORD_PATTERN})`),
    /^\\sqrt\{[^}]+\}/,
    /^\\[a-zA-Z]+/,
    /^[0-9]+(\.[0-9]+)?/,
    /^[a-zA-Z]\^\{[^}]+\}/,
    /^[a-zA-Z]\^[a-zA-Z0-9]/,
    /^[a-zA-Z]/,
  ];
  const pieces = [];
  let rest = text;
  let offset = 0;

  while (rest.length > 0) {
    if (/^[{}()[\]+\-<>=]/.test(rest)) return [];
    const functionCall = readKnownFunctionCall(rest);
    if (functionCall) {
      pieces.push({ value: functionCall.token, start: offset });
      rest = rest.slice(functionCall.endIndex);
      offset += functionCall.endIndex;
      continue;
    }

    const match = patterns.map((pattern) => rest.match(pattern)).find(Boolean);
    if (!match) return [];
    pieces.push({ value: match[0], start: offset });
    rest = rest.slice(match[0].length);
    offset += match[0].length;
  }

  return pieces.length > 1 ? pieces : [];
}

function splitImplicitFactorSequence(text) {
  const pieces = [];
  let offset = 0;

  while (offset < text.length) {
    const rest = text.slice(offset);
    let token = null;
    let endIndex = 0;

    if (rest[0] === "(") {
      const group = readParenthesized(rest, 0);
      if (!group) return [];
      token = rest.slice(0, group.endIndex);
      endIndex = group.endIndex;
    } else {
      const functionCall = readKnownFunctionCall(rest);
      if (functionCall) {
        token = functionCall.token;
        endIndex = functionCall.endIndex;
      } else {
        const match = [
          /^\\[a-zA-Z]+\^\{[^}]+\}/,
          /^\\[a-zA-Z]+\^[a-zA-Z0-9]/,
          /^d\\[a-zA-Z]+/,
          new RegExp(`^d(?:${DIFFERENTIAL_WORD_PATTERN})`),
          /^\\sqrt\{[^}]+\}/,
          /^\\[a-zA-Z]+/,
          /^[0-9]+(\.[0-9]+)?/,
          /^[a-zA-Z]\^\{[^}]+\}/,
          /^[a-zA-Z]\^[a-zA-Z0-9]/,
          /^[a-zA-Z]/,
        ].map((pattern) => rest.match(pattern)).find(Boolean);
        if (!match) return [];
        token = match[0];
        endIndex = match[0].length;
      }
    }

    pieces.push({ value: token, start: offset });
    offset += endIndex;
  }

  return pieces.length > 1 ? pieces : [];
}

function splitParentheticalFactors(text) {
  const factors = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "(") return [];
    const group = readParenthesized(text, index);
    if (!group) return [];
    factors.push({ value: text.slice(index, group.endIndex), inner: group.value, start: index });
    index = group.endIndex;
  }
  return factors.length > 1 ? factors : [];
}

function findPowerSplit(text) {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth === 0 && char === "^" && index > 0) {
      const exponent = text[index + 1] === "{"
        ? readBraced(text, index + 1)
        : { value: text[index + 1] || "", endIndex: Math.min(text.length, index + 2) };
      if (!exponent) return null;
      return {
        base: text.slice(0, index),
        exponent: exponent.value,
        endIndex: exponent.endIndex,
      };
    }
  }
  return null;
}

function parseFraction(text) {
  if (!text.startsWith("\\frac")) return null;
  const numerator = readBraced(text, "\\frac".length);
  if (!numerator) return null;
  const denominator = readBraced(text, numerator.endIndex);
  if (!denominator) return null;
  if (denominator.endIndex !== text.length) return null;
  return { numerator: numerator.value, denominator: denominator.value };
}

function parseSlashFraction(text) {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    if (char === "}" || char === ")" || char === "]") depth -= 1;
    if (depth === 0 && char === "/" && index > 0 && index < text.length - 1) {
      return {
        numerator: text.slice(0, index),
        denominator: text.slice(index + 1),
      };
    }
  }
  return null;
}

function parseRadical(text) {
  if (!text.startsWith("\\sqrt")) return null;
  const radicand = readBraced(text, "\\sqrt".length);
  if (!radicand || radicand.endIndex !== text.length) return null;
  return radicand.value;
}

function parseFunction(text) {
  const spaced = normalizeLatexFunctionSpacing(text).replace(/\s+/g, "");
  if (spaced !== text) return parseFunction(spaced);

  const knownFunction = readKnownFunctionCall(text);
  if (knownFunction && knownFunction.token === stripWrapping(text)) {
    return {
      name: knownFunction.name,
      argument: stripWrapping(knownFunction.argument || ""),
    };
  }

  const commandMatch = text.match(/^\\([a-zA-Z]+)(.*)$/);
  if (commandMatch && FUNCTION_NAMES.has(commandMatch[1])) {
    return {
      name: `\\${commandMatch[1]}`,
      argument: stripWrapping(commandMatch[2] || ""),
    };
  }

  const customMatch = text.match(/^([a-zA-Z][a-zA-Z0-9]*)\((.+)\)$/);
  if (customMatch) {
    return {
      name: customMatch[1],
      argument: customMatch[2],
    };
  }

  return null;
}

function parseIntegral(text) {
  const command = text.match(INTEGRAL_COMMAND_PATTERN)?.[0];
  if (!command) return null;

  let index = command.length;
  let lower = null;
  let upper = null;

  if (text[index] === "_") {
    const script = readScript(text, index + 1);
    if (script) {
      lower = script.value;
      index = script.endIndex;
    }
  }

  if (text[index] === "^") {
    const script = readScript(text, index + 1);
    if (script) {
      upper = script.value;
      index = script.endIndex;
    }
  }

  const body = text.slice(index);
  if (!lower && !upper && !body) return null;
  return { command, lower, upper, body };
}

function readScript(text, startIndex) {
  if (!text[startIndex]) return null;
  if (text[startIndex] === "{") return readBraced(text, startIndex);
  if (text[startIndex] === "(") return readParenthesized(text, startIndex);
  if (text[startIndex] === "\\") {
    const command = text.slice(startIndex).match(/^\\[a-zA-Z]+/);
    if (command) {
      return {
        value: command[0],
        endIndex: startIndex + command[0].length,
      };
    }
  }

  const match = text.slice(startIndex).match(/^[a-zA-Z0-9]+/);
  if (match) {
    return {
      value: match[0],
      endIndex: startIndex + match[0].length,
    };
  }

  return {
    value: text[startIndex],
    endIndex: startIndex + 1,
  };
}

function renderOperatorLatex(value) {
  if (value === "<=" || value === "в‰¤") return "\\le";
  if (value === ">=" || value === "в‰Ґ") return "\\ge";
  return value;
}

function renderFunctionName(name) {
  const normalized = String(name || "");
  if (normalized.startsWith("\\")) return normalized;
  return FUNCTION_NAMES.has(normalized) ? `\\${normalized}` : normalized;
}

function normalizeMathValue(value = "") {
  const input = normalizeEscapedLatexInput(value);
  return shouldPreserveLatex(input)
    ? normalizeLatexTransport(input)
    : normalizeMathText(input);
}

function renderImplicitProduct(parts, depth) {
  return parts.reduce((output, part, index) => {
    const value = part.value || part;
    const rendered = renderLatexForKatex(value, depth + 1);
    if (index === 0) return rendered;
    if (part.separator === "\\cdot" || part.separator === "·") return `${output}\\cdot ${rendered}`;
    if (part.separator === "\\;" || part.separator === "\\,") return `${output}${part.separator}${rendered}`;

    return /^d(\\[a-zA-Z]+|[a-zA-Z]+)$/.test(normalizeMathText(value))
      ? `${output}\\,${rendered}`
      : `${output}${rendered}`;
  }, "");
}

function renderIntegralLatex(text, depth) {
  if (!text.startsWith("\\int")) return null;

  let index = "\\int".length;
  let lower = null;
  let upper = null;

  if (text[index] === "_") {
    const script = readScript(text, index + 1);
    if (script) {
      lower = script.value;
      index = script.endIndex;
    }
  }

  if (text[index] === "^") {
    const script = readScript(text, index + 1);
    if (script) {
      upper = script.value;
      index = script.endIndex;
    }
  }

  const bounds = `${lower !== null ? `_{${renderLatexForKatex(lower, depth + 1)}}` : ""}${upper !== null ? `^{${renderLatexForKatex(upper, depth + 1)}}` : ""}`;
  const body = text.slice(index);
  return `\\int${bounds}${body ? ` ${renderLatexForKatex(body, depth + 1)}` : ""}`;
}

function renderDerivativeLatex(text, depth) {
  const match = text.match(/^d\/d([a-zA-Z])(.+)$/);
  if (!match) return null;
  const body = match[2] || "";
  const grouped = body.startsWith("(") && body.endsWith(")")
    ? `\\left(${renderLatexForKatex(body.slice(1, -1), depth + 1)}\\right)`
    : renderLatexForKatex(body, depth + 1);
  return `\\frac{d}{d${match[1]}}${grouped ? ` ${grouped}` : ""}`;
}

function renderLatexForKatex(value, depth = 0) {
  if (depth === 0 && shouldPreserveLatex(value)) {
    return normalizeLatexForKatex(normalizeEscapedLatexInput(value));
  }

  if (depth > 12) return normalizeMathText(value);
  const normalized = normalizeMathText(value);
  if (!normalized) return "";

  const derivative = renderDerivativeLatex(normalized, depth);
  if (derivative) return derivative;

  const integral = renderIntegralLatex(normalized, depth);
  if (integral) return integral;

  const relations = splitTopLevelRelations(normalized);
  if (relations.length > 0) {
    return relations.map((piece) => (
      piece.type === "operator"
        ? renderOperatorLatex(piece.value)
        : renderLatexForKatex(piece.value, depth + 1)
    )).join("");
  }

  const addends = splitTopLevelAddends(normalized);
  if (addends.length > 0) {
    return addends.map((piece) => (
      piece.type === "operator"
        ? piece.value
        : renderLatexForKatex(piece.value, depth + 1)
    )).join("");
  }

  const explicitFraction = parseFraction(normalized);
  if (explicitFraction) {
    return `\\frac{${renderLatexForKatex(explicitFraction.numerator, depth + 1)}}{${renderLatexForKatex(explicitFraction.denominator, depth + 1)}}`;
  }

  const slashFraction = parseSlashFraction(normalized);
  if (slashFraction) {
    return `\\frac{${renderLatexForKatex(stripWrapping(slashFraction.numerator), depth + 1)}}{${renderLatexForKatex(stripWrapping(slashFraction.denominator), depth + 1)}}`;
  }

  const radical = parseRadical(normalized);
  if (radical) return `\\sqrt{${renderLatexForKatex(radical, depth + 1)}}`;

  const power = findPowerSplit(normalized);
  if (power && power.endIndex === normalized.length) {
    return `${renderLatexForKatex(power.base, depth + 1)}^{${renderLatexForKatex(power.exponent, depth + 1)}}`;
  }

  const fn = parseFunction(normalized);
  if (fn) {
    return `${renderFunctionName(fn.name)}${fn.argument ? ` ${renderLatexForKatex(fn.argument, depth + 1)}` : ""}`;
  }

  const grouped = stripWrapping(normalized);
  if (grouped !== normalized) return renderLatexForKatex(grouped, depth + 1);

  const products = splitTopLevelProducts(normalized);
  if (products.length > 0) return renderImplicitProduct(products, depth);

  const factorSequence = splitImplicitFactorSequence(normalized);
  if (factorSequence.length > 0) return renderImplicitProduct(factorSequence, depth);

  const adjacentParts = splitAdjacentMathTokens(normalized);
  if (adjacentParts.length > 0) return renderImplicitProduct(adjacentParts, depth);

  if (/^d(\\[a-zA-Z]+|[a-zA-Z]+)$/.test(normalized)) {
    return `d${renderLatexForKatex(normalized.slice(1), depth + 1)}`;
  }

  return renderOperatorLatex(normalized);
}

export function renderMathLatex(value = "") {
  const input = normalizeEscapedLatexInput(value);
  if (shouldPreserveLatex(input)) {
    const preserved = normalizeLatexForKatex(input);
    traceMathStage("Markdown conversion", value, preserved, "preserved immutable LaTeX");
    return preserved;
  }

  try {
    const rendered = renderLatexForKatex(normalizeLatexFunctionSpacing(input));
    traceMathStage("Markdown conversion", value, rendered, "plain text math repair");
    return rendered;
  } catch (error) {
    console.error("Failed to normalize render math:", { value, error });
    return normalizeMathText(normalizeEscapedLatexInput(value));
  }
}

function splitImplicitProduct(text) {
  const normalized = stripWrapping(text);
  const numberThenRadical = normalized.match(/^([0-9]+)(\\sqrt\{.+\})$/);
  if (numberThenRadical) return [numberThenRadical[1], numberThenRadical[2]];
  if (/^[0-9]+\\[a-zA-Z]+$/.test(normalized)) {
    const match = normalized.match(/^([0-9]+)(\\[a-zA-Z]+)$/);
    return [match[1], match[2]];
  }
  if (/^\\rho\^/.test(normalized) || /^\\[a-zA-Z]+\^/.test(normalized)) return [];
  if (/^\\[a-zA-Z]+[a-zA-Z0-9]+$/.test(normalized)) return [];
  return [];
}

function atomicRole(text) {
  if (/^(\\le|\\ge|<=|>=|≤|≥|=|<|>|\+|-|\\cdot|·)$/.test(text)) return "operator";
  if (/^\\times$/.test(text)) return "operator";
  if (/^\\nabla$/.test(text)) return "operator";
  if (/^d(\\[a-zA-Z]+|[a-zA-Z]+)$/.test(text)) return "differential";
  if (/^[0-9]+(\.[0-9]+)?$/.test(text) || GREEK_LABELS.has(text)) return GREEK_LABELS.has(text) && text !== "\\pi" ? "variable" : "constant";
  if (/^(e|i)$/.test(text)) return "constant";
  if (/^\\[a-zA-Z]+$/.test(text)) return GREEK_LABELS.has(text) && text !== "\\pi" ? "variable" : "function";
  if (FUNCTION_NAMES.has(text)) return "function";
  if (/^[a-zA-Z]$/.test(text)) return "variable";
  return "other";
}

function groupDifferentials(nodes, idPrefix, expressionKey) {
  const grouped = [];
  let index = 0;

  while (index < nodes.length) {
    const current = nodes[index];
    if (current.role !== "differential") {
      grouped.push(current);
      index += 1;
      continue;
    }

    const differentials = [current];
    let cursor = index + 1;
    while (cursor < nodes.length && nodes[cursor].role === "differential") {
      differentials.push(nodes[cursor]);
      cursor += 1;
    }

    if (differentials.length > 1) {
      grouped.push(createNode({
        latex: differentials.map((node) => node.latex).join("\\,"),
        role: "differential_group",
        idPrefix,
        index: `diffs-${index}`,
        start: differentials[0].start,
        expressionKey,
        children: differentials,
      }));
    } else {
      grouped.push(current);
    }

    index = cursor;
  }

  return grouped;
}

function productChildRole(value) {
  const normalized = stripWrapping(normalizeMathValue(value));
  if (parseIntegral(compactStructuralLatex(normalized))) return "integral";
  if (splitTopLevelVectorOperations(compactStructuralLatex(normalized)).length > 0) return "vector_operation";
  if (readKnownFunctionCall(normalized)?.token === normalized) return "function";
  if (parseFraction(normalized) || parseSlashFraction(normalized)) return "fraction";
  if (findPowerSplit(normalized)?.endIndex === normalized.length) return "power";
  const role = atomicRole(value);
  return role === "other" ? "product" : role;
}

function parseExpressionChildren(text, idPrefix, expressionKey, depth = 0) {
  if (depth > 4) return [];
  const normalized = compactStructuralLatex(stripWrapping(normalizeMathValue(text)));
  if (!normalized) return [];

  const relations = splitTopLevelRelations(normalized);
  if (relations.length > 0) {
    return relations.flatMap((piece, index) => {
      if (piece.type === "operator") {
        return createNode({ latex: piece.value, role: "operator", idPrefix, index, start: piece.start, expressionKey });
      }

      const additiveNodes = nodesForAdditiveExpression(
        piece.value,
        `${idPrefix}-${index}`,
        expressionKey,
        depth
      );
      return additiveNodes.length > 0
        ? additiveNodes
        : parseNode(piece.value, "other", idPrefix, index, piece.start, expressionKey, depth + 1);
    });
  }

  const factors = splitParentheticalFactors(normalized);
  if (factors.length > 0) {
    return factors.map((factor, index) => parseNode(
      factor.value,
      "factor",
      idPrefix,
      index,
      factor.start,
      expressionKey,
      depth + 1
    ));
  }

  const addends = splitTopLevelAddends(normalized);
  if (addends.length > 0) {
    return nodesForAdditiveExpression(normalized, idPrefix, expressionKey, depth);
  }

  const vectorOps = splitTopLevelVectorOperations(normalized);
  if (vectorOps.length > 0) {
    return vectorOps.map((piece, index) => (
      piece.type === "operator"
        ? createNode({ latex: piece.value, role: "operator", idPrefix, index, start: piece.start, expressionKey })
        : parseNode(piece.value, atomicRole(piece.value), idPrefix, index, piece.start, expressionKey, depth + 1)
    ));
  }

  const products = splitTopLevelProducts(normalized);
  if (products.length > 0) {
    const productNodes = products.flatMap((piece, pieceIndex) => {
      const adjacent = splitAdjacentMathTokens(piece.value);
      if (adjacent.length === 0) {
        return [parseNode(piece.value, productChildRole(piece.value), idPrefix, pieceIndex, piece.start, expressionKey, depth + 1)];
      }
      return adjacent.map((child, childIndex) => parseNode(
        child.value,
        childIndex === 0 && /^[0-9]+(\.[0-9]+)?$/.test(child.value) ? "coefficient" : productChildRole(child.value),
        idPrefix,
        pieceIndex * 10 + childIndex,
        piece.start + child.start,
        expressionKey,
        depth + 1
      ));
    });
    return groupDifferentials(productNodes, idPrefix, expressionKey);
  }

  const factorSequence = splitImplicitFactorSequence(normalized);
  if (factorSequence.length > 0) {
    return factorSequence.map((piece, index) => parseNode(
      piece.value,
      index === 0 && /^[0-9]+(\.[0-9]+)?$/.test(piece.value) ? "coefficient" : productChildRole(piece.value),
      idPrefix,
      index,
      piece.start,
      expressionKey,
      depth + 1
    ));
  }

  const fraction = parseFraction(normalized) || parseSlashFraction(normalized);
  if (fraction) {
    return [
      parseNode(fraction.numerator, "numerator", idPrefix, 0, 0, expressionKey, depth + 1),
      parseNode(fraction.denominator, "denominator", idPrefix, 1, 0, expressionKey, depth + 1),
    ];
  }

  const radical = parseRadical(normalized);
  if (radical) {
    return [parseNode(radical, "radicand", idPrefix, 0, 0, expressionKey, depth + 1)];
  }

  const power = findPowerSplit(normalized);
  if (power && power.endIndex === normalized.length) {
    return [
      parseNode(power.base, atomicRole(power.base), idPrefix, 0, 0, expressionKey, depth + 1),
      parseNode(power.exponent, "exponent", idPrefix, 1, normalized.indexOf("^") + 1, expressionKey, depth + 1),
    ];
  }

  const functionPower = normalized.match(new RegExp(`^(\\\\(?:${FUNCTION_NAME_PATTERN}))\\^(\\{[^}]+\\}|[A-Za-z0-9]+)(.+)$`));
  if (functionPower) {
    const exponent = stripWrapping(functionPower[2]);
    const argument = stripWrapping(functionPower[3]);
    return [
      createNode({ latex: functionPower[1], role: "function", idPrefix, index: 0, expressionKey }),
      parseNode(exponent, "exponent", idPrefix, 1, normalized.indexOf("^") + 1, expressionKey, depth + 1),
      ...(argument ? [parseNode(argument, "argument", idPrefix, 2, normalized.indexOf(functionPower[3]), expressionKey, depth + 1)] : []),
    ];
  }

  const fn = parseFunction(normalized);
  if (fn) {
    return [
      createNode({ latex: fn.name, role: "function", idPrefix, index: 0, expressionKey }),
      ...(fn.argument ? [parseNode(fn.argument, "argument", idPrefix, 1, fn.name.length, expressionKey, depth + 1)] : []),
    ];
  }

  const productParts = splitImplicitProduct(normalized);
  if (productParts.length > 0) {
    return productParts.map((piece, index) => parseNode(
      piece,
      index === 0 && /^[0-9]+(\.[0-9]+)?$/.test(piece) ? "coefficient" : atomicRole(piece),
      idPrefix,
      index,
      normalized.indexOf(piece),
      expressionKey,
      depth + 1
    ));
  }

  const integral = parseIntegral(normalized);
  if (integral) {
    const children = [];
    if (integral.lower) {
      children.push(parseNode(integral.lower, "domain", idPrefix, "domain", normalized.indexOf("_") + 1, expressionKey, depth + 1));
    }
    if (integral.upper) {
      children.push(parseNode(integral.upper, "bound", idPrefix, "upper", normalized.indexOf("^") + 1, expressionKey, depth + 1));
    }
    const body = stripWrapping(integral.body);
    if (body) {
      children.push(parseNode(body, inferCompoundRole(body), idPrefix, "body", normalized.indexOf(integral.body), expressionKey, depth + 1));
    }
    return children;
  }

  const adjacentParts = splitAdjacentMathTokens(normalized);
  if (adjacentParts.length > 0) {
    return adjacentParts.map((piece, index) => parseNode(
      piece.value,
      index === 0 && /^[0-9]+(\.[0-9]+)?$/.test(piece.value) ? "coefficient" : productChildRole(piece.value),
      idPrefix,
      index,
      piece.start,
      expressionKey,
      depth + 1
    ));
  }

  return [];
}

function inferCompoundRole(text, preferredRole) {
  if (preferredRole && preferredRole !== "other") return preferredRole;
  const normalized = compactStructuralLatex(stripWrapping(normalizeMathValue(text)));
  if (/\\le|\\ge|<=|>=|≤|≥|<|>/.test(text)) return "bound";
  if (/=/.test(text)) return "equation";
  if (parseIntegral(normalized)) return "integral";
  if (splitTopLevelVectorOperations(normalized).length > 0) return "vector_operation";
  if (/\\frac/.test(text) || parseSlashFraction(stripWrapping(normalizeMathValue(text)))) return "fraction";
  if (/\\sqrt/.test(text)) return "radical";
  if (/\\,|\\;|\\cdot|·/.test(text)) return "product";
  if (/\^/.test(text) && findPowerSplit(text)?.endIndex === text.length) return "power";
  if (readKnownFunctionCall(text)?.token === stripWrapping(text)) return "function";
  if (new RegExp(`\\\\(${FUNCTION_NAME_PATTERN})`).test(text)) return "function";
  if (/^\(.+\)\(.+\)$/.test(text)) return "product";
  if (/[+\-]/.test(text)) return "sum";
  if (splitImplicitFactorSequence(text).length > 0) return "product";
  if (splitAdjacentMathTokens(text).length > 0) return "product";
  if (splitImplicitProduct(text).length > 0) return "product";
  return atomicRole(text);
}

function parseNode(text, preferredRole, idPrefix, index, start, expressionKey, depth) {
  const normalized = normalizeMathValue(text);
  const role = inferCompoundRole(normalized, preferredRole);
  const children = parseExpressionChildren(normalized, `${idPrefix}-${index}`, expressionKey, depth);
  return createNode({
    latex: normalized,
    role,
    idPrefix,
    index,
    start,
    expressionKey,
    children,
  });
}

export function annotateExpression({ id = "expr-1", latex = "", role = "other", problemId = "problem" } = {}) {
  const normalizedLatex = normalizeMathValue(latex);
  const expressionKey = `${problemId}:${normalizedLatex}`;
  const rootRole = inferCompoundRole(normalizedLatex, role);
  let children = [];

  try {
    if (!hierarchicalTokensEnabled()) {
      return {
        id,
        latex: normalizedLatex,
        role: rootRole,
        tokens: [createNode({
          latex: normalizedLatex,
          role: rootRole,
          idPrefix: id,
          index: 0,
          expressionKey,
          children: [],
        })],
      };
    }
    children = parseExpressionChildren(normalizedLatex, `${id}-root`, expressionKey);
  } catch (error) {
    console.error("Failed to parse math expression:", { latex: normalizedLatex, error });
  }

  const root = createNode({
    latex: normalizedLatex,
    role: rootRole,
    idPrefix: id,
    index: 0,
    expressionKey,
    children,
  });

  return {
    id,
    latex: normalizedLatex,
    role: rootRole,
    tokens: [root],
  };
}

function tokenToChunkPart(token) {
  return {
    id: token.id,
    kind: token.kind || token.role,
    rawText: token.rawText || token.latex || token.display || "",
    display: token.latex || token.display,
    short: token.short,
    medium: token.medium,
    deep: token.deep,
    text: token.text,
    latex: token.latex,
    role: token.role,
    start: token.start,
    end: token.end,
    sourceRange: token.sourceRange || (Number.isFinite(token.start) && Number.isFinite(token.end) ? { start: token.start, end: token.end } : null),
    explanationId: token.explanationId || `${token.id}:explanation`,
    explanation: token.explanation,
    conceptIds: token.conceptIds || [],
    relatedTokenIds: token.relatedTokenIds || [],
    children: Array.isArray(token.children) ? token.children.map(tokenToChunkPart) : [],
  };
}

function tokenToLineToken(token, fallbackId) {
  const display = normalizeMathValue(token?.latex || token?.display || token?.text || "");
  const explanation = explainToken(token?.role || inferCompoundRole(display), display, "line-token");
  return {
    id: token?.id || fallbackId,
    kind: token?.kind || token?.role || inferCompoundRole(display),
    rawText: token?.rawText || token?.latex || token?.display || token?.text || display,
    display,
    latex: normalizeMathValue(token?.latex || display),
    text: normalizeDisplayText(token?.text || displayText(display)),
    role: token?.role || inferCompoundRole(display),
    short: token?.short || token?.label || explanation.short,
    medium: token?.medium || token?.explanation || explanation.medium,
    deep: token?.deep || explanation.deep,
    explanation: token?.explanation || token?.medium || explanation.medium,
    conceptIds: token?.conceptIds || [],
    relatedTokenIds: token?.relatedTokenIds || [],
    sourceRange: token?.sourceRange || (Number.isFinite(token?.start) && Number.isFinite(token?.end) ? { start: token.start, end: token.end } : null),
    explanationId: token?.explanationId || `${token?.id || fallbackId}:explanation`,
    parts: Array.isArray(token?.children) ? token.children.map(tokenToChunkPart) : [],
    children: Array.isArray(token?.children) ? token.children.map(tokenToChunkPart) : [],
  };
}

function normalizeLineToken(token, fallbackId) {
  if (!token || typeof token !== "object") {
    const display = normalizeMathText(token || "");
    const explanation = explainToken("other", display, "line-token");
    return {
      id: fallbackId,
      display,
      latex: display,
      text: normalizeDisplayText(displayText(display)),
      role: inferCompoundRole(display),
      short: explanation.short,
      medium: explanation.medium,
      deep: explanation.deep,
      relatedTokenIds: [],
      parts: [],
      children: [],
    };
  }

  const normalized = normalizeExistingPart(token, fallbackId);
  const children = Array.isArray(normalized.children) ? normalized.children : [];
  const parts = Array.isArray(token.parts) && token.parts.length > 0
    ? token.parts.map((part, index) => normalizeExistingPart(part, `${normalized.id}-part-${index + 1}`))
    : children;

  return {
    ...normalized,
    parts,
    children,
  };
}

function expressionToLine(expression, step, index) {
  const tokens = Array.isArray(expression?.tokens) ? expression.tokens : [];
  const rootTokens = tokens.length > 0
    ? tokens
    : [annotateExpression({
        id: expression?.id || `${step.id || "step"}-expr-${index + 1}`,
        latex: expression?.latex || step.math || "",
        role: expression?.role || "other",
      }).tokens[0]];

  return {
    id: expression?.id || `${step.id || "step"}-line-${index + 1}`,
    kind: expression?.kind || "math",
    role: expression?.role || "other",
    text: expression?.text || "",
    latex: expression?.latex || "",
    tokens: rootTokens.map((token, tokenIndex) => tokenToLineToken(
      token,
      `${step.id || "step"}-line-${index + 1}-token-${tokenIndex + 1}`
    )),
  };
}

function chunksToLine(step, chunks, index = 0) {
  return {
    id: `${step.id || "step"}-line-${index + 1}`,
    kind: "math",
    role: "legacy_chunks",
    text: "",
    latex: step.math || "",
    tokens: chunks.map((chunk, chunkIndex) => normalizeLineToken(
      chunk,
      `${step.id || "step"}-chunk-${chunkIndex + 1}`
    )),
  };
}

function normalizeStepLines(step, fallbackChunks) {
  if (Array.isArray(step.lines) && step.lines.length > 0) {
    return step.lines.map((line, lineIndex) => ({
      id: line?.id || `${step.id || "step"}-line-${lineIndex + 1}`,
      kind: line?.kind || (line?.latex ? "math" : "text"),
      role: line?.role || "other",
      text: normalizeDisplayText(line?.text || ""),
      latex: line?.latex ? normalizeMathValue(line.latex) : "",
      tokens: Array.isArray(line?.tokens)
        ? line.tokens.map((token, tokenIndex) => normalizeLineToken(
            token,
            `${step.id || "step"}-line-${lineIndex + 1}-token-${tokenIndex + 1}`
          ))
        : [],
    })).filter((line) => line.text || line.latex || line.tokens.length > 0);
  }

  if (Array.isArray(step.expressions) && step.expressions.length > 0) {
    return step.expressions
      .map((expression, index) => expressionToLine(expression, step, index))
      .filter((line) => line.text || line.latex || line.tokens.length > 0);
  }

  if (fallbackChunks.length > 0) {
    return [chunksToLine(step, fallbackChunks)];
  }

  if (step.math) {
    return [expressionToLine({ id: `${step.id || "step"}-expr-1`, latex: step.math, role: "other" }, step, 0)];
  }

  return [];
}

function hasUsefulParts(chunk) {
  return Array.isArray(chunk?.parts)
    && chunk.parts.length > 0
    && chunk.parts.some((part) => String(part?.display || "").trim());
}

function chunkDisplayValue(chunk) {
  return chunk?.display ?? chunk?.latex ?? chunk?.text ?? "";
}

function withChunkRenderMetadata(chunk, normalizedLatex = normalizeMathValue(chunkDisplayValue(chunk))) {
  const originalDisplay = String(chunk?.originalDisplay ?? chunkDisplayValue(chunk) ?? "");
  return {
    ...chunk,
    originalDisplay,
    normalizedLatex,
    renderStatus: chunk?.renderStatus || "ready",
    fallbackDisplay: chunk?.fallbackDisplay || originalDisplay || normalizedLatex,
  };
}

function normalizeExistingPart(part, fallbackId) {
  const display = normalizeMathValue(part?.display || part?.latex || part?.text || "");
  const explanation = explainToken(part?.role || inferCompoundRole(display), display, "existing");
  return {
    ...part,
    id: part?.id || fallbackId,
    kind: part?.kind || part?.role || inferCompoundRole(display),
    rawText: part?.rawText || part?.latex || part?.display || part?.text || display,
    display,
    latex: normalizeMathValue(part?.latex || display),
    text: normalizeDisplayText(part?.text || displayText(display)),
    role: part?.role || inferCompoundRole(display),
    short: part?.short || explanation.short,
    medium: part?.medium || part?.explanation || explanation.medium,
    deep: part?.deep || explanation.deep,
    explanation: part?.explanation || part?.medium || explanation.medium,
    sourceRange: part?.sourceRange || (Number.isFinite(part?.start) && Number.isFinite(part?.end) ? { start: part.start, end: part.end } : null),
    explanationId: part?.explanationId || `${part?.id || fallbackId}:explanation`,
    children: Array.isArray(part?.children)
      ? part.children.map((child, index) => normalizeExistingPart(child, `${fallbackId}-${index}`))
      : [],
  };
}

function expressionFromChunk(problemId, step, chunk, chunkIndex) {
  return annotateExpression({
    id: `${step.id || "step"}-expr-${chunkIndex + 1}`,
    latex: chunk.display || step.math || "",
    role: inferCompoundRole(chunk.display || ""),
    problemId,
  });
}

function normalizeExpressions(problemId, step, fallbackChunks) {
  if (Array.isArray(step.expressions) && step.expressions.length > 0) {
    return step.expressions.map((expression, expressionIndex) => {
      const latex = normalizeMathValue(expression?.latex || fallbackChunks[expressionIndex]?.display || step.math || "");
      const annotated = annotateExpression({
        id: expression?.id || `${step.id}-expr-${expressionIndex + 1}`,
        latex,
        role: expression?.role || inferCompoundRole(latex),
        problemId,
      });
      const modelTokens = Array.isArray(expression?.tokens) ? expression.tokens : [];
      const hasModelChildren = modelTokens.some((token) => Array.isArray(token?.children) && token.children.length > 0);
      return hasModelChildren
        ? {
            ...annotated,
            tokens: modelTokens.map((token, tokenIndex) => normalizeExistingPart(token, `${annotated.id}-token-${tokenIndex + 1}`)),
          }
        : annotated;
    });
  }

  return fallbackChunks.map((chunk, chunkIndex) => expressionFromChunk(problemId, step, chunk, chunkIndex));
}

export function annotateMathExplanation(value) {
  if (!value || typeof value !== "object") return value;

  const aiUsage = value._aiUsage;
  const problemId = cleanIdPart(value.id || value.demoKey || value.originalProblem || value.problem || value.title || "problem");
  const annotated = {
    ...value,
    problem: value.problem || value.originalProblem || value.expression || "",
    title: normalizeDisplayText(value.title || ""),
    description: normalizeDisplayText(value.description || ""),
    summary: normalizeDisplayText(value.summary || value.description || value.explanations?.intermediate || ""),
    originalProblem: value.originalProblem || value.problem || value.expression || "",
    expression: value.expression ? normalizeMathValue(value.expression) : value.expression,
    finalAnswer: value.finalAnswer ? normalizeMathValue(value.finalAnswer) : value.finalAnswer,
    steps: Array.isArray(value.steps)
      ? value.steps.map((step, stepIndex) => {
          const fallbackChunks = Array.isArray(step.chunks) && step.chunks.length > 0
            ? step.chunks
            : [{
                id: `${step.id || `step-${stepIndex + 1}`}-chunk-1`,
                display: step.math || step.label || "",
                short: step.title || step.label || "Step expression",
                medium: step.plainExplanation || step.summary || "This expression is part of the solution.",
                deep: step.plainExplanation || step.summary || "This expression supports the reasoning in this step.",
              }];
          const hasModelExpressions = Array.isArray(step.expressions) && step.expressions.length > 0;
          const expressions = normalizeExpressions(problemId, step, fallbackChunks);
          const expressionByLatex = new Map(expressions.map((expression) => [normalizeMathValue(expression.latex), expression]));
          const chunks = fallbackChunks.map((chunk, chunkIndex) => {
            if (hasUsefulParts(chunk)) {
              const display = chunkDisplayValue(chunk);
              const normalizedLatex = normalizeMathValue(display);
              return {
                ...withChunkRenderMetadata(chunk, normalizedLatex),
                parts: chunk.parts.map((part, partIndex) => normalizeExistingPart(part, `${chunk.id}-part-${partIndex + 1}`)),
              };
            }
            const latex = normalizeMathValue(chunkDisplayValue(chunk));
            const expression = expressionByLatex.get(latex) || expressions[chunkIndex] || expressionFromChunk(problemId, step, chunk, chunkIndex);
            const root = expression.tokens?.[0];
            const parts = Array.isArray(root?.children) && root.children.length > 0
              ? root.children.map(tokenToChunkPart)
              : [];
            const normalizedChunk = withChunkRenderMetadata(chunk, latex);
            return parts.length > 0
              ? { ...normalizedChunk, display: latex, parts }
              : { ...normalizedChunk, display: latex };
          });
          return {
            ...step,
            label: normalizeDisplayText(step.label || step.title || `Step ${stepIndex + 1}`),
            title: normalizeDisplayText(step.title || step.label),
            math: step.math ? normalizeMathValue(step.math) : step.math,
            summary: normalizeDisplayText(step.summary || ""),
            plainExplanation: normalizeDisplayText(step.plainExplanation || step.summary),
            expressions,
            chunks,
            lines: normalizeStepLines(hasModelExpressions ? { ...step, expressions } : { ...step, expressions: [] }, chunks),
          };
        })
      : [],
  };

  if (aiUsage !== undefined) {
    Object.defineProperty(annotated, "_aiUsage", {
      enumerable: false,
      value: aiUsage,
    });
  }

  return annotated;
}

export function hasCompleteTokenHierarchy(explanation) {
  return Boolean(explanation?.steps?.every((step) => (
    Array.isArray(step.expressions)
    && step.expressions.length > 0
    && step.expressions.every((expression) => (
      Array.isArray(expression.tokens)
      && expression.tokens.some((token) => Array.isArray(token.children) && token.children.length > 0)
    ))
  )));
}
