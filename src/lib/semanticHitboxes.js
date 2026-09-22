export function rectArea(rect = {}) {
  if (!rect) return 0;
  const width = Math.max(0, Number(rect.width ?? rect.right - rect.left) || 0);
  const height = Math.max(0, Number(rect.height ?? rect.bottom - rect.top) || 0);
  return width * height;
}

export function rectContainsPoint(rect = {}, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Convert a viewport-space DOM rectangle into the local coordinate space of
 * an ancestor that scrolls with the same rendered content. Scroll offsets and
 * page movement are already represented in both viewport rectangles, so they
 * must not be added again here.
 */
export function viewportRectToLocalSemanticRect(rect = null, originRect = null, options = {}) {
  const source = normalizeSemanticRect(rect);
  const origin = normalizeSemanticRect(originRect);
  if (!source || !origin) return null;

  const layoutWidth = Number(options.originWidth);
  const layoutHeight = Number(options.originHeight);
  const scaleX = Number.isFinite(layoutWidth) && layoutWidth > 0 && origin.width > 0
    ? origin.width / layoutWidth
    : 1;
  const scaleY = Number.isFinite(layoutHeight) && layoutHeight > 0 && origin.height > 0
    ? origin.height / layoutHeight
    : 1;

  const scrollLeft = Number(options.scrollLeft) || 0;
  const scrollTop = Number(options.scrollTop) || 0;
  const left = (source.left - origin.left) / scaleX + scrollLeft;
  const top = (source.top - origin.top) / scaleY + scrollTop;
  const width = source.width / scaleX;
  const height = source.height / scaleY;
  return normalizeSemanticRect({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });
}

/** Convert a stable root-content-local rectangle back into viewport space. */
export function localSemanticRectToViewportRect(rect = null, originRect = null, options = {}) {
  const source = normalizeSemanticRect(rect);
  const origin = normalizeSemanticRect(originRect);
  if (!source || !origin) return null;

  const layoutWidth = Number(options.originWidth);
  const layoutHeight = Number(options.originHeight);
  const scaleX = Number.isFinite(layoutWidth) && layoutWidth > 0 && origin.width > 0
    ? origin.width / layoutWidth
    : 1;
  const scaleY = Number.isFinite(layoutHeight) && layoutHeight > 0 && origin.height > 0
    ? origin.height / layoutHeight
    : 1;
  const scrollLeft = Number(options.scrollLeft) || 0;
  const scrollTop = Number(options.scrollTop) || 0;
  const left = origin.left + (source.left - scrollLeft) * scaleX;
  const top = origin.top + (source.top - scrollTop) * scaleY;
  const width = source.width * scaleX;
  const height = source.height * scaleY;
  return normalizeSemanticRect({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });
}

function rectContainsRect(outer = {}, inner = {}, tolerance = 1) {
  return Boolean(outer && inner)
    && inner.left >= outer.left - tolerance
    && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance
    && inner.bottom <= outer.bottom + tolerance;
}

export function rectIntersectsRect(left = {}, right = {}) {
  return Boolean(left && right)
    && left.right > right.left
    && left.left < right.right
    && left.bottom > right.top
    && left.top < right.bottom;
}

export function preserveSemanticRectFragments(rects = []) {
  const seen = new Set();
  return rects
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => rectArea(rect) > 0)
    .filter((rect) => {
      const key = [rect.left, rect.top, rect.right, rect.bottom]
        .map((value) => Math.round(Number(value) * 100) / 100)
        .join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.top - right.top || left.left - right.left || rectArea(left) - rectArea(right));
}

/**
 * Build only the whitespace corridors between neighboring painted children.
 * These rectangles make a meaningful compound target reachable without
 * stretching its hitbox across unrelated whitespace or descendant ink.
 */
export function buildSemanticGapRects(rects = [], options = {}) {
  const children = preserveSemanticRectFragments(rects);
  const occupiedRects = preserveSemanticRectFragments(options.occupiedRects || children);
  const medianHeight = Number(options.medianHeight) || medianRectHeight(children) || 18;
  const maxGap = Number(options.maxGap) || Math.max(4, medianHeight);
  const gaps = [];

  for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) {
    const left = children[leftIndex];
    for (let rightIndex = 0; rightIndex < children.length; rightIndex += 1) {
      if (leftIndex === rightIndex) continue;
      const right = children[rightIndex];
      const width = right.left - left.right;
      if (width <= 0 || width > maxGap) continue;
      const top = Math.max(left.top, right.top);
      const bottom = Math.min(left.bottom, right.bottom);
      const overlapHeight = bottom - top;
      if (overlapHeight < Math.min(left.height, right.height) * 0.4) continue;
      const gap = normalizeSemanticRect({ left: left.right, right: right.left, top, bottom });
      if (!gap) continue;
      const occupied = occupiedRects.some((child) => rectIntersectsRect(child, gap));
      if (!occupied) gaps.push(gap);
    }
  }

  return preserveSemanticRectFragments(gaps);
}

export function dedupeSemanticTargetsById(targets = []) {
  const byId = new Map();
  for (const target of targets.filter(Boolean)) {
    const id = target.id || target.semanticId || target.semanticNodeId;
    if (!id) continue;
    const current = byId.get(id);
    if (!current) {
      byId.set(id, {
        ...target,
        rects: preserveSemanticRectFragments(target.rects || []),
        paintedRects: preserveSemanticRectFragments(target.paintedRects || []),
        gapRects: preserveSemanticRectFragments(target.gapRects || []),
        ownedPrimitiveRects: preserveSemanticRectFragments(target.ownedPrimitiveRects || []),
      });
      continue;
    }
    byId.set(id, {
      ...current,
      ...target,
      id,
      rects: preserveSemanticRectFragments([...(current.rects || []), ...(target.rects || [])]),
      paintedRects: preserveSemanticRectFragments([...(current.paintedRects || []), ...(target.paintedRects || [])]),
      gapRects: preserveSemanticRectFragments([...(current.gapRects || []), ...(target.gapRects || [])]),
      ownedPrimitiveRects: preserveSemanticRectFragments([...(current.ownedPrimitiveRects || []), ...(target.ownedPrimitiveRects || [])]),
    });
  }
  return [...byId.values()];
}

function semanticTargetId(target = {}) {
  return target.id || target.semanticId || target.semanticNodeId || "";
}

function semanticTargetSummary(target = {}) {
  return {
    id: semanticTargetId(target),
    latex: target.latex || target.display || target.text || "",
    role: target.role || target.kind || target.type || "node",
    sourceRange: target.sourceRange || null,
  };
}

export function auditSemanticHoverCoverage({
  stepId = "",
  sourceLatex = "",
  recognizedTokens = [],
  descriptors = [],
  registeredTargets = [],
  renderedTargets = [],
} = {}) {
  const descriptorIds = new Set(descriptors.map(semanticTargetId).filter(Boolean));
  const registeredIds = new Set(registeredTargets.map(semanticTargetId).filter(Boolean));
  const mappingOwners = new Map();

  for (const target of registeredTargets) {
    const mappingKey = String(target.chosenDomKey || "");
    const id = semanticTargetId(target);
    if (!mappingKey || !id) continue;
    const owners = mappingOwners.get(mappingKey) || [];
    owners.push(id);
    mappingOwners.set(mappingKey, owners);
  }

  return {
    stepId,
    sourceLatex: String(sourceLatex || ""),
    recognizedTokens: recognizedTokens.map(semanticTargetSummary),
    descriptorCount: descriptorIds.size,
    registeredNodeCount: registeredIds.size,
    unmappedTokens: descriptors
      .filter((target) => !registeredIds.has(semanticTargetId(target)))
      .map(semanticTargetSummary),
    duplicateMappings: [...mappingOwners]
      .filter(([, ids]) => new Set(ids).size > 1)
      .map(([mappingKey, ids]) => ({ mappingKey, tokenIds: [...new Set(ids)] })),
    renderedTokenIds: [...new Set(renderedTargets.map(semanticTargetId).filter(Boolean))],
  };
}

export const HOVER_ELIGIBLE_ROLES = new Set([
  "variable",
  "constant",
  "coefficient",
  "imaginaryUnit",
  "functionName",
  "function",
  "operator",
  "equality",
  "approximation",
  "radical",
  "integralSymbol",
  "differentialOperator",
  "derivativeVariable",
  "exponent",
  "base",
  "differential",
  "lowerBound",
  "upperBound",
  "bound",
  "small-group",
  "smallGroup",
  "component",
  "argument",
  "summand",
  "bound",
  "numerator",
  "denominator",
  "radicand",
]);

export const STRUCTURAL_ONLY_ROLES = new Set([
  "equation",
  "expression",
  "leftSide",
  "rightSide",
  "term",
  "sum",
  "product",
  "fraction",
  "numerator",
  "denominator",
  "integrand",
  "integral",
  "integral-expression",
  "integralExpression",
  "function",
  "argument",
  "step",
]);

const STRUCTURAL_ONLY_TYPES = new Set([
  "equation",
  "sum",
  "product",
  "fraction",
  "integral",
  "functionCall",
  "vector",
]);

const HOVER_PENALIZED_ROLES = new Set([
  "chunk",
  "line",
  "equation",
  "expression",
  "leftSide",
  "rightSide",
  "term",
  "sum",
  "product",
  "fraction",
  "numerator",
  "denominator",
  "radicand",
  "integrand",
  "integral",
  "step",
]);

export const AGGREGATE_HOVER_ROLES = new Set([
  "absoluteValue",
  "integral",
  "integral-expression",
  "integralExpression",
  "integrand",
  "lowerBound",
  "upperBound",
  "bound",
  "fraction",
  "function",
  "argument",
  "power",
  "root",
  "radical",
  "radicand",
  "numerator",
  "denominator",
  "group",
  "groupedExpression",
  "parenthesized",
  "delimited",
  "operatorHead",
  "small-group",
  "smallGroup",
]);

function compactLatexLength(target = {}) {
  return String(target.latex || target.display || target.text || "")
    .replace(/\\(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|ln|log|exp)/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "x")
    .replace(/[{}()[\]\s,]/g, "")
    .length;
}

function isCompositeAtomTarget(target = {}) {
  const type = target.type || target.kind || "";
  if (type !== "atom") return false;
  const latex = String(target.latex || target.display || target.text || "");
  return /[()+\-*/=]|\\(?:cdot|times|pm|sqrt|sin|cos|tan|arctan|ln|log)/.test(latex)
    && compactLatexLength(target) > 1;
}

export function isCompactRadicalParent(target = {}) {
  const type = target.type || target.kind || "";
  const latex = String(target.latex || target.display || target.text || "");
  return (type === "root" || /^\\sqrt/.test(latex)) && compactLatexLength(target) <= 16;
}

export function isCompactPowerParent(target = {}) {
  const type = target.type || target.kind || "";
  const latex = String(target.latex || target.display || target.text || "");
  return type === "power" && /\^/.test(latex) && compactLatexLength(target) <= 10;
}

export function isStructuralHoverTarget(target = {}) {
  const role = target.role || target.kind || target.type || "";
  const type = target.type || target.kind || "";
  return STRUCTURAL_ONLY_ROLES.has(role) || STRUCTURAL_ONLY_TYPES.has(type);
}

export function isAggregateHoverTarget(target = {}) {
  if (!target) return false;
  const hasChildren = Boolean(target.childIds?.length || target.children?.length);
  if (!hasChildren) return false;
  const role = target.role || target.kind || target.type || "";
  const type = target.type || target.kind || "";
  return AGGREGATE_HOVER_ROLES.has(role) || AGGREGATE_HOVER_ROLES.has(type);
}

export function isHoverEligibleTarget(target = {}) {
  if (!target) return false;
  const role = target.role || target.kind || target.type || "";
  const type = target.type || target.kind || "";
  // Delimiter leaves are parser bookkeeping for the visible delimiter owned
  // by their enclosing group. They intentionally have no annotation wrapper;
  // making a fallback leaf independently selectable would steal the exact
  // primitive from the group's semantic identity.
  if (
    role === "delimiter"
    || role === "evaluationBar"
    || ["integralSymbol", "summationOperator", "productOperator", "limitOperator", "extremumOperator"].includes(role)
  ) return false;
  if (type === "number") return true;
  if (isAggregateHoverTarget(target)) return true;
  if ((target.childIds?.length || target.children?.length) && !isCompactRadicalParent(target) && !isCompactPowerParent(target)) return false;
  if (isCompositeAtomTarget(target)) return false;
  if (HOVER_ELIGIBLE_ROLES.has(role)) return true;
  if (isStructuralHoverTarget(target)) {
    return ["number", "symbol", "operator", "atom", "subscript"].includes(type)
      || (!(target.type || target.kind) && compactLatexLength(target) <= 8);
  }
  return compactLatexLength(target) <= 8;
}

function candidateHits(targets = [], x, y) {
  return targets
    .filter((target) => target?.geometryValid !== false)
    .flatMap((target, targetIndex) => (
      Array.isArray(target?.rects)
        ? target.rects.map((rect, rectIndex) => {
          const paintedRects = targetPaintedRects(target);
          const paintedDistances = paintedRects.map((paintedRect) => rectPointDistance(paintedRect, x, y));
          const paintedDistance = paintedDistances.length > 0 ? Math.min(...paintedDistances) : Number.POSITIVE_INFINITY;
          return {
            target,
            rect,
            targetIndex,
            rectIndex,
            paintedExact: paintedRects.some((paintedRect) => rectContainsPoint(paintedRect, x, y)),
            gapExact: (target.gapRects || []).some((gapRect) => rectContainsPoint(gapRect, x, y)),
            ownedPrimitiveExact: (target.ownedPrimitiveRects || []).some((primitiveRect) => rectContainsPoint(primitiveRect, x, y)),
            paintedDistance,
          };
        })
        : []
    ))
    .filter(({ rect }) => rectContainsPoint(rect, x, y) && rectArea(rect) > 0)
    .filter((hit) => !isRejectedGhostHit(hit));
}

function rectSource(target = {}) {
  return String(target.rectSource || target.rect_source || "").toLowerCase();
}

function isDeterministicSemanticTarget(target = {}) {
  const source = rectSource(target);
  return Boolean(target.deterministic) || source.startsWith("semantic-dom") || source.startsWith("annotated-semantic-dom");
}

function isExplicitAggregateHoverTarget(target = {}) {
  if (!isAggregateHoverTarget(target)) return false;
  const source = rectSource(target);
  return Boolean(target.isAggregateTarget || target.aggregate)
    || source.includes("aggregate")
    || source.includes("child-union")
    || source.includes("internal-gaps")
    || source.includes("annotated");
}

function deterministicTargetPriority(target = {}) {
  const explicit = Number(target.semanticPriority ?? target.order ?? target.leafStart ?? target.sourceRange?.start);
  return Number.isFinite(explicit) ? explicit : 0;
}

const GEOMETRY_QUALITY_RANK = new Map([
  ["zero_size", 0],
  ["stale_or_unmapped", 1],
  ["structural_only", 2],
  ["collapsed", 3],
  ["broad_aggregate", 4],
  ["fragmented_group", 6],
  ["precise_group", 8],
  ["precise_leaf", 10],
]);

const GHOST_HIT_DISTANCE_PX = 7;

function rectPointDistance(rect = {}, x, y) {
  const normalized = normalizeSemanticRect(rect);
  if (!normalized) return Number.POSITIVE_INFINITY;
  const dx = x < normalized.left ? normalized.left - x : x > normalized.right ? x - normalized.right : 0;
  const dy = y < normalized.top ? normalized.top - y : y > normalized.bottom ? y - normalized.bottom : 0;
  return Math.hypot(dx, dy);
}

function targetPaintedRects(target = {}) {
  return (Array.isArray(target.paintedRects) && target.paintedRects.length > 0
    ? target.paintedRects
    : Array.isArray(target.rects) ? target.rects : []
  ).map(normalizeSemanticRect).filter(Boolean);
}

function geometryQuality(target = {}) {
  return String(target.geometryQuality || target.geometry_quality || (
    isLeafSemanticTarget(target) ? "precise_leaf" : isAggregateHoverTarget(target) ? "precise_group" : "structural_only"
  ));
}

function geometryQualityRank(target = {}) {
  return GEOMETRY_QUALITY_RANK.get(geometryQuality(target)) ?? 5;
}

function hasExplicitPaintedGeometry(target = {}) {
  return Array.isArray(target.paintedRects)
    && target.paintedRects.some((rect) => rectArea(rect) > 0);
}

function isBroadGeometryTarget(target = {}) {
  const quality = geometryQuality(target);
  return quality === "broad_aggregate"
    || quality === "fragmented_group"
    || quality === "structural_only"
    || quality === "zero_size"
    || quality === "collapsed"
    || quality === "stale_or_unmapped";
}

function sourceRangeLength(target = {}) {
  const start = Number(target.sourceRange?.start ?? target.start);
  const end = Number(target.sourceRange?.end ?? target.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : Number.POSITIVE_INFINITY;
}

function domDepthForTarget(target = {}) {
  const value = Number(target.domDepth ?? target.debugDom?.depth);
  return Number.isFinite(value) ? value : 0;
}

function isOperatorLikeTarget(target = {}) {
  const role = target.role || target.kind || target.type || "";
  const text = String(target.latex || target.display || target.text || "").trim();
  return ["operator", "equality", "approximation", "delimiter"].includes(role)
    || /^(=|\+|-|\/|,|\\cdot|\\times|\\pm|\\le|\\ge|\\approx|<|>)$/.test(text);
}

function isTrustworthyOperatorTarget(target = {}) {
  if (!isOperatorLikeTarget(target)) return true;
  return geometryQuality(target) === "precise_leaf"
    && targetPaintedRects(target).some((rect) => rectArea(rect) > 0);
}

function isRejectedGhostHit(hit = {}) {
  const target = hit.target || {};
  const quality = geometryQuality(target);
  if (["zero_size", "structural_only", "stale_or_unmapped"].includes(quality) || target.paintedArea === 0) {
    hit.rejectionReason = "untrusted-empty-or-stale-geometry";
    return true;
  }
  if (quality === "collapsed" && !hasExplicitPaintedGeometry(target)) {
    hit.rejectionReason = "collapsed-without-painted-geometry";
    return true;
  }
  if (isOperatorLikeTarget(target) && !isTrustworthyOperatorTarget(target)) {
    hit.rejectionReason = "imprecise-operator-geometry";
    return true;
  }
  if (!isBroadGeometryTarget(target)) return false;
  if (hit.gapExact) return false;
  if (hit.paintedExact) return false;
  if (Number(hit.paintedDistance) <= GHOST_HIT_DISTANCE_PX) return false;
  hit.rejectionReason = "broad-aggregate-pointer-not-on-painted-descendant";
  return true;
}

function isDifferentialOperatorChildOf(child = {}, parent = {}) {
  const childRole = child.role || child.kind || child.type || "";
  return childRole === "differentialOperator"
    && isDifferentialSemanticTarget(parent)
    && (
      child.parentId === parent.id
      || (parent.childIds || []).includes(child.id)
      || (parent.children || []).some((candidate) => candidate?.id === child.id)
    );
}

function compareDeterministicCandidates(left, right) {
  return (
    Number(isDifferentialOperatorChildOf(left.target, right.target)) - Number(isDifferentialOperatorChildOf(right.target, left.target))
    || Number(right.paintedExact) - Number(left.paintedExact)
    || geometryQualityRank(right.target) - geometryQualityRank(left.target)
    || left.paintedDistance - right.paintedDistance
    || left.area - right.area
    || Number(right.target.depth || 0) - Number(left.target.depth || 0)
    || domDepthForTarget(right.target) - domDepthForTarget(left.target)
    || Number(right.leaf) - Number(left.leaf)
    || sourceRangeLength(left.target) - sourceRangeLength(right.target)
    || aggregateScopePriority(right.target) - aggregateScopePriority(left.target)
    || left.distance - right.distance
    || deterministicTargetPriority(left.target) - deterministicTargetPriority(right.target)
    || String(left.target.id || "").localeCompare(String(right.target.id || ""))
    || left.rectIndex - right.rectIndex
  );
}

function aggregateScopePriority(target = {}) {
  if (!isAggregateHoverTarget(target)) return 0;
  const role = target.role || target.kind || target.type || "";
  if (role === "integral" || role === "integral-expression" || role === "integralExpression") return 42;
  if (role === "fraction" || role === "power" || role === "function" || role === "group" || role === "groupedExpression") return 18;
  return 0;
}

export function isUnionHoverTarget(target = {}) {
  const source = rectSource(target);
  return source.includes("union") || source.includes("child-union") || source.includes("radicand-union");
}

export function isHighlightableHoverTarget(target = {}, options = {}) {
  if (!target || !(target.rects || []).some((rect) => rectArea(rect) > 0)) return false;
  if (isDifferentialSemanticTarget(target)) return true;
  if (isPreferredAggregateHoverTarget(target) || isAggregateHoverTarget(target)) return true;
  if (isUnionHoverTarget(target) && !options.allowUnionFallback && !isCompactRadicalParent(target)) return false;
  return true;
}

function isPenalizedHoverTarget(target = {}) {
  const role = target.role || target.kind || target.type || "";
  const type = target.type || target.kind || "";
  return HOVER_PENALIZED_ROLES.has(role) || HOVER_PENALIZED_ROLES.has(type);
}

export function isLeafSemanticTarget(target = {}) {
  return !target.childIds?.length && !target.children?.length;
}

function isPreferredAggregateHoverTarget(target = {}) {
  const role = target?.role || target?.kind || target?.type || "";
  return ["lowerBound", "upperBound", "bound"].includes(role);
}

export function isDifferentialSemanticTarget(target = {}) {
  return target?.role === "differential"
    || target?.type === "differential"
    || target?.kind === "differential";
}

function isDifferentialHoverTarget(target = {}) {
  return isDifferentialSemanticTarget(target)
    && (target.rects || []).some((rect) => rectArea(rect) > 0);
}

export function isTallSemanticConstruct(target = {}) {
  const role = target.role || target.kind || target.type || "";
  const latex = String(target.latex || target.display || target.text || "");
  if (role === "radical") return false;
  return /sqrt|root|fraction|integral|sum|prod|paren|bracket/i.test(role)
    || /\\(?:sqrt|frac|int|iint|iiint|oint|sum|prod)|[()[\]{}]/.test(latex);
}

export function medianRectHeight(rects = []) {
  const heights = rects
    .map((rect) => Number(rect?.height ?? rect?.bottom - rect?.top))
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((left, right) => left - right);
  if (heights.length === 0) return 0;
  const middle = Math.floor(heights.length / 2);
  return heights.length % 2 === 1
    ? heights[middle]
    : (heights[middle - 1] + heights[middle]) / 2;
}

export function unionSemanticRects(rects = []) {
  const safeRects = rects.map(normalizeSemanticRect).filter(Boolean);
  if (safeRects.length === 0) return null;
  return normalizeSemanticRect({
    left: Math.min(...safeRects.map((rect) => rect.left)),
    right: Math.max(...safeRects.map((rect) => rect.right)),
    top: Math.min(...safeRects.map((rect) => rect.top)),
    bottom: Math.max(...safeRects.map((rect) => rect.bottom)),
  });
}

function visibleSemanticRects(rects = [], options = {}) {
  const containerRect = normalizeSemanticRect(options.containerRect);
  return rects
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => rectArea(rect) > 0)
    .filter((rect) => !containerRect || rectIntersectsRect(rect, containerRect));
}

function annotateRefinedDifferentialTarget(target = {}, rects = [], source = "", aggregateRect = null) {
  return {
    ...target,
    rects,
    rectSource: source,
    visualRectSource: source,
    aggregateRectBeforeRefinement: aggregateRect,
  };
}

function differentialGlyphLength(target = {}) {
  const latex = String(target.latex || target.display || target.text || "")
    .replace(/^\\,/, "")
    .replace(/\\(?:theta|phi|rho|alpha|beta|gamma|delta|lambda|mu|nu|xi|tau|omega)/g, "gg")
    .replace(/\\mathbf\{?([a-zA-Z])\}?/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "g")
    .replace(/[{}_\s]/g, "");
  return Math.max(2, latex.length || 2);
}

function isConservativeDifferentialRect(rect = {}, target = {}, options = {}) {
  const normalized = normalizeSemanticRect(rect);
  if (!normalized) return false;
  const medianHeight = Number(options.medianLeafHeight) || 0;
  const glyphLength = differentialGlyphLength(target);
  const heightLimit = medianHeight > 0 ? Math.max(18, medianHeight * 1.75) : 34;
  const widthLimit = medianHeight > 0
    ? Math.max(22, medianHeight * Math.max(1.75, glyphLength * 0.9))
    : Math.max(24, glyphLength * 16);
  return normalized.width <= widthLimit && normalized.height <= heightLimit;
}

export function refineDifferentialHighlightGeometry(target = {}, options = {}) {
  if (!isDifferentialSemanticTarget(target) || isLeafSemanticTarget(target)) return target;

  const aggregateRects = visibleSemanticRects(options.aggregateRects ?? target.rects, options);
  const childRects = visibleSemanticRects(options.childRects, options);
  const textRects = visibleSemanticRects(options.textRects, options);
  const medianLeafHeight = Number(options.medianLeafHeight) || medianRectHeight([...childRects, ...textRects, ...aggregateRects]);
  const aggregateUnion = unionSemanticRects(aggregateRects);
  const childUnion = unionSemanticRects(childRects);
  const textUnion = unionSemanticRects(textRects);
  const baseSource = String(target.rectSource || "semantic");
  const geometryOptions = { ...options, medianLeafHeight };

  if (childUnion && isConservativeDifferentialRect(childUnion, target, geometryOptions)) {
    const aggregateMuchWider = aggregateUnion
      ? aggregateUnion.width > Math.max(childUnion.width * 1.65, childUnion.width + 12)
      : false;
    const source = aggregateMuchWider
      ? `${baseSource}:differential-child-leaf-union-wide-aggregate`
      : `${baseSource}:differential-child-leaf-union`;
    return annotateRefinedDifferentialTarget(
      target,
      preserveSemanticRectFragments(childRects),
      source.replace("child-leaf-union", "child-leaf-fragments"),
      aggregateUnion
    );
  }

  if (textUnion && isConservativeDifferentialRect(textUnion, target, geometryOptions)) {
    return annotateRefinedDifferentialTarget(
      target,
      [textUnion],
      `${baseSource}:differential-text-range`,
      aggregateUnion
    );
  }

  const conservativeAggregateRects = aggregateRects.filter((rect) => (
    isConservativeDifferentialRect(rect, target, geometryOptions)
  ));
  if (conservativeAggregateRects.length > 0) {
    return annotateRefinedDifferentialTarget(
      target,
      conservativeAggregateRects,
      `${baseSource}:differential-conservative-aggregate`,
      aggregateUnion
    );
  }

  return annotateRefinedDifferentialTarget(
    target,
    [],
    `${baseSource}:differential-omitted-oversized`,
    aggregateUnion
  );
}

function compactTokenLength(target = {}) {
  return String(target.latex || target.display || target.text || "")
    .replace(/\\(arcsin|arccos|arctan|sin|cos|tan|sec|csc|cot|ln|log|exp)/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "x")
    .replace(/[{}_^()[\]\s,]/g, "")
    .length || 1;
}

export function filterLeafRects(rects = [], target = {}, options = {}) {
  const medianHeight = Number(options.medianLeafHeight) || 0;
  const containerRect = options.containerRect || null;
  const tallConstruct = isTallSemanticConstruct(target);
  const compactLength = compactTokenLength(target);
  const maxSimpleHeight = medianHeight > 0 ? medianHeight * 2.35 : 0;
  const maxContainerHeight = containerRect?.height ? containerRect.height * 0.72 : 0;
  const maxSimpleWidth = medianHeight > 0
    ? Math.max(18, medianHeight * Math.max(2.6, compactLength + 1.75))
    : 0;

  return rects
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (containerRect && rect.height >= containerRect.height * 0.92 && !tallConstruct) return false;
      if (!tallConstruct && maxSimpleHeight > 0 && rect.height > maxSimpleHeight) return false;
      if (!tallConstruct && maxContainerHeight > 0 && rect.height > maxContainerHeight) return false;
      if (!tallConstruct && maxSimpleWidth > 0 && rect.width > maxSimpleWidth) return false;
      return true;
    });
}

function sortHits(left, right) {
  return (
    (rectArea(left.rect) - rectArea(right.rect))
    || (Number(right.target.depth) - Number(left.target.depth))
    || (Number(isLeafSemanticTarget(right.target)) - Number(isLeafSemanticTarget(left.target)))
    || (Number(Boolean(right.target.rectSource === "dom-leaf")) - Number(Boolean(left.target.rectSource === "dom-leaf")))
    || (Number(isPenalizedHoverTarget(left.target)) - Number(isPenalizedHoverTarget(right.target)))
    || (right.targetIndex - left.targetIndex)
    || (right.rectIndex - left.rectIndex)
  );
}

function rectCenterDistance(rect = {}, x, y) {
  const centerX = (Number(rect.left) + Number(rect.right)) / 2;
  const centerY = (Number(rect.top) + Number(rect.bottom)) / 2;
  if (![centerX, centerY].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return Math.hypot(x - centerX, y - centerY);
}

function semanticScore(hit, pointer = {}, currentTarget = null, options = {}) {
  const target = hit.target || {};
  const area = Math.max(1, rectArea(hit.rect));
  const depth = Number(target.depth) || 0;
  const leaf = isLeafSemanticTarget(target);
  const source = rectSource(target);
  const role = target.role || target.kind || target.type || "";
  const type = target.type || target.kind || "";
  const compactPower = isCompactPowerParent(target);
  const compactRadical = isCompactRadicalParent(target);
  const structural = isPenalizedHoverTarget(target);
  const union = isUnionHoverTarget(target);
  const exact = rectContainsPoint(hit.rect, pointer.x, pointer.y);
  const distance = rectCenterDistance(hit.rect, pointer.x, pointer.y);
  const paintedExact = Boolean(hit.paintedExact);
  const gapExact = Boolean(hit.gapExact);
  const ownedPrimitiveExact = Boolean(hit.ownedPrimitiveExact);
  const paintedDistance = Number.isFinite(Number(hit.paintedDistance)) ? Number(hit.paintedDistance) : distance;
  const qualityRank = geometryQualityRank(target);
  const currentBonus = currentTarget?.id && currentTarget.id === target.id ? 7 : 0;
  const atomicBonus = ["number", "symbol", "operator", "function"].includes(type) || ["functionName", "exponent", "base", "constant", "variable"].includes(role) ? 42 : 0;
  const usefulCompoundBonus = compactPower || compactRadical || ["argument", "numerator", "denominator", "differential"].includes(role) ? 18 : 0;
  const differentialAggregateBonus = isDifferentialSemanticTarget(target) ? 70 : 0;
  const differentialChildPenalty = role === "differentialOperator" && target.parentId ? -95 : 0;
  const delimiterPenalty = role === "delimiter" ? -120 : 0;
  const sourceBonus = source === "dom-leaf" || source === "mathml-leaf" ? 28 : source.includes("union") ? -45 : 0;
  const aggregateBonus = isAggregateHoverTarget(target) ? 32 : 0;
  const structuralPenalty = structural && !leaf && !compactPower && !compactRadical && !isAggregateHoverTarget(target) && !options.includeStructural ? -260 : 0;
  const unionPenalty = union && !options.allowUnionFallback && !compactRadical && !isPreferredAggregateHoverTarget(target) ? -140 : 0;
  return {
    target,
    rect: hit.rect,
    targetIndex: hit.targetIndex,
    rectIndex: hit.rectIndex,
    exact,
    area,
    distance,
    paintedExact,
    gapExact,
    ownedPrimitiveExact,
    paintedDistance,
    geometryQuality: geometryQuality(target),
    geometryQualityRank: qualityRank,
    sourceRangeLength: sourceRangeLength(target),
    domDepth: domDepthForTarget(target),
    rejectionReason: hit.rejectionReason || null,
    leaf,
    role,
    score:
      (exact ? 1000 : 0)
      + (paintedExact ? 160 : 0)
      + qualityRank * 55
      + depth * 24
      + (leaf ? 95 : 0)
      + atomicBonus
      + usefulCompoundBonus
      + differentialAggregateBonus
      + aggregateBonus
      + sourceBonus
      + currentBonus
      + structuralPenalty
      + unionPenalty
      + differentialChildPenalty
      + delimiterPenalty
      - Math.log2(area) * 7
      - Math.min(90, paintedDistance * 2.2)
      - Math.min(80, distance * 0.18),
  };
}

function compareScoredCandidates(left, right) {
  return (
    Number(isDifferentialOperatorChildOf(left.target, right.target)) - Number(isDifferentialOperatorChildOf(right.target, left.target))
    || Number(right.exact) - Number(left.exact)
    || Number(right.paintedExact) - Number(left.paintedExact)
    || right.geometryQualityRank - left.geometryQualityRank
    || left.paintedDistance - right.paintedDistance
    || left.area - right.area
    || Number(right.target.depth || 0) - Number(left.target.depth || 0)
    || right.domDepth - left.domDepth
    || Number(right.leaf) - Number(left.leaf)
    || left.sourceRangeLength - right.sourceRangeLength
    || right.score - left.score
    || left.distance - right.distance
    || left.targetIndex - right.targetIndex
    || left.rectIndex - right.rectIndex
  );
}

function isNegativeNumberTarget(target = {}) {
  const text = String(target.latex || target.display || target.text || "");
  return /^-\d/.test(text) && ["number", "atom"].includes(target.type || target.kind || "number");
}

function isMinusOperatorTarget(target = {}) {
  const text = String(target.latex || target.display || target.text || "").trim();
  const role = target.role || target.kind || target.type || "";
  return text === "-" && (role === "operator" || target.type === "operator" || target.kind === "operator");
}

function isNumericTextTarget(value = "") {
  return /^-?\d+(?:\.\d+)?$/.test(String(value || ""));
}

function isDigitLikeChar(value = "") {
  return /[\d.]/.test(String(value || ""));
}

export function isBoundaryCompatibleTextMatch(fullText = "", foundAt = 0, targetText = "") {
  if (!isNumericTextTarget(targetText)) return true;
  const text = String(fullText || "");
  const target = String(targetText || "");
  const before = text[foundAt - 1] || "";
  const after = text[foundAt + target.length] || "";
  if (isDigitLikeChar(before) || isDigitLikeChar(after)) return false;

  // A positive numeric token must not claim the digit span inside a rendered negative
  // number; otherwise a later base like the 5 in 5^2 can bind to an earlier -5.
  if (!target.startsWith("-") && before === "-") return false;
  return true;
}

function shouldMergeMinusIntoNegativeNumber(negativeHit, bestHit) {
  if (!negativeHit || !bestHit || negativeHit === bestHit) return false;
  if (!isMinusOperatorTarget(bestHit.target)) return false;
  const minusRange = bestHit.target.sourceRange;
  const negativeRange = negativeHit.target.sourceRange;
  if (
    Number.isFinite(Number(minusRange?.start))
    && Number.isFinite(Number(minusRange?.end))
    && Number.isFinite(Number(negativeRange?.start))
    && Number.isFinite(Number(negativeRange?.end))
    && Number(minusRange.start) === Number(negativeRange.start)
    && Number(minusRange.end) <= Number(negativeRange.end)
  ) {
    return false;
  }
  return Number(bestHit.target.depth || 0) <= Number(negativeHit.target.depth || 0) + 3
    && rectArea(bestHit.rect) <= rectArea(negativeHit.rect);
}

function shouldPreferStandaloneMinus(minusHit, negativeHit) {
  if (!minusHit || !negativeHit) return false;
  if (!isMinusOperatorTarget(minusHit.target) || !isNegativeNumberTarget(negativeHit.target)) return false;
  const minusRange = minusHit.target.sourceRange;
  const negativeRange = negativeHit.target.sourceRange;
  const sameSourceStart = Number.isFinite(Number(minusRange?.start))
    && Number.isFinite(Number(negativeRange?.start))
    && Number(minusRange.start) === Number(negativeRange.start);
  return sameSourceStart && rectArea(minusHit.rect) < rectArea(negativeHit.rect) * 0.85;
}

function shouldPreferSignedNumberBody(negativeHit, minusHit, pointer = {}) {
  if (!negativeHit || !minusHit) return false;
  if (!isNegativeNumberTarget(negativeHit.target) || !isMinusOperatorTarget(minusHit.target)) return false;
  const minusRange = minusHit.target.sourceRange;
  const negativeRange = negativeHit.target.sourceRange;
  const sameSourceStart = Number.isFinite(Number(minusRange?.start))
    && Number.isFinite(Number(negativeRange?.start))
    && Number(minusRange.start) === Number(negativeRange.start);
  if (!sameSourceStart) return false;
  const rect = negativeHit.rect;
  const x = Number(pointer.x);
  if (!rect || !Number.isFinite(x) || !Number.isFinite(rect.left) || !Number.isFinite(rect.width) || rect.width <= 0) {
    return false;
  }
  const bodyThreshold = rect.left + Math.min(rect.width - 1, Math.max(2, rect.width * 0.35));
  return x >= bodyThreshold;
}

function sourceRangeContainedBy(child = {}, parent = {}) {
  const childStart = Number(child.sourceRange?.start ?? child.start);
  const childEnd = Number(child.sourceRange?.end ?? child.end);
  const parentStart = Number(parent.sourceRange?.start ?? parent.start);
  const parentEnd = Number(parent.sourceRange?.end ?? parent.end);
  return [childStart, childEnd, parentStart, parentEnd].every(Number.isFinite)
    && childStart >= parentStart
    && childEnd <= parentEnd
    && childEnd > childStart
    && parentEnd > parentStart;
}

function isSemanticDescendantOrContained(child = {}, parent = {}) {
  return child.parentId === parent.id
    || safeArray(parent.childIds).includes(child.id)
    || safeArray(parent.children).some((candidate) => candidate?.id === child.id)
    || sourceRangeContainedBy(child, parent);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isImpreciseLeafOverlayForAggregate(leafHit = {}, aggregateHit = {}) {
  const target = leafHit?.target || {};
  const aggregate = aggregateHit?.target || {};
  if (aggregate.id === target.id || !isAggregateHoverTarget(aggregate)) return false;
  const leafArea = rectArea(leafHit.rect);
  const aggregateArea = rectArea(aggregateHit.rect);
  if (leafArea <= 0 || aggregateArea <= 0 || leafArea < aggregateArea * 0.82) return false;
  if (!rectContainsRect(aggregateHit.rect, leafHit.rect)) return false;
  return isSemanticDescendantOrContained(target, aggregate);
}

function isImpreciseLeafOverlayHit(hit, allHits = []) {
  const target = hit?.target || {};
  if (!isLeafSemanticTarget(target) || isPreferredAggregateHoverTarget(target)) return false;
  const role = target.role || target.kind || target.type || "";
  if (!["operator", "equality", "delimiter"].includes(role)) return false;
  if (isTrustworthyOperatorTarget(target)) return false;
  return allHits.some((candidate) => isImpreciseLeafOverlayForAggregate(hit, candidate));
}

function isAggregateRescueForImpreciseLeaf(hit, allHits = []) {
  if (!isAggregateHoverTarget(hit?.target || {})) return false;
  return allHits.some((candidate) => (
    isImpreciseLeafOverlayForAggregate(candidate, hit)
    && !isOperatorLikeTarget(candidate.target)
  ));
}

export function chooseSemanticHit(targets = [], x, y, fallback = null, options = {}) {
  return resolveSemanticTarget({
    pointer: { x, y },
    candidates: targets,
    currentTarget: fallback,
    interactionMode: options.interactionMode || "hover",
    options,
  }).target;
}

/**
 * @param {{
 *   pointer?: { x?: number, y?: number },
 *   candidates?: Array<any>,
 *   currentTarget?: any,
 *   interactionMode?: string,
 *   options?: {
 *     fallback?: any,
 *     interactionMode?: string,
 *     includeStructural?: boolean,
 *     allowUnionFallback?: boolean,
 *     medianLeafHeight?: number,
 *     containerRect?: any,
 *   },
 * }} params
 */
export function resolveSemanticTarget({
  pointer = {},
  candidates = [],
  currentTarget = null,
  interactionMode = "hover",
  options = {},
} = {}) {
  const x = Number(pointer.x);
  const y = Number(pointer.y);
  const fallback = options.fallback ?? currentTarget;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { target: null, candidateScores: [], reason: "invalid-pointer" };
  }

  const allHits = candidateHits(candidates, x, y)
    .filter(({ target }) => isHighlightableHoverTarget(target, options));
  const deterministicHits = allHits.filter(({ target }) => isDeterministicSemanticTarget(target));
  if (deterministicHits.length > 0) {
    const preciseDeterministicHits = deterministicHits
      .filter((hit) => !isImpreciseLeafOverlayHit(hit, deterministicHits));
    const deterministicLeafHits = preciseDeterministicHits.filter(({ target }) => (
      isLeafSemanticTarget(target) && isHoverEligibleTarget(target)
    ));
    const deterministicPaintedLeafHits = deterministicLeafHits.filter((hit) => hit.paintedExact);
    const deterministicOwnedPrimitiveHits = preciseDeterministicHits.filter((hit) => (
      hit.ownedPrimitiveExact
      && isAggregateHoverTarget(hit.target)
      && isExplicitAggregateHoverTarget(hit.target)
    ));
    const deterministicOwnedGapHits = preciseDeterministicHits.filter((hit) => (
      hit.gapExact
      && isAggregateHoverTarget(hit.target)
      && isExplicitAggregateHoverTarget(hit.target)
    ));
    const deterministicEligibleHits = preciseDeterministicHits.filter(({ target }) => (
      options.includeStructural
        ? !isUnionHoverTarget(target) || options.allowUnionFallback
        : isHoverEligibleTarget(target)
          && (!isAggregateHoverTarget(target) || isExplicitAggregateHoverTarget(target))
    ));
    const deterministicRescueHits = preciseDeterministicHits.filter((hit) => (
      isAggregateRescueForImpreciseLeaf(hit, deterministicHits)
    ));
    const deterministicPool = (
      deterministicOwnedPrimitiveHits.length > 0
        ? deterministicOwnedPrimitiveHits
        : deterministicPaintedLeafHits.length > 0
          ? deterministicPaintedLeafHits
        : deterministicOwnedGapHits.length > 0
          ? deterministicOwnedGapHits
          : deterministicLeafHits.length > 0
            ? deterministicLeafHits
        : deterministicEligibleHits.length > 0
          ? deterministicEligibleHits
          : deterministicRescueHits.length > 0
            ? deterministicRescueHits
          : options.includeStructural
            ? deterministicHits
            : []
    );
    if (deterministicPool.length === 0) {
      return {
        target: null,
        candidateScores: deterministicHits.map((hit) => semanticScore(hit, { x, y }, currentTarget, { ...options, interactionMode })),
        reason: "deterministic-no-eligible-hit",
      };
    }
    const deterministicNegativeNumberHit = deterministicPool
      .filter(({ target }) => isNegativeNumberTarget(target))
      .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0];
    const deterministicMinusOperatorHit = deterministicPool
      .filter(({ target }) => isMinusOperatorTarget(target))
      .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0];
    if (shouldPreferSignedNumberBody(deterministicNegativeNumberHit, deterministicMinusOperatorHit, { x, y })) {
      return {
        target: deterministicNegativeNumberHit.target,
        candidateScores: [semanticScore(deterministicNegativeNumberHit, { x, y }, currentTarget, { ...options, interactionMode })],
        reason: "deterministic-negative-number-body",
      };
    }
    if (shouldPreferStandaloneMinus(deterministicMinusOperatorHit, deterministicNegativeNumberHit)) {
      return {
        target: deterministicMinusOperatorHit.target,
        candidateScores: [semanticScore(deterministicMinusOperatorHit, { x, y }, currentTarget, { ...options, interactionMode })],
        reason: "deterministic-standalone-minus",
      };
    }
    const scoredHits = deterministicPool
      .map((hit) => semanticScore(hit, { x, y }, currentTarget, { ...options, interactionMode }))
      .sort(compareDeterministicCandidates);
    const best = scoredHits[0];
    return {
      target: best?.target || null,
      candidateScores: scoredHits,
      reason: deterministicLeafHits.length > 0 ? "deterministic-leaf-hit" : "deterministic-hit",
    };
  }
  const preciseAllHits = allHits
    .filter((hit) => !isImpreciseLeafOverlayHit(hit, allHits));
  const leafHits = allHits
    .filter(({ target }) => (
      isLeafSemanticTarget(target) && isHoverEligibleTarget(target)
    ))
    .filter((hit) => preciseAllHits.includes(hit))
    .sort(sortHits);
  const negativeNumberHit = leafHits
    .filter(({ target }) => isNegativeNumberTarget(target))
    .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0];
  const minusOperatorHit = leafHits
    .filter(({ target }) => isMinusOperatorTarget(target))
    .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0];
  if (shouldPreferStandaloneMinus(minusOperatorHit, negativeNumberHit)) {
    return {
      target: minusOperatorHit.target,
      candidateScores: [semanticScore(minusOperatorHit, { x, y }, currentTarget, options)],
      reason: "standalone-minus",
    };
  }
  if (shouldMergeMinusIntoNegativeNumber(negativeNumberHit, leafHits[0])) {
    return {
      target: negativeNumberHit.target,
      candidateScores: [semanticScore(negativeNumberHit, { x, y }, currentTarget, options)],
      reason: "negative-number-merge",
    };
  }

  const eligibleHits = preciseAllHits
    .filter(({ target }) => (
      options.includeStructural
        ? !isUnionHoverTarget(target) || options.allowUnionFallback
        : isHoverEligibleTarget(target)
    ))
    .sort(sortHits);
  const rescueHits = preciseAllHits
    .filter((hit) => isAggregateRescueForImpreciseLeaf(hit, allHits))
    .sort(sortHits);
  const hits = eligibleHits.length > 0
    ? eligibleHits
    : rescueHits.length > 0
      ? rescueHits
    : allHits.sort(sortHits);

  const scoredHits = (leafHits.length > 0 ? leafHits : hits)
    .map((hit) => semanticScore(hit, { x, y }, currentTarget, { ...options, interactionMode }))
    .sort(compareScoredCandidates);
  const best = scoredHits[0];
  if (!best) {
    const fallbackTarget = fallback?.geometryValid !== false && isHighlightableHoverTarget(fallback, options)
      && candidateHits([fallback], x, y).length > 0
      ? fallback
      : null;
    return {
      target: fallbackTarget,
      candidateScores: [],
      reason: fallbackTarget ? "current-target-fallback" : "no-hit",
    };
  }

  if (!options.includeStructural && !best.leaf && isPenalizedHoverTarget(best.target)) {
    return { target: null, candidateScores: scoredHits, reason: "penalized-structural-target" };
  }

  return { target: best.target, candidateScores: scoredHits, reason: leafHits.length > 0 ? "leaf-hit" : "scored-hit" };
}

export function normalizeSemanticRect(rect) {
  if (!rect) return null;
  const left = Number(rect.left);
  const right = Number(rect.right);
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) return null;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width <= 0 || height <= 0) return null;
  return { left, right, top, bottom, width, height };
}

function targetPrimaryRect(target = {}) {
  return unionSemanticRects(target.rects || []) || normalizeSemanticRect(target.rects?.[0]);
}

export function isSelectableLeafTarget(target = {}) {
  return isLeafSemanticTarget(target) && isHoverEligibleTarget(target) && (target.rects || []).some((rect) => rectArea(rect) > 0);
}

export function isSelectableSemanticTarget(target = {}) {
  return isHoverEligibleTarget(target) && (target.rects || []).some((rect) => rectArea(rect) > 0);
}

export function getTargetsIntersectingRect(targets = [], selectionRect = {}) {
  const rect = normalizeSemanticRect(selectionRect);
  if (!rect) return [];
  return targets
    .filter(isSelectableLeafTarget)
    .filter((target) => target.rects.some((targetRect) => rectIntersectsRect(targetRect, rect)));
}

function lineBucketForTarget(target = {}, lineHeight = 18) {
  const rect = targetPrimaryRect(target);
  if (!rect) return 0;
  return Math.round((rect.top + rect.height / 2) / Math.max(1, lineHeight));
}

export function sortTargetsByRenderedOrder(targets = []) {
  const medianHeight = medianRectHeight(targets.flatMap((target) => target.rects || [])) || 18;
  return [...targets].sort((left, right) => {
    const leftRect = targetPrimaryRect(left);
    const rightRect = targetPrimaryRect(right);
    if (!leftRect || !rightRect) return 0;
    const leftLine = lineBucketForTarget(left, medianHeight * 1.35);
    const rightLine = lineBucketForTarget(right, medianHeight * 1.35);
    return (
      leftLine - rightLine
      || leftRect.left - rightRect.left
      || (Number(left.order ?? left.leafStart) - Number(right.order ?? right.leafStart))
      || String(left.id || "").localeCompare(String(right.id || ""))
    );
  });
}

export function groupTargetsByRenderedLine(targets = []) {
  const ordered = sortTargetsByRenderedOrder(targets);
  const medianHeight = medianRectHeight(ordered.flatMap((target) => target.rects || [])) || 18;
  const tolerance = Math.max(6, medianHeight * 0.65);
  const lines = [];

  for (const target of ordered) {
    const rect = targetPrimaryRect(target);
    if (!rect) continue;
    const centerY = rect.top + rect.height / 2;
    const line = lines.find((candidate) => Math.abs(candidate.centerY - centerY) <= tolerance);
    if (line) {
      line.targets.push(target);
      line.centerY = (line.centerY * (line.targets.length - 1) + centerY) / line.targets.length;
    } else {
      lines.push({ centerY, targets: [target] });
    }
  }

  return lines
    .sort((left, right) => left.centerY - right.centerY)
    .map((line) => sortTargetsByRenderedOrder(line.targets));
}

export function textForSemanticTarget(target = {}) {
  return String(target.display || target.text || target.latex || "").trim();
}

export function reconstructTextFromTargets(targets = []) {
  return groupTargetsByRenderedLine(targets)
    .map((line) => line.map(textForSemanticTarget).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n");
}
