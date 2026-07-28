function cleanSelectionId(value = "selection") {
  return String(value || "selection")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "selection";
}

function getNode(tree, id) {
  return tree?.nodeMap?.[id] || tree?.nodes?.[id] || null;
}

function leavesForNode(tree, nodeId) {
  const node = getNode(tree, nodeId);
  if (!node) return [];
  if (!node.childIds?.length) return [node.id];
  return tree.linearLeaves.slice(node.leafStart, node.leafEnd + 1);
}

export function normalizeRangeToNode(tree, leafIds = []) {
  if (!tree || leafIds.length === 0) return null;
  const ordered = [...leafIds].sort((left, right) => (getNode(tree, left)?.order ?? 0) - (getNode(tree, right)?.order ?? 0));
  const first = getNode(tree, ordered[0]);
  const last = getNode(tree, ordered.at(-1));
  if (!first || !last) return null;
  const spanStart = first.order;
  const spanEnd = last.order;
  return [...(tree.flatNodes || [])]
    .filter((node) => node.leafStart === spanStart && node.leafEnd === spanEnd)
    .sort((left, right) => (Number(right.depth) - Number(left.depth)))[0]?.id || null;
}

export function createSemanticSelection(tree, nodeId) {
  const node = getNode(tree, nodeId);
  if (!node) return null;
  const leafIds = leavesForNode(tree, nodeId);
  return {
    id: `sel-${cleanSelectionId(nodeId)}`,
    stepId: tree.stepId,
    kind: "semantic",
    nodeIds: [nodeId],
    leafIds,
    anchorId: nodeId,
    focusId: nodeId,
    normalizedToNodeId: nodeId,
    selectedText: node.latex,
  };
}

export function createRangeSelection(tree, anchorId, focusId) {
  const anchor = getNode(tree, anchorId);
  const focus = getNode(tree, focusId);
  if (!anchor || !focus) return null;
  const anchorOrder = anchor.order ?? anchor.leafStart;
  const focusOrder = focus.order ?? focus.leafEnd;
  if (!Number.isFinite(anchorOrder) || !Number.isFinite(focusOrder)) return null;
  const [from, to] = anchorOrder <= focusOrder ? [anchorOrder, focusOrder] : [focusOrder, anchorOrder];
  const leafIds = tree.linearLeaves.slice(from, to + 1);
  const normalizedToNodeId = normalizeRangeToNode(tree, leafIds);
  const normalizedNode = normalizedToNodeId ? getNode(tree, normalizedToNodeId) : null;
  const nodeIds = normalizedToNodeId ? [normalizedToNodeId] : leafIds;
  return {
    id: `sel-${cleanSelectionId(tree.stepId)}-${from}-${to}`,
    stepId: tree.stepId,
    kind: normalizedToNodeId ? "semantic" : "range",
    nodeIds,
    leafIds,
    anchorId,
    focusId,
    normalizedToNodeId,
    selectedText: normalizedNode?.latex || leafIds.map((leafId) => getNode(tree, leafId)?.latex).filter(Boolean).join(" "),
  };
}

export function createMultiSelection(tree, nodeIds = []) {
  const validNodeIds = nodeIds.filter((nodeId) => getNode(tree, nodeId));
  if (validNodeIds.length === 0) return null;
  const leafIds = [...new Set(validNodeIds.flatMap((nodeId) => leavesForNode(tree, nodeId)))]
    .sort((left, right) => (getNode(tree, left)?.order ?? 0) - (getNode(tree, right)?.order ?? 0));
  return {
    id: `sel-${cleanSelectionId(tree.stepId)}-${cleanSelectionId(validNodeIds.join("-"))}`,
    stepId: tree.stepId,
    kind: "multi",
    nodeIds: validNodeIds,
    leafIds,
    anchorId: validNodeIds[0],
    focusId: validNodeIds.at(-1),
    normalizedToNodeId: null,
    selectedText: validNodeIds.map((nodeId) => getNode(tree, nodeId)?.latex).filter(Boolean).join(" "),
  };
}
