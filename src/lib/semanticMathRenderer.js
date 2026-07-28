const SAFE_DATA_VALUE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const HIDDEN_SYNTAX_LATEX = new Set(["^", "_"]);
const HIDDEN_ROLES = new Set(["delimiter"]);
const GROUP_ANNOTATION_ROLES = new Set([
  "argument",
  "base",
  "bound",
  "denominator",
  "differential",
  "exponent",
  "fraction",
  "function",
  "integral",
  "lowerBound",
  "numerator",
  "power",
  "radicand",
  "root",
  "upperBound",
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

function wrapWithSemanticData(node, content, source) {
  return `{\\htmlData{${htmlDataAttributesForNode(node, source)}}{${content}}}`;
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
  if (!validation.valid || !canonical) return false;
  const source = canonical.displayLatex;
  return canonical.flatNodes.some((node) => shouldAnnotateNode(node, source));
}

export function serializeSemanticTreeToLatex(tree = null) {
  const canonical = normalizeCanonicalSemanticTree(tree);
  if (!canonical?.displayLatex) {
    return {
      latex: "",
      annotatedNodeCount: 0,
      canonicalTree: canonical,
      error: "missing-canonical-tree",
    };
  }

  const rangeValidation = validateSemanticTreeRanges(canonical);
  if (!rangeValidation.valid) {
    return {
      latex: "",
      annotatedNodeCount: 0,
      canonicalTree: canonical,
      error: "invalid-semantic-ranges",
      rangeValidation,
      diagnostics: rangeValidation.errors,
    };
  }

  const source = canonical.displayLatex;
  const root = canonical.nodes[canonical.rootId] || canonical.semanticTree;
  const rootStart = 0;
  const rootEnd = source.length;
  const nodesByParent = new Map();

  for (const node of canonical.flatNodes) {
    const range = numericRange(node.sourceRange);
    if (!range || range.start < rootStart || range.end > rootEnd) continue;
    const key = node.parentId || "__root__";
    const list = nodesByParent.get(key) || [];
    list.push(node);
    nodesByParent.set(key, list);
  }

  for (const [key, nodes] of nodesByParent) {
    nodesByParent.set(key, nodes.sort(sortNodesByRange));
  }

  let annotatedNodeCount = 0;

  const renderRange = (start, end, parentId) => {
    const children = (nodesByParent.get(parentId || "__root__") || [])
      .filter((child) => {
        const range = numericRange(child.sourceRange);
        return range && range.start >= start && range.end <= end;
      });
    let cursor = start;
    let output = "";

    for (const child of children) {
      const range = numericRange(child.sourceRange);
      if (!range || range.start < cursor || range.start < start || range.end > end) continue;
      output += source.slice(cursor, range.start);
      output += renderNode(child);
      cursor = range.end;
    }

    return `${output}${source.slice(cursor, end)}`;
  };

  const renderNode = (node) => {
    const range = numericRange(node.sourceRange);
    if (!range) return "";
    const content = renderRange(range.start, range.end, node.id);
    if (!shouldAnnotateNode(node, source)) return content;
    annotatedNodeCount += 1;
    return wrapWithSemanticData(node, content, source);
  };

  const latex = root?.sourceRange
    ? renderRange(rootStart, rootEnd, root.id)
    : renderRange(rootStart, rootEnd, "__root__");

  return {
    latex,
    annotatedNodeCount,
    canonicalTree: canonical,
    error: annotatedNodeCount > 0 ? "" : "no-serializable-nodes",
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
