import katex from "katex";
import { getTexSourceAtoms } from "./texAnnotationGrammar.js";

/** @typedef {{ type?: string, family?: string }} KatexSyntaxNode */
const KATEX_INTERNAL = /** @type {{ __parse: (latex: string, options?: object) => KatexSyntaxNode[] }} */ (
  /** @type {unknown} */ (katex)
);

const FUNCTION_COMMANDS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "ln", "log", "exp", "arcsin", "arccos", "arctan"]);
const GREEK_COMMANDS = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "varkappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "varpi", "rho",
  "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
]);
const CONSTANT_COMMANDS = new Set(["pi", "infty"]);
const OPERATOR_COMMANDS = new Set([
  "cdot", "times", "otimes", "circ", "bullet", "nabla", "partial",
  "to", "mapsto", "Rightarrow", "leftarrow", "rightarrow", "leftrightarrow",
]);
const PRESENTATION_COMMANDS = new Set(["mathbf", "mathrm", "mathit", "mathcal", "mathbb", "mathsf", "mathtt", "boldsymbol", "vec", "hat", "bar", "tilde", "overline"]);
const SPACING_COMMANDS = ["\\qquad", "\\quad", "\\,", "\\!", "\\:", "\\;"];
const NUMBER_LITERAL_SOURCE = "-?\\d+(?:\\.\\d+)?";
const NUMBER_LITERAL_PATTERN = new RegExp(`^${NUMBER_LITERAL_SOURCE}$`);
const UNICODE_SUPERSCRIPT_DIGITS = new Map([
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

function normalizeUnicodeRadicals(value = "") {
  return String(value || "")
    .replace(/√\(([^()]+)\)/g, "\\sqrt{$1}")
    .replace(/√([a-zA-Z]+|\d+(?:\.\d+)?)/g, "\\sqrt{$1}");
}

function normalizeUnicodeSuperscripts(value = "") {
  return String(value || "").replace(/([0-9A-Za-z}\\)])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, base, superscript) => {
    const exponent = [...superscript].map((char) => UNICODE_SUPERSCRIPT_DIGITS.get(char) || "").join("");
    return exponent ? `${base}^${exponent}` : `${base}${superscript}`;
  });
}

function normalizeLatexInput(value = "") {
  const normalized = normalizeUnicodeSuperscripts(normalizeUnicodeRadicals(value))
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/∞/g, "\\infty")
    .replace(/Σ/g, "\\sum")
    .replace(/Π/g, "\\prod")
    .replace(/→/g, "\\to")
    .replace(/∂/g, "\\partial")
    .replace(/∫/g, "\\int")
    .replace(/∬/g, "\\iint")
    .replace(/∭/g, "\\iiint")
    .replace(/≤/g, "\\le")
    .replace(/≥/g, "\\ge")
    .replace(/≈/g, "\\approx")
    .replace(/±/g, "\\pm")
    .replace(/−/g, "-")
    .replace(/\\text\{(?:or|and)\}/gi, ",")
    .replace(/\\mathrm\{(?:or|and)\}/gi, ",")
    .replace(/\\mathbf\s+([a-zA-Z])/g, "\\mathbf{$1}")
    .replace(/\\rangle\s+(?=d(?:\\[a-zA-Z]+|[a-zA-Z]))/g, "\\rangle\\,")
    .replace(/\\pm(?=(?:\\[a-zA-Z]+|[a-zA-Z]))/g, "\\pm ");
  return normalizeUnicodeSuperscripts(normalized);
}

function cleanIdPart(value = "node") {
  return String(value || "node")
    .replace(/\\/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "node";
}

function semanticLayerEnabled(override) {
  if (override !== undefined) return override !== false && override !== "false";
  const viteFlag = typeof import.meta !== "undefined" ? import.meta.env?.VITE_SEMANTIC_MATH_AST : undefined;
  const processFlag = globalThis.process?.env?.VITE_SEMANTIC_MATH_AST;
  const flag = viteFlag ?? processFlag;
  return flag === undefined || flag === "" || flag === "true" || flag === true;
}

export function isSemanticMathLayerEnabled(override) {
  return semanticLayerEnabled(override);
}

function stripOuterParens(value = "") {
  let text = String(value || "").trim();
  let changed = true;
  while (changed && text.startsWith("(") && text.endsWith(")")) {
    changed = false;
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1;
      if (text[index] === ")") depth -= 1;
      if (depth === 0 && index < text.length - 1) return text;
    }
    text = text.slice(1, -1).trim();
    changed = true;
  }
  return text;
}

function readKnownFunctionPrefix(text = "") {
  const source = String(text || "");
  const candidates = [...FUNCTION_COMMANDS]
    .sort((left, right) => right.length - left.length)
    .flatMap((name) => [`\\${name}`, name]);
  return candidates.find((candidate) => (
    source.startsWith(candidate)
    && source.length > candidate.length
  )) || "";
}

function readGroup(text, startIndex, open = "{", close = "}") {
  if (text[startIndex] !== open) return null;
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    if (text[index] === close) depth -= 1;
    if (depth === 0) {
      return {
        value: text.slice(startIndex + 1, index),
        start: startIndex,
        end: index + 1,
      };
    }
  }
  return null;
}

const DELIMITER_PAIRS = { "{": "}", "(": ")", "[": "]" };

function readDelimited(text, startIndex) {
  const open = text[startIndex];
  const close = DELIMITER_PAIRS[open];
  return close ? readGroup(text, startIndex, open, close) : null;
}

function readControlSequence(text = "", startIndex = 0) {
  if (text[startIndex] !== "\\") return "";
  return text.slice(startIndex).match(/^\\(?:[A-Za-z@]+|.)/u)?.[0] || "";
}

function readRequiredArgument(text = "", startIndex = 0) {
  const argumentStart = skipLeadingSpacing(text, startIndex);
  const group = readGroup(text, argumentStart);
  if (group) {
    return {
      value: group.value,
      contentStart: group.start + 1,
      contentEnd: group.end - 1,
      start: group.start,
      end: group.end,
      grouped: true,
    };
  }
  const command = readControlSequence(text, argumentStart);
  const atom = command || text[argumentStart] || "";
  return atom ? {
    value: atom,
    contentStart: argumentStart,
    contentEnd: argumentStart + atom.length,
    start: argumentStart,
    end: argumentStart + atom.length,
    grouped: false,
  } : null;
}

const SIZED_DELIMITER_COMMANDS = [
  "\\langle", "\\rangle", "\\lfloor", "\\rfloor", "\\lceil", "\\rceil",
  "\\lvert", "\\rvert", "\\lVert", "\\rVert", "\\Vert", "\\vert", "\\|",
  "\\{", "\\}",
];
const SIZED_DELIMITER_PAIRS = [
  { open: "\\left", close: "\\right" },
  { open: "\\bigl", close: "\\bigr" },
  { open: "\\Bigl", close: "\\Bigr" },
  { open: "\\biggl", close: "\\biggr" },
  { open: "\\Biggl", close: "\\Biggr" },
];

function readSizedDelimiterToken(text = "", startIndex = 0, command = "\\left") {
  if (!text.startsWith(command, startIndex)) return null;
  let delimiterStart = startIndex + command.length;
  while (/\s/u.test(text[delimiterStart] || "")) delimiterStart += 1;
  const delimiter = SIZED_DELIMITER_COMMANDS.find((candidate) => text.startsWith(candidate, delimiterStart))
    || text[delimiterStart]
    || "";
  if (!delimiter) return null;
  return {
    command,
    delimiter,
    start: startIndex,
    delimiterStart,
    end: delimiterStart + delimiter.length,
  };
}

function readSizedDelimited(text = "", startIndex = 0) {
  const pair = SIZED_DELIMITER_PAIRS.find((candidate) => text.startsWith(candidate.open, startIndex));
  if (!pair) return null;
  const open = readSizedDelimiterToken(text, startIndex, pair.open);
  if (!open) return null;
  let depth = 1;
  let cursor = open.end;

  while (cursor < text.length) {
    if (text.startsWith(pair.open, cursor)) {
      const nested = readSizedDelimiterToken(text, cursor, pair.open);
      if (nested) {
        depth += 1;
        cursor = nested.end;
        continue;
      }
    }
    if (text.startsWith(pair.close, cursor)) {
      const close = readSizedDelimiterToken(text, cursor, pair.close);
      if (close) {
        depth -= 1;
        if (depth === 0) {
          return {
            open,
            close,
            value: text.slice(open.end, close.start),
            innerStart: open.end,
            innerEnd: close.start,
            end: close.end,
          };
        }
        cursor = close.end;
        continue;
      }
    }
    cursor += 1;
  }
  return null;
}

function readNameToken(text = "", startIndex = 0) {
  const source = String(text || "").slice(startIndex);
  const operatorNameCommand = source.match(/^\\operatorname\*?/)?.[0] || "";
  if (operatorNameCommand) {
    const nameGroup = readGroup(source, operatorNameCommand.length);
    if (nameGroup?.value.trim()) return source.slice(0, nameGroup.end);
  }
  const command = source.match(/^\\[a-zA-Z@]+/)?.[0];
  if (command) return command;
  return source.match(/^[A-Za-z][A-Za-z0-9]*/)?.[0] || "";
}

function readSpacingToken(text = "", index = 0) {
  const source = String(text || "");
  if (source[index] === "\\" && /\s/u.test(source[index + 1] || "")) return source.slice(index, index + 2);
  if (/\s/.test(source[index] || "")) return source[index];
  for (const command of SPACING_COMMANDS) {
    if (!source.startsWith(command, index)) continue;
    if (/^\\[a-zA-Z]+$/.test(command) && /[a-zA-Z]/.test(source[index + command.length] || "")) continue;
    return command;
  }
  return "";
}

function skipLeadingSpacing(text = "", index = 0) {
  let cursor = index;
  while (cursor < text.length) {
    const spacing = readSpacingToken(text, cursor);
    if (!spacing) break;
    cursor += spacing.length;
  }
  return cursor;
}

function skipTrailingSpacing(text = "", endIndex = text.length) {
  let end = endIndex;
  while (end > 0) {
    if (/\s/.test(text[end - 1] || "")) {
      if (end >= 2 && text[end - 2] === "\\") end -= 1;
      end -= 1;
      continue;
    }
    const command = SPACING_COMMANDS.find((candidate) => text.slice(Math.max(0, end - candidate.length), end) === candidate);
    if (!command) break;
    end -= command.length;
  }
  return end;
}

function trimSourcePart(part) {
  const value = String(part?.value || "");
  const leading = skipLeadingSpacing(value, 0);
  const trailing = skipTrailingSpacing(value, value.length);
  if (trailing <= leading) return { ...part, value: "", start: (part?.start || 0) + leading };
  return {
    ...part,
    value: value.slice(leading, trailing),
    start: (part?.start || 0) + leading,
  };
}

function trimExpressionSource(value = "", start = 0) {
  const source = String(value || "");
  const leading = skipLeadingSpacing(source, 0);
  const trailing = skipTrailingSpacing(source, source.length);
  if (trailing <= leading) return { text: "", start: start + leading };
  return {
    text: source.slice(leading, trailing),
    start: start + leading,
  };
}

function nameTokenDisplayName(name = "") {
  return String(name || "").replace(/^\\/, "");
}

function isLikelyFunctionName(name = "") {
  const bare = nameTokenDisplayName(name);
  if (!bare) return false;
  if (String(name).startsWith("\\")) {
    return !GREEK_COMMANDS.has(bare)
      && !CONSTANT_COMMANDS.has(bare)
      && !OPERATOR_COMMANDS.has(bare)
      && !PRESENTATION_COMMANDS.has(bare);
  }
  return bare.length > 1 || ["f", "g", "h"].includes(bare);
}

function readScriptAtom(text = "", markerIndex = 0) {
  const marker = text[markerIndex];
  if (marker !== "_" && marker !== "^") return null;
  const valueStart = markerIndex + 1;
  const group = readDelimited(text, valueStart);
  if (group) {
    return {
      marker,
      markerStart: markerIndex,
      start: group.start + 1,
      end: group.end - 1,
      value: group.value,
      endIndex: group.end,
    };
  }
  const command = text.slice(valueStart).match(/^\\[a-zA-Z]+/)?.[0];
  const paren = text[valueStart] === "(" ? readGroup(text, valueStart, "(", ")") : null;
  if (paren) {
    return {
      marker,
      markerStart: markerIndex,
      start: paren.start + 1,
      end: paren.end - 1,
      value: paren.value,
      endIndex: paren.end,
    };
  }
  const atom = command || text[valueStart] || "";
  return atom
    ? {
        marker,
        markerStart: markerIndex,
        start: valueStart,
        end: valueStart + atom.length,
        value: atom,
        endIndex: valueStart + atom.length,
      }
    : null;
}

function readScriptsAfter(text = "", startIndex = 0) {
  const scripts = [];
  let index = startIndex;
  while (index < text.length && (text[index] === "_" || text[index] === "^")) {
    const script = readScriptAtom(text, index);
    if (!script) break;
    scripts.push(script);
    index = script.endIndex;
  }
  return { scripts, endIndex: index };
}

function readPrimeSuffixEnd(text = "", startIndex = 0) {
  let index = startIndex;
  while (text[index] === "'") index += 1;
  return index;
}

function readAtomicFactorEnd(text = "", startIndex = 0) {
  const source = String(text || "");
  if (startIndex >= source.length) return -1;
  if (source[startIndex] === "|") {
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    for (let index = startIndex + 1; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") braceDepth += 1;
      else if (char === "}") braceDepth -= 1;
      else if (char === "(") parenDepth += 1;
      else if (char === ")") parenDepth -= 1;
      else if (char === "[") bracketDepth += 1;
      else if (char === "]") bracketDepth -= 1;
      if (char !== "|" || braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) continue;
      const scriptInfo = readScriptsAfter(source, index + 1);
      return scriptInfo.endIndex;
    }
  }
  const sizedDelimited = readSizedDelimited(source, startIndex);
  if (sizedDelimited) {
    return readScriptsAfter(source, sizedDelimited.end).endIndex;
  }
  const delimited = readDelimited(source, startIndex);
  let endIndex = delimited?.end || -1;
  if (endIndex < 0) {
    const command = source.slice(startIndex).match(/^\\[a-zA-Z]+/)?.[0];
    if (command && PRESENTATION_COMMANDS.has(command.slice(1))) {
      const group = readDelimited(source, startIndex + command.length);
      if (group) return group.end;
    }
    const number = source.slice(startIndex).match(new RegExp(`^${NUMBER_LITERAL_SOURCE}`))?.[0];
    const symbol = source.slice(startIndex).match(/^[A-Za-z]/)?.[0];
    endIndex = startIndex + (command || number || symbol || "").length;
  }
  if (endIndex <= startIndex) return -1;
  endIndex = readPrimeSuffixEnd(source, endIndex);
  const scriptInfo = readScriptsAfter(source, endIndex);
  return scriptInfo.endIndex;
}

function readAtomicBaseEnd(text = "", startIndex = 0) {
  const source = String(text || "");
  if (startIndex >= source.length) return -1;
  const sizedDelimited = readSizedDelimited(source, startIndex);
  if (sizedDelimited) return sizedDelimited.end;
  const delimited = readDelimited(source, startIndex);
  if (delimited) return delimited.end;
  const command = readControlSequence(source, startIndex);
  if (command && source[startIndex + command.length] === "{") {
    const argument = readGroup(source, startIndex + command.length);
    if (argument) return argument.end;
  }
  const number = source.slice(startIndex).match(new RegExp(`^${NUMBER_LITERAL_SOURCE}`))?.[0];
  const symbol = source.slice(startIndex).match(/^[A-Za-z]/)?.[0];
  const atom = command || number || symbol || "";
  return atom ? startIndex + atom.length : -1;
}

function trailingNameToken(text = "") {
  const match = String(text || "").match(/(?:\\[a-zA-Z]+|[A-Za-z][A-Za-z0-9]*)$/);
  return match?.[0] || "";
}

function readLeadingFunctionCall(text = "") {
  const name = readNameToken(text, 0);
  if (!name) return null;
  const scriptInfo = readScriptsAfter(text, name.length);
  const argument = readDelimited(text, scriptInfo.endIndex);
  if (!argument) return null;
  const bareName = nameTokenDisplayName(name);
  if (!isLikelyFunctionName(name)
    && !GREEK_COMMANDS.has(bareName)
    && !/^\\operatorname/u.test(name)) return null;
  if (OPERATOR_COMMANDS.has(bareName) || CONSTANT_COMMANDS.has(bareName) || PRESENTATION_COMMANDS.has(bareName)) return null;
  return {
    name,
    nameStart: 0,
    nameEnd: name.length,
    scripts: scriptInfo.scripts,
    argument,
    end: argument.end,
  };
}

function findDifferentials(text = "") {
  const source = String(text || "");
  const matches = [];
  for (let index = 0; index < source.length; index += 1) {
    const hasThinSpace = source.startsWith("\\,", index);
    const dIndex = hasThinSpace ? index + 2 : index;
    if (source[dIndex] !== "d") continue;
    const before = source[index - 1] || "";
    if (!hasThinSpace && /[A-Za-z\\]/.test(before)) continue;
    const variableStart = dIndex + 1;
    const command = source.slice(variableStart).match(/^\\[a-zA-Z]+/)?.[0];
    let variable = command || source[variableStart] || "";
    if (!variable) continue;
    let end = variableStart + variable.length;
    if (command && source[end] === "{") {
      const group = readGroup(source, end);
      if (group) {
        variable = source.slice(variableStart, group.end);
        end = group.end;
      }
    }
    if (!hasThinSpace && !command && /[A-Za-z]/.test(source[end] || "")) continue;
    matches.push({
      index,
      latex: source.slice(index, end),
      0: source.slice(index, end),
    });
    index = end - 1;
  }
  return matches;
}

function findTopLevelOperator(text, operators) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text.startsWith("\\rangle", index)) {
      angleDepth += 1;
      index -= "\\rangle".length - 1;
      continue;
    }
    if (text.startsWith("\\langle", index)) {
      angleDepth -= 1;
      index -= "\\langle".length - 1;
      continue;
    }
    const char = text[index];
    if (char === "}") braceDepth += 1;
    else if (char === "{") braceDepth -= 1;
    else if (char === ")") parenDepth += 1;
    else if (char === "(") parenDepth -= 1;
    else if (char === "]") bracketDepth += 1;
    else if (char === "[") bracketDepth -= 1;
    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || angleDepth !== 0) continue;
    for (const operator of operators) {
      const start = index - operator.length + 1;
      if (start >= 0 && text.slice(start, index + 1) === operator) return start;
    }
  }
  return -1;
}

const KATEX_ATOM_FAMILY_CACHE = new Map();

function katexAtomFamily(latex = "") {
  if (KATEX_ATOM_FAMILY_CACHE.has(latex)) return KATEX_ATOM_FAMILY_CACHE.get(latex);
  let family = "";
  try {
    const parsed = KATEX_INTERNAL.__parse(latex, { strict: "ignore", throwOnError: true });
    if (parsed.length === 1 && parsed[0]?.type === "atom") family = parsed[0].family || "";
  } catch {
    family = "";
  }
  KATEX_ATOM_FAMILY_CACHE.set(latex, family);
  return family;
}

function readRelationAtom(text = "", index = 0) {
  const command = readControlSequence(text, index);
  const candidate = command || text[index] || "";
  return candidate && katexAtomFamily(candidate) === "rel" ? candidate : "";
}

function findTopLevelRelation(text) {
  let braceDepth = 0;
  let delimiterDepth = 0;
  let angleDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("\\langle", index)) {
      angleDepth += 1;
      index += "\\langle".length - 1;
      continue;
    }
    if (text.startsWith("\\rangle", index)) {
      angleDepth -= 1;
      index += "\\rangle".length - 1;
      continue;
    }
    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(" || char === "[") delimiterDepth += 1;
    else if (char === ")" || char === "]") delimiterDepth = Math.max(0, delimiterDepth - 1);
    if (braceDepth !== 0 || delimiterDepth !== 0 || angleDepth !== 0) continue;
    const first = readRelationAtom(text, index);
    if (!first || index === 0) continue;
    let end = index + first.length;
    while (end < text.length) {
      const next = readRelationAtom(text, end);
      if (!next) break;
      end += next.length;
    }
    if (end < text.length) return { index, operator: text.slice(index, end) };
  }
  return null;
}

function findTopLevelSlash(text) {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text.startsWith("\\rangle", index)) {
      angleDepth += 1;
      index -= "\\rangle".length - 1;
      continue;
    }
    if (text.startsWith("\\langle", index)) {
      angleDepth -= 1;
      index -= "\\langle".length - 1;
      continue;
    }
    const char = text[index];
    if (char === "}") braceDepth += 1;
    else if (char === "{") braceDepth -= 1;
    else if (char === ")") parenDepth += 1;
    else if (char === "(") parenDepth -= 1;
    else if (char === "]") bracketDepth += 1;
    else if (char === "[") bracketDepth -= 1;
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0 && char === "/" && text.slice(Math.max(0, index - 5), index) !== "\\frac") {
      return index;
    }
  }
  return -1;
}

function splitTopLevelTerms(text) {
  const terms = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let start = 0;
  let operator = null;
  let operatorIndex = null;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("\\langle", index)) {
      angleDepth += 1;
      index += "\\langle".length - 1;
      continue;
    }
    if (text.startsWith("\\rangle", index)) {
      angleDepth -= 1;
      index += "\\rangle".length - 1;
      continue;
    }
    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || angleDepth !== 0) continue;
    const pmOperator = text.startsWith("\\pm", index);
    const prefix = text.slice(start, index).trim();
    const hasOperandBeforeSign = index > start && !/^[+-]+$/u.test(prefix);
    if (((char === "+" || char === "-") && hasOperandBeforeSign) || (pmOperator && index > start)) {
      terms.push({ value: text.slice(start, index), operator, operatorIndex, start });
      operator = pmOperator ? "\\pm" : char;
      operatorIndex = index;
      start = index + operator.length;
      if (pmOperator) index += operator.length - 1;
    }
  }
  terms.push({ value: text.slice(start), operator, operatorIndex, start });
  return terms.map(trimSourcePart).filter((term) => term.value);
}

function splitCompletedIntegralTerms(text) {
  const terms = splitTopLevelTerms(text);
  if (terms.length < 2 || !readIntegralHead(text)) return terms;
  const grouped = [];
  let current = terms[0];
  for (const next of terms.slice(1)) {
    const head = readIntegralHead(current.value);
    const hasCompletedIntegral = head && findDifferentials(current.value)
      .some((match) => match.index >= head.endIndex);
    if (head && !hasCompletedIntegral) {
      current = {
        ...current,
        value: text.slice(current.start, next.start + next.value.length),
      };
    } else {
      grouped.push(current);
      current = next;
    }
  }
  grouped.push(current);
  return grouped;
}

function splitImplicitProduct(text) {
  const compact = String(text || "");
  const splitAt = (leftStart, leftEnd, rightStart, rightEnd = compact.length) => {
    const left = trimSourcePart({ value: compact.slice(leftStart, leftEnd), start: leftStart });
    const right = trimSourcePart({ value: compact.slice(rightStart, rightEnd), start: rightStart });
    if (!left.value || !right.value) return null;
    if (!hasBalancedGroups(left.value) || !hasBalancedGroups(right.value)) return null;
    return [left, right];
  };

  // A coefficient or symbol immediately followed by an absolute-value factor
  // has no textual separator (`\\alpha|z|^4`). Split that boundary before
  // whitespace inside the absolute value can be mistaken for a product break.
  const leadingAtomEnd = readAtomicFactorEnd(compact, 0);
  if (leadingAtomEnd === compact.length) return null;
  if (compact[0] === "|" && leadingAtomEnd > 0) {
    const split = splitAt(0, leadingAtomEnd, leadingAtomEnd);
    if (split) return split;
  }
  if (leadingAtomEnd > 0 && compact[leadingAtomEnd] === "|") {
    const split = splitAt(0, leadingAtomEnd, leadingAtomEnd);
    if (split) return split;
  }
  if (leadingAtomEnd > 0) {
    const callable = readLeadingFunctionCall(compact) || readLeadingFunctionFactor(compact);
    if (!callable || callable.end <= leadingAtomEnd) {
      const split = splitAt(0, leadingAtomEnd, leadingAtomEnd);
      if (split) return split;
    }
  }

  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) continue;

    const explicit = compact.startsWith("\\cdot", index) ? "\\cdot" : "";
    const spacing = readSpacingToken(compact, index);
    const separator = explicit || spacing;
    if (!separator) continue;
    if (!explicit) {
      const leftName = trailingNameToken(compact.slice(0, index));
      if (leftName && isLikelyFunctionName(leftName)) {
        index += separator.length - 1;
        continue;
      }
    }
    const rightStart = skipLeadingSpacing(compact, index + separator.length);
    const split = splitAt(0, index, rightStart);
    if (split) return split;
    index += separator.length - 1;
  }

  const leadingDelimited = readDelimited(compact, 0);
  if (leadingDelimited?.end > 0 && leadingDelimited.end < compact.length) {
    const scriptInfo = readScriptsAfter(compact, leadingDelimited.end);
    if (scriptInfo.scripts.length > 0 && scriptInfo.endIndex < compact.length) {
      const split = splitAt(0, scriptInfo.endIndex, scriptInfo.endIndex);
      if (split) return split;
    }
  }
  const leadingCall = readLeadingFunctionCall(compact);
  if (leadingCall && leadingCall.end > 0 && leadingCall.end < compact.length) {
    const split = splitAt(0, leadingCall.end, leadingCall.end);
    if (split) return split;
  }
  const leadingFunctionFactor = readLeadingFunctionFactor(compact);
  if (leadingFunctionFactor && leadingFunctionFactor.end > 0 && leadingFunctionFactor.end < compact.length) {
    const split = splitAt(0, leadingFunctionFactor.end, leadingFunctionFactor.end);
    if (split) return split;
  }
  const symbolRoot = compact.match(/^([a-zA-Z]|\\(?:theta|phi|rho|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega))(\\sqrt(?:\{.+\}|[a-zA-Z0-9].*))$/);
  if (symbolRoot && hasBalancedGroups(symbolRoot[1]) && hasBalancedGroups(symbolRoot[2])) {
    const split = splitAt(0, symbolRoot[1].length, symbolRoot[1].length);
    if (split) return split;
  }
  const groupRoot = compact.match(/^(\([^)]+\))(\\sqrt(?:\{.+\}|[a-zA-Z0-9].*))$/);
  if (groupRoot && hasBalancedGroups(groupRoot[1]) && hasBalancedGroups(groupRoot[2])) {
    const split = splitAt(0, groupRoot[1].length, groupRoot[1].length);
    if (split) return split;
  }
  const groupSymbol = compact.match(/^(\(.+\))(\\[a-zA-Z]+|[a-zA-Z])$/);
  if (groupSymbol && hasBalancedGroups(groupSymbol[1]) && hasBalancedGroups(groupSymbol[2])) {
    const split = splitAt(0, groupSymbol[1].length, groupSymbol[1].length);
    if (split) return split;
  }
  const symbolGroup = compact.match(/^((?:\\[a-zA-Z]+|[a-zA-Z]))(\(.+\)|\[.+\])$/);
  if (symbolGroup && !isLikelyFunctionName(symbolGroup[1]) && hasBalancedGroups(symbolGroup[1]) && hasBalancedGroups(symbolGroup[2])) {
    const split = splitAt(0, symbolGroup[1].length, symbolGroup[1].length);
    if (split) return split;
  }
  const leadingNumber = compact.match(new RegExp(`^(${NUMBER_LITERAL_SOURCE})(?=[a-zA-Z\\\\(])`));
  if (leadingNumber && leadingNumber[1].length < compact.length) {
    const split = splitAt(0, leadingNumber[1].length, leadingNumber[1].length);
    if (split) return split;
  }
  const numberVariable = compact.match(new RegExp(`^(${NUMBER_LITERAL_SOURCE})(\\\\[a-zA-Z]+|[a-zA-Z])$`));
  if (numberVariable) return splitAt(0, numberVariable[1].length, numberVariable[1].length);
  const numberFunction = compact.match(new RegExp(`^(${NUMBER_LITERAL_SOURCE})(\\\\?[a-zA-Z][a-zA-Z0-9]*\\(.+\\))$`));
  if (numberFunction && readLeadingFunctionCall(numberFunction[2])) return splitAt(0, numberFunction[1].length, numberFunction[1].length);
  const symbolSymbol = compact.match(/^(\\(?:theta|phi|rho|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega)|[a-zA-Z])(\\(?:theta|phi|rho|pi|alpha|beta|gamma|delta|lambda|mu|sigma|omega)|[a-zA-Z])$/);
  if (symbolSymbol) return splitAt(0, symbolSymbol[1].length, symbolSymbol[1].length);

  const firstAtomEnd = readAtomicFactorEnd(compact, 0);
  if (firstAtomEnd > 0 && firstAtomEnd < compact.length) {
    const split = splitAt(0, firstAtomEnd, firstAtomEnd);
    if (split) return split;
  }
  return null;
}

const EXPLICIT_PRODUCT_OPERATORS = ["\\otimes", "\\cdot", "\\times", "\\circ", "\\bullet"];

function splitExplicitProduct(text = "") {
  const source = String(text || "");
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) continue;
    const operator = EXPLICIT_PRODUCT_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!operator || index === 0 || index + operator.length >= source.length) continue;
    const left = trimSourcePart({ value: source.slice(0, index), start: 0 });
    const right = trimSourcePart({ value: source.slice(index + operator.length), start: index + operator.length });
    if (!left.value || !right.value || !hasBalancedGroups(left.value) || !hasBalancedGroups(right.value)) continue;
    return { left, operator, operatorIndex: index, right };
  }
  return null;
}

function tokenTypeForLatex(latex = "") {
  if (NUMBER_LITERAL_PATTERN.test(latex)) return { type: "number", role: "constant" };
  if (latex === "i") return { type: "symbol", role: "imaginaryUnit" };
  if (/^\\mathbf\{?[a-zA-Z]\}?$/.test(latex)) return { type: "symbol", role: "variable" };
  if (/^\\[a-zA-Z]+$/.test(latex)) {
    const command = latex.slice(1);
    if (GREEK_COMMANDS.has(command) || CONSTANT_COMMANDS.has(command)) return { type: "symbol", role: CONSTANT_COMMANDS.has(command) ? "constant" : "variable" };
    if (FUNCTION_COMMANDS.has(command)) return { type: "function", role: "function" };
  }
  if (/^[a-zA-Z]$/.test(latex)) return { type: "symbol", role: "variable" };
  if (/^(=|\+|-|\/|\^|_|,|\(|\)|\[|\]|\{|\}|\\le|\\ge|\\approx|\\pm|<|>)$/.test(latex)) {
    return { type: "operator", role: latex === "=" ? "equality" : latex === "\\approx" ? "approximation" : "operator" };
  }
  return { type: "atom", role: "factor" };
}

function splitVectorComponents(text = "") {
  const components = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    if (braceDepth === 0 && parenDepth === 0 && char === ",") {
      components.push({ value: text.slice(start, index), start });
      start = index + 1;
    }
  }
  components.push({ value: text.slice(start), start });
  return components
    .map(trimSourcePart)
    .filter((component) => component.value);
}

function splitTopLevelCommas(text = "") {
  const parts = [];
  let braceDepth = 0;
  let delimiterDepth = 0;
  let angleDepth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.startsWith("\\langle", index)) {
      angleDepth += 1;
      index += "\\langle".length - 1;
      continue;
    }
    if (text.startsWith("\\rangle", index)) {
      angleDepth -= 1;
      index += "\\rangle".length - 1;
      continue;
    }
    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(" || char === "[") delimiterDepth += 1;
    else if (char === ")" || char === "]") delimiterDepth = Math.max(0, delimiterDepth - 1);
    if (braceDepth === 0 && delimiterDepth === 0 && angleDepth === 0 && char === "," && text[index - 1] !== "\\") {
      parts.push({ value: text.slice(start, index), start, commaIndex: index });
      start = index + 1;
    }
  }
  parts.push({ value: text.slice(start), start, commaIndex: null });
  return parts
    .map(trimSourcePart)
    .filter((part) => part.value);
}

function hasBalancedGroups(text = "") {
  const braceStack = [];
  let delimiterDepth = 0;
  for (const char of String(text || "")) {
    if (char === "{") braceStack.push("}");
    else if (char === "}") {
      if (braceStack.pop() !== char) return false;
    } else if (braceStack.length === 0 && (char === "(" || char === "[")) delimiterDepth += 1;
    else if (braceStack.length === 0 && (char === ")" || char === "]")) delimiterDepth -= 1;
    if (delimiterDepth < 0) return false;
  }
  return braceStack.length === 0 && delimiterDepth === 0;
}

function createBuilder(stepId, displayLatex) {
  const nodes = new Map();
  const idCounts = new Map();
  const createNode = ({ type, role, latex, parentId = null, childIds = [], depth = 0, start = null, end = null }) => {
    const suffix = cleanIdPart(latex || role || type || "node");
    const rangeSuffix = Number.isFinite(start) && Number.isFinite(end) ? `${start}-${end}` : `${depth}`;
    const idBase = `${stepId}.${role || type}.${suffix}.${rangeSuffix}`;
    const duplicateCount = idCounts.get(idBase) || 0;
    idCounts.set(idBase, duplicateCount + 1);
    const id = duplicateCount ? `${idBase}.${duplicateCount}` : idBase;
    const node = {
      id,
      stepId,
      type,
      role,
      latex: String(latex || ""),
      text: String(latex || ""),
      display: String(latex || ""),
      source: String(latex || ""),
      normalizedSource: String(latex || ""),
      parentId,
      childIds,
      depth,
      leafStart: null,
      leafEnd: null,
      order: null,
      sourceRange: Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      short: null,
      medium: null,
      deep: null,
    };
    nodes.set(id, node);
    return node;
  };
  return { stepId, displayLatex, nodes, createNode };
}

function parseIntegralScripts(integralLatex = "") {
  const operator = integralLatex.match(/^\\(?:iiint|iint|oint|int)/)?.[0] || integralLatex;
  const scriptInfo = readScriptsAfter(integralLatex, operator.length);
  const scripts = scriptInfo.scripts.map((script) => ({
    role: script.marker === "_" ? "lowerBound" : "upperBound",
    latex: script.value,
    start: script.start,
    end: script.end,
    markerStart: script.markerStart,
  }));

  return { operator, scripts, endIndex: scriptInfo.endIndex };
}

const INTEGRAL_COMMANDS = ["\\iiint", "\\iint", "\\oint", "\\int"];

function findTopLevelIntegralOperator(text = "") {
  const source = String(text || "");
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const command = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0
      ? INTEGRAL_COMMANDS.find((candidate) => source.startsWith(candidate, index))
      : null;
    if (command) return { index, operator: command };

    const char = source[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
  }
  return null;
}

function readIntegralHead(text = "") {
  const source = String(text || "");
  const operatorMatch = findTopLevelIntegralOperator(source);
  if (!operatorMatch) return null;
  const { index, operator } = operatorMatch;
  const leading = source.slice(0, index);
  const scriptInfo = readScriptsAfter(source, index + operator.length);
  const integralLatex = source.slice(index, scriptInfo.endIndex);
  const scripts = parseIntegralScripts(integralLatex).scripts;
  return {
    leading,
    operator,
    operatorIndex: index,
    integralLatex,
    scripts,
    endIndex: scriptInfo.endIndex,
    tail: source.slice(scriptInfo.endIndex),
  };
}

function readLeadingFunctionFactor(text = "") {
  const source = String(text || "");
  let name = readNameToken(source, 0);
  if (!name || !isLikelyFunctionName(name)) name = readKnownFunctionPrefix(source);
  if (!name || !isLikelyFunctionName(name)) return null;

  const scriptInfo = readScriptsAfter(source, name.length);
  const argumentStart = skipLeadingSpacing(source, scriptInfo.endIndex);
  if (argumentStart >= source.length) return null;
  const delimitedArgument = readDelimited(source, argumentStart);
  if (delimitedArgument) {
    return {
      name,
      nameStart: 0,
      nameEnd: name.length,
      scripts: scriptInfo.scripts,
      argument: delimitedArgument,
      end: delimitedArgument.end,
    };
  }

  const nestedFunction = readLeadingFunctionFactor(source.slice(argumentStart));
  const argumentEnd = nestedFunction
    ? argumentStart + nestedFunction.end
    : readAtomicFactorEnd(source, argumentStart);
  if (argumentEnd <= argumentStart) return null;
  return {
    name,
    nameStart: 0,
    nameEnd: name.length,
    scripts: scriptInfo.scripts,
    argument: {
      value: source.slice(argumentStart, argumentEnd),
      start: argumentStart,
      end: argumentEnd,
    },
    end: argumentEnd,
  };
}

function createDifferentialNode(builder, rawLatex, parentId, depth, start, end, role = "differential") {
  const latex = String(rawLatex || "").replace(/^\\,/, "");
  const visibleOffset = String(rawLatex || "").length - latex.length;
  const visibleStart = start + visibleOffset;
  const node = builder.createNode({ type: "differential", role, latex, parentId, depth, start: visibleStart, end });
  const dIndex = latex.indexOf("d");
  const variableLatex = dIndex >= 0 ? latex.slice(dIndex + 1) : "";
  const childIds = [];
  if (dIndex >= 0) {
    childIds.push(builder.createNode({
      type: "operator",
      role: "differentialOperator",
      latex: "d",
      parentId: node.id,
      depth: depth + 1,
      start: visibleStart + dIndex,
      end: visibleStart + dIndex + 1,
    }).id);
  }
  if (variableLatex) {
    childIds.push(parseExpression(builder, variableLatex, node.id, depth + 1, visibleStart + dIndex + 1, "variable")?.id);
  }
  node.childIds = childIds.filter(Boolean);
  return node;
}

function parseDelimitedExpression(builder, text, parentId, depth, start, role) {
  if (!text || text.length < 2) return null;
  const open = text[0];
  const close = text[text.length - 1];
  if (!(open === "(" || open === "[") || !(close === ")" || close === "]")) {
    if (open !== "{" || close !== "}") return null;
  }
  const group = open === "{" ? readDelimited(text, 0) : null;
  if (open === "{" && (!group || group.end !== text.length)) return null;
  if (open !== "{") {
    let delimiterDepth = 0;
    let braceDepth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") braceDepth += 1;
      else if (char === "}") braceDepth -= 1;
      else if (braceDepth === 0 && (char === "(" || char === "[")) delimiterDepth += 1;
      else if (braceDepth === 0 && (char === ")" || char === "]")) delimiterDepth -= 1;
      if (delimiterDepth === 0 && index < text.length - 1) return null;
    }
    if (delimiterDepth !== 0) return null;
  }
  const innerValue = text.slice(1, -1);
  const nodeType = open === "(" ? "parenthesized" : open === "[" ? "delimited" : "group";
  const nodeRole = open === "("
    ? (role === "expression" || role === "term" || role === "factor" ? "parenthesized" : role)
    : (role === "expression" || role === "term" || role === "factor" ? "delimited" : role);
  const innerRole = ["denominator", "numerator", "factor", "base", "argument"].includes(role)
    ? role
    : "expression";
  const node = builder.createNode({ type: nodeType, role: nodeRole, latex: text, parentId, depth, start, end: start + text.length });
  const inner = parseExpression(builder, innerValue, node.id, depth + 1, start + 1, innerRole);
  if (open === "(" && close === ")") {
    node.childIds = [inner?.id].filter(Boolean);
    return node;
  }
  const openNode = builder.createNode({ type: "operator", role: "delimiter", latex: open, parentId: node.id, depth: depth + 1, start, end: start + 1 });
  const closeNode = builder.createNode({ type: "operator", role: "delimiter", latex: close, parentId: node.id, depth: depth + 1, start: start + text.length - 1, end: start + text.length });
  node.childIds = [openNode.id, inner?.id, closeNode.id].filter(Boolean);
  return node;
}

function parseAbsoluteValueExpression(builder, text, parentId, depth, start, role) {
  if (!text.startsWith("|") || !text.endsWith("|") || text.length < 3) return null;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (char === "|" && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) return null;
  }
  const node = builder.createNode({
    type: "absoluteValue",
    role: role === "expression" || role === "term" || role === "factor" || role === "base" ? "absoluteValue" : role,
    latex: text,
    parentId,
    depth,
    start,
    end: start + text.length,
  });
  const open = builder.createNode({ type: "operator", role: "delimiter", latex: "|", parentId: node.id, depth: depth + 1, start, end: start + 1 });
  const inner = parseExpression(builder, text.slice(1, -1), node.id, depth + 1, start + 1, "argument");
  const close = builder.createNode({ type: "operator", role: "delimiter", latex: "|", parentId: node.id, depth: depth + 1, start: start + text.length - 1, end: start + text.length });
  node.childIds = [open.id, inner?.id, close.id].filter(Boolean);
  return node;
}

function parseFractionExpression(builder, text, parentId, depth, start, role) {
  if (!text.startsWith("\\frac")) return null;
  const numerator = readRequiredArgument(text, "\\frac".length);
  const denominator = numerator ? readRequiredArgument(text, numerator.end) : null;
  if (!numerator || !denominator) return null;

  if (denominator.end < text.length) {
    const node = builder.createNode({
      type: "product",
      role: role === "expression" ? "term" : role,
      latex: text,
      parentId,
      depth,
      start,
      end: start + text.length,
    });
    const first = parseExpression(builder, text.slice(0, denominator.end), node.id, depth + 1, start, "factor");
    const secondStart = skipLeadingSpacing(text, denominator.end);
    const second = parseExpression(builder, text.slice(secondStart), node.id, depth + 1, start + secondStart, "factor");
    node.childIds = [first?.id, second?.id].filter(Boolean);
    return node;
  }

  const node = builder.createNode({
    type: "fraction",
    role: role === "expression" || role === "term" ? "fraction" : role,
    latex: text,
    parentId,
    depth,
    start,
    end: start + text.length,
  });
  const top = parseExpression(builder, numerator.value, node.id, depth + 1, start + numerator.contentStart, "numerator");
  const bottom = parseExpression(builder, denominator.value, node.id, depth + 1, start + denominator.contentStart, "denominator");
  if (top) top.role = "numerator";
  if (bottom) bottom.role = "denominator";
  const childIds = [top?.id];
  if (numerator.grouped && denominator.grouped) {
    const bar = builder.createNode({
      type: "operator",
      role: "fractionBar",
      latex: "/",
      parentId: node.id,
      depth: depth + 1,
      start: start + numerator.contentEnd,
      end: start + denominator.contentStart,
    });
    bar.source = text.slice(numerator.contentEnd, denominator.contentStart);
    bar.normalizedSource = "/";
    childIds.push(bar.id);
  }
  childIds.push(bottom?.id);
  node.childIds = childIds.filter(Boolean);
  return node;
}

function parseScriptedExpression(builder, text, parentId, depth, start, role) {
  const exponentIndex = findTopLevelOperator(text, ["^"]);
  if (exponentIndex > 0) {
    const exponent = readScriptAtom(text, exponentIndex);
    if (!exponent || exponent.endIndex !== text.length) return null;
    const node = builder.createNode({
      type: "power",
      role: "power",
      latex: text,
      parentId,
      depth,
      start,
      end: start + text.length,
    });
    const base = parseExpression(builder, text.slice(0, exponentIndex), node.id, depth + 1, start, "base");
    const marker = builder.createNode({
      type: "operator",
      role: "operator",
      latex: "^",
      parentId: node.id,
      depth: depth + 1,
      start: start + exponentIndex,
      end: start + exponentIndex + 1,
    });
    const exponentNode = parseExpression(builder, exponent.value, node.id, depth + 1, start + exponent.start, "exponent");
    node.childIds = [base?.id, marker.id, exponentNode?.id].filter(Boolean);
    return node;
  }

  const baseEnd = readAtomicBaseEnd(text, 0);
  if (baseEnd <= 0 || baseEnd >= text.length) return null;
  const scriptInfo = readScriptsAfter(text, baseEnd);
  if (scriptInfo.scripts.length === 1 && scriptInfo.scripts[0].marker === "_" && scriptInfo.endIndex === text.length) {
    return builder.createNode({
      type: "subscript",
      role: role === "expression" ? "variable" : role,
      latex: text,
      parentId,
      depth,
      start,
      end: start + text.length,
    });
  }
  return null;
}

function parseCommandApplication(builder, text, parentId, depth, start, role) {
  const command = readControlSequence(text, 0);
  if (!command) return null;
  const argument = readRequiredArgument(text, command.length);
  if (!argument?.grouped || argument.end !== text.length) return null;
  try {
    const parsed = KATEX_INTERNAL.__parse(text, { strict: "ignore", throwOnError: true });
    if (parsed.length !== 1 || parsed[0]?.type !== "accent") return null;
  } catch {
    return null;
  }
  const node = builder.createNode({
    type: "commandApplication",
    role: role === "expression" || role === "term" || role === "factor" ? "decorated" : role,
    latex: text,
    parentId,
    depth,
    start,
    end: start + text.length,
  });
  const argumentNode = parseExpression(builder, argument.value, node.id, depth + 1, start + argument.contentStart, "argument");
  node.childIds = [argumentNode?.id].filter(Boolean);
  return node;
}

function isEvaluationBarDelimiter(delimiter = "") {
  return ["|", "\\|", "\\vert", "\\Vert", "\\rvert", "\\rVert"].includes(delimiter);
}

function sizedDelimiterRole(delimiter = "") {
  if (delimiter === "(") return "parenthesized";
  if (delimiter === "[") return "delimited";
  if (delimiter === "\\{" || delimiter === "{") return "group";
  if (isEvaluationBarDelimiter(delimiter)) return "absoluteValue";
  return "delimited";
}

function createSizedDelimiterNode(builder, token, parentId, depth, start) {
  return builder.createNode({
    type: "operator",
    role: "delimiter",
    latex: token.delimiter,
    parentId,
    depth,
    start: start + token.delimiterStart,
    end: start + token.end,
  });
}

function parseSizedDelimitedExpression(builder, text, parentId, depth, start, role) {
  const sized = readSizedDelimited(text, 0);
  if (!sized) return null;
  const scriptInfo = readScriptsAfter(text, sized.end);
  const isEvaluation = sized.open.delimiter === "."
    && isEvaluationBarDelimiter(sized.close.delimiter)
    && scriptInfo.scripts.some((script) => script.marker === "_")
    && scriptInfo.endIndex === text.length;
  if (!isEvaluation && sized.end !== text.length) return null;
  const node = builder.createNode({
    type: isEvaluation ? "evaluation" : "sizedDelimited",
    role: isEvaluation
      ? "evaluation"
      : (role === "expression" || role === "term" || role === "factor"
        ? sizedDelimiterRole(sized.open.delimiter)
        : role),
    latex: text,
    parentId,
    depth,
    start,
    end: start + text.length,
  });
  const open = createSizedDelimiterNode(builder, sized.open, node.id, depth + 1, start);
  const inner = parseExpression(
    builder,
    sized.value,
    node.id,
    depth + 1,
    start + sized.innerStart,
    isEvaluation ? "evaluatedExpression" : "expression",
  );
  const close = createSizedDelimiterNode(builder, sized.close, node.id, depth + 1, start);
  if (isEvaluation) {
    close.role = "evaluationBar";
    close.latex = sized.close.delimiter;
  }

  const childIds = [open.id, inner?.id, close.id].filter(Boolean);
  for (const script of scriptInfo.scripts) {
    const scriptRole = script.marker === "_" ? "evaluationCondition" : "evaluationSuperscript";
    const scriptNode = parseExpression(
      builder,
      script.value,
      node.id,
      depth + 1,
      start + script.start,
      scriptRole,
    );
    if (scriptNode) {
      scriptNode.role = scriptRole;
      childIds.push(scriptNode.id);
    }
  }
  node.childIds = childIds;
  return node;
}

function splitEnvironmentRows(body = "") {
  const rows = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && body.startsWith("\\\\", index)) {
      rows.push({ value: body.slice(start, index), start });
      index += 1;
      start = index + 1;
    }
  }
  rows.push({ value: body.slice(start), start });
  return rows.filter((row) => row.value.length > 0);
}

function splitEnvironmentCells(rowText = "") {
  const cells = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let index = 0; index < rowText.length; index += 1) {
    const char = rowText[index];
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && char === "&") {
      cells.push({ value: rowText.slice(start, index), start });
      start = index + 1;
    }
  }
  cells.push({ value: rowText.slice(start), start });
  return cells.filter((cell) => cell.value.length > 0);
}

function parseEnvironment(builder, text, parentId, depth, start, role) {
  const match = text.match(/^\\begin\{(matrix|pmatrix|bmatrix|vmatrix|cases)\}([\s\S]+)\\end\{\1\}$/);
  if (!match) return null;
  const [, environment, body] = match;
  const bodyStart = text.indexOf(body);
  const isCases = environment === "cases";
  const node = builder.createNode({
    type: isCases ? "cases" : "matrix",
    role: isCases ? "cases" : (role === "expression" ? "matrix" : role),
    latex: text,
    parentId,
    depth,
    start,
    end: start + text.length,
  });
  node.environment = environment;
  node.childIds = splitEnvironmentRows(body).map((row, rowIndex) => {
    const rowNode = builder.createNode({
      type: isCases ? "caseRow" : "matrixRow",
      role: isCases ? "caseRow" : "matrixRow",
      latex: row.value,
      parentId: node.id,
      depth: depth + 1,
      start: start + bodyStart + row.start,
      end: start + bodyStart + row.start + row.value.length,
    });
    rowNode.rowIndex = rowIndex;
    rowNode.childIds = splitEnvironmentCells(row.value).map((cell, cellIndex) => {
      const cellNode = builder.createNode({
        type: isCases ? (cellIndex === 0 ? "caseExpression" : "caseCondition") : "matrixCell",
        role: isCases ? (cellIndex === 0 ? "caseExpression" : "caseCondition") : "matrixCell",
        latex: cell.value,
        parentId: rowNode.id,
        depth: depth + 2,
        start: start + bodyStart + row.start + cell.start,
        end: start + bodyStart + row.start + cell.start + cell.value.length,
      });
      cellNode.rowIndex = rowIndex;
      cellNode.columnIndex = cellIndex;
      const parsed = parseExpression(builder, cell.value, cellNode.id, depth + 3, start + bodyStart + row.start + cell.start, "expression");
      cellNode.childIds = [parsed?.id].filter(Boolean);
      return cellNode.id;
    });
    return rowNode.id;
  });
  return node;
}

function parseDerivative(builder, text, parentId, depth, start, role) {
  const ordinary = text.match(/^d\/d(\\[a-zA-Z]+|[a-zA-Z])(.+)$/);
  if (ordinary) {
    const [, variable, argumentRaw] = ordinary;
    const derivativeHead = `d/d${variable}`;
    const operatorLatex = "d/d";
    const argumentStart = skipLeadingSpacing(text, derivativeHead.length);
    const argumentGroup = readDelimited(text, argumentStart);
    const argumentLatex = argumentGroup ? argumentGroup.value : stripOuterParens(argumentRaw);
    const argumentOffset = argumentGroup ? argumentGroup.start + 1 : text.indexOf(argumentRaw);
    const node = builder.createNode({ type: "derivative", role: role === "expression" ? "derivative" : role, latex: text, parentId, depth, start, end: start + text.length });
    const operator = builder.createNode({ type: "operator", role: "differentialOperator", latex: operatorLatex, parentId: node.id, depth: depth + 1, start, end: start + operatorLatex.length });
    const variableNode = parseExpression(builder, variable, node.id, depth + 1, start + "d/d".length, "derivativeVariable");
    const argument = parseExpression(builder, argumentLatex, node.id, depth + 1, start + argumentOffset, "argument");
    if (argument) argument.role = "argument";
    node.childIds = [operator.id, variableNode?.id, argument?.id].filter(Boolean);
    return node;
  }

  const partial = text.match(/^\\partial(?:\^(\{?[^{}]+\}?))?(.+)\/\\partial(.+)$/);
  if (partial) {
    const [, orderRaw = "", functionRaw, variablesRaw] = partial;
    const operatorEnd = "\\partial".length + (orderRaw ? 1 + orderRaw.length : 0);
    const node = builder.createNode({ type: "partialDerivative", role: role === "expression" ? "partialDerivative" : role, latex: text, parentId, depth, start, end: start + text.length });
    const operator = builder.createNode({ type: "operator", role: "differentialOperator", latex: text.slice(0, operatorEnd), parentId: node.id, depth: depth + 1, start, end: start + operatorEnd });
    const childIds = [operator.id];
    if (orderRaw) {
      const orderLatex = orderRaw.replace(/^\{|\}$/g, "");
      childIds.push(parseExpression(builder, orderLatex, node.id, depth + 1, start + "\\partial^".length + (orderRaw.startsWith("{") ? 1 : 0), "order")?.id);
    }
    const functionStart = operatorEnd;
    childIds.push(parseExpression(builder, functionRaw, node.id, depth + 1, start + functionStart, "function")?.id);
    const variableTextStart = text.indexOf(variablesRaw);
    let cursor = 0;
    for (const variable of variablesRaw.split(/\\partial/).filter(Boolean)) {
      const offset = variablesRaw.indexOf(variable, cursor);
      cursor = offset + variable.length;
      childIds.push(parseExpression(builder, variable, node.id, depth + 1, start + variableTextStart + offset, "derivativeVariable")?.id);
    }
    node.childIds = childIds.filter(Boolean);
    return node;
  }

  return null;
}

function parseLargeOperator(builder, text, parentId, depth, start, role) {
  const operator = text.match(/^(?:\\(?:sum|prod|lim|inf|sup|min|max)|lim)(?![A-Za-z])/)?.[0];
  if (!operator) return null;
  const { scripts, endIndex } = readScriptsAfter(text, operator.length);
  const body = text.slice(endIndex);
  const operatorName = operator.slice(1);
  const type = operatorName === "sum"
    ? "summation"
    : operatorName === "prod"
      ? "productNotation"
      : ["inf", "sup", "min", "max"].includes(operatorName)
        ? "extremum"
        : "limit";
  const nodeRole = role === "expression" || role === "term" ? type : role;
  const node = builder.createNode({ type, role: nodeRole, latex: text, parentId, depth, start, end: start + text.length });
  const operatorHead = builder.createNode({
    type: "operatorHead",
    role: "operatorHead",
    latex: text.slice(0, endIndex),
    parentId: node.id,
    depth: depth + 1,
    start,
    end: start + endIndex,
  });
  const headChildIds = [builder.createNode({
    type: "operator",
    role: operatorName === "sum"
      ? "summationOperator"
      : operatorName === "prod"
        ? "productOperator"
        : ["inf", "sup", "min", "max"].includes(operatorName)
          ? "extremumOperator"
          : "limitOperator",
    latex: operator,
    parentId: operatorHead.id,
    depth: depth + 2,
    start,
    end: start + operator.length,
  }).id];
  for (const script of scripts) {
    const scriptRole = ["lim", "inf", "sup", "min", "max"].includes(operatorName)
      ? "bound"
      : script.marker === "_" ? "lowerBound" : "upperBound";
    headChildIds.push(parseExpression(builder, script.value, operatorHead.id, depth + 2, start + script.start, scriptRole)?.id);
  }
  operatorHead.childIds = headChildIds.filter(Boolean);
  const childIds = [operatorHead.id];
  if (body) {
    const bodyRole = operatorName === "sum" ? "summand" : operatorName === "prod" ? "productBody" : "argument";
    const bodyNode = parseExpression(
      builder,
      body,
      node.id,
      depth + 1,
      start + endIndex,
      bodyRole
    );
    if (bodyNode) {
      bodyNode.role = bodyRole;
      childIds.push(bodyNode.id);
    }
  }
  node.childIds = childIds.filter(Boolean);
  return node;
}

function parseIntegralExpression(builder, text, parentId, depth, start, role) {
  const differentialMatches = findDifferentials(text);
  const integralHead = readIntegralHead(text);
  if (!integralHead) return null;

  const firstDifferential = differentialMatches.find((match) => match.index >= integralHead.endIndex);
  const integrand = firstDifferential
    ? text.slice(integralHead.endIndex, firstDifferential.index)
    : integralHead.tail;
  const node = builder.createNode({ type: "integral", role: role === "expression" || role === "term" || role === "numerator" ? "integral" : role, latex: text, parentId, depth, start, end: start + text.length });
  const childIds = [];
  if (integralHead.leading) {
    const coefficient = parseExpression(builder, integralHead.leading, node.id, depth + 1, start, "coefficient");
    if (coefficient) childIds.push(coefficient.id);
  }
  const headStart = start + integralHead.operatorIndex;
  const operatorHead = builder.createNode({
    type: "operatorHead",
    role: "operatorHead",
    latex: text.slice(integralHead.operatorIndex, integralHead.endIndex),
    parentId: node.id,
    depth: depth + 1,
    start: headStart,
    end: start + integralHead.endIndex,
  });
  const headChildIds = [builder.createNode({
    type: "operator",
    role: "integralSymbol",
    latex: integralHead.operator,
    parentId: operatorHead.id,
    depth: depth + 2,
    start: headStart,
    end: headStart + integralHead.operator.length,
  }).id];
  for (const script of integralHead.scripts) {
    const bound = parseExpression(
      builder,
      script.latex,
      operatorHead.id,
      depth + 2,
      start + integralHead.operatorIndex + script.start,
      script.role
    );
    if (bound) {
      bound.role = script.role;
      headChildIds.push(bound.id);
    }
  }
  operatorHead.childIds = headChildIds;
  childIds.push(operatorHead.id);
  const integrandStart = start + integralHead.endIndex;
  const integrandNode = integrand
    ? parseExpression(builder, integrand, node.id, depth + 1, integrandStart, "integrand")
    : null;
  if (integrandNode) childIds.push(integrandNode.id);
  for (const differential of differentialMatches.filter((match) => match.index >= integralHead.endIndex)) {
    childIds.push(createDifferentialNode(
      builder,
      differential.latex,
      node.id,
      depth + 1,
      start + differential.index,
      start + differential.index + differential.latex.length
    ).id);
  }
  node.childIds = childIds;
  return node;
}

function parseGenericFunctionCall(builder, text, parentId, depth, start, role) {
  const call = readLeadingFunctionCall(text);
  if (call && call.end !== text.length) return null;
  if (!call) {
    const factor = readLeadingFunctionFactor(text);
    if (!factor || factor.end !== text.length) return null;
    const name = factor.name;
    const scriptInfo = { scripts: factor.scripts };
    const argumentLatex = factor.argument.value;
    const node = builder.createNode({ type: "functionCall", role: role === "expression" || role === "term" || role === "factor" ? "function" : role, latex: text, parentId, depth, start, end: start + text.length });
    const childIds = [builder.createNode({
      type: "function",
      role: "functionName",
      latex: name,
      parentId: node.id,
      depth: depth + 1,
      start,
      end: start + name.length,
    }).id];
    for (const script of scriptInfo.scripts) {
      const scriptRole = script.marker === "^" ? "exponent" : "subscript";
      childIds.push(builder.createNode({
        type: "operator",
        role: "operator",
        latex: script.marker,
        parentId: node.id,
        depth: depth + 1,
        start: start + script.markerStart,
        end: start + script.markerStart + 1,
      }).id);
      childIds.push(parseExpression(builder, script.value, node.id, depth + 1, start + script.start, scriptRole)?.id);
    }
    const argument = parseExpression(builder, argumentLatex, node.id, depth + 1, start + factor.argument.start, "argument");
    node.childIds = [childIds, argument?.id].flat().filter(Boolean);
    return node;
  }
  const node = builder.createNode({ type: "functionCall", role: role === "expression" || role === "term" || role === "factor" ? "function" : role, latex: text, parentId, depth, start, end: start + text.length });
  const childIds = [builder.createNode({
    type: "function",
    role: "functionName",
    latex: call.name,
    parentId: node.id,
    depth: depth + 1,
    start: start + call.nameStart,
    end: start + call.nameEnd,
  }).id];
  for (const script of call.scripts) {
    const scriptRole = script.marker === "^" ? "exponent" : "subscript";
    childIds.push(builder.createNode({
      type: "operator",
      role: "operator",
      latex: script.marker,
      parentId: node.id,
      depth: depth + 1,
      start: start + script.markerStart,
      end: start + script.markerStart + 1,
    }).id);
    childIds.push(parseExpression(builder, script.value, node.id, depth + 1, start + script.start, scriptRole)?.id);
  }
  const open = text[call.argument.start];
  const close = text[call.argument.end - 1];
  childIds.push(builder.createNode({ type: "operator", role: "delimiter", latex: open, parentId: node.id, depth: depth + 1, start: start + call.argument.start, end: start + call.argument.start + 1 }).id);
  const argument = parseExpression(builder, call.argument.value, node.id, depth + 1, start + call.argument.start + 1, "argument");
  childIds.push(argument?.id);
  childIds.push(builder.createNode({ type: "operator", role: "delimiter", latex: close, parentId: node.id, depth: depth + 1, start: start + call.argument.end - 1, end: start + call.argument.end }).id);
  node.childIds = childIds.filter(Boolean);
  return node;
}

function parseSumTerms(builder, text, terms, parentId, depth, start, role) {
  const node = builder.createNode({ type: "sum", role, latex: text, parentId, depth, start, end: start + text.length });
  const childIds = [];
  for (const term of terms) {
    if (term.operator) {
      childIds.push(builder.createNode({ type: "operator", role: "operator", latex: term.operator, parentId: node.id, depth: depth + 1, start: start + term.operatorIndex, end: start + term.operatorIndex + term.operator.length }).id);
    }
    const isSignedNumericSubtrahend = term.operator === "-" && NUMBER_LITERAL_PATTERN.test(term.value);
    const child = isSignedNumericSubtrahend
      ? builder.createNode({
          type: "number",
          role: "constant",
          latex: `-${term.value}`,
          parentId: node.id,
          depth: depth + 1,
          start: start + term.operatorIndex,
          end: start + term.start + term.value.length,
        })
      : parseExpression(builder, term.value, node.id, depth + 1, start + term.start, "term");
    if (child) childIds.push(child.id);
  }
  node.childIds = childIds;
  return node;
}

function parseExpression(builder, latex, parentId = null, depth = 0, start = 0, role = "expression") {
  const trimmed = trimExpressionSource(latex, start);
  const text = trimmed.text;
  start = trimmed.start;
  if (!text) return null;

  const sizedDelimited = parseSizedDelimitedExpression(builder, text, parentId, depth, start, role);
  if (sizedDelimited) return sizedDelimited;

  const environment = parseEnvironment(builder, text, parentId, depth, start, role);
  if (environment) return environment;

  const sequenceParts = splitTopLevelCommas(text);
  if (sequenceParts.length > 1) {
    const node = builder.createNode({ type: "sequence", role, latex: text, parentId, depth, start, end: start + text.length });
    const childIds = [];
    for (const part of sequenceParts) {
      const child = parseExpression(builder, part.value, node.id, depth + 1, start + part.start, "term");
      if (child) childIds.push(child.id);
      if (part.commaIndex !== null) {
        childIds.push(builder.createNode({
          type: "operator",
          role: "operator",
          latex: ",",
          parentId: node.id,
          depth: depth + 1,
          start: start + part.commaIndex,
          end: start + part.commaIndex + 1,
        }).id);
      }
    }
    node.childIds = childIds;
    return node;
  }

  const relation = findTopLevelRelation(text);
  if (relation?.index > 0) {
    const relationRole = relation.operator === "="
      ? "equality"
      : relation.operator === "\\approx"
        ? "approximation"
      : relation.operator.length > 1 && relation.operator.endsWith("=")
        ? "definition"
        : "relation";
    const nodeRole = role === "expression" || role === "term"
      ? (relationRole === "equality" ? "equation" : relationRole)
      : role;
    const node = builder.createNode({ type: "equation", role: nodeRole, latex: text, parentId, depth, start, end: start + text.length });
    const left = parseExpression(builder, text.slice(0, relation.index), node.id, depth + 1, start, "leftSide");
    const operator = builder.createNode({ type: "operator", role: relationRole, latex: relation.operator, parentId: node.id, depth: depth + 1, start: start + relation.index, end: start + relation.index + relation.operator.length });
    const right = parseExpression(builder, text.slice(relation.index + relation.operator.length), node.id, depth + 1, start + relation.index + relation.operator.length, "rightSide");
    node.childIds = [left?.id, operator.id, right?.id].filter(Boolean);
    if (left) left.role = "leftSide";
    if (right) right.role = "rightSide";
    return node;
  }

  const differentialVariablePattern = "(?:\\\\mathbf\\{?[a-zA-Z]\\}?|\\\\[a-zA-Z]+|[a-zA-Z])";
  const vectorMatch = text.match(new RegExp(`^\\\\langle(.+)\\\\rangle(?:\\\\,?d${differentialVariablePattern})?$`));
  if (vectorMatch) {
    const node = builder.createNode({ type: "vector", role: role === "expression" || role === "term" ? "vector" : role, latex: text, parentId, depth, start, end: start + text.length });
    const componentText = vectorMatch[1];
    const componentOffset = text.indexOf(componentText);
    const childIds = splitVectorComponents(componentText).map((component, index) => {
      const child = parseExpression(builder, component.value, node.id, depth + 1, start + componentOffset + component.start, "component");
      if (child) {
        child.role = "component";
        child.componentIndex = index;
      }
      return child?.id;
    }).filter(Boolean);
    const differentialMatch = text.match(new RegExp(`(\\\\,?d${differentialVariablePattern})$`));
    if (differentialMatch) {
      childIds.push(createDifferentialNode(
        builder,
        differentialMatch[1],
        node.id,
        depth + 1,
        start + text.length - differentialMatch[1].length,
        start + text.length
      ).id);
    }
    node.childIds = childIds;
    return node;
  }

  const differentialSymbolMatch = text.match(/^d(\\mathbf\{?[a-zA-Z]\}?|\\[a-zA-Z]+|[a-zA-Z])$/);
  if (differentialSymbolMatch) {
    return createDifferentialNode(builder, text, parentId, depth, start, start + text.length, role === "expression" ? "differential" : role);
  }

  const delimited = parseDelimitedExpression(builder, text, parentId, depth, start, role);
  if (delimited) return delimited;

  const absoluteValue = parseAbsoluteValueExpression(builder, text, parentId, depth, start, role);
  if (absoluteValue) return absoluteValue;

  const derivative = parseDerivative(builder, text, parentId, depth, start, role);
  if (derivative) return derivative;

  const fraction = parseFractionExpression(builder, text, parentId, depth, start, role);
  if (fraction) return fraction;

  const completedIntegralTerms = readIntegralHead(text) ? splitCompletedIntegralTerms(text) : [];
  if (completedIntegralTerms.length > 1) {
    return parseSumTerms(builder, text, completedIntegralTerms, parentId, depth, start, role);
  }

  const integral = parseIntegralExpression(builder, text, parentId, depth, start, role);
  if (integral) return integral;

  const largeOperator = parseLargeOperator(builder, text, parentId, depth, start, role);
  if (largeOperator) return largeOperator;

  const terms = splitTopLevelTerms(text);
  if (terms.length > 1) {
    return parseSumTerms(builder, text, terms, parentId, depth, start, role);
  }

  const unaryOperator = text[0];
  const signedProductParts = (unaryOperator === "+" || unaryOperator === "-") && text.length > 1
    ? (splitImplicitProduct(text) || (() => {
        if (unaryOperator !== "+") return null;
        const unsignedParts = splitImplicitProduct(text.slice(1));
        if (!unsignedParts || !NUMBER_LITERAL_PATTERN.test(unsignedParts[0]?.value || "")) return null;
        return [
          { ...unsignedParts[0], value: `+${unsignedParts[0].value}`, start: 0 },
          { ...unsignedParts[1], start: unsignedParts[1].start + 1 },
        ];
      })())
    : null;
  if (signedProductParts && /^[+-]\d/.test(signedProductParts[0]?.value || "")) {
    const node = builder.createNode({ type: "product", role: role === "expression" ? "term" : role, latex: text, parentId, depth, start, end: start + text.length });
    const [coefficientPart, factorPart] = signedProductParts;
    const coefficient = builder.createNode({
      type: "number",
      role: "coefficient",
      latex: coefficientPart.value,
      parentId: node.id,
      depth: depth + 1,
      start: start + coefficientPart.start,
      end: start + coefficientPart.start + coefficientPart.value.length,
    });
    const factor = parseExpression(builder, factorPart.value, node.id, depth + 1, start + factorPart.start, "factor");
    node.childIds = [coefficient.id, factor?.id].filter(Boolean);
    return node;
  }
  const isSignedNumberLiteral = NUMBER_LITERAL_PATTERN.test(text);
  if ((unaryOperator === "+" || unaryOperator === "-") && text.length > 1 && !isSignedNumberLiteral) {
    const node = builder.createNode({
      type: "unaryExpression",
      role,
      latex: text,
      parentId,
      depth,
      start,
      end: start + text.length,
    });
    const operator = builder.createNode({
      type: "operator",
      role: "unaryOperator",
      latex: unaryOperator,
      parentId: node.id,
      depth: depth + 1,
      start,
      end: start + 1,
    });
    const operand = parseExpression(
      builder,
      text.slice(1),
      node.id,
      depth + 1,
      start + 1,
      "operand",
    );
    node.childIds = [operator.id, operand?.id].filter(Boolean);
    return node;
  }

  const partialMatch = text.match(/^\\partial\/\\partial([a-zA-Z]|\\[a-zA-Z]+)(.+)$/);
  if (partialMatch) {
    const [, variable, argumentRaw] = partialMatch;
    const node = builder.createNode({ type: "partialDerivative", role: role === "expression" ? "partialDerivative" : role, latex: text, parentId, depth, start, end: start + text.length });
    const operator = builder.createNode({ type: "operator", role: "differentialOperator", latex: `\\partial/\\partial${variable}`, parentId: node.id, depth: depth + 1, start, end: start + `\\partial/\\partial${variable}`.length });
    const variableNode = parseExpression(builder, variable, node.id, depth + 1, start + "\\partial/\\partial".length, "variable");
    const argumentLatex = stripOuterParens(argumentRaw);
    const argumentStart = start + text.indexOf(argumentRaw) + (argumentRaw.startsWith("(") ? 1 : 0);
    const argument = parseExpression(builder, argumentLatex, node.id, depth + 1, argumentStart, "argument");
    node.childIds = [operator.id, variableNode?.id, argument?.id].filter(Boolean);
    return node;
  }

  const slashIndex = findTopLevelSlash(text);
  if (slashIndex > 0) {
    const node = builder.createNode({ type: "fraction", role: role === "expression" || role === "term" ? "fraction" : role, latex: text, parentId, depth, start, end: start + text.length });
    const top = parseExpression(builder, text.slice(0, slashIndex), node.id, depth + 1, start, "numerator");
    const slash = builder.createNode({ type: "operator", role: "operator", latex: "/", parentId: node.id, depth: depth + 1, start: start + slashIndex, end: start + slashIndex + 1 });
    const bottom = parseExpression(builder, text.slice(slashIndex + 1), node.id, depth + 1, start + slashIndex + 1, "denominator");
    if (top) top.role = "numerator";
    if (bottom) bottom.role = "denominator";
    node.childIds = [top?.id, slash.id, bottom?.id].filter(Boolean);
    return node;
  }

  if (text.startsWith("\\sqrt")) {
    const radicand = readGroup(text, "\\sqrt".length);
    if (radicand) {
      const node = builder.createNode({ type: "root", role: "root", latex: text, parentId, depth, start, end: start + text.length });
      const radical = builder.createNode({
        type: "operator",
        role: "radical",
        latex: "\\sqrt",
        parentId: node.id,
        depth: depth + 1,
        start,
        end: start + "\\sqrt".length,
      });
      const child = parseExpression(builder, radicand.value, node.id, depth + 1, start + radicand.start + 1, "radicand");
      node.childIds = [radical.id, child?.id].filter(Boolean);
      return node;
    }
  }

  const differentialMatches = findDifferentials(text);
  const integralHead = readIntegralHead(text);
  if (integralHead) {
    const firstDifferential = differentialMatches.find((match) => match.index >= integralHead.endIndex);
    const integrand = firstDifferential
      ? text.slice(integralHead.endIndex, firstDifferential.index)
      : integralHead.tail;
    const node = builder.createNode({ type: "integral", role: role === "expression" ? "integral" : role, latex: text, parentId, depth, start, end: start + text.length });
    const childIds = [];
    if (integralHead.leading) {
      const coefficient = parseExpression(builder, integralHead.leading, node.id, depth + 1, start, "coefficient");
      if (coefficient) childIds.push(coefficient.id);
    }
    childIds.push(builder.createNode({ type: "operator", role: "integralSymbol", latex: integralHead.operator, parentId: node.id, depth: depth + 1, start: start + integralHead.operatorIndex, end: start + integralHead.operatorIndex + integralHead.operator.length }).id);
    for (const script of integralHead.scripts) {
      const bound = parseExpression(
        builder,
        script.latex,
        node.id,
        depth + 1,
        start + integralHead.operatorIndex + script.start,
        script.role
      );
      if (bound) {
        bound.role = script.role;
        childIds.push(bound.id);
      }
    }
    const integrandNode = integrand
      ? parseExpression(builder, integrand, node.id, depth + 1, start + integralHead.endIndex, "integrand")
      : null;
    if (integrandNode) childIds.push(integrandNode.id);
    for (const differential of differentialMatches.filter((match) => match.index >= integralHead.endIndex)) {
      childIds.push(createDifferentialNode(
        builder,
        differential.latex,
        node.id,
        depth + 1,
        start + differential.index,
        start + differential.index + differential.latex.length
      ).id);
    }
    node.childIds = childIds;
    return node;
  }

  const explicitProduct = splitExplicitProduct(text);
  if (explicitProduct) {
    const node = builder.createNode({
      type: "product",
      role: role === "expression" ? "term" : role,
      latex: text,
      parentId,
      depth,
      start,
      end: start + text.length,
    });
    const left = parseExpression(builder, explicitProduct.left.value, node.id, depth + 1, start + explicitProduct.left.start, "factor");
    const operator = builder.createNode({
      type: "operator",
      role: "operator",
      latex: explicitProduct.operator,
      parentId: node.id,
      depth: depth + 1,
      start: start + explicitProduct.operatorIndex,
      end: start + explicitProduct.operatorIndex + explicitProduct.operator.length,
    });
    const right = parseExpression(builder, explicitProduct.right.value, node.id, depth + 1, start + explicitProduct.right.start, "factor");
    node.childIds = [left?.id, operator.id, right?.id].filter(Boolean);
    return node;
  }

  const functionCall = parseGenericFunctionCall(builder, text, parentId, depth, start, role);
  if (functionCall) return functionCall;

  const productParts = splitImplicitProduct(text);
  if (productParts) {
    const node = builder.createNode({ type: "product", role: role === "expression" ? "term" : role, latex: text, parentId, depth, start, end: start + text.length });
    const [firstPart, secondPart] = productParts;
    const firstRole = NUMBER_LITERAL_PATTERN.test(firstPart.value)
      ? "coefficient"
      : firstPart.value === "i"
        ? "imaginaryUnit"
        : "factor";
    const first = parseExpression(builder, firstPart.value, node.id, depth + 1, start + firstPart.start, firstRole);
    const second = parseExpression(builder, secondPart.value, node.id, depth + 1, start + secondPart.start, "factor");
    if (first && firstRole !== "factor") first.role = firstRole;
    node.childIds = [first?.id, second?.id].filter(Boolean);
    return node;
  }

  // Implicit-product splitting above understands complete scripted factors,
  // including absolute values. Once no product boundary remains, parse the
  // base and its script descendants as one semantic construct.
  const scripted = parseScriptedExpression(builder, text, parentId, depth, start, role);
  if (scripted) return scripted;

  const commandApplication = parseCommandApplication(builder, text, parentId, depth, start, role);
  if (commandApplication) return commandApplication;

  const tokenMeta = tokenTypeForLatex(text);
  const inheritedRole = role === "expression" || (role === "term" && ["number", "symbol", "operator"].includes(tokenMeta.type))
    ? tokenMeta.role
    : role;
  return builder.createNode({ ...tokenMeta, role: inheritedRole, latex: text, parentId, depth, start, end: start + text.length });
}

function addDerivedFields(tree) {
  const nodes = tree.nodes;
  const leaves = [];
  const visit = (id, depth = 0) => {
    const node = nodes[id];
    if (!node) return [];
    node.depth = depth;
    if (!node.childIds?.length) {
      node.order = leaves.length;
      node.leafStart = leaves.length;
      node.leafEnd = leaves.length;
      leaves.push(node.id);
      return [node.id];
    }
    const childLeaves = node.childIds.flatMap((childId) => visit(childId, depth + 1));
    node.leafStart = Math.min(...childLeaves.map((leafId) => nodes[leafId].order));
    node.leafEnd = Math.max(...childLeaves.map((leafId) => nodes[leafId].order));
    return childLeaves;
  };
  visit(tree.rootId, 0);
  tree.linearLeaves = leaves;
  tree.nodeMap = nodes;
  tree.flatNodes = Object.values(nodes);
  return tree;
}

function ingestExplicitNode(input, builder, parentId = null, depth = 0) {
  if (!input || typeof input !== "object") return null;
  const node = builder.createNode({
    type: input.type || input.kind || "group",
    role: input.role || input.kind || "expression",
    latex: input.latex || input.display || input.text || "",
    parentId,
    depth,
    start: input.sourceRange?.start ?? input.start,
    end: input.sourceRange?.end ?? input.end,
  });
  if (input.id) {
    const generatedId = node.id;
    node.id = input.id;
    builder.nodes.delete(generatedId);
    builder.nodes.set(node.id, node);
  }
  node.short = input.short || input.explanation || null;
  node.medium = input.medium || input.explanation || null;
  node.deep = input.deep || input.medium || input.explanation || null;
  node.childIds = (input.childIds || input.children || input.parts || [])
    .map((child) => ingestExplicitNode(child, builder, node.id, depth + 1)?.id)
    .filter(Boolean);
  return node;
}

// The tutor parser supplies mathematical roles. KaTeX supplies source-backed
// atoms when that parser leaves an opaque compound (e.g. an array's cells).
// Refine only opaque leaves, preserving existing IDs and multi-digit numbers.
function refineOpaqueTexLeaves(builder, source) {
  const opaque = [...builder.nodes.values()].filter((node) => !node.childIds.length
    && ["atom", "fallback"].includes(node.type) && node.sourceRange);
  if (!opaque.length) return;
  const atoms = getTexSourceAtoms(source);
  const counts = new Map();
  for (const atom of atoms) {
    const key = `${atom.start}:${atom.end}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const parent of opaque) {
    // Prime decorations are painted as a superscript attached to their base,
    // but KaTeX exposes only the base source slot. Keep the decorated symbol
    // as one exact semantic leaf instead of silently discarding the primes.
    if (parent.latex.includes("'")) continue;
    const children = atoms.filter((atom) => atom.start >= parent.start && atom.end <= parent.end
      && (atom.start > parent.start || atom.end < parent.end)
      && counts.get(`${atom.start}:${atom.end}`) === 1);
    if (!children.length) continue;
    parent.childIds = children.map((atom) => {
      const latex = source.slice(atom.start, atom.end);
      const meta = tokenTypeForLatex(latex);
      if (atom.type === "atom") {
        meta.type = "operator";
        meta.role = ["open", "close"].includes(atom.family) ? "delimiter" : latex === "=" ? "equality" : "operator";
      }
      const child = builder.createNode({ ...meta, latex, parentId: parent.id,
        depth: parent.depth + 1, start: atom.start, end: atom.end });
      child.provenance = "katex-source-atom";
      return child.id;
    });
    parent.type = "expression";
    parent.role = "expression";
  }
}

export function buildSemanticTree({ stepId = "step", displayLatex = "", explicitTree = null, tokens = null, enabled = undefined } = {}) {
  if (!semanticLayerEnabled(enabled)) return null;
  const latex = normalizeLatexInput(displayLatex);
  if (!latex && !explicitTree && !tokens) return null;
  const builder = createBuilder(cleanIdPart(stepId), latex);
  let root = null;

  if (explicitTree && typeof explicitTree === "object") root = ingestExplicitNode(explicitTree.root || explicitTree, builder, null, 0);
  if (!root && !latex && Array.isArray(tokens) && tokens.length === 1 && (tokens[0]?.children?.length || tokens[0]?.parts?.length)) {
    root = ingestExplicitNode(tokens[0], builder, null, 0);
  }
  if (!root && !hasBalancedGroups(latex)) {
    root = builder.createNode({ type: "fallback", role: "expression", latex, parentId: null, depth: 0, start: 0, end: latex.length });
  }
  if (!root) root = parseExpression(builder, latex, null, 0, 0, "expression");
  if (!root) return null;
  if (!explicitTree) refineOpaqueTexLeaves(builder, latex);

  const nodes = Object.fromEntries(builder.nodes);
  const tree = {
    stepId,
    displayLatex: latex,
    rootId: root.id,
    semanticTree: root,
    nodes,
    nodeMap: nodes,
    flatNodes: [],
    linearLeaves: [],
    fallback: root.type === "fallback" || (root.type === "atom" && root.latex === latex && latex.length > 24),
  };
  return addDerivedFields(tree);
}

export function semanticNodeToToken(node, tree) {
  if (!node) return null;
  return {
    id: node.id,
    semanticNodeId: node.id,
    stepId: node.stepId,
    kind: node.type,
    type: node.type,
    role: node.role,
    display: node.display || node.latex,
    latex: node.latex,
    text: node.text || node.display || node.latex,
    short: node.short,
    medium: node.medium,
    deep: node.deep,
    parentId: node.parentId,
    childIds: node.childIds || [],
    depth: node.depth,
    order: node.order,
    leafStart: node.leafStart,
    leafEnd: node.leafEnd,
    source: node.source || node.latex,
    normalizedSource: node.normalizedSource || node.latex,
    start: node.start,
    end: node.end,
    sourceRange: node.sourceRange,
    parentExpression: tree?.displayLatex || "",
    parentTokenId: tree?.rootId || null,
    semanticTree: tree ? { stepId: tree.stepId, rootId: tree.rootId } : null,
    relatedTokenIds: [],
    children: [],
  };
}

export function flattenSemanticTreeForTargets(tree) {
  if (!tree?.flatNodes?.length) return [];
  return tree.flatNodes
    .filter((node) => node.id !== tree.rootId || node.childIds?.length)
    .map((node) => semanticNodeToToken(node, tree))
    .filter(Boolean);
}
