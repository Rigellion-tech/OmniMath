import { classifySemanticNodeInteraction, normalizeCanonicalSemanticTree } from "./semanticMathRenderer.js";

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

export function auditSemanticCoverage({
  tree = null,
  serialization = null,
  domRoot = null,
  domHtml = "",
  measuredTargets = null,
  geometryAcceptedTargets = null,
  reachableTargets = null,
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

  const nodes = (canonical?.flatNodes || []).map((node) => {
    const interaction = classifySemanticNodeInteraction(node, source);
    const serialized = serializedIds.has(node.id);
    const domAnnotationFound = domIds.has(node.id);
    const measuredTarget = measuredById.get(node.id) || null;
    const measured = Boolean(measuredTarget && targetHasGeometry(measuredTarget));
    const geometryAccepted = acceptedIds.has(node.id) && measured;
    const reachable = reachableIds.has(node.id) && geometryAccepted;
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
      type: node.type || node.kind || "node",
      role: node.role || node.kind || node.type || "node",
      source: node.source || node.latex || node.display || node.text || "",
      latex: node.latex || node.display || node.text || "",
      sourceRange: node.sourceRange || null,
      interactionClassification: interaction.classification,
      serialized,
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
    complete: silentMissingNodes.length === 0,
  };
}
