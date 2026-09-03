import katex from "katex";

const SAFE_DATA_VALUE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const HIDDEN_SYNTAX_LATEX = new Set(["^", "_"]);
const HIDDEN_ROLES = new Set(["delimiter", "evaluationBar"]);
const GROUP_ANNOTATION_ROLES = new Set([
  "argument",
  "base",
  "bound",
  "denominator",
  "decorated",
  "differential",
  "evaluatedExpression",
  "evaluation",
  "evaluationCondition",
  "exponent",
  "fraction",
  "function",
  "integral",
  "lowerBound",
  "numerator",
  "operand",
  "power",
  "radicand",
  "root",
  "upperBound",
  "unaryExpression",
]);

function cleanDataValue(value = "", fallback = "node") {
  const raw = String(value || fallback);
  const cleaned = raw
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return cleaned || fallback;
}

function numericRange(range) {
  const start = Number(range?.start);
  const end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function commandTokenSpans(source = "") {
  const spans = [];
  const pattern = /\\[A-Za-z]+/g;
  let match = null;
  while ((match = pattern.exec(source))) {
    spans.push({ start: match.index, end: match.index + match[0].length, latex: match[0] });
  }
  return spans;
}

function boundaryInsideCommand(boundary, spans = []) {
  return spans.find((span) => boundary > span.start && boundary < span.end) || null;
}

function expectedSourceForNode(node = {}) {
  return String(
    node.metadata?.source
    || node.source
    || node.latex
    || node.display
    || node.text
    || ""
  );
}

function rangeDiagnostic(node = {}, source = "", reason = "") {
  const range = node.sourceRange || { start: node.start, end: node.end };
  const start = Number(range?.start);
  const end = Number(range?.end);
  return {
    sourceLatex: source,
    nodeId: node.id || node.semanticNodeId || null,
    nodeType: node.type || node.kind || node.role || "node",
    nodeRole: node.role || node.kind || node.type || "node",
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    sourceSlice: Number.isFinite(start) && Number.isFinite(end) ? source.slice(Math.max(0, start), Math.max(0, end)) : "",
    expectedSource: expectedSourceForNode(node),
    reason,
  };
}

function isLeafNode(node = {}) {
  return !(Array.isArray(node.childIds) && node.childIds.length > 0)
    && !(Array.isArray(node.children) && node.children.length > 0);
}

function nodeRole(node = {}) {
  return node.role || node.kind || node.type || "node";
}

function nodeType(node = {}) {
  return node.type || node.kind || node.role || "node";
}

function isHiddenSyntaxNode(node = {}, source = "") {
  const latex = String(node.latex || node.display || node.text || "").trim();
  const role = nodeRole(node);
  if (!latex || HIDDEN_ROLES.has(role) || HIDDEN_SYNTAX_LATEX.has(latex)) return true;

  const range = numericRange(node.sourceRange || { start: node.start, end: node.end });
  const sourceSlice = range ? source.slice(range.start, range.end).trim() : "";
  if (latex === "\\sqrt" && sourceSlice === "\\sqrt") return true;
  if (latex === "/" && sourceSlice !== "/") return true;
  return false;
}

/*
 * TeX source ranges describe characters, not grammar productions.  In
 * particular, a range ending after `\\binom` or `\\sqrt[3]` is not a
 * renderable expression even though it is a meaningful prefix to our math
 * parser.  Keep the grammar-sensitive parts explicit so they can never
 * become hover targets by accident.  This scanner identifies TeX grammar
 * tokens; it does not attempt to know the argument signature of individual
 * macros.  The public KaTeX renderer below remains the authority for whether
 * a proposed set of annotations is a valid expression.
 */
export function scanTexSyntaxRanges(source = "") {
  const text = String(source || "");
  const ranges = [];
  const push = (start, end, kind) => {
    if (end > start) ranges.push({ start, end, kind, source: text.slice(start, end) });
  };

  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "\\") {
      const command = readTexControlSequence(text, index);
      const end = index + command.length;
      if (command === "\\\\") push(index, end, "row-separator");

      if (command === "\\begin" || command === "\\end") {
        const groupStart = skipTexWhitespace(text, end);
        const groupEnd = readBalancedTexContainer(text, groupStart, "{", "}");
        push(index, groupEnd > groupStart ? groupEnd : end, "environment-marker");
        index = groupEnd > groupStart ? groupEnd : end;
        continue;
      }

      if (["\\left", "\\right", "\\middle"].includes(command)) {
        const delimiterStart = skipTexWhitespace(text, end);
        const delimiter = readTexControlSequence(text, delimiterStart);
        push(index, delimiter ? delimiterStart + delimiter.length : delimiterStart + 1, "delimiter-grammar");
        index = delimiter ? delimiterStart + delimiter.length : delimiterStart + 1;
        continue;
      }

      index = Math.max(index + 1, end);
      continue;
    }

    const kind = char === "{" || char === "}"
      ? "group-marker"
      : char === "[" || char === "]"
        ? "optional-argument-marker"
        : char === "^" || char === "_"
          ? "script-marker"
          : char === "&"
            ? "alignment-marker"
            : "";
    if (kind) push(index, index + 1, kind);
    index += 1;
  }

  // Array-like grammar is especially layout-sensitive when it is used as a
  // script. KaTeX intentionally compacts constructs such as a two-line limit
  // condition. Although htmlData remains syntactically valid inside those
  // rows, inserting ordinary atoms there can change the script's measured
  // width. Treat the complete scripted structural container as a protected
  // syntax scope. This is based on grammar relationships (script + structural
  // separators), not on the name of the macro that happens to create it.
  const structuralKinds = new Set(["alignment-marker", "environment-marker", "row-separator"]);
  const grammarRanges = [...ranges];
  for (const script of grammarRanges.filter((range) => range.kind === "script-marker")) {
    const argumentStart = skipTexWhitespace(text, script.end);
    if (text[argumentStart] !== "{") continue;
    const argumentEnd = readBalancedTexContainer(text, argumentStart, "{", "}");
    if (argumentEnd <= argumentStart) continue;
    const containsStructuralGrammar = grammarRanges.some((range) => (
      structuralKinds.has(range.kind)
      && range.start >= argumentStart + 1
      && range.end <= argumentEnd - 1
    ));
    if (containsStructuralGrammar) {
      push(argumentStart + 1, argumentEnd - 1, "scripted-structural-container");
    }
  }

  return ranges;
}

function readTexControlSequence(source = "", start = 0) {
  if (source[start] !== "\\") return "";
  return source.slice(start).match(/^\\(?:[A-Za-z@]+|.)/u)?.[0] || "";
}

function skipTexWhitespace(source = "", start = 0) {
  let index = start;
  while (/\s/u.test(source[index] || "")) index += 1;
  return index;
}

function readBalancedTexContainer(source = "", start = 0, open = "{", close = "}") {
  if (source[start] !== open) return -1;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "\\") {
      const command = readTexControlSequence(source, index);
      index += Math.max(0, command.length - 1);
      continue;
    }
    if (source[index] === open) depth += 1;
    else if (source[index] === close) depth -= 1;
    if (depth === 0) return index + 1;
  }
  return -1;
}

function isPureTexSyntaxRange(range, syntaxRanges = []) {
  return syntaxRanges.some((syntax) => syntax.start === range.start && syntax.end === range.end);
}

export function classifySemanticNodeInteraction(node = {}, source = "") {
  if (!isLeafNode(node)) {
    return {
      interactive: false,
      classification: "non-leaf-interactive",
      reason: "structural-node-represented-by-semantic-descendants",
    };
  }
  if (isHiddenSyntaxNode(node, source)) {
    return {
      interactive: false,
      classification: "structural-parent-only",
      reason: "rendered-primitive-or-syntax-owned-by-structural-parent",
    };
  }
  return { interactive: true, classification: "interactive-leaf", reason: "" };
}

function shouldAnnotateNode(node = {}, source = "") {
  const range = numericRange(node.sourceRange || { start: node.start, end: node.end });
  if (!range || isHiddenSyntaxNode(node, source)) return false;
  if (isLeafNode(node)) return true;
  return GROUP_ANNOTATION_ROLES.has(nodeRole(node)) || GROUP_ANNOTATION_ROLES.has(nodeType(node));
}

function semanticKindForNode(node = {}) {
  return isLeafNode(node) ? "leaf" : "group";
}

function semanticPriorityForNode(node = {}) {
  const order = Number(node.order ?? node.leafStart ?? node.siblingIndex);
  return Number.isFinite(order) ? String(order) : "0";
}

function htmlDataAttributesForNode(node = {}, source = "") {
  const range = numericRange(node.sourceRange || { start: node.start, end: node.end });
  const attrs = [
    ["semantic-id", cleanDataValue(node.id || node.semanticNodeId, "node")],
    ["semantic-kind", semanticKindForNode(node)],
    ["semantic-role", cleanDataValue(nodeRole(node), "node")],
    ["semantic-type", cleanDataValue(nodeType(node), "node")],
    ["semantic-depth", cleanDataValue(node.depth ?? 0, "0")],
    ["semantic-priority", cleanDataValue(semanticPriorityForNode(node), "0")],
  ];

  if (range) attrs.push(["semantic-range", `${range.start}-${range.end}`]);
  if (isLeafNode(node) && !isHiddenSyntaxNode(node, source)) attrs.push(["semantic-selectable", "true"]);
  return attrs.map(([key, value]) => `${key}=${value}`).join(",");
}

function wrapWithSemanticData(node, content, source, wrapperMode = "direct") {
  const annotation = `\\htmlData{${htmlDataAttributesForNode(node, source)}}{${content}}`;
  // htmlData is normally layout-transparent without another TeX group.
  // Grammar slots that consume exactly one token (for example shorthand
  // scripts) need the annotation command and its arguments grouped as that
  // token. The annotation planner selects this mode transactionally.
  return wrapperMode === "grouped" ? `{${annotation}}` : annotation;
}

function sortNodesByRange(left, right) {
  const leftRange = numericRange(left.sourceRange || { start: left.start, end: left.end });
  const rightRange = numericRange(right.sourceRange || { start: right.start, end: right.end });
  return (
    (leftRange?.start ?? 0) - (rightRange?.start ?? 0)
    || (rightRange?.end ?? 0) - (leftRange?.end ?? 0)
    || String(left.id || "").localeCompare(String(right.id || ""))
  );
}

function normalizeNode(rawNode = {}, nodeMap = new Map()) {
  const id = cleanDataValue(rawNode.id || rawNode.semanticNodeId, `node-${nodeMap.size + 1}`);
  const childIds = Array.isArray(rawNode.childIds)
    ? rawNode.childIds.map((childId) => cleanDataValue(childId, "node"))
    : Array.isArray(rawNode.children)
      ? rawNode.children.map((child) => cleanDataValue(child?.id || child?.semanticNodeId, "node"))
      : [];
  const range = numericRange(rawNode.sourceRange || { start: rawNode.start, end: rawNode.end });

  return {
    ...rawNode,
    id,
    semanticNodeId: rawNode.semanticNodeId || id,
    type: nodeType(rawNode),
    role: nodeRole(rawNode),
    latex: String(rawNode.latex || rawNode.display || rawNode.text || ""),
    text: String(rawNode.text || rawNode.display || rawNode.latex || ""),
    display: String(rawNode.display || rawNode.latex || rawNode.text || ""),
    sourceRange: range,
    start: range?.start ?? null,
    end: range?.end ?? null,
    parentId: rawNode.parentId ? cleanDataValue(rawNode.parentId, "node") : null,
    depth: Number.isFinite(Number(rawNode.depth)) ? Number(rawNode.depth) : 0,
    childIds,
    children: [],
    selectable: Boolean(isLeafNode({ ...rawNode, childIds }) && range),
    metadata: {
      source: rawNode.source || rawNode.latex || rawNode.display || rawNode.text || "",
      normalizedSource: rawNode.normalizedSource || rawNode.latex || rawNode.display || rawNode.text || "",
      order: rawNode.order ?? null,
      leafStart: rawNode.leafStart ?? null,
      leafEnd: rawNode.leafEnd ?? null,
    },
  };
}

export function normalizeCanonicalSemanticTree(tree = null) {
  if (!tree || typeof tree !== "object") return null;
  const rawNodes = Array.isArray(tree.flatNodes)
    ? tree.flatNodes
    : tree.nodes && typeof tree.nodes === "object"
      ? Object.values(tree.nodes)
      : [];
  if (rawNodes.length === 0) return null;

  const nodeMap = new Map();
  const normalizedNodes = rawNodes.map((node) => {
    const normalized = normalizeNode(node, nodeMap);
    nodeMap.set(normalized.id, normalized);
    return normalized;
  });

  for (const node of normalizedNodes) {
    node.children = node.childIds.map((childId) => nodeMap.get(childId)).filter(Boolean);
    node.selectable = Boolean(isLeafNode(node) && node.sourceRange && !isHiddenSyntaxNode(node, tree.displayLatex || ""));
  }

  const rootId = cleanDataValue(tree.rootId || tree.semanticTree?.id || normalizedNodes[0]?.id, "root");
  const nodes = Object.fromEntries(normalizedNodes.map((node) => [node.id, node]));
  return {
    ...tree,
    canonical: true,
    rootId,
    displayLatex: String(tree.displayLatex || nodeMap.get(rootId)?.latex || ""),
    semanticTree: nodeMap.get(rootId) || tree.semanticTree || normalizedNodes[0],
    nodes,
    nodeMap: nodes,
    flatNodes: normalizedNodes,
    linearLeaves: Array.isArray(tree.linearLeaves)
      ? tree.linearLeaves.map((id) => cleanDataValue(id, "node")).filter((id) => nodes[id])
      : normalizedNodes.filter(isLeafNode).map((node) => node.id),
  };
}

export function validateSemanticTreeRanges(tree = null) {
  const canonical = normalizeCanonicalSemanticTree(tree);
  if (!canonical?.displayLatex) {
    return { valid: false, canonicalTree: canonical, errors: [rangeDiagnostic({}, "", "missing-canonical-tree")] };
  }

  const source = canonical.displayLatex;
  const commandSpans = commandTokenSpans(source);
  const errors = [];

  for (const node of canonical.flatNodes) {
    const range = numericRange(node.sourceRange || { start: node.start, end: node.end });
    if (!range) {
      errors.push(rangeDiagnostic(node, source, "invalid-or-empty-range"));
      continue;
    }
    if (range.start < 0 || range.end > source.length) {
      errors.push(rangeDiagnostic(node, source, "range-outside-source"));
      continue;
    }

    const sourceSlice = source.slice(range.start, range.end);
    const expectedSource = expectedSourceForNode(node);
    if (expectedSource && sourceSlice !== expectedSource) {
      errors.push(rangeDiagnostic(node, source, "source-slice-mismatch"));
      continue;
    }
    if (sourceSlice === "\\") {
      errors.push(rangeDiagnostic(node, source, "lone-escape-sequence"));
      continue;
    }
    if (/\\$/.test(sourceSlice) || /^\\[A-Za-z]*$/.test(sourceSlice) && sourceSlice !== "\\" && !/^\\[A-Za-z]+$/.test(sourceSlice)) {
      errors.push(rangeDiagnostic(node, source, "split-escape-sequence"));
      continue;
    }

    const startCommand = boundaryInsideCommand(range.start, commandSpans);
    if (startCommand) {
      errors.push(rangeDiagnostic(node, source, `range-start-inside-command:${startCommand.latex}`));
      continue;
    }
    const endCommand = boundaryInsideCommand(range.end, commandSpans);
    if (endCommand) {
      errors.push(rangeDiagnostic(node, source, `range-end-inside-command:${endCommand.latex}`));
      continue;
    }

    if (node.parentId) {
      const parent = canonical.nodes[node.parentId];
      const parentRange = numericRange(parent?.sourceRange || { start: parent?.start, end: parent?.end });
      if (parentRange && (range.start < parentRange.start || range.end > parentRange.end)) {
        errors.push(rangeDiagnostic(node, source, "range-outside-parent"));
      }
    }
  }

  return {
    valid: errors.length === 0,
    canonicalTree: canonical,
    errors,
  };
}

export function hasSerializableSemanticRanges(tree = null) {
  const validation = validateSemanticTreeRanges(tree);
  const canonical = validation.canonicalTree;
  if (!canonical) return false;
  const source = canonical.displayLatex;
  const invalidIds = new Set(validation.errors.map((error) => error.nodeId).filter(Boolean));
  return canonical.flatNodes.some((node) => shouldAnnotateNode(node, source) && !invalidIds.has(node.id));
}

function rangesCross(left, right) {
  return (
    left.start < right.start && right.start < left.end && left.end < right.end
  ) || (
    right.start < left.start && left.start < right.end && right.end < left.end
  );
}

function annotationPriority(left, right) {
  const leftRange = numericRange(left.sourceRange);
  const rightRange = numericRange(right.sourceRange);
  return (
    Number(isLeafNode(right)) - Number(isLeafNode(left))
    || ((leftRange?.end - leftRange?.start) || 0) - ((rightRange?.end - rightRange?.start) || 0)
    || sortNodesByRange(left, right)
  );
}

function createAnnotationForest(nodes = []) {
  const roots = [];
  const stack = [];
  const entries = [...nodes]
    .sort((left, right) => {
      const leftNode = left.node || left;
      const rightNode = right.node || right;
      const byRange = sortNodesByRange(leftNode, rightNode);
      if (byRange) return byRange;
      // Identical ranges remain deterministic. Structural owners surround
      // their more precise leaf owner when both are intentionally retained.
      return Number(isLeafNode(leftNode)) - Number(isLeafNode(rightNode));
    })
    .map((candidate) => ({
      node: candidate.node || candidate,
      wrapperMode: candidate.wrapperMode || "direct",
      children: [],
    }));

  for (const entry of entries) {
    const range = numericRange(entry.node.sourceRange);
    while (stack.length > 0) {
      const parentRange = numericRange(stack.at(-1).node.sourceRange);
      const contains = parentRange
        && range
        && parentRange.start <= range.start
        && parentRange.end >= range.end;
      if (contains) break;
      stack.pop();
    }
    if (stack.length > 0) stack.at(-1).children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  }
  return roots;
}

function serializeAnnotationNodes(source = "", nodes = []) {
  const renderEntries = (entries, start, end) => {
    let cursor = start;
    let output = "";
    for (const entry of entries) {
      const range = numericRange(entry.node.sourceRange);
      if (!range || range.start < cursor || range.end > end) continue;
      output += source.slice(cursor, range.start);
      const content = renderEntries(entry.children, range.start, range.end);
      output += wrapWithSemanticData(entry.node, content, source, entry.wrapperMode);
      cursor = range.end;
    }
    return `${output}${source.slice(cursor, end)}`;
  };
  return renderEntries(createAnnotationForest(nodes), 0, source.length);
}

function preferredWrapperMode(node, source = "") {
  const range = numericRange(node.sourceRange);
  if (!range) return "direct";
  // An unbraced script consumes one TeX atom. Group the generated annotation
  // command so its metadata/content arguments remain attached to that atom.
  return source[range.start - 1] === "^" || source[range.start - 1] === "_"
    ? "grouped"
    : "direct";
}

function katexAcceptsAnnotation(latex = "") {
  try {
    // renderToString is the public KaTeX parser/rendering contract.  Keeping
    // this boundary out of katex.__parse isolates OmniMath from private AST
    // changes while still making KaTeX itself authoritative for its grammar.
    katex.renderToString(latex, {
      throwOnError: true,
      strict: "ignore",
      trust: createSemanticKatexTrust(),
      output: "html",
    });
    return { valid: true, error: "" };
  } catch (error) {
    return { valid: false, error: error?.message || "KaTeX rejected semantic annotations." };
  }
}

function planSafeSemanticAnnotations(canonical, rangeValidation) {
  const source = canonical.displayLatex;
  const syntaxRanges = scanTexSyntaxRanges(source);
  const diagnostics = new Map();
  const invalidReasons = new Map();
  for (const error of rangeValidation.errors) {
    if (error.nodeId && !invalidReasons.has(error.nodeId)) invalidReasons.set(error.nodeId, error.reason);
  }

  const eligible = [];
  for (const node of canonical.flatNodes) {
    const range = numericRange(node.sourceRange);
    if (!shouldAnnotateNode(node, source)) {
      diagnostics.set(node.id, {
        annotationStatus: "unsupported",
        reason: classifySemanticNodeInteraction(node, source).reason || "intentionally-not-annotated",
      });
      continue;
    }
    if (invalidReasons.has(node.id)) {
      diagnostics.set(node.id, { annotationStatus: "unsupported", reason: invalidReasons.get(node.id) });
      continue;
    }
    if (range && isPureTexSyntaxRange(range, syntaxRanges)) {
      diagnostics.set(node.id, { annotationStatus: "unsupported", reason: "pure-tex-syntax" });
      continue;
    }
    const containedStructuralSyntax = range && syntaxRanges.find((syntax) => (
      ["environment-marker", "alignment-marker", "row-separator"].includes(syntax.kind)
      && syntax.start >= range.start
      && syntax.end <= range.end
    ));
    if (containedStructuralSyntax) {
      diagnostics.set(node.id, {
        annotationStatus: "unsupported",
        reason: `contains-tex-structural-syntax:${containedStructuralSyntax.kind}`,
      });
      continue;
    }
    const enclosingProtectedSyntax = range && syntaxRanges.find((syntax) => (
      syntax.kind === "scripted-structural-container"
      && syntax.start <= range.start
      && syntax.end >= range.end
    ));
    if (enclosingProtectedSyntax) {
      diagnostics.set(node.id, {
        annotationStatus: "unsupported",
        reason: "inside-layout-sensitive-script-structure",
      });
      continue;
    }
    if (range && (source[range.start] === "^" || source[range.start] === "_")) {
      diagnostics.set(node.id, { annotationStatus: "unsupported", reason: "detached-script-syntax" });
      continue;
    }
    if (range && !isLeafNode(node) && (source[range.end] === "^" || source[range.end] === "_")) {
      diagnostics.set(node.id, { annotationStatus: "unsupported", reason: "script-attached-to-structural-boundary" });
      continue;
    }
    eligible.push(node);
  }

  const laminar = [];
  for (const node of [...eligible].sort(annotationPriority)) {
    const range = numericRange(node.sourceRange);
    const conflict = laminar.find((accepted) => rangesCross(range, numericRange(accepted.sourceRange)));
    if (conflict) {
      diagnostics.set(node.id, {
        annotationStatus: "unsupported",
        reason: `crossing-semantic-range:${conflict.id}`,
      });
      continue;
    }
    laminar.push(node);
  }

  const completeCandidates = laminar.map((node) => ({ node, wrapperMode: preferredWrapperMode(node, source) }));
  const completeLatex = serializeAnnotationNodes(source, completeCandidates);
  const completeValidation = katexAcceptsAnnotation(completeLatex);
  if (completeValidation.valid) {
    for (const node of laminar) diagnostics.set(node.id, { annotationStatus: "exact", reason: "" });
    return {
      latex: completeLatex,
      accepted: completeCandidates,
      diagnostics,
      syntaxRanges,
      originalKatexValid: true,
      completeAnnotationValid: true,
    };
  }

  // A grammar-sensitive construct invalidated the all-at-once annotation.
  // Rebuild transactionally from precise leaves outward. Each accepted node
  // is tested together with every previously accepted node, so the final
  // result is guaranteed to remain valid KaTeX while only the offending
  // ownership ranges are downgraded.
  const accepted = [];
  for (const node of [...laminar].sort(annotationPriority)) {
    const preferredMode = preferredWrapperMode(node, source);
    const modes = preferredMode === "grouped" ? ["grouped", "direct"] : ["direct", "grouped"];
    let acceptedCandidate = null;
    let lastValidation = null;
    for (const wrapperMode of modes) {
      const candidate = { node, wrapperMode };
      const candidateLatex = serializeAnnotationNodes(source, [...accepted, candidate]);
      lastValidation = katexAcceptsAnnotation(candidateLatex);
      if (lastValidation.valid) {
        acceptedCandidate = candidate;
        break;
      }
    }
    if (acceptedCandidate) {
      accepted.push(acceptedCandidate);
      diagnostics.set(node.id, {
        annotationStatus: "exact",
        reason: "",
        wrapperMode: acceptedCandidate.wrapperMode,
      });
    } else {
      diagnostics.set(node.id, {
        annotationStatus: "unsupported",
        reason: "katex-rejected-wrapper-boundary",
        katexError: lastValidation?.error || "KaTeX rejected semantic wrapper boundary.",
      });
    }
  }

  return {
    latex: serializeAnnotationNodes(source, accepted),
    accepted,
    diagnostics,
    syntaxRanges,
    originalKatexValid: true,
    completeAnnotationValid: false,
    completeAnnotationError: completeValidation.error,
  };
}

export function serializeSemanticTreeToLatex(tree = null) {
  const canonical = normalizeCanonicalSemanticTree(tree);
  if (!canonical?.displayLatex) {
    return {
      latex: "",
      annotatedNodeCount: 0,
      annotatedNodeIds: [],
      canonicalTree: canonical,
      error: "missing-canonical-tree",
    };
  }

  const originalValidation = katexAcceptsAnnotation(canonical.displayLatex);
  if (!originalValidation.valid) {
    return {
      latex: "",
      annotatedNodeCount: 0,
      annotatedNodeIds: [],
      canonicalTree: canonical,
      error: "original-katex-invalid",
      diagnostics: [{ reason: "original-katex-invalid", katexError: originalValidation.error }],
    };
  }

  const rangeValidation = validateSemanticTreeRanges(canonical);
  const plan = planSafeSemanticAnnotations(canonical, rangeValidation);
  const annotatedNodeIds = plan.accepted.map((candidate) => (candidate.node || candidate).id);

  return {
    latex: plan.latex,
    annotatedNodeCount: annotatedNodeIds.length,
    annotatedNodeIds,
    nodeDiagnostics: canonical.flatNodes.map((node) => ({
      semanticId: node.id,
      serialized: annotatedNodeIds.includes(node.id),
      annotationStatus: plan.diagnostics.get(node.id)?.annotationStatus || "unsupported",
      reason: plan.diagnostics.get(node.id)?.reason || "",
      katexError: plan.diagnostics.get(node.id)?.katexError || "",
      wrapperMode: plan.diagnostics.get(node.id)?.wrapperMode || "",
    })),
    annotationPlan: {
      originalKatexValid: plan.originalKatexValid,
      completeAnnotationValid: plan.completeAnnotationValid,
      completeAnnotationError: plan.completeAnnotationError || "",
      syntaxRanges: plan.syntaxRanges,
      exactNodeIds: annotatedNodeIds,
      unsupportedNodeIds: canonical.flatNodes
        .filter((node) => !annotatedNodeIds.includes(node.id))
        .map((node) => node.id),
    },
    rangeValidation,
    canonicalTree: canonical,
    // Valid original TeX is always returned, even when no semantic range is
    // safe. This makes degradation local and prevents MathRenderer from
    // treating semantic limitations as a whole-expression render failure.
    error: "",
  };
}

export function createSemanticKatexTrust() {
  return (context = {}) => {
    if (context.command !== "\\htmlData") return false;
    const attributes = context.attributes || {};
    const allowedKeys = new Set([
      "data-semantic-id",
      "data-semantic-kind",
      "data-semantic-role",
      "data-semantic-type",
      "data-semantic-depth",
      "data-semantic-priority",
      "data-semantic-range",
      "data-semantic-selectable",
    ]);

    return Object.entries(attributes).every(([key, value]) => (
      allowedKeys.has(key)
      && SAFE_DATA_VALUE_PATTERN.test(String(value || ""))
    ));
  };
}
