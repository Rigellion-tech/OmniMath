function finitePointer(pointer = null) {
  const clientX = Number(pointer?.clientX ?? pointer?.x);
  const clientY = Number(pointer?.clientY ?? pointer?.y);
  return Number.isFinite(clientX) && Number.isFinite(clientY)
    ? { clientX, clientY }
    : null;
}

function pointInRect(rect = {}, pointer = null) {
  return Boolean(pointer && rect)
    && pointer.clientX >= Number(rect.left)
    && pointer.clientX <= Number(rect.right ?? (Number(rect.left) + Number(rect.width)))
    && pointer.clientY >= Number(rect.top)
    && pointer.clientY <= Number(rect.bottom ?? (Number(rect.top) + Number(rect.height)));
}

function closestMatching(element, selector) {
  return element?.matches?.(selector) ? element : element?.closest?.(selector) || null;
}

function semanticIdsForTooltip(tooltip) {
  return [
    tooltip?.getAttribute?.("data-tooltip-semantic-id"),
    tooltip?.getAttribute?.("data-semantic-id"),
    tooltip?.getAttribute?.("data-token-id"),
  ].filter(Boolean);
}

function findConnectedSource({ sourceElement = null, measuredTarget = null, documentRef = null } = {}) {
  if (sourceElement && sourceElement.isConnected !== false) return sourceElement;
  if (!documentRef?.querySelectorAll) return null;
  const ownerId = measuredTarget?.ownerId;
  if (ownerId) {
    const owners = [...(documentRef.querySelectorAll?.("[data-math-chunk-owner]") || [])];
    const owner = owners.find((element) => element.getAttribute?.("data-math-chunk-owner") === ownerId);
    if (owner) return owner;
  }
  return null;
}

/**
 * Reconciles browser hit testing with OmniMath's logical source-token + tooltip
 * hover region. This is deliberately event driven; callers invoke it only after
 * a relevant layout mutation or before executing a delayed clear.
 */
export function reconcileLogicalHoverOwnership({
  pointer: rawPointer = null,
  activeTokenId = null,
  activeSemanticId = null,
  sourceElement = null,
  measuredTargets = [],
  documentRef = typeof document !== "undefined" ? document : null,
} = {}) {
  const pointer = finitePointer(rawPointer);
  if (!pointer || !activeTokenId || !documentRef?.elementsFromPoint) {
    return {
      retained: false,
      owner: null,
      reason: !pointer ? "missing-pointer" : !activeTokenId ? "missing-active-token" : "hit-testing-unavailable",
      pointer,
      sourceElement: null,
      measuredTarget: null,
    };
  }

  const measuredTarget = measuredTargets.find((target) => target?.id === activeTokenId) || null;
  const currentSource = findConnectedSource({ sourceElement, measuredTarget, documentRef });
  const hitStack = [...(documentRef.elementsFromPoint(pointer.clientX, pointer.clientY) || [])];
  const validIds = new Set([activeTokenId, activeSemanticId].filter(Boolean));
  const tooltip = hitStack
    .map((element) => closestMatching(element, ".omni-quick-tooltip"))
    .find((candidate) => candidate && semanticIdsForTooltip(candidate).some((id) => validIds.has(id))) || null;

  if (tooltip) {
    return {
      retained: true,
      owner: "tooltip",
      reason: "matching-tooltip-hit",
      pointer,
      sourceElement: currentSource,
      measuredTarget,
      tooltip,
    };
  }

  const sourceInHitStack = Boolean(currentSource) && hitStack.some((element) => (
    element === currentSource
    || currentSource.contains?.(element)
  ));
  const activeRectHit = measuredTarget?.geometryValid !== false
    && (measuredTarget?.rects?.some((rect) => pointInRect(rect, pointer)) || false);
  const sourceRectHit = !measuredTarget && currentSource?.getBoundingClientRect
    ? pointInRect(currentSource.getBoundingClientRect(), pointer)
    : false;

  if (currentSource && sourceInHitStack && (activeRectHit || sourceRectHit)) {
    return {
      retained: true,
      owner: "source",
      reason: activeRectHit ? "active-token-geometry-hit" : "source-element-hit",
      pointer,
      sourceElement: currentSource,
      measuredTarget,
    };
  }

  return {
    retained: false,
    owner: null,
    reason: !currentSource
      ? "source-owner-missing"
      : !sourceInHitStack
        ? "pointer-outside-logical-region"
        : "pointer-outside-active-token-geometry",
    pointer,
    sourceElement: currentSource,
    measuredTarget,
  };
}

/**
 * @param {{
 *   scheduledRevision?: number,
 *   currentRevision?: number,
 *   reconciliation?: { retained?: boolean, owner?: string | null, reason?: string } | null
 * }} options
 */
export function shouldExecuteHoverClear({ scheduledRevision, currentRevision, reconciliation } = {}) {
  if (scheduledRevision !== currentRevision) return { execute: false, reason: "stale-hover-revision" };
  if (reconciliation?.retained) return { execute: false, reason: `ownership-retained:${reconciliation.owner}` };
  return { execute: true, reason: reconciliation?.reason || "logical-region-departed" };
}
