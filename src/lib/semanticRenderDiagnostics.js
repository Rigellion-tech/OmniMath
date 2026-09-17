import { resolveSemanticTarget } from "./semanticHitboxes.js";

const rectCopy = (rect) => rect ? Object.fromEntries(
  ["left", "top", "right", "bottom", "width", "height"].map((key) => [key, rect[key]]),
) : null;

/** Called on demand by the development console, never from pointer handlers. */
export function inspectSemanticRenderTarget({ tree, rendering, snapshot, id, pointer = null }) {
  const node = tree?.nodeMap?.[id];
  if (!node) return null;
  const annotation = rendering?.nodeDiagnostics?.find((item) => item.semanticId === id) || null;
  const target = [...(snapshot?.targets || []), ...(snapshot?.rejectedTargets || [])].find((item) => item.id === id);
  const owners = [...new Set(target?.elements || [])];
  const selection = pointer && snapshot?.valid ? resolveSemanticTarget({
    pointer, candidates: snapshot.childTargets || [],
  }) : null;
  return {
    semanticId: id,
    sourceLatex: tree.displayLatex,
    sourceRange: node.sourceRange,
    sourceSlice: node.sourceRange ? tree.displayLatex.slice(node.sourceRange.start, node.sourceRange.end) : null,
    type: node.type,
    role: node.role,
    parentId: node.parentId,
    childIds: node.childIds,
    annotatedLatex: rendering?.latex || "",
    annotation,
    grammarVersion: rendering?.annotationPlan?.grammarVersion,
    grammarSlots: (rendering?.annotationPlan?.grammarSlots || []).filter((slot) => (
      node.sourceRange && slot.start >= node.sourceRange.start && slot.end <= node.sourceRange.end
    )),
    // Retain actual elements so DevTools can reveal the owner in the DOM.
    ownerElements: owners,
    owners: owners.map((element) => ({
      connected: element.isConnected,
      className: element.getAttribute?.("class"),
      semanticId: element.getAttribute?.("data-semantic-id"),
      liveRects: Array.from(element.getClientRects?.() || []).map(rectCopy),
    })),
    geometry: {
      snapshotValid: snapshot?.valid || false,
      revision: snapshot?.revision,
      translationRevision: snapshot?.translationRevision,
      phase: snapshot?.phase,
      accepted: target?.geometryValid === true,
      reason: snapshot?.reason || "",
      filteringReasons: target?.geometryRejectionReasons || [],
      rectSource: target?.rectSource || null,
      rects: target?.rects || [],
      paintedRects: target?.paintedRects || [],
      gapRects: target?.gapRects || [],
      ownedPrimitiveRects: target?.ownedPrimitiveRects || [],
    },
    pointerSelection: pointer ? {
      pointer,
      selectedId: selection?.target?.id || null,
      reason: selection?.reason || "snapshot-invalid",
      candidates: (selection?.candidateScores || []).map((candidate) => ({
        id: candidate.target?.id, paintedExact: candidate.paintedExact,
        gapExact: candidate.gapExact, ownedPrimitiveExact: candidate.ownedPrimitiveExact,
        geometryQuality: candidate.geometryQuality, score: candidate.score,
      })),
    } : null,
  };
}
