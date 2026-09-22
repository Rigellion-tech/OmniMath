import { classifySemanticNodeInteraction, normalizeCanonicalSemanticTree } from "./semanticMathRenderer.js";
import { getTexSourceAtoms } from "./texAnnotationGrammar.js";

function asIdSet(value = []) {
  if (value instanceof Set) return value;
  if (value instanceof Map) return new Set(value.keys());
  return new Set((Array.isArray(value) ? value : []).map((item) => (
    typeof item === "string" ? item : item?.id || item?.semanticId || item?.semanticNodeId
  )).filter(Boolean));
}

function annotationIdsFromDom(domRoot = null, domHtml = "") {
  if (domRoot?.querySelectorAll) {
    return new Set([...domRoot.querySelectorAll("[data-semantic-id]")]
      .map((element) => element.getAttribute?.("data-semantic-id"))
      .filter(Boolean));
  }
  const ids = new Set();
  const pattern = /\bdata-semantic-id=["']([^"']+)["']/gu;
  let match = null;
  while ((match = pattern.exec(String(domHtml || "")))) ids.add(match[1]);
  return ids;
}

function targetHasGeometry(target = {}) {
  return (target.rects || []).some((rect) => Number(rect?.width) > 0 && Number(rect?.height) > 0);
}

const SOURCE_GROUP_OWNER_ROLES = new Set([
  "absoluteValue", "argument", "bound", "delimited", "differential", "lowerBound",
  "operatorHead", "parenthesized", "power", "radicand", "root", "upperBound",
]);

function rangeFor(value = {}) {
  const start = Number(value?.sourceRange?.start ?? value?.start);
  const end = Number(value?.sourceRange?.end ?? value?.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
}

function visibleSourceAtoms(source = "", canonical = null) {
  const atoms = getTexSourceAtoms(source).map((atom) => ({ ...atom, sourceRange: { start: atom.start, end: atom.end } }));
  const primePattern = /'+/gu;
  let primeMatch = null;
  while ((primeMatch = primePattern.exec(source))) {
    atoms.push({
      start: primeMatch.index,
      end: primeMatch.index + primeMatch[0].length,
      sourceRange: { start: primeMatch.index, end: primeMatch.index + primeMatch[0].length },
      type: "prime",
    });
  }
  // KaTeX does not attach source locations to some painted large operators.
  // Their canonical semantic leaves are nevertheless exact source atoms and
  // must participate in the same end-to-end coverage audit.
  for (const node of canonical?.flatNodes || []) {
    const role = node.role || node.type || "";
    if (!["integralSymbol", "summationOperator", "productOperator", "limitOperator", "extremumOperator"].includes(role)) continue;
    const range = rangeFor(node);
    if (!range || atoms.some((atom) => atom.start === range.start && atom.end === range.end)) continue;
    atoms.push({ ...range, sourceRange: range, type: "large-operator" });
  }
  return atoms
    .filter((atom) => atom.end > atom.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((atom, index, all) => index === 0 || atom.start !== all[index - 1].start || atom.end !== all[index - 1].end);
}

function asOutcomeMap(value = null) {
  if (value instanceof Map) return value;
  return new Map((value || []).map((item) => [item?.semanticId || item?.id, item]).filter(([id]) => id));
}

export function auditSemanticCoverage({
  tree = null,
  serialization = null,
  domRoot = null,
  domHtml = "",
  measuredTargets = null,
  geometryAcceptedTargets = null,
  reachableTargets = null,
  pointerResolutions = null,
  hoverDispatches = null,
} = {}) {
  const canonical = normalizeCanonicalSemanticTree(tree);
  const source = canonical?.displayLatex || "";
  const serializedIds = new Set(serialization?.annotatedNodeIds || []);
  const serializationDiagnostics = new Map((serialization?.nodeDiagnostics || []).map((item) => [item.semanticId, item]));
  const domIds = annotationIdsFromDom(domRoot, domHtml);
  const measuredById = measuredTargets instanceof Map
    ? measuredTargets
    : new Map((measuredTargets || []).map((target) => [target?.id || target?.semanticId, target]).filter(([id]) => id));
  const acceptedSource = geometryAcceptedTargets ?? measuredTargets;
  const reachableSource = reachableTargets ?? acceptedSource;
  const acceptedIds = asIdSet(acceptedSource || []);
  const reachableIds = asIdSet(reachableSource || []);
  const pointerById = asOutcomeMap(pointerResolutions);
  const dispatchById = asOutcomeMap(hoverDispatches);

  // Compare KaTeX's visible source atoms with leaf ranges independently of
  // the node pipeline. A parser can omit an entire suffix while every node it
  // did create still passes annotation, geometry, and reachability checks.
  const sourceAtoms = visibleSourceAtoms(source, canonical).map((atom) => {
    const containing = (canonical?.flatNodes || []).filter((node) => {
      const range = rangeFor(node);
      if (!range || range.start > atom.start || range.end < atom.end) return false;
      const interaction = classifySemanticNodeInteraction(node, source);
      return interaction.interactive || SOURCE_GROUP_OWNER_ROLES.has(node.role || node.type || "");
    }).sort((left, right) => {
      const leftRange = rangeFor(left);
      const rightRange = rangeFor(right);
      const leftSerialized = serializedIds.has(left.id);
      const rightSerialized = serializedIds.has(right.id);
      return Number(rightSerialized) - Number(leftSerialized)
        || (leftRange.end - leftRange.start) - (rightRange.end - rightRange.start)
        || Number(right.depth || 0) - Number(left.depth || 0);
    });
    const owner = containing[0] || null;
    const ownerId = owner?.id || "";
    const measuredTarget = measuredById.get(ownerId) || null;
    const serialized = Boolean(ownerId && serializedIds.has(ownerId));
    const domAnnotationFound = Boolean(ownerId && domIds.has(ownerId));
    const measured = Boolean(measuredTarget && targetHasGeometry(measuredTarget));
    const geometryAccepted = Boolean(ownerId && acceptedIds.has(ownerId) && measured);
    const reachable = Boolean(ownerId && reachableIds.has(ownerId) && geometryAccepted);
    const pointer = pointerById.get(ownerId);
    const pointerResolved = pointerResolutions === null
      ? null
      : Boolean(pointer && (pointer.resolvedSemanticId || pointer.semanticId || pointer.id) === ownerId);
    const dispatch = dispatchById.get(ownerId);
    const hoverDispatched = hoverDispatches === null
      ? null
      : Boolean(dispatch && (dispatch.semanticId || dispatch.id) === ownerId);
    let firstFailingLayer = 0;
    let failureReason = "";
    if (!owner) {
      firstFailingLayer = 1;
      failureReason = "visible-source-atom-without-semantic-node";
    } else if (serialization && !serialized) {
      firstFailingLayer = 3;
      failureReason = serializationDiagnostics.get(ownerId)?.reason || "annotation-wrapper-missing";
    } else if ((domRoot || domHtml) && !domAnnotationFound) {
      firstFailingLayer = 4;
      failureReason = "dom-owner-missing";
    } else if (measuredTargets !== null && !measured) {
      firstFailingLayer = 5;
      failureReason = measuredTarget?.noGeometryReason || "geometry-missing";
    } else if (acceptedSource !== null && !geometryAccepted) {
      firstFailingLayer = 5;
      failureReason = "geometry-rejected";
    } else if (reachableSource !== null && !reachable) {
      firstFailingLayer = 6;
      failureReason = "pointer-target-unreachable";
    } else if (pointerResolved === false) {
      firstFailingLayer = 6;
      failureReason = "pointer-resolver-selected-wrong-target";
    } else if (hoverDispatched === false) {
      firstFailingLayer = 7;
      failureReason = "hover-request-not-dispatched";
    }
    return {
      latex: source.slice(atom.start, atom.end),
      type: atom.type,
      sourceRange: { start: atom.start, end: atom.end },
      semanticId: ownerId || null,
      semanticRole: owner?.role || owner?.type || null,
      semanticSourceRange: rangeFor(owner),
      serialized,
      domAnnotationFound,
      measured,
      geometryAccepted,
      reachable,
      pointerResolved,
      hoverDispatched,
      firstFailingLayer,
      failureReason,
    };
  });
  const sourceAtomGaps = sourceAtoms.filter((atom) => atom.firstFailingLayer === 1).map((atom) => ({
    sourceRange: atom.sourceRange,
    latex: atom.latex,
    type: atom.type,
    failureReason: atom.failureReason,
  }));

  const nodes = (canonical?.flatNodes || []).map((node) => {
    const interaction = classifySemanticNodeInteraction(node, source);
    const directlySerialized = serializedIds.has(node.id);
    let representedBy = null;
    let ancestorId = node.parentId;
    const seen = new Set([node.id]);
    while (!directlySerialized && ancestorId && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const ancestor = canonical?.nodeMap?.[ancestorId];
      const role = ancestor?.role || ancestor?.type || "";
      if (ancestor && serializedIds.has(ancestor.id) && SOURCE_GROUP_OWNER_ROLES.has(role)) {
        representedBy = ancestor;
        break;
      }
      ancestorId = ancestor?.parentId;
    }
    const effectiveId = directlySerialized ? node.id : representedBy?.id || node.id;
    const serialized = directlySerialized || Boolean(representedBy);
    const domAnnotationFound = domIds.has(effectiveId);
    const measuredTarget = measuredById.get(effectiveId) || null;
    const measured = Boolean(measuredTarget && targetHasGeometry(measuredTarget));
    const geometryAccepted = acceptedIds.has(effectiveId) && measured;
    const reachable = reachableIds.has(effectiveId) && geometryAccepted;
    let failureReason = "";
    if (!interaction.interactive) failureReason = interaction.reason;
    else if (serialization?.error) failureReason = `serialization-failed:${serialization.error}`;
    else if (!serialized) failureReason = serializationDiagnostics.get(node.id)?.reason || "semantic-node-not-serialized";
    else if ((domRoot || domHtml) && !domAnnotationFound) failureReason = "dom-annotation-not-found";
    else if (measuredTargets !== null && !measured) failureReason = measuredTarget?.noGeometryReason || "not-measured";
    else if (acceptedSource !== null && !geometryAccepted) failureReason = "geometry-rejected";
    else if (reachableSource !== null && !reachable) failureReason = "not-reachable";

    return {
      semanticId: node.id,
      effectiveSemanticId: effectiveId,
      representedBySemanticId: representedBy?.id || null,
      type: node.type || node.kind || "node",
      role: node.role || node.kind || node.type || "node",
      source: node.source || node.latex || node.display || node.text || "",
      latex: node.latex || node.display || node.text || "",
      sourceRange: node.sourceRange || null,
      interactionClassification: interaction.classification,
      serialized,
      directlySerialized,
      domAnnotationFound,
      measured,
      geometryAccepted,
      reachable,
      coverageOutcome: reachable
        ? "authoritative-reachable-geometry"
        : !interaction.interactive
          ? "intentional-non-leaf-interactive"
          : "explicit-pipeline-failure",
      failureReason,
    };
  });

  const silentMissingNodes = nodes.filter((node) => (
    node.interactionClassification === "interactive-leaf"
    && Boolean(node.failureReason)
  ));
  return {
    sourceLatex: source,
    serializationError: serialization?.error || "",
    nodes,
    silentMissingNodes,
    sourceAtomGaps,
    sourceAtoms,
    sourceAtomCoverageComplete: sourceAtomGaps.length === 0,
    complete: silentMissingNodes.length === 0 && sourceAtoms.every((atom) => atom.firstFailingLayer === 0),
  };
}
