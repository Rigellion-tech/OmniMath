import katex from "katex";

// Keep the two experimental KaTeX interfaces behind this adapter. No parser
// mutation, global macro registration, or command-signature table is needed.
// Unsupported adapter contracts fail closed to the caller's original TeX.
const engine = /** @type {any} */ (katex);
const options = { throwOnError: true, strict: "ignore", maxExpand: 1000 };

function canonicalParse(value) {
  if (Array.isArray(value)) {
    return value.flatMap((node) => node?.type === "html" && node.attributes?.["data-semantic-id"]
      ? canonicalParse(node.body)
      : [canonicalParse(node)]);
  }
  if (!value || typeof value !== "object") return value;
  if ((value.type === "html" && value.attributes?.["data-semantic-id"]) || value.type === "ordgroup") {
    const body = canonicalParse(value.body);
    // Bracing a single-token argument is grammatically equivalent. Atom-class
    // and script-placement differences are checked separately in HTML output.
    if (body.length === 1) return body[0];
    return { type: "ordgroup", mode: value.mode, body };
  }
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !["loc", "token"].includes(key))
    .map((key) => [key, canonicalParse(value[key])]));
}

function combineMathGlyphRuns(children) {
  const combined = [];
  for (const child of children) {
    const previous = combined.at(-1);
    // KaTeX coalesces adjacent SymbolNodes (e.g. /2 or 2Γ). Metadata spans
    // can stop that optimization without changing their math layout. Match
    // its font/style/skew and italic-correction constraints when comparing.
    if (typeof previous?.text === "string" && typeof child?.text === "string"
      && !previous.children && !child.children
      && JSON.stringify(previous.classes) === JSON.stringify(child.classes)
      && JSON.stringify(previous.style) === JSON.stringify(child.style)
      && previous.skew === child.skew && previous.maxFontSize === child.maxFontSize
      && !previous.italic) {
      previous.text += child.text;
      previous.height = Math.max(previous.height, child.height);
      previous.depth = Math.max(previous.depth, child.depth);
      previous.italic = child.italic;
    } else combined.push(child);
  }
  return combined;
}

function layoutTree(node, ownerIds, inText = false) {
  if (!node || typeof node !== "object") return node;
  const id = node.attributes?.["data-semantic-id"];
  if (id) ownerIds.push(id);
  const textMode = inText || node.classes?.includes("text");
  const rawChildren = node.children?.flatMap((child) => layoutTree(child, ownerIds, textMode));
  // Text-mode splitting can affect kerning and ligatures; retain its exact
  // grouping. Only normalize KaTeX's ordinary math glyph-run optimization.
  const children = rawChildren && !textMode ? combineMathGlyphRuns(rawChildren) : rawChildren;
  if (id && node.classes?.includes("enclosing")) return children || [];
  // KaTeX splits top-level math into unbreakable bases at operators. OmniMath
  // renders these in a nowrap scroller; annotations may coalesce bases. The
  // root metrics still verify ascent/descent; base struts carry no ink.
  if (node.classes?.includes("base")) return children || [];
  if (node.classes?.includes("strut")) return [];
  // A neutral single-child group is introduced when an annotation occupies
  // an unbraced argument slot. Keep all style-bearing groups, glyph classes,
  // dimensions, rules, SVG paths, spacing and line-breaking containers.
  if (children?.length === 1 && node.classes?.filter(Boolean).every((name) => ["mord", "mtight"].includes(name))
    && !Object.keys(node.style || {}).length && !Object.keys(node.attributes || {}).length) return children;
  const result = Object.fromEntries(Object.keys(node).sort()
    .filter((key) => key !== "children" && node[key] !== undefined)
    .map((key) => [key, key === "classes" ? node[key].filter(Boolean) : node[key]]));
  if (children) result.children = children;
  return [result];
}

function parsedSlots(tree, source) {
  const slots = [];
  const visit = (value, parent = null, field = "", inList = false) => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, parent, field, true));
      return;
    }
    if (!value || typeof value !== "object") return;
    const loc = value.loc;
    if (loc && Number.isInteger(loc.start) && Number.isInteger(loc.end)
      && loc.lexer?.input === source) {
      slots.push({ start: loc.start, end: loc.end, type: value.type, mode: value.mode, family: value.family,
        parentType: parent?.type || null, field, argument: Boolean(parent && !inList),
        braced: source[loc.start] === "{" || source[loc.start] === "[" });
    }
    for (const [key, child] of Object.entries(value)) {
      if (!["loc", "token"].includes(key)) visit(child, value, key);
    }
  };
  visit(tree);
  return slots;
}

export function getTexSourceAtoms(source) {
  try {
    return parsedSlots(engine.__parse(source, { ...options, trust: false }), source)
      .filter((slot) => slot.mode === "math" && ["mathord", "textord", "atom"].includes(slot.type))
      .map((slot) => {
        // KaTeX source locations sometimes attach the whitespace following a
        // control word to the painted atom (for example `\\nabla u`).  The
        // whitespace has no glyph and must not prevent an otherwise exact
        // semantic owner from being created inside the enclosing expression.
        const trailingWhitespace = source.slice(slot.start, slot.end).match(/\s+$/u)?.[0].length || 0;
        return trailingWhitespace > 0 ? { ...slot, end: slot.end - trailingWhitespace } : slot;
      })
      .filter((slot) => slot.end > slot.start);
  } catch {
    return [];
  }
}

export function createTexAnnotationGrammar(source, trust) {
  if (typeof engine.__parse !== "function" || typeof engine.__renderToHTMLTree !== "function") {
    throw new Error("Unsupported KaTeX annotation adapter contract");
  }
  const settings = { ...options, trust };
  const parsed = engine.__parse(source, settings);
  const parseSignature = JSON.stringify(canonicalParse(parsed));
  // An expression can move between inline/display style without being
  // reserialized. Verify both (notably limits and mathchoice).
  const layoutSignatures = [false, true].map((displayMode) => JSON.stringify(
    layoutTree(engine.__renderToHTMLTree(source, { ...settings, displayMode }), []),
  ));
  const slots = parsedSlots(parsed, source);
  let attempts = 0;
  return {
    version: katex.version,
    slots,
    get attempts() { return attempts; },
    wrapperMode(range) {
      return slots.some((slot) => slot.argument && !slot.braced
        && slot.start === range.start && slot.end === range.end) ? "grouped" : "direct";
    },
    validate(latex, expectedIds = []) {
      attempts += 1;
      try {
        const annotatedParse = engine.__parse(latex, settings);
        if (JSON.stringify(canonicalParse(annotatedParse)) !== parseSignature) {
          return { valid: false, reason: "tex-parse-structure-changed", error: "Annotation changed parsed TeX arguments or scope." };
        }
        for (const [index, displayMode] of [false, true].entries()) {
          const ownerIds = [];
          const signature = JSON.stringify(layoutTree(engine.__renderToHTMLTree(latex, { ...settings, displayMode }), ownerIds));
          if (signature !== layoutSignatures[index]) {
            return { valid: false, reason: "tex-layout-changed", error: `Annotation changed KaTeX ${displayMode ? "display" : "inline"} layout.` };
          }
          const ownerCounts = new Map();
          for (const id of ownerIds) ownerCounts.set(id, (ownerCounts.get(id) || 0) + 1);
          if (expectedIds.some((id) => ownerCounts.get(id) !== 1)) {
            return { valid: false, reason: "tex-owner-not-emitted-once", error: "Annotation was consumed, omitted, or duplicated by TeX grammar." };
          }
        }
        return { valid: true, reason: "", error: "" };
      } catch (error) {
        return { valid: false, reason: "katex-rejected-wrapper-boundary", error: error?.message || "Annotation parse failed." };
      }
    },
  };
}
