import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import InlineMath from "./InlineMath";
import { getConceptForChunk } from "@/data/conceptGraph";
import { useHover } from "@/lib/HoverContext";
import { attachLocalSemanticExplanation, cleanSemanticTarget } from "@/lib/mathHitboxes";
import { buildSemanticTree, flattenSemanticTreeForTargets } from "@/lib/mathSemanticTree";
import { userFacingTooltipTitle } from "@/lib/presentationLabels";
import { hasSerializableSemanticRanges, normalizeCanonicalSemanticTree } from "@/lib/semanticMathRenderer";
import {
  filterLeafRects,
  isAggregateHoverTarget,
  isBoundaryCompatibleTextMatch,
  isCompactPowerParent,
  isCompactRadicalParent,
  isDifferentialSemanticTarget,
  isHoverEligibleTarget,
  isLeafSemanticTarget,
  isSelectableLeafTarget,
  medianRectHeight,
  normalizeSemanticRect,
  rectArea,
  rectContainsPoint,
  refineDifferentialHighlightGeometry,
  resolveSemanticTarget,
  unionSemanticRects,
} from "@/lib/semanticHitboxes";
import { cn } from "@/lib/utils";

const OPERATOR_PATTERN = /^(=|\+|-|\\le|\\ge|<=|>=|<|>|\\cdot|\u00b7|\\pm|,|\(|\)|\\Rightarrow|\\to)$/;
const noop = () => {};
const LARGE_ANNOTATED_CHUNK_CHARS = 48;
const DEBUG_SEMANTIC_HITBOXES = import.meta.env.DEV
  && (
    import.meta.env.VITE_DEBUG_MATH_HITBOXES === "true"
    || import.meta.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true"
  );
const DEBUG_HOVER_TARGETS = import.meta.env.DEV
  && (
    import.meta.env.VITE_DEBUG_HOVER_TARGETS === "true"
    || import.meta.env.VITE_DEBUG_MATH_HITBOXES === "true"
    || import.meta.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
  );
const DEBUG_MATH_HOVER_DIAGNOSTICS = import.meta.env.DEV
  && (import.meta.env.VITE_DEBUG_MATH_HOVER === "true" || import.meta.env.VITE_DEBUG_MATH_HOVER === "1");
const DEBUG_MATH_HOVER_PERF = import.meta.env.DEV
  && (
    import.meta.env.VITE_DEBUG_MATH_HOVER_PERF === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER_PERF === "1"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
  );
const BOUND_TARGET_ROLES = new Set(["upperBound", "lowerBound", "bound"]);

function semanticHoverPerfStore() {
  if (!DEBUG_MATH_HOVER_PERF || typeof window === "undefined") return null;
  const diagnosticWindow = /** @type {any} */ (window);
  const store = diagnosticWindow.__OMNIMATH_HOVER_PERF__ || {
    createdAt: Date.now(),
    counters: {},
    last: {},
    events: [],
    reset() {
      this.createdAt = Date.now();
      this.counters = {};
      this.last = {};
      this.events = [];
    },
  };
  diagnosticWindow.__OMNIMATH_HOVER_PERF__ = store;
  if (typeof store.reset !== "function") {
    store.reset = function resetSemanticHoverDiagnostics() {
      this.createdAt = Date.now();
      this.counters = {};
      this.last = {};
      this.events = [];
    };
  }
  return store;
}

function recordSemanticHoverPerf(event, details = {}) {
  const store = semanticHoverPerfStore();
  if (!store) return;
  store.counters[event] = (store.counters[event] || 0) + 1;
  store.last[event] = { at: Date.now(), ...details };
  store.events.push({ at: Date.now(), event, ...details });
  if (store.events.length > 240) store.events.splice(0, store.events.length - 240);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (!store.lastSummaryAt || now - store.lastSummaryAt > 1000) {
    store.lastSummaryAt = now;
    console.info("[omnimath:hover-perf]", {
      elapsedMs: Date.now() - store.createdAt,
      counters: store.counters,
      last: store.last,
    });
  }
}

function recordSemanticHoverCounter(name, delta = 1, details = {}) {
  const store = semanticHoverPerfStore();
  if (!store) return;
  store.counters[name] = (store.counters[name] || 0) + delta;
  if (Object.keys(details).length > 0) {
    store.last[name] = { at: Date.now(), ...details };
  }
}

function hasSemanticAncestorRole(node = {}, roles = new Set(), semanticNodeById = new Map()) {
  if (!node || roles.size === 0) return false;
  if (roles.has(node.parentRole)) return true;
  let parentId = node.parentId;
  const seen = new Set([node.id].filter(Boolean));
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = semanticNodeById.get(parentId);
    const role = parent?.role || parent?.kind || parent?.type || "";
    if (roles.has(role)) return true;
    parentId = parent?.parentId;
  }
  return false;
}

function isBoundInternalTarget(target = {}, semanticNodeById = new Map()) {
  const role = target.role || target.kind || target.type || "";
  return !BOUND_TARGET_ROLES.has(role) && hasSemanticAncestorRole(target, BOUND_TARGET_ROLES, semanticNodeById);
}

function pointerHasUnderlyingNode(event, node) {
  if (!node || typeof document === "undefined" || typeof document.elementsFromPoint !== "function") return false;
  const elements = document.elementsFromPoint(event.clientX, event.clientY);
  return elements.some((element) => element !== event.target && node.contains(element));
}

function buildAggregateRectsFromDescendants(targets = []) {
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const collectDescendantRects = (target, seen = new Set()) => {
    if (!target?.id || seen.has(target.id)) return [];
    seen.add(target.id);
    return safeList(target.childIds || target.children)
      .flatMap((child) => {
        const childId = typeof child === "string" ? child : child?.id;
        const childTarget = targetById.get(childId);
        if (!childTarget) return [];
        return [
          ...safeList(childTarget.rects).filter((rect) => rectArea(rect) > 0),
          ...collectDescendantRects(childTarget, seen),
        ];
      });
  };

  return targets.map((target) => {
    if (!isAggregateHoverTarget(target) || safeList(target.rects).some((rect) => rectArea(rect) > 0)) {
      return target;
    }
    const descendantRects = collectDescendantRects(target);
    const clusters = clusterSemanticRects(descendantRects, medianRectHeight(descendantRects) || 18);
    return clusters.length > 0
      ? applySemanticGeometryMetadata(
        {
          ...target,
          rectSource: "aggregate-descendant-clusters",
          isAggregateTarget: true,
          aggregate: true,
          leaf: false,
        },
        clusters,
        descendantRects,
        { rectSource: "aggregate-descendant-clusters" }
      )
      : target;
  });
}

function semanticTreeCoverageScore(tree = null) {
  if (!tree) return Number.NEGATIVE_INFINITY;
  const flatNodes = safeList(tree.flatNodes);
  const leaves = safeList(tree.linearLeaves).length > 0
    ? safeList(tree.linearLeaves)
    : flatNodes.filter(isLeafSemanticTarget);
  const rangedLeaves = leaves.filter((node) => node.sourceRange || (Number.isFinite(node.start) && Number.isFinite(node.end)));
  return (
    (tree.fallback ? 0 : 100000)
    + rangedLeaves.length * 1000
    + leaves.length * 100
    + flatNodes.length
  );
}

function chooseSemanticTreeCandidate(candidates = []) {
  const validCandidates = candidates.filter(({ tree }) => tree && hasSerializableSemanticRanges(tree));
  const pool = validCandidates.length > 0
    ? validCandidates
    : candidates.filter(({ tree }) => tree);
  return [...pool].sort((left, right) => (
    semanticTreeCoverageScore(right.tree) - semanticTreeCoverageScore(left.tree)
  ))[0] || null;
}

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
const KATEX_FUNCTION_NAMES = new Set([
  "arccos",
  "arcsin",
  "arctan",
  "arg",
  "cos",
  "cosh",
  "cot",
  "coth",
  "csc",
  "deg",
  "det",
  "dim",
  "exp",
  "gcd",
  "hom",
  "ker",
  "lg",
  "lim",
  "ln",
  "log",
  "max",
  "min",
  "Pr",
  "sec",
  "sin",
  "sinh",
  "tan",
  "tanh",
]);

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return String(value.latex || value.display || value.text || fallback);
  }
  return String(value);
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRenderableToken(token, fallbackId) {
  if (token && typeof token === "object") {
    const children = safeList(token.children).filter(Boolean);
    const parts = safeList(token.parts).filter(Boolean);
    return {
      ...token,
      id: safeText(token.id, fallbackId),
      display: safeText(token.display || token.latex || token.text),
      latex: safeText(token.latex || token.display || token.text),
      text: safeText(token.text || token.display || token.latex),
      role: safeText(token.role, "other"),
      short: safeText(token.short || token.explanation || token.display || token.latex, "Math token"),
      relatedTokenIds: safeList(token.relatedTokenIds),
      children,
      parts: parts.length > 0 ? parts : children,
    };
  }

  const display = safeText(token);
  return {
    id: fallbackId,
    display,
    latex: display,
    text: display,
    role: "other",
    short: display || "Math token",
    relatedTokenIds: [],
    children: [],
    parts: [],
  };
}

function tokenHitboxWeight(token) {
  if (isOperatorToken(token)) return 0.7;
  const compact = safeText(token?.display || token?.latex || token?.text)
    .replace(/\\[a-zA-Z]+/g, "x")
    .replace(/[{}()[\]]/g, "");
  return Math.max(1, Math.min(8, compact.length || 1));
}

function isOperatorToken(token) {
  return token?.role === "operator" || OPERATOR_PATTERN.test(String(token?.display || token?.latex || "").trim());
}

function isLargeAnnotatedToken(token, parts = []) {
  const compact = safeText(token?.display || token?.latex || token?.text).replace(/\s+/g, "");
  return parts.length > 2 && compact.length > LARGE_ANNOTATED_CHUNK_CHARS;
}

function isPowerToken(token) {
  return token?.role === "power" && /\^/.test(String(token?.latex || token?.display || ""));
}

function isFractionToken(token, children = []) {
  return token?.role === "fraction"
    || (
      children.length >= 2
      && children[0]?.role === "numerator"
      && children[1]?.role === "denominator"
    );
}

function isFunctionToken(token, children = []) {
  return token?.role === "function"
    && children.length >= 1
    && children[0]?.role === "function";
}

function semanticText(value = "") {
  return String(value || "")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (char) => UNICODE_SUPERSCRIPT_DIGITS.get(char) || char)
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1$2")
    .replace(/\\pi/g, "π")
    .replace(/\\theta/g, "θ")
    .replace(/\\phi/g, "φ")
    .replace(/\\rho/g, "ρ")
    .replace(/\\nabla/g, "∇")
    .replace(/\\infty/g, "∞")
    .replace(/\\approx/g, "≈")
    .replace(/\\sqrt/g, "√")
    .replace(/\\pm/g, "±")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/−/g, "-")
    .replace(/\\arctan/g, "arctan")
    .replace(/\\arcsin/g, "arcsin")
    .replace(/\\arccos/g, "arccos")
    .replace(/\\cos/g, "cos")
    .replace(/\\sin/g, "sin")
    .replace(/\\tan/g, "tan")
    .replace(/\\ln/g, "ln")
    .replace(/\\log/g, "log")
    .replace(/\\int/g, "∫")
    .replace(/\\iint/g, "∬")
    .replace(/[{}_^\\,\s()]/g, "")
    .trim();
}

function normalizeSemanticLatexInput(value = "") {
  return String(value || "")
    .replace(/([0-9A-Za-z}\)])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_, base, superscript) => {
      const exponent = [...superscript].map((char) => UNICODE_SUPERSCRIPT_DIGITS.get(char) || "").join("");
      return exponent ? `${base}^${exponent}` : `${base}${superscript}`;
    })
    .replace(/−/g, "-");
}

function rectIntersects(left, right) {
  if (!left || !right) return false;
  return !(left.right <= right.left || left.left >= right.right || left.bottom <= right.top || left.top >= right.bottom);
}

function rectCenter(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function splitRectHorizontally(rect, parts, index) {
  if (!rect || parts <= 0) return null;
  const width = rect.width / parts;
  const left = rect.left + width * index;
  return normalizeSemanticRect({
    left,
    right: left + width,
    top: rect.top,
    bottom: rect.bottom,
  });
}

function splitRectVertically(rect, parts, index) {
  if (!rect || parts <= 0) return null;
  const height = rect.height / parts;
  const top = rect.top + height * index;
  return normalizeSemanticRect({
    left: rect.left,
    right: rect.right,
    top,
    bottom: top + height,
  });
}

function leafFallbackScope(node, visualRect) {
  if (!visualRect) return null;
  const role = node?.role || "";
  const parentRole = node?.parentRole || "";

  if (role === "denominator" || parentRole === "denominator") {
    return normalizeSemanticRect({
      left: visualRect.left,
      right: visualRect.right,
      top: visualRect.top + visualRect.height * 0.78,
      bottom: visualRect.bottom,
    });
  }

  if (role === "numerator" || parentRole === "numerator") {
    return normalizeSemanticRect({
      left: visualRect.left,
      right: visualRect.right,
      top: visualRect.top,
      bottom: visualRect.top + visualRect.height * 0.48,
    });
  }

  if (role === "exponent" || parentRole === "power") {
    return normalizeSemanticRect({
      left: visualRect.left,
      right: visualRect.right,
      top: visualRect.top,
      bottom: visualRect.top + visualRect.height * 0.55,
    });
  }

  if (role === "base") {
    return normalizeSemanticRect({
      left: visualRect.left,
      right: visualRect.right,
      top: visualRect.top + visualRect.height * 0.28,
      bottom: visualRect.bottom,
    });
  }

  return visualRect;
}

function roleAwareLeafFallbackRect(node, sourceRect, visualRect, leafMedianHeight) {
  if (!sourceRect) return null;
  const scope = leafFallbackScope(node, visualRect) || sourceRect;
  const fallbackHeight = leafMedianHeight > 0
    ? Math.min(scope.height, leafMedianHeight * 1.35)
    : Math.min(scope.height, sourceRect.height);
  const fallbackCenter = scope.top + scope.height / 2;
  const width = Math.min(
    scope.width,
    Math.max(sourceRect.width, leafMedianHeight > 0 ? leafMedianHeight * 0.7 : 10)
  );

  const preferredLeft = Math.min(
    Math.max(sourceRect.left, scope.left),
    Math.max(scope.left, scope.right - width)
  );

  return normalizeSemanticRect({
    left: preferredLeft,
    right: preferredLeft + width,
    top: fallbackCenter - fallbackHeight / 2,
    bottom: fallbackCenter + fallbackHeight / 2,
  });
}

function compactLeafFallbackRect(node, cellRect, visualRect, leafMedianHeight) {
  if (!cellRect) return null;
  const scope = leafFallbackScope(node, visualRect) || cellRect;
  const compactLength = Math.max(1, semanticText(node?.latex || node?.display || node?.text).length || 1);
  const width = Math.min(
    cellRect.width,
    Math.max(10, leafMedianHeight > 0 ? leafMedianHeight * Math.min(3.2, Math.max(0.9, compactLength * 0.75)) : 12)
  );
  const height = leafMedianHeight > 0
    ? Math.min(scope.height, leafMedianHeight * 1.35)
    : Math.min(scope.height, cellRect.height);
  const centerX = cellRect.left + cellRect.width / 2;
  const centerY = scope.top + scope.height / 2;
  const left = Math.min(Math.max(centerX - width / 2, scope.left), Math.max(scope.left, scope.right - width));
  return normalizeSemanticRect({
    left,
    right: left + width,
    top: centerY - height / 2,
    bottom: centerY + height / 2,
  });
}

function getElementRects(element) {
  if (!element?.getClientRects) return [];
  recordSemanticHoverCounter("getClientRectsCalls", 1);
  const rects = [...element.getClientRects()].map(normalizeSemanticRect).filter(Boolean);
  recordSemanticHoverCounter("clientRectFragments", rects.length);
  return rects;
}

function getMergedRect(rects = []) {
  const safeRects = rects.filter(Boolean);
  if (safeRects.length === 0) return null;
  return normalizeSemanticRect({
    left: Math.min(...safeRects.map((rect) => rect.left)),
    right: Math.max(...safeRects.map((rect) => rect.right)),
    top: Math.min(...safeRects.map((rect) => rect.top)),
    bottom: Math.max(...safeRects.map((rect) => rect.bottom)),
  });
}

function rectsTotalArea(rects = []) {
  return rects.map(normalizeSemanticRect).filter(Boolean).reduce((total, rect) => total + rectArea(rect), 0);
}

function paintedRectsForElements(root, elements = [], containerRect = null) {
  const uniqueElements = [...new Set(safeList(elements).filter(Boolean))];
  const rects = uniqueElements.flatMap((element) => (
    textLeafCandidatesInElement(root, element).flatMap((candidate) => candidate.rects?.length ? candidate.rects : [candidate.rect])
  ))
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => rectArea(rect) > 0)
    .filter((rect) => !containerRect || rectIntersects(rect, containerRect));
  const seen = new Set();
  return sortRectsByVisualOrder(rects.filter((rect) => {
    const key = [
      Math.round(rect.left * 10),
      Math.round(rect.top * 10),
      Math.round(rect.width * 10),
      Math.round(rect.height * 10),
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function clusterSemanticRects(rects = [], medianHeight = 18) {
  const sorted = sortRectsByVisualOrder(rects.map(normalizeSemanticRect).filter(Boolean));
  if (sorted.length <= 1) return sorted;
  const clusters = [];
  let current = sorted[0];
  for (const rect of sorted.slice(1)) {
    const sameLine = Math.abs(rectCenter(current).y - rectCenter(rect).y) <= Math.max(6, medianHeight * 0.85);
    const closeGap = rect.left - current.right <= Math.max(5, medianHeight * 0.45);
    const overlaps = rect.left <= current.right + 1 && rect.right >= current.left - 1;
    if (sameLine && (closeGap || overlaps)) {
      current = unionSemanticRects([current, rect]) || current;
      continue;
    }
    clusters.push(current);
    current = rect;
  }
  clusters.push(current);
  return clusters;
}

function semanticRectQuality(target = {}, rects = [], paintedRects = [], options = {}) {
  const normalizedRects = rects.map(normalizeSemanticRect).filter(Boolean);
  const normalizedPainted = paintedRects.map(normalizeSemanticRect).filter(Boolean);
  const rawArea = rectsTotalArea(normalizedRects);
  const paintedArea = rectsTotalArea(normalizedPainted);
  const role = target.role || target.kind || target.type || "";
  if (normalizedRects.length === 0) return "zero_size";
  if (paintedArea <= 0) return isLeafSemanticTarget(target) ? "collapsed" : "structural_only";
  const rectUnion = unionSemanticRects(normalizedRects);
  const paintedUnion = unionSemanticRects(normalizedPainted);
  if (!rectUnion || !paintedUnion) return "stale_or_unmapped";
  const unionRatio = rectArea(rectUnion) / Math.max(1, paintedArea);
  const areaRatio = rawArea / Math.max(1, paintedArea);
  const leaf = isLeafSemanticTarget(target);
  if (leaf && areaRatio <= 2.25 && unionRatio <= 2.75) return "precise_leaf";
  if (leaf) return "collapsed";
  if (normalizedRects.length > 1) return "fragmented_group";
  if (["lowerBound", "upperBound", "bound", "numerator", "denominator", "argument", "differential"].includes(role)) {
    return unionRatio <= 3.5 ? "precise_group" : "broad_aggregate";
  }
  if (unionRatio > 4.5 || areaRatio > 4.5 || options.rectSource?.includes("aggregate-descendant-union")) {
    return "broad_aggregate";
  }
  return "precise_group";
}

/**
 * @param {any} target
 * @param {Array<any>} rects
 * @param {Array<any>} paintedRects
 * @param {any} options
 * @returns {any}
 */
function applySemanticGeometryMetadata(target = {}, rects = [], paintedRects = [], options = {}) {
  const safeRects = sortRectsByVisualOrder(rects.map(normalizeSemanticRect).filter(Boolean));
  const safePaintedRects = sortRectsByVisualOrder(paintedRects.map(normalizeSemanticRect).filter(Boolean));
  const geometryQuality = semanticRectQuality(target, safeRects, safePaintedRects, options);
  const paintedArea = rectsTotalArea(safePaintedRects);
  const rectAreaTotal = rectsTotalArea(safeRects);
  return {
    ...target,
    rects: safeRects,
    paintedRects: safePaintedRects,
    paintedArea,
    geometryArea: rectAreaTotal,
    geometryQuality,
    geometryRejectionReasons: [
      geometryQuality === "broad_aggregate" ? "broad-aggregate-geometry" : null,
      geometryQuality === "structural_only" ? "no-painted-descendant-geometry" : null,
      geometryQuality === "collapsed" ? "collapsed-or-imprecise-painted-geometry" : null,
      geometryQuality === "zero_size" ? "zero-size-geometry" : null,
    ].filter(Boolean),
  };
}

function attachMeasurementRoot(target = {}, rootRect = null) {
  return rootRect ? { ...target, measurementRootRect: rectSnapshot(rootRect) } : target;
}

const MIN_SEMANTIC_RECT_DIMENSION = 0.5;
const OUTSIDE_ROOT_TOLERANCE_PX = 6;

function scrollableAncestorsForSnapshot(root = null, visualRoot = null) {
  if (typeof window === "undefined") return [];
  const owners = [root, visualRoot].filter(Boolean);
  const seen = new Set(owners);
  const ancestors = [];
  for (const owner of owners) {
    let current = owner?.parentElement || null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!seen.has(current)) {
        seen.add(current);
        const style = window.getComputedStyle?.(current);
        const hasScrollableOverflow = /(auto|scroll|overlay)/.test(`${style?.overflow || ""} ${style?.overflowX || ""} ${style?.overflowY || ""}`);
        const canScroll = current.scrollWidth > current.clientWidth + 1 || current.scrollHeight > current.clientHeight + 1;
        if (hasScrollableOverflow && canScroll) ancestors.push(current);
      }
      current = current.parentElement;
    }
  }
  return ancestors;
}

function emptyGeometrySnapshot(reason = "not-measured") {
  return {
    valid: false,
    revision: 0,
    renderRevision: 0,
    chunkId: "",
    stepId: "",
    domOwner: null,
    scrollState: null,
    reason,
    rootRect: null,
    visualRect: null,
    targets: [],
    childTargets: [],
    targetById: new Map(),
    rejectedTargets: [],
    overlayTargets: [],
    signature: "",
    createdAt: 0,
  };
}

function readSnapshotScrollState(root = null, visualRoot = null) {
  const scrollAncestors = scrollableAncestorsForSnapshot(root, visualRoot)
    .map((element) => ({
      owner: element.getAttribute?.("data-math-chunk-owner")
        || element.getAttribute?.("data-math-renderer")
        || element.className
        || element.tagName
        || "scroll-container",
      left: element.scrollLeft || 0,
      top: element.scrollTop || 0,
    }));
  if (typeof window === "undefined") {
    return {
      windowX: 0,
      windowY: 0,
      rootLeft: root?.scrollLeft || 0,
      rootTop: root?.scrollTop || 0,
      visualLeft: visualRoot?.scrollLeft || 0,
      visualTop: visualRoot?.scrollTop || 0,
      scrollAncestors,
    };
  }
  return {
    windowX: window.scrollX || 0,
    windowY: window.scrollY || 0,
    rootLeft: root?.scrollLeft || 0,
    rootTop: root?.scrollTop || 0,
    visualLeft: visualRoot?.scrollLeft || 0,
    visualTop: visualRoot?.scrollTop || 0,
    scrollAncestors,
  };
}

function sameSnapshotScrollState(left = null, right = null) {
  if (!left || !right) return false;
  const leftAncestors = safeList(left.scrollAncestors);
  const rightAncestors = safeList(right.scrollAncestors);
  return left.windowX === right.windowX
    && left.windowY === right.windowY
    && left.rootLeft === right.rootLeft
    && left.rootTop === right.rootTop
    && left.visualLeft === right.visualLeft
    && left.visualTop === right.visualTop
    && leftAncestors.length === rightAncestors.length
    && leftAncestors.every((entry, index) => (
      entry.owner === rightAncestors[index]?.owner
      && entry.left === rightAncestors[index]?.left
      && entry.top === rightAncestors[index]?.top
    ));
}

function semanticRectSignature(rect = null) {
  const normalized = normalizeSemanticRect(rect);
  if (!normalized) return "null";
  return [
    normalized.left,
    normalized.top,
    normalized.width,
    normalized.height,
  ].map((value) => Math.round(value * 10) / 10).join(",");
}

function semanticTargetSignature(target = {}) {
  return [
    target.id,
    target.parentId || "",
    target.role || target.kind || target.type || "",
    target.rectSource || "",
    target.geometryQuality || "",
    safeList(target.rects).map(semanticRectSignature).join("|"),
    safeList(target.paintedRects).map(semanticRectSignature).join("|"),
  ].join(":");
}

function semanticSnapshotSignature({ rootRect = null, visualRect = null, targets = [] } = {}) {
  return [
    semanticRectSignature(rootRect),
    semanticRectSignature(visualRect),
    targets.map(semanticTargetSignature).join(";"),
  ].join("::");
}

function semanticRectKey(rect = {}) {
  return [
    Math.round(Number(rect.left) * 10),
    Math.round(Number(rect.top) * 10),
    Math.round(Number(rect.width) * 10),
    Math.round(Number(rect.height) * 10),
  ].join(":");
}

function sanitizeSemanticRects(rects = []) {
  const seen = new Set();
  return safeList(rects)
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => (
      Number.isFinite(rect.left)
      && Number.isFinite(rect.top)
      && Number.isFinite(rect.right)
      && Number.isFinite(rect.bottom)
      && rect.width >= MIN_SEMANTIC_RECT_DIMENSION
      && rect.height >= MIN_SEMANTIC_RECT_DIMENSION
    ))
    .filter((rect) => {
      const key = semanticRectKey(rect);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * @param {any} target
 * @param {any} rootRect
 * @param {Map<string, any>} semanticNodeById
 * @param {string} rootTargetId
 * @returns {string[]}
 */
function semanticTargetRejectionReasons(target = {}, rootRect = null, semanticNodeById = new Map(), rootTargetId = "") {
  const reasons = [];
  const rects = sanitizeSemanticRects(target.rects);
  const paintedRects = sanitizeSemanticRects(target.paintedRects);
  const quality = target.geometryQuality || "";
  const knownSemanticNode = target.id === rootTargetId || semanticNodeById.has(target.id);
  if (!knownSemanticNode) reasons.push("unmapped-semantic-node");
  if (rects.length === 0) reasons.push("zero-or-collapsed-rect");
  if (["zero_size", "stale_or_unmapped"].includes(quality)) reasons.push(quality);
  if (quality === "structural_only" && paintedRects.length === 0) reasons.push("structural-without-painted-content");
  if (quality === "collapsed" && paintedRects.length === 0) reasons.push("collapsed-without-painted-content");
  if (quality === "broad_aggregate" && isLeafSemanticTarget(target)) reasons.push("broad-leaf-geometry");
  if (quality === "broad_aggregate" && paintedRects.length === 0) reasons.push("broad-without-painted-content");
  const source = String(target.latex || target.display || target.text || "");
  if (
    isLeafSemanticTarget(target)
    && source.length > 8
    && /[{}()]|\\(?:sin|cos|tan|cot|sec|csc|ln|log)|[+=]/.test(source)
  ) {
    reasons.push("compound-leaf-geometry");
  }
  if (rootRect && rects.length > 0 && !rects.some((rect) => rectIntersects(rect, rootRect))) {
    reasons.push("outside-current-math-root");
  }
  const rootArea = rootRect ? rectArea(rootRect) : 0;
  if (
    rootArea > 0
    && target.id !== rootTargetId
    && rects.some((rect) => rectArea(rect) > rootArea * 1.25 && !rectWithinRect(rect, rootRect, OUTSIDE_ROOT_TOLERANCE_PX))
  ) {
    reasons.push("suspiciously-broad-outside-root");
  }
  return [...new Set(reasons)];
}

/**
 * @param {any} target
 * @param {any} rootRect
 * @param {Map<string, any>} semanticNodeById
 * @param {string} rootTargetId
 * @returns {any}
 */
function prepareSnapshotTarget(target = {}, rootRect = null, semanticNodeById = new Map(), rootTargetId = "") {
  const rects = sanitizeSemanticRects(target.rects);
  const paintedRects = sanitizeSemanticRects(target.paintedRects);
  const prepared = {
    ...target,
    rects,
    paintedRects,
    paintedArea: paintedRects.length > 0 ? rectsTotalArea(paintedRects) : target.paintedArea ?? 0,
    geometryArea: rectsTotalArea(rects),
  };
  const rejectionReasons = semanticTargetRejectionReasons(prepared, rootRect, semanticNodeById, rootTargetId);
  return {
    ...prepared,
    geometryValid: rejectionReasons.length === 0,
    geometryRejectionReasons: [
      ...safeList(prepared.geometryRejectionReasons),
      ...rejectionReasons,
    ].filter(Boolean),
  };
}

function escapedCssAttributeValue(value = "") {
  const raw = String(value || "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sortRectsByVisualOrder(rects = []) {
  return [...rects].sort((left, right) => (
    (left.top ?? 0) - (right.top ?? 0)
    || (left.left ?? 0) - (right.left ?? 0)
    || rectArea(left) - rectArea(right)
  ));
}

function mergeContiguousSemanticRects(rects = []) {
  const sorted = sortRectsByVisualOrder(rects).map(normalizeSemanticRect).filter(Boolean);
  if (sorted.length <= 1) return sorted;
  const merged = [];
  let current = sorted[0];
  for (const next of sorted.slice(1)) {
    if (rectsAreVisuallyAdjacent(current, next)) {
      current = unionSemanticRects([current, next]) || current;
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

function normalizeDeterministicLeafRects(rects = [], target = {}) {
  const role = target.role || target.kind || target.type || "";
  if (role === "functionName") {
    const merged = unionSemanticRects(rects);
    return merged ? [merged] : [];
  }
  return mergeContiguousSemanticRects(rects);
}

function collectDescendantLeafRects(target = {}, measuredById = new Map(), semanticNodeById = new Map(), seen = new Set()) {
  const childIds = safeList(target.childIds);
  if (childIds.length === 0) return [];
  const rects = [];
  for (const childId of childIds) {
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    const childTarget = measuredById.get(childId) || semanticNodeById.get(childId);
    if (!childTarget) continue;
    if (isLeafSemanticTarget(childTarget)) {
      rects.push(...safeList(childTarget.rects));
      continue;
    }
    rects.push(...collectDescendantLeafRects(childTarget, measuredById, semanticNodeById, seen));
  }
  return rects
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => rectArea(rect) > 0);
}

function collectDescendantPaintedRects(target = {}, measuredById = new Map(), semanticNodeById = new Map(), seen = new Set()) {
  const childIds = safeList(target.childIds);
  if (childIds.length === 0) return [];
  const rects = [];
  for (const childId of childIds) {
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);
    const childTarget = measuredById.get(childId) || semanticNodeById.get(childId);
    if (!childTarget) continue;
    const childPaintedRects = safeList(childTarget.paintedRects).length > 0
      ? childTarget.paintedRects
      : childTarget.rects;
    rects.push(...safeList(childPaintedRects));
    rects.push(...collectDescendantPaintedRects(childTarget, measuredById, semanticNodeById, seen));
  }
  return rects
    .map(normalizeSemanticRect)
    .filter(Boolean)
    .filter((rect) => rectArea(rect) > 0);
}

function shouldPreferChildClusterGeometry(target = {}, currentRects = [], childClusters = []) {
  if (childClusters.length === 0) return false;
  const role = target.role || target.kind || target.type || "";
  const quality = target.geometryQuality || "";
  if (["broad_aggregate", "structural_only", "collapsed", "stale_or_unmapped"].includes(quality)) return true;
  if (["integrand", "leftSide", "rightSide", "fraction", "numerator", "denominator", "argument", "function", "power"].includes(role)) {
    return true;
  }
  const currentUnion = unionSemanticRects(currentRects);
  const childArea = rectsTotalArea(childClusters);
  return currentUnion && rectArea(currentUnion) > Math.max(childArea * 3, childArea + 80);
}

function refineAggregateGeometryFromChildren({
  targets = [],
  measuredById = new Map(),
  semanticNodeById = new Map(),
  medianHeight = 18,
}) {
  for (const target of targets) {
    if (!target?.id || isLeafSemanticTarget(target)) continue;
    const childRects = collectDescendantPaintedRects(target, measuredById, semanticNodeById);
    const childClusters = clusterSemanticRects(childRects, medianHeight || 18);
    if (!shouldPreferChildClusterGeometry(target, safeList(target.rects), childClusters)) continue;
    const patched = applySemanticGeometryMetadata(
      {
        ...target,
        rectSource: target.rectSource?.includes("targeted-fallback")
          ? target.rectSource
          : `${target.rectSource || "semantic-dom"}:painted-child-clusters`,
        clientRectCount: childRects.length,
      },
      childClusters,
      childRects,
      { rectSource: "painted-child-clusters" }
    );
    measuredById.set(target.id, patched);
    const index = targets.findIndex((candidate) => candidate.id === target.id);
    if (index >= 0) targets[index] = patched;
  }
}

function occurrenceIndexesByDifferentialId(targets = []) {
  const groups = new Map();
  for (const target of targets.filter(isDifferentialSemanticTarget)) {
    const text = semanticText(target.latex || target.display || target.text);
    if (!text) continue;
    const group = groups.get(text) || [];
    group.push(target);
    groups.set(text, group);
  }
  const occurrenceById = new Map();
  for (const group of groups.values()) {
    group
      .sort((left, right) => (
        Number(left.sourceRange?.start ?? left.start ?? left.order ?? 0)
        - Number(right.sourceRange?.start ?? right.start ?? right.order ?? 0)
      ))
      .forEach((target, index) => occurrenceById.set(target.id, index));
  }
  return occurrenceById;
}

function refineMeasuredDifferentialHighlights({
  targets = [],
  measuredById = new Map(),
  semanticNodeById = new Map(),
  textIndex = null,
  containerRect = null,
}) {
  const occurrenceById = occurrenceIndexesByDifferentialId(targets);
  const medianHeight = medianRectHeight(targets.flatMap((target) => safeList(target.rects))) || 18;
  for (const target of targets.filter(isDifferentialSemanticTarget)) {
    const sourceTarget = measuredById.get(target.id) || target;
    const childRects = collectDescendantLeafRects(sourceTarget, measuredById, semanticNodeById)
      .filter((rect) => !containerRect || rectIntersects(rect, containerRect));
    const targetText = semanticText(sourceTarget.latex || sourceTarget.display || sourceTarget.text);
    const occurrenceIndex = occurrenceById.get(sourceTarget.id) ?? 0;
    const textMatches = targetText && textIndex
      ? sortMatchesByRenderedOrder(
        getTextRangeMatches(textIndex, targetText, containerRect),
        Math.max(1, medianHeight * 1.35)
      )
      : [];
    const textRect = textMatches[occurrenceIndex]?.rect || null;
    const refined = refineDifferentialHighlightGeometry(sourceTarget, {
      childRects,
      textRects: textRect ? [textRect] : [],
      containerRect,
      medianLeafHeight: medianHeight,
    });
    if (refined === sourceTarget) continue;
    measuredById.set(sourceTarget.id, refined);
    const index = targets.findIndex((candidate) => candidate.id === sourceTarget.id);
    if (index >= 0) targets[index] = refined;
  }
}

function semanticDomElementsForId(root, id) {
  if (!root || !id) return [];
  return queryElements(root, `[data-semantic-id="${escapedCssAttributeValue(id)}"]`);
}

function fallbackSemanticDomElementsForNode(root, node = {}, semanticNodeById = new Map()) {
  const role = node.role || node.kind || node.type || "";
  if (role !== "radical" && node.latex !== "\\sqrt") return [];
  const parent = node.parentId ? semanticNodeById.get(node.parentId) : null;
  return semanticDomElementsForId(root, parent?.id)
    .flatMap((element) => queryElements(element, ".sqrt-sign"))
    .filter(Boolean);
}

function deterministicHitboxRoleForNode(node = {}, semanticNodeById = new Map()) {
  const role = node.role || node.kind || node.type || "";
  const parent = node.parentId ? semanticNodeById.get(node.parentId) : null;
  if (
    role === "constant"
    && parent?.role === "numerator"
    && /\+/.test(String(parent.latex || parent.display || parent.text || ""))
  ) {
    return "numerator";
  }
  return node.hitboxRole || null;
}

function findSplitSignedNumberFallback({
  target = {},
  targetText = "",
  textIndex = null,
  semanticNodes = [],
  measuredById = new Map(),
  containerRect = null,
}) {
  if (!/^-?\d/.test(targetText) || !targetText.startsWith("-")) return null;
  /** @type {any} */
  const targetNode = target || {};
  const sourceStart = Number(targetNode.sourceRange?.start ?? targetNode.start);
  if (!Number.isFinite(sourceStart)) return null;
  const minusNode = semanticNodes.find((candidate) => {
    /** @type {any} */
    const node = candidate || {};
    const latex = String(node?.latex || node?.display || node?.text || "").trim();
    const nodeStart = Number(node?.sourceRange?.start ?? node?.start);
    return node?.id !== targetNode.id
      && latex === "-"
      && Number.isFinite(nodeStart)
      && nodeStart === sourceStart;
  });
  /** @type {any} */
  const matchedMinusNode = minusNode || {};
  const minusTarget = matchedMinusNode.id ? measuredById.get(matchedMinusNode.id) : null;
  const minusRect = safeList(minusTarget?.rects).find((rect) => rectArea(rect) > 0);
  if (!minusRect) return null;

  const unsignedText = targetText.slice(1);
  const unsignedMatches = sortMatchesByRenderedOrder(
    getTextRangeMatches(textIndex, unsignedText, containerRect),
    Math.max(1, (minusRect.height || 0) * 1.35 || 18)
  )
    .filter((match) => match.rect && rectArea(match.rect) > 0)
    .filter((match) => {
      const rect = match.rect;
      const verticalOverlap = rect.bottom > minusRect.top && rect.top < minusRect.bottom;
      const followsMinus = rect.left >= minusRect.left - Math.max(2, minusRect.width * 0.2);
      return verticalOverlap && followsMinus;
    })
    .sort((left, right) => (
      Math.abs((left.rect.left || 0) - (minusRect.right || 0))
      - Math.abs((right.rect.left || 0) - (minusRect.right || 0))
      || (left.rect.left || 0) - (right.rect.left || 0)
    ));
  const numberMatch = unsignedMatches[0] || null;
  const rect = numberMatch ? unionSemanticRects([minusRect, numberMatch.rect]) : null;
  if (!rect) return null;
  return {
    rect,
    elements: [
      ...safeList(minusTarget?.elements),
      ...safeList(numberMatch.elements),
    ],
    key: `${targetNode.id}:split-signed:${matchedMinusNode.id}:${textMatchKey(numberMatch)}`,
    candidateCount: unsignedMatches.length,
  };
}

function patchMissingSharedMinusTargets({
  targets = [],
  semanticNodes = [],
  measuredById = new Map(),
  rectSource = "signed-number-minus-fallback",
  deterministic = false,
  fallbackSemanticMappings = null,
}) {
  for (const target of targets) {
    const latex = String(target?.latex || target?.display || target?.text || "").trim();
    const role = target?.role || target?.kind || target?.type || "";
    const start = Number(target?.sourceRange?.start ?? target?.start);
    if (
      latex !== "-"
      || role !== "operator"
      || !Number.isFinite(start)
      || safeList(target.rects).some((rect) => rectArea(rect) > 0)
    ) {
      continue;
    }
    const signedNode = semanticNodes.find((node) => {
      const nodeStart = Number(node?.sourceRange?.start ?? node?.start);
      const nodeText = String(node?.latex || node?.display || node?.text || "");
      return node?.id !== target.id
        && Number.isFinite(nodeStart)
        && nodeStart === start
        && /^-\d/.test(nodeText);
    });
    const signedTarget = signedNode ? measuredById.get(signedNode.id) : null;
    const signedRect = safeList(signedTarget?.rects).find((rect) => rectArea(rect) > 0);
    if (!signedRect) continue;
    const width = Math.min(
      signedRect.width,
      Math.max(5, Math.min(signedRect.height * 0.75, signedRect.width * 0.34))
    );
    const rect = normalizeSemanticRect({
      left: signedRect.left,
      right: signedRect.left + width,
      top: signedRect.top,
      bottom: signedRect.bottom,
    });
    if (!rect) continue;
    const patched = {
      ...target,
      rects: [rect],
      paintedRects: [rect],
      rectSource,
      deterministic: deterministic || target.deterministic,
      elements: safeList(signedTarget?.elements),
      domMatchCount: signedTarget?.domMatchCount ?? 0,
      chosenDomKey: `${target.id}:leading-minus-of:${signedNode.id}`,
      clientRectCount: 1,
      fallbackMappingReason: "same-source-signed-number-leading-minus",
    };
    const patchedWithGeometry = applySemanticGeometryMetadata(patched, [rect], [rect], {
      rectSource,
    });
    measuredById.set(target.id, patchedWithGeometry);
    const index = targets.findIndex((candidate) => candidate.id === target.id);
    if (index >= 0) targets[index] = patchedWithGeometry;
    fallbackSemanticMappings?.push({
      id: target.id,
      role,
      sourceRange: target.sourceRange || null,
      sourceText: latex,
      fallbackStatus: "mapped",
      fallbackReason: "same-source-signed-number-leading-minus",
      chosenDomKey: patchedWithGeometry.chosenDomKey,
    });
  }
}

function measureAnnotatedSemanticTargets({
  katexRoot,
  semanticNodes = [],
  semanticNodeById = new Map(),
  visualRect = null,
  rootRect = null,
}) {
  const annotatedElements = queryElements(katexRoot, "[data-semantic-id]");
  const annotatedDomCount = annotatedElements.length;
  const annotatedIds = annotatedElements
    .map((element) => element.getAttribute?.("data-semantic-id"))
    .filter(Boolean);
  const annotatedIdSet = new Set(annotatedIds);
  const duplicateDomMappings = duplicateEntries(annotatedIds);
  if (annotatedDomCount === 0) {
    return {
      targets: [],
      annotatedDomCount: 0,
      missingSemanticIds: semanticNodes.map((node) => node.id).filter(Boolean),
      duplicateDomMappings,
      selectableNoRect: [],
      measuredById: new Map(),
    };
  }

  const containerRect = visualRect || rootRect;
  const allAnnotatedRects = annotatedElements.flatMap(getElementRects);
  const leafMedianHeight = medianRectHeight(allAnnotatedRects) || 0;
  const measuredById = new Map();
  const targets = semanticNodes.map((node) => {
    const semanticTarget = semanticNodeById.get(node.id) || node;
    const directElements = semanticDomElementsForId(katexRoot, node.id);
    const elements = directElements.length > 0
      ? directElements
      : fallbackSemanticDomElementsForNode(katexRoot, semanticTarget, semanticNodeById);
    const rawRects = elements
      .flatMap(getElementRects)
      .map(normalizeSemanticRect)
      .filter(Boolean)
      .filter((rect) => !containerRect || rectIntersects(rect, containerRect));
    const rawPaintedRects = paintedRectsForElements(katexRoot, elements, containerRect);
    const clusteredPaintedRects = clusterSemanticRects(rawPaintedRects, leafMedianHeight || 18);
    const leaf = isLeafSemanticTarget(semanticTarget);
    const leafRects = normalizeDeterministicLeafRects(filterLeafRects(rawRects, semanticTarget, {
          medianLeafHeight: leafMedianHeight,
          containerRect,
        }), semanticTarget);
    const paintedLeafRects = normalizeDeterministicLeafRects(filterLeafRects(clusteredPaintedRects, semanticTarget, {
      medianLeafHeight: leafMedianHeight,
      containerRect,
    }), semanticTarget);
    const rects = sortRectsByVisualOrder(leaf
      ? (leafRects.length > 0 && (
        rectsTotalArea(leafRects) <= Math.max(1, rectsTotalArea(paintedLeafRects)) * 2.4
        || paintedLeafRects.length === 0
      ) ? leafRects : paintedLeafRects)
      : (clusteredPaintedRects.length > 0 ? clusteredPaintedRects : rawRects)
    );
    const paintedRects = clusteredPaintedRects.length > 0 ? clusteredPaintedRects : rects;
    const measured = {
      ...semanticTarget,
      depth: semanticTarget.depth ?? node.depth,
      rects,
      rectSource: "semantic-dom",
      deterministic: true,
      hitboxRole: deterministicHitboxRoleForNode(semanticTarget, semanticNodeById),
      elements,
      domMatchCount: elements.length,
      chosenDomKey: directElements.length > 0 ? node.id : `${node.id}:semantic-fallback`,
      clientRectCount: rawRects.length,
      annotatedDomNodeCount: annotatedDomCount,
    };
    const measuredWithGeometry = applySemanticGeometryMetadata(measured, rects, paintedRects, {
      rectSource: measured.rectSource,
    });
    measuredById.set(node.id, measuredWithGeometry);
    return measuredWithGeometry;
  });
  const fallbackSemanticMappings = [];
  const leafNodes = semanticNodes.filter(isLeafSemanticTarget);
  const eligibleMissingLeaves = targets
    .filter((target) => isLeafSemanticTarget(target))
    .filter((target) => isHoverEligibleTarget(target))
    .filter((target) => !safeList(target.rects).some((rect) => rectArea(rect) > 0))
    .filter((target) => semanticText(target.latex || target.display || target.text));
  if (eligibleMissingLeaves.length > 0) {
    const textIndex = collectTextNodes(katexRoot);
    const visibleLeaves = collectVisibleMathLeaves(katexRoot);
    const fallbackMedianHeight = medianRectHeight([
      ...allAnnotatedRects,
      ...visibleLeaves.flatMap((item) => item.rects?.length ? item.rects : [item.rect]),
    ]);
    const leafOccurrenceById = new Map();
    const leavesByText = new Map();
    for (const leaf of [...leafNodes].sort((left, right) => (
      Number(left.sourceRange?.start ?? left.order ?? 0) - Number(right.sourceRange?.start ?? right.order ?? 0)
      || Number(left.order ?? 0) - Number(right.order ?? 0)
    ))) {
      const key = semanticText(leaf.latex || leaf.display || leaf.text);
      if (!key || !leaf.sourceRange) continue;
      const group = leavesByText.get(key) || [];
      leafOccurrenceById.set(leaf.id, group.length);
      group.push(leaf);
      leavesByText.set(key, group);
    }
    const claimedFallbackMatchKeys = new Set();
    for (const target of eligibleMissingLeaves.sort((left, right) => (
      Number(left.sourceRange?.start ?? left.order ?? 0) - Number(right.sourceRange?.start ?? right.order ?? 0)
      || Number(left.order ?? 0) - Number(right.order ?? 0)
    ))) {
      const targetText = semanticText(target.latex || target.display || target.text);
      const occurrenceIndex = leafOccurrenceById.get(target.id) ?? 0;
      if (target.role === "radical" || target.latex === "\\sqrt") {
        const radicalCandidates = sortMatchesByRenderedOrder(
          queryElements(katexRoot, ".sqrt")
            .map((element) => deriveRadicalOperatorCandidate(katexRoot, element, fallbackMedianHeight))
            .filter(Boolean)
            .filter((match) => !containerRect || rectIntersects(match.rect, containerRect)),
          Math.max(1, fallbackMedianHeight * 1.35 || 18)
        );
        const radicalMatch = radicalCandidates[occurrenceIndex] || null;
        if (radicalMatch) {
          const rects = filterLeafRects([radicalMatch.rect], target, {
            medianLeafHeight: fallbackMedianHeight,
            containerRect,
          });
          if (rects.length > 0) {
            annotateMeasuredElements(radicalMatch.elements, target.id);
            const normalizedRects = sortRectsByVisualOrder(normalizeDeterministicLeafRects(rects, target));
            const patched = applySemanticGeometryMetadata({
              ...target,
              rects: normalizedRects,
              rectSource: "semantic-dom-targeted-fallback",
              deterministic: true,
              elements: radicalMatch.elements || [],
              domMatchCount: radicalCandidates.length,
              chosenDomKey: `${target.id}:radical:${occurrenceIndex}`,
              clientRectCount: 1,
              fallbackMappingReason: "missing-deterministic-radical-dom-node",
            }, normalizedRects, radicalMatch.paintedRects || normalizedRects, {
              rectSource: "semantic-dom-targeted-fallback",
            });
            measuredById.set(target.id, patched);
            const index = targets.findIndex((candidate) => candidate.id === target.id);
            if (index >= 0) targets[index] = patched;
            fallbackSemanticMappings.push({
              id: target.id,
              role: target.role || target.kind || target.type || "node",
              sourceRange: target.sourceRange || null,
              sourceText: target.latex || target.display || target.text || "",
              fallbackStatus: "mapped",
              fallbackReason: "radical-sign-by-rendered-order",
              candidateCount: radicalCandidates.length,
              expectedOccurrence: occurrenceIndex,
              chosenDomKey: patched.chosenDomKey,
              derivedFrom: "katex-svg-radical-operator",
            });
            continue;
          }
        }
      }
      const rawMatches = sortMatchesByRenderedOrder(
        getTextRangeMatches(textIndex, targetText),
        Math.max(1, fallbackMedianHeight * 1.35 || 18)
      );
      const preferred = rawMatches[occurrenceIndex] || null;
      const preferredKey = preferred ? textMatchKey(preferred) : "";
      const splitSignedFallback = (!preferred || claimedFallbackMatchKeys.has(preferredKey))
        ? findSplitSignedNumberFallback({
          target,
          targetText,
          textIndex,
          semanticNodes,
          measuredById,
          containerRect,
        })
        : null;
      if ((!preferred || claimedFallbackMatchKeys.has(preferredKey)) && !splitSignedFallback) {
        fallbackSemanticMappings.push({
          id: target.id,
          role: target.role || target.kind || target.type || "node",
          sourceRange: target.sourceRange || null,
          sourceText: target.latex || target.display || target.text || "",
          fallbackStatus: "unmapped",
          fallbackReason: preferred ? "fallback-occurrence-already-claimed" : "no-confident-text-occurrence",
          candidateCount: rawMatches.length,
          expectedOccurrence: occurrenceIndex,
        });
        continue;
      }
      const selectedFallback = splitSignedFallback || preferred;
      const selectedKey = splitSignedFallback?.key || preferredKey;
      const rects = filterLeafRects([selectedFallback.rect], target, {
        medianLeafHeight: fallbackMedianHeight,
        containerRect,
      });
      const filteredSplitSignedFallback = rects.length === 0 && !splitSignedFallback
        ? findSplitSignedNumberFallback({
          target,
          targetText,
          textIndex,
          semanticNodes,
          measuredById,
          containerRect,
        })
        : null;
      const finalFallback = filteredSplitSignedFallback || selectedFallback;
      const finalKey = filteredSplitSignedFallback?.key || selectedKey;
      const finalRects = filteredSplitSignedFallback
        ? filterLeafRects([filteredSplitSignedFallback.rect], target, {
          medianLeafHeight: fallbackMedianHeight,
          containerRect,
        })
        : rects;
      if (finalRects.length === 0) {
        fallbackSemanticMappings.push({
          id: target.id,
          role: target.role || target.kind || target.type || "node",
          sourceRange: target.sourceRange || null,
          sourceText: target.latex || target.display || target.text || "",
          fallbackStatus: "unmapped",
          fallbackReason: "fallback-rects-filtered",
          candidateCount: rawMatches.length,
          expectedOccurrence: occurrenceIndex,
        });
        continue;
      }
      claimedFallbackMatchKeys.add(finalKey);
      annotateMeasuredElements(finalFallback.elements, target.id);
      const patched = {
        ...target,
        rects: sortRectsByVisualOrder(normalizeDeterministicLeafRects(finalRects, target)),
        rectSource: "semantic-dom-targeted-fallback",
        deterministic: true,
        elements: finalFallback.elements || [],
        domMatchCount: splitSignedFallback?.candidateCount ?? filteredSplitSignedFallback?.candidateCount ?? rawMatches.length,
        chosenDomKey: finalKey,
        clientRectCount: 1,
        fallbackMappingReason: splitSignedFallback || filteredSplitSignedFallback
          ? "missing-deterministic-split-signed-number-dom-node"
          : "missing-deterministic-dom-node",
      };
      measuredById.set(target.id, patched);
      const index = targets.findIndex((candidate) => candidate.id === target.id);
      if (index >= 0) targets[index] = patched;
      fallbackSemanticMappings.push({
        id: target.id,
        role: target.role || target.kind || target.type || "node",
        sourceRange: target.sourceRange || null,
        sourceText: target.latex || target.display || target.text || "",
        fallbackStatus: "mapped",
        fallbackReason: splitSignedFallback || filteredSplitSignedFallback
          ? "split-signed-number-by-adjacent-minus"
          : "text-occurrence-by-source-order",
        candidateCount: rawMatches.length,
        expectedOccurrence: occurrenceIndex,
        chosenDomKey: finalKey,
      });
    }
  }
  const missingTargetedGroupTargets = targets
    .filter((target) => {
      const role = target.role || target.type || target.kind || "";
      return role === "differential"
        || ((role === "numerator" || role === "denominator") && !isLeafSemanticTarget(target));
    })
    .filter((target) => !safeList(target.rects).some((rect) => rectArea(rect) > 0));
  for (const target of missingTargetedGroupTargets) {
    const role = target.role || target.type || target.kind || "node";
    const childRects = safeList(target.childIds)
      .flatMap((childId) => measuredById.get(childId)?.rects || [])
      .filter(Boolean);
    const rects = clusterSemanticRects(childRects, leafMedianHeight || 18);
    if (rects.length === 0) {
      fallbackSemanticMappings.push({
        id: target.id,
        role,
        sourceRange: target.sourceRange || null,
        sourceText: target.latex || target.display || target.text || "",
        fallbackStatus: "unmapped",
        fallbackReason: `no-${role}-child-rects`,
      });
      continue;
    }
    const patched = {
      ...target,
      rects,
      rectSource: "semantic-dom-targeted-fallback",
      deterministic: true,
      elements: [],
      domMatchCount: 0,
      chosenDomKey: `${target.id}:${role}-child-union`,
      clientRectCount: childRects.length,
      fallbackMappingReason: `missing-${role}-group-dom-node`,
    };
    const patchedWithGeometry = applySemanticGeometryMetadata(patched, rects, childRects, {
      rectSource: patched.rectSource,
    });
    measuredById.set(target.id, patchedWithGeometry);
    const index = targets.findIndex((candidate) => candidate.id === target.id);
    if (index >= 0) targets[index] = patchedWithGeometry;
    fallbackSemanticMappings.push({
      id: target.id,
      role,
      sourceRange: target.sourceRange || null,
      sourceText: target.latex || target.display || target.text || "",
      fallbackStatus: "mapped",
      fallbackReason: `${role}-child-union`,
      candidateCount: childRects.length,
      chosenDomKey: patched.chosenDomKey,
    });
  }
  patchMissingSharedMinusTargets({
    targets,
    semanticNodes,
    measuredById,
    rectSource: "semantic-dom-targeted-fallback",
    deterministic: true,
    fallbackSemanticMappings,
  });
  refineMeasuredDifferentialHighlights({
    targets,
    measuredById,
    semanticNodeById,
    textIndex: collectTextNodes(katexRoot),
    containerRect,
  });
  refineAggregateGeometryFromChildren({
    targets,
    measuredById,
    semanticNodeById,
    medianHeight: leafMedianHeight || 18,
  });
  for (const target of [...targets]) {
    if (target.geometryQuality) continue;
    const rects = safeList(target.rects).map(normalizeSemanticRect).filter(Boolean);
    const paintedRects = safeList(target.paintedRects).length > 0 ? target.paintedRects : rects;
    const patched = applySemanticGeometryMetadata(target, rects, paintedRects, {
      rectSource: target.rectSource || "semantic-dom",
    });
    measuredById.set(target.id, patched);
    const index = targets.findIndex((candidate) => candidate.id === target.id);
    if (index >= 0) targets[index] = patched;
  }
  const missingSemanticIds = semanticNodes
    .map((node) => node.id)
    .filter((id) => id && !annotatedIdSet.has(id));
  const selectableNoRect = targets
    .filter((target) => isLeafSemanticTarget(target) && isHoverEligibleTarget(target) && target.rects.length === 0)
    .map((target) => target.id);

  return {
    targets,
    annotatedDomCount,
    missingSemanticIds,
    duplicateDomMappings,
    selectableNoRect,
    fallbackSemanticMappings,
    measuredById,
  };
}

function mergeToSingleRect(rects = []) {
  const merged = unionSemanticRects(rects);
  return merged ? [merged] : [];
}

function rectWithinRect(inner, outer, tolerance = 1) {
  if (!inner || !outer) return false;
  return inner.left >= outer.left - tolerance
    && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance
    && inner.bottom <= outer.bottom + tolerance;
}

function rectSnapshot(rect) {
  const normalized = normalizeSemanticRect(rect);
  if (!normalized) return null;
  return {
    left: Math.round(normalized.left * 100) / 100,
    top: Math.round(normalized.top * 100) / 100,
    width: Math.round(normalized.width * 100) / 100,
    height: Math.round(normalized.height * 100) / 100,
    right: Math.round(normalized.right * 100) / 100,
    bottom: Math.round(normalized.bottom * 100) / 100,
  };
}

function describeDomElement(element) {
  if (!element) return null;
  return {
    tag: element.tagName?.toLowerCase?.() || "",
    className: elementClassName(element),
    text: semanticText(element.textContent || ""),
    semanticId: element.getAttribute?.("data-semantic-id") || null,
  };
}

function collectTextNodes(root) {
  if (!root || typeof document === "undefined" || typeof NodeFilter === "undefined") {
    return { nodes: [], text: "" };
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let offset = 0;
  let current = walker.nextNode();
  let previousTextItem = null;

  while (current) {
    const raw = current.textContent || "";
    const normalized = semanticText(raw);
    if (normalized) {
      const rect = getTextNodeRect(current, raw.length);
      if (previousTextItem && shouldInsertVisualTextBoundary(previousTextItem, { rect })) {
        offset += 1;
      }
      const rawOffsets = [];
      let normalizedOffset = 0;
      for (let rawOffset = 0; rawOffset < raw.length; rawOffset += 1) {
        const normalizedChar = semanticText(raw[rawOffset]);
        for (let charIndex = 0; charIndex < normalizedChar.length; charIndex += 1) {
          rawOffsets[normalizedOffset] = rawOffset;
          normalizedOffset += 1;
        }
      }
      rawOffsets[normalized.length] = raw.length;
      nodes.push({
        node: current,
        raw,
        normalized,
        rawOffsets,
        start: offset,
        end: offset + normalized.length,
        rect,
      });
      offset += normalized.length;
      previousTextItem = { rect };
    }
    current = walker.nextNode();
  }

  return {
    nodes,
    text: nodes.reduce((text, item, index) => {
      const previous = nodes[index - 1];
      const gap = previous ? Math.max(0, item.start - previous.end) : 0;
      return `${text}${gap > 0 ? " ".repeat(gap) : ""}${item.normalized}`;
    }, ""),
  };
}

function getTextNodeRect(node, rawLength = 0) {
  if (!node || typeof document === "undefined" || rawLength <= 0) return null;
  const range = document.createRange();
  try {
    range.setStart(node, 0);
    range.setEnd(node, rawLength);
    return getMergedRect(getElementRects(range));
  } catch {
    return null;
  } finally {
    range.detach?.();
  }
}

function shouldInsertVisualTextBoundary(previous = {}, current = {}) {
  const previousRect = previous.rect;
  const currentRect = current.rect;
  if (!previousRect || !currentRect) return false;

  const previousCenterY = previousRect.top + previousRect.height / 2;
  const currentCenterY = currentRect.top + currentRect.height / 2;
  const rowTolerance = Math.max(4, Math.min(previousRect.height || 0, currentRect.height || 0) * 0.72);
  if (Math.abs(previousCenterY - currentCenterY) > rowTolerance) return true;

  const backwardsTolerance = Math.max(2, Math.min(previousRect.height || 0, currentRect.height || 0) * 0.18);
  return currentRect.left < previousRect.left - backwardsTolerance;
}

function visibleLeafLabel(element, text = "") {
  const className = typeof element?.className === "string" ? element.className : "";
  if (text) return text;
  if (/\bsqrt-sign\b/.test(className)) return "√";
  if (/\bmathnormal\b/.test(className) && !text) return "mathnormal";
  if (/\bmrel\b/.test(className)) return "relation";
  if (/\bmop\b/.test(className)) return "operator";
  return className.trim().replace(/\s+/g, " ").slice(0, 48) || "math-leaf";
}

function collectVisibleMathLeaves(katexRoot) {
  if (!katexRoot || typeof document === "undefined") return [];
  const walker = document.createTreeWalker(katexRoot, NodeFilter.SHOW_TEXT);
  const leaves = [];
  let current = walker.nextNode();
  while (current) {
    const raw = current.textContent || "";
    const text = semanticText(raw);
    const parent = current.parentElement;
    if (!text || !parent) {
      current = walker.nextNode();
      continue;
    }
    let element = parent;
    let rect = getMergedRect(getElementRects(element));
    while (element && element !== katexRoot && !rect) {
      element = element.parentElement;
      rect = getMergedRect(getElementRects(element));
    }
    if (!element || element === katexRoot) {
      current = walker.nextNode();
      continue;
    }
    const range = document.createRange();
    range.setStart(current, 0);
    range.setEnd(current, raw.length);
    const rects = getElementRects(range);
    range.detach?.();
    const resolvedRects = rects.length > 0 ? rects : getElementRects(element);
    rect = getMergedRect(resolvedRects) || rect;
    if (!rect) {
      current = walker.nextNode();
      continue;
    }
    const className = typeof element.className === "string" ? element.className : "";
    leaves.push({
      element,
      node: current,
      rects: resolvedRects,
      rect,
      text,
      raw,
      label: visibleLeafLabel(element, text),
      className,
    });
    current = walker.nextNode();
  }
  return leaves;
}

function elementClassName(element) {
  return typeof element?.className === "string" ? element.className : "";
}

function elementHasClass(element, className) {
  return element?.classList?.contains?.(className)
    || new RegExp(`(^|\\s)${className}(\\s|$)`).test(elementClassName(element));
}

function closestClassWithin(element, className, stopElement = null) {
  let current = element;
  while (current && current !== stopElement) {
    if (elementHasClass(current, className)) return current;
    current = current.parentElement;
  }
  return null;
}

function elementSemanticText(element) {
  return semanticText(element?.textContent || "");
}

function queryElements(root, selector) {
  return typeof root?.querySelectorAll === "function" ? [...root.querySelectorAll(selector)] : [];
}

function candidateKey(candidate = {}) {
  const rect = candidate.rect || getMergedRect(candidate.rects || []);
  return [
    candidate.kind || "",
    candidate.side || "",
    candidate.text || "",
    rect ? Math.round(rect.left * 100) : "",
    rect ? Math.round(rect.top * 100) : "",
    rect ? Math.round(rect.width * 100) : "",
    rect ? Math.round(rect.height * 100) : "",
  ].join(":");
}

function sortDomCandidatesByVisualOrder(candidates = []) {
  return [...candidates].sort((left, right) => {
    const leftRect = left.rect || getMergedRect(left.rects || []);
    const rightRect = right.rect || getMergedRect(right.rects || []);
    return (
      (leftRect?.top ?? 0) - (rightRect?.top ?? 0)
      || (leftRect?.left ?? 0) - (rightRect?.left ?? 0)
      || rectArea(leftRect) - rectArea(rightRect)
    );
  });
}

function textLeafCandidatesInElement(root, scopeElement) {
  if (!root || !scopeElement || typeof document === "undefined" || typeof NodeFilter === "undefined") return [];
  const walker = document.createTreeWalker(scopeElement, NodeFilter.SHOW_TEXT);
  const candidates = [];
  let current = walker.nextNode();
  while (current) {
    const raw = current.textContent || "";
    const text = semanticText(raw);
    const element = current.parentElement;
    if (text && element) {
      const range = document.createRange();
      try {
        range.setStart(current, 0);
        range.setEnd(current, raw.length);
        const rects = getElementRects(range);
        const rect = getMergedRect(rects);
        if (rect) {
          candidates.push({
            element,
            elements: [element],
            node: current,
            rect,
            rects: rects.length > 0 ? rects : [rect],
            text,
            raw,
          });
        }
      } finally {
        range.detach?.();
      }
    }
    current = walker.nextNode();
  }
  return candidates;
}

function radicandTextLeafCandidates(katexRoot, sqrtElement) {
  return textLeafCandidatesInElement(katexRoot, sqrtElement)
    .filter((candidate) => !closestClassWithin(candidate.element, "root", sqrtElement));
}

function rootIndexTextLeafCandidates(katexRoot, sqrtElement) {
  return textLeafCandidatesInElement(katexRoot, sqrtElement)
    .filter((candidate) => closestClassWithin(candidate.element, "root", sqrtElement));
}

function deriveRadicalOperatorCandidate(katexRoot, sqrtElement, medianHeight = 18) {
  const rootRect = getMergedRect(getElementRects(sqrtElement));
  if (!rootRect) return null;
  const svgElement = queryElements(sqrtElement, ".hide-tail svg")[0]
    || queryElements(sqrtElement, "svg")[0]
    || queryElements(sqrtElement, ".hide-tail")[0]
    || sqrtElement;
  const svgRect = getMergedRect(getElementRects(svgElement)) || rootRect;
  if (!svgRect) return null;

  const radicandLeaves = radicandTextLeafCandidates(katexRoot, sqrtElement);
  const radicandRect = unionSemanticRects(radicandLeaves.flatMap((leaf) => leaf.rects?.length ? leaf.rects : [leaf.rect]));
  const fallbackWidth = Math.max(10, (Number(medianHeight) || 18) * 0.95);
  const boundary = radicandRect
    ? Math.min(svgRect.right, Math.max(svgRect.left + fallbackWidth, radicandRect.left))
    : Math.min(svgRect.right, svgRect.left + fallbackWidth);
  const rect = normalizeSemanticRect({
    left: svgRect.left,
    right: Math.max(svgRect.left + MIN_SEMANTIC_RECT_DIMENSION, boundary),
    top: svgRect.top,
    bottom: svgRect.bottom,
  });
  if (!rect || rectArea(rect) <= 0) return null;
  return {
    kind: "radical",
    side: "sign",
    element: svgElement,
    elements: [svgElement],
    rect,
    rects: [rect],
    paintedRects: [rect],
    text: "√",
    rootRect,
    radicandRect,
    sourceClassName: elementClassName(svgElement),
  };
}

function deriveRadicandCandidate(katexRoot, sqrtElement) {
  const rootRect = getMergedRect(getElementRects(sqrtElement));
  if (!rootRect) return null;
  const leaves = radicandTextLeafCandidates(katexRoot, sqrtElement);
  const rect = unionSemanticRects(leaves.flatMap((leaf) => leaf.rects?.length ? leaf.rects : [leaf.rect]));
  if (!rect || rectArea(rect) <= 0) return null;
  return {
    kind: "radicand",
    side: "radicand",
    element: sqrtElement,
    elements: leaves.map((leaf) => leaf.element).filter(Boolean),
    rect,
    rects: [rect],
    paintedRects: leaves.flatMap((leaf) => leaf.rects?.length ? leaf.rects : [leaf.rect]).map(normalizeSemanticRect).filter(Boolean),
    text: leaves
      .sort((left, right) => left.rect.left - right.rect.left)
      .map((leaf) => leaf.text)
      .join(""),
    containerRect: rootRect,
  };
}

function deriveRootIndexCandidates(katexRoot, sqrtElement) {
  const rootRect = getMergedRect(getElementRects(sqrtElement));
  if (!rootRect) return [];
  return rootIndexTextLeafCandidates(katexRoot, sqrtElement)
    .map((leaf) => ({
      ...leaf,
      kind: "rootIndex",
      side: "index",
      containerRect: rootRect,
    }));
}

function collectKatexStructuralCandidates(katexRoot) {
  const empty = {
    functionName: [],
    fractionPart: [],
    integralSymbol: [],
    operator: [],
    radical: [],
    radicand: [],
    rootIndex: [],
    script: [],
    structural: [],
  };
  if (!katexRoot || typeof document === "undefined") return empty;

  const structural = queryElements(katexRoot, ".mfrac, .sqrt, .sqrt-sign, .msupsub, .mop, .mopen, .mclose, .mbin, .mrel, .mpunct, .op-symbol")
    .map((element) => {
      const rects = getElementRects(element);
      const rect = getMergedRect(rects);
      return rect ? {
        kind: "structural",
        element,
        elements: [element],
        rect,
        rects,
        text: elementSemanticText(element),
        className: elementClassName(element),
      } : null;
    })
    .filter(Boolean);

  const functionName = queryElements(katexRoot, ".mop")
    .map((element) => {
      const text = elementSemanticText(element);
      const matchedName = [...KATEX_FUNCTION_NAMES]
        .filter((name) => text === name || text.startsWith(name))
        .sort((left, right) => right.length - left.length)[0];
      if (!matchedName || element.querySelector?.(".op-symbol")) return null;
      const rects = getElementRects(element);
      const rect = getMergedRect(rects);
      if (!rect) return null;
      return {
        kind: "functionName",
        element,
        elements: [element],
        rect,
        rects,
        text: matchedName,
        fullText: text,
      };
    })
    .filter(Boolean);

  const operator = queryElements(katexRoot, ".mopen, .mclose, .mbin, .mrel, .mpunct, .op-symbol")
    .map((element) => {
      const text = elementSemanticText(element);
      const rects = getElementRects(element);
      const rect = getMergedRect(rects);
      return text && rect ? {
        kind: "operator",
        element,
        elements: [element],
        rect,
        rects,
        text,
      } : null;
    })
    .filter(Boolean);

  const integralSymbol = operator
    .filter((candidate) => /^[∫∬∭∮]$/.test(candidate.text))
    .map((candidate) => ({ ...candidate, kind: "integralSymbol" }));

  const radical = [
    ...queryElements(katexRoot, ".sqrt")
      .map((element) => deriveRadicalOperatorCandidate(katexRoot, element, medianRectHeight(structural.map((candidate) => candidate.rect)) || 18))
      .filter(Boolean),
    ...queryElements(katexRoot, ".sqrt-sign")
      .map((element) => {
        const rects = getElementRects(element);
        const rect = getMergedRect(rects);
        if (!rect) return null;
        return {
          kind: "radical",
          element,
          elements: [element],
          rect,
          rects,
          paintedRects: rects,
          text: "√",
          side: "sign",
        };
      })
      .filter(Boolean),
  ];

  const radicand = queryElements(katexRoot, ".sqrt")
    .map((element) => deriveRadicandCandidate(katexRoot, element))
    .filter(Boolean);

  const rootIndex = queryElements(katexRoot, ".sqrt")
    .flatMap((element) => deriveRootIndexCandidates(katexRoot, element))
    .filter(Boolean);

  const radicalRoot = queryElements(katexRoot, ".sqrt")
    .map((element) => {
      const rects = getElementRects(element);
      const rect = getMergedRect(rects);
      if (!rect) return null;
      return {
        kind: "radical",
        element,
        elements: [element],
        rect,
        rects,
        text: "√",
        side: "root",
      };
    })
    .filter(Boolean);

  const fractionPart = [];
  for (const fraction of queryElements(katexRoot, ".mfrac")) {
    const lineRect = getMergedRect(queryElements(fraction, ".frac-line").flatMap(getElementRects));
    const fractionRect = getMergedRect(getElementRects(fraction));
    const leaves = textLeafCandidatesInElement(katexRoot, fraction);
    if (!lineRect || !fractionRect || leaves.length === 0) continue;
    for (const leaf of leaves) {
      const centerY = leaf.rect.top + leaf.rect.height / 2;
      fractionPart.push({
        ...leaf,
        kind: "fractionPart",
        side: centerY < lineRect.top + lineRect.height / 2 ? "numerator" : "denominator",
        containerRect: fractionRect,
      });
    }
    for (const side of ["numerator", "denominator"]) {
      const sideLeaves = fractionPart.filter((candidate) => candidate.containerRect === fractionRect && candidate.side === side);
      const rect = unionSemanticRects(sideLeaves.map((candidate) => candidate.rect));
      if (rect) {
        fractionPart.push({
          kind: "fractionPart",
          side,
          element: fraction,
          elements: sideLeaves.map((candidate) => candidate.element).filter(Boolean),
          rect,
          rects: [rect],
          text: sideLeaves
            .sort((left, right) => left.rect.left - right.rect.left)
            .map((candidate) => candidate.text)
            .join(""),
          containerRect: fractionRect,
        });
      }
    }
  }

  const script = [];
  for (const scriptElement of queryElements(katexRoot, ".msupsub")) {
    const scriptRect = getMergedRect(getElementRects(scriptElement));
    const leaves = textLeafCandidatesInElement(katexRoot, scriptElement);
    if (!scriptRect || leaves.length === 0) continue;
    const centerY = scriptRect.top + scriptRect.height / 2;
    for (const leaf of leaves) {
      const leafCenterY = leaf.rect.top + leaf.rect.height / 2;
      script.push({
        ...leaf,
        kind: "script",
        side: leafCenterY < centerY ? "upper" : "lower",
        containerRect: scriptRect,
      });
    }
    for (const side of ["upper", "lower"]) {
      const sideLeaves = script.filter((candidate) => candidate.containerRect === scriptRect && candidate.side === side);
      const rect = unionSemanticRects(sideLeaves.map((candidate) => candidate.rect));
      if (rect) {
        script.push({
          kind: "script",
          side,
          element: scriptElement,
          elements: sideLeaves.map((candidate) => candidate.element).filter(Boolean),
          rect,
          rects: [rect],
          text: sideLeaves
            .sort((left, right) => left.rect.left - right.rect.left)
            .map((candidate) => candidate.text)
            .join(""),
          containerRect: scriptRect,
        });
      }
    }
  }

  return {
    functionName: sortDomCandidatesByVisualOrder(functionName),
    fractionPart: sortDomCandidatesByVisualOrder(fractionPart),
    integralSymbol: sortDomCandidatesByVisualOrder(integralSymbol),
    operator: sortDomCandidatesByVisualOrder(operator),
    radical: sortDomCandidatesByVisualOrder([...radical, ...radicalRoot]),
    radicand: sortDomCandidatesByVisualOrder(radicand),
    rootIndex: sortDomCandidatesByVisualOrder(rootIndex),
    script: sortDomCandidatesByVisualOrder(script),
    structural,
  };
}

function rectCenterPoint(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function describeHiddenSemanticLeaf(target, hitboxElement, visualRect, rootRect) {
  if (!target?.rects?.length) return "no-rect";
  const rect = target.rects[0];
  if (rectArea(rect) <= 0.25) return "zero-area";
  if (!hitboxElement) return "no-overlay-node";
  const style = typeof window !== "undefined" && window.getComputedStyle ? window.getComputedStyle(hitboxElement) : null;
  if (style?.pointerEvents === "none") return "pointer-events:none";
  if (visualRect && (rect.right < visualRect.left || rect.left > visualRect.right || rect.bottom < visualRect.top || rect.top > visualRect.bottom)) {
    return "clipped-by-visual-bounds";
  }
  if (rootRect && (rect.right < rootRect.left || rect.left > rootRect.right || rect.bottom < rootRect.top || rect.top > rootRect.bottom)) {
    return "clipped-by-root";
  }
  if (typeof document === "undefined" || !document.elementFromPoint) return "z-index/stacking";
  const center = rectCenterPoint(rect);
  const topElement = document.elementFromPoint(center.x, center.y);
  if (!topElement) return "clipped";
  if (topElement === hitboxElement || hitboxElement.contains(topElement) || topElement.contains(hitboxElement)) return "";
  return "z-index/stacking";
}

function buildSemanticCoverageAudit({
  chunkId,
  visibleLeaves = [],
  semanticLeafTargets = [],
  semanticTargets = semanticLeafTargets,
  overlayTargets = [],
  overlayRoot = null,
  visualRect = null,
  rootRect = null,
}) {
  const semanticLeafTargetsWithRects = semanticLeafTargets.filter((target) => isLeafSemanticTarget(target) && Array.isArray(target.rects) && target.rects.length > 0);
  const semanticLeafTargetsWithoutRects = semanticLeafTargets.filter((target) => isLeafSemanticTarget(target) && !(Array.isArray(target.rects) && target.rects.length > 0));
  const matchedVisibleLeaves = visibleLeaves.filter((leaf) => semanticLeafTargetsWithRects.some((target) => (
    target.rects.some((rect) => rectIntersects(rect, leaf.rect))
  )));
  const unmatchedVisibleLeaves = visibleLeaves.filter((leaf) => !semanticLeafTargetsWithRects.some((target) => (
    target.rects.some((rect) => rectIntersects(rect, leaf.rect))
  )));
  const zeroOrNearZeroAreaRects = semanticLeafTargetsWithRects.flatMap((target) => (
    target.rects
      .map((rect) => ({
        target,
        rect,
        area: rectArea(rect),
      }))
      .filter((item) => item.area <= 4)
  ));
  const hiddenTargets = semanticLeafTargetsWithRects
    .map((target) => {
      const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(target.id)
        : String(target.id).replace(/"/g, '\\"');
      const hitboxElement = overlayRoot?.querySelector?.(`[data-token-id="${escapedId}"]`) || null;
      const reason = describeHiddenSemanticLeaf(target, hitboxElement, visualRect, rootRect);
      return reason ? {
        id: target.id,
        latex: target.latex || target.display || target.text || "",
        role: target.role || target.kind || target.type || "node",
        reason,
        rect: target.rects[0] || null,
      } : null;
    })
    .filter(Boolean);
  const overlayTargetIds = new Set(overlayTargets.map((target) => target.id));
  const aggregateNodes = semanticTargets.filter((target) => isAggregateHoverTarget(target));
  const aggregateNodesExcluded = aggregateNodes
    .filter((target) => !overlayTargetIds.has(target.id))
    .map((target) => ({
      id: target.id,
      latex: target.latex || target.display || target.text || "",
      role: target.role || target.kind || target.type || "node",
      rectCount: safeList(target.rects).length,
      rectSource: target.rectSource || "unmeasured",
    }));
  const ambiguousOverlaps = overlayTargets.flatMap((target, index) => (
    overlayTargets.slice(index + 1)
      .filter((other) => target.id !== other.id)
      .filter((other) => safeList(target.rects).some((left) => safeList(other.rects).some((right) => rectIntersects(left, right))))
      .map((other) => ({
        leftId: target.id,
        rightId: other.id,
        leftRole: target.role || target.kind || target.type || "node",
        rightRole: other.role || other.kind || other.type || "node",
      }))
  )).slice(0, 25);

  return {
    chunkId,
    totalVisibleLeaves: visibleLeaves.length,
    totalSemanticLeaves: semanticLeafTargets.length,
    matchedVisibleLeaves: matchedVisibleLeaves.length,
    coverageRatio: visibleLeaves.length > 0 ? matchedVisibleLeaves.length / visibleLeaves.length : 1,
    coveragePercent: visibleLeaves.length > 0 ? Math.round((matchedVisibleLeaves.length / visibleLeaves.length) * 1000) / 10 : 100,
    unmatchedVisibleText: unmatchedVisibleLeaves.map((leaf) => ({
      text: leaf.label || leaf.text || "",
      rect: leaf.rect,
      className: leaf.className || "",
    })),
    semanticNodesWithNoRect: semanticLeafTargetsWithoutRects.map((target) => ({
      id: target.id,
      latex: target.latex || target.display || target.text || "",
      role: target.role || target.kind || target.type || "node",
    })),
    zeroOrNearZeroAreaRects: zeroOrNearZeroAreaRects.map((item) => ({
      id: item.target.id,
      latex: item.target.latex || item.target.display || item.target.text || "",
      role: item.target.role || item.target.kind || item.target.type || "node",
      rect: item.rect,
      area: item.area,
    })),
    hiddenByPointerEventsZIndexClipping: hiddenTargets,
    aggregateNodesExcludedFromInteraction: aggregateNodesExcluded,
    ambiguousOverlappingTargets: ambiguousOverlaps,
  };
}

function buildSemanticLeafDiagnostics({
  semanticLeaves = [],
  measuredById = new Map(),
  overlayTargets = [],
  selectionTargets = [],
  overlayRoot = null,
  visualRect = null,
  rootRect = null,
  measurementDiagnosticsById = new Map(),
}) {
  const overlayTargetIds = new Set(overlayTargets.map((target) => target.id));
  const selectionTargetIds = new Set(selectionTargets.map((target) => target.id));
  return semanticLeaves.map((leaf) => {
    const measured = measuredById.get(leaf.id) || leaf;
    const rects = safeList(measured.rects);
    const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(leaf.id)
      : String(leaf.id).replace(/"/g, '\\"');
    const hitboxElements = [...(overlayRoot?.querySelectorAll?.(`[data-token-id="${escapedId}"]`) || [])];
    const hitboxElement = hitboxElements[0] || null;
    const style = typeof window !== "undefined" && window.getComputedStyle && hitboxElement
      ? window.getComputedStyle(hitboxElement)
      : null;
    const center = rects[0] ? rectCenterPoint(rects[0]) : null;
    const topElement = center && typeof document !== "undefined" && document.elementFromPoint
      ? document.elementFromPoint(center.x, center.y)
      : null;
    const overlayReason = rects.length > 0
      ? describeHiddenSemanticLeaf(measured, hitboxElement, visualRect, rootRect)
      : "";
    const measurementDiagnostic = measurementDiagnosticsById.get(leaf.id) || {};

    return {
      id: leaf.id,
      latex: leaf.latex || leaf.display || leaf.text || "",
      text: semanticText(leaf.latex || leaf.display || leaf.text || ""),
      role: leaf.role || leaf.kind || leaf.type || "node",
      type: leaf.type || leaf.kind || "",
      sourceRange: leaf.sourceRange || null,
      order: leaf.order ?? null,
      path: {
        parentId: leaf.parentId || null,
        siblingIndex: leaf.siblingIndex ?? null,
        siblingCount: leaf.siblingCount ?? null,
        leafStart: leaf.leafStart ?? null,
        leafEnd: leaf.leafEnd ?? null,
      },
      semanticNodeExists: true,
      domNodeExists: Boolean(measured.chosenDomKey || hitboxElement),
      domMatchCount: measured.domMatchCount ?? 0,
      chosenDomKey: measured.chosenDomKey || null,
      usedAllocatedMatch: Boolean(measured.usedAllocatedMatch),
      measurement: measurementDiagnostic,
      matchedDomElements: measurementDiagnostic.matchedDomElements || [],
      sourceText: measurementDiagnostic.sourceText || leaf.latex || leaf.display || leaf.text || "",
      finalUnionRect: measurementDiagnostic.finalUnionRect || null,
      outsideContainer: Boolean(measurementDiagnostic.outsideContainer),
      discardedRectCount: measurementDiagnostic.discardedRectCount ?? 0,
      bboxMeasured: rects.length > 0,
      bboxCount: rects.length,
      zeroSizeRectCount: rects.filter((rect) => rectArea(rect) <= 0.25).length,
      hitboxCreated: Boolean(hitboxElement) || overlayTargetIds.has(leaf.id),
      hitboxCount: hitboxElements.length,
      pointerEventsEnabled: style ? style.pointerEvents !== "none" : false,
      selectable: selectionTargetIds.has(leaf.id) && isSelectableLeafTarget(measured),
      hoverable: overlayTargetIds.has(leaf.id) && Boolean(hitboxElement) && style?.pointerEvents !== "none",
      excludedFromSelection: !selectionTargetIds.has(leaf.id),
      rectSource: measured.rectSource || "unmeasured",
      coveringElement: topElement && hitboxElement && topElement !== hitboxElement && !hitboxElement.contains(topElement) && !topElement.contains(hitboxElement)
        ? {
            tag: topElement.tagName?.toLowerCase?.() || "",
            className: String(topElement.className || ""),
            tokenId: topElement.getAttribute?.("data-token-id") || null,
          }
        : null,
      missingReason: !rects.length
        ? measurementDiagnostic.noGeometryReason || "bbox-not-measured"
        : !hitboxElement && !overlayTargetIds.has(leaf.id)
          ? "hitbox-not-created"
          : !selectionTargetIds.has(leaf.id)
            ? "excluded-from-selection-model"
          : style?.pointerEvents === "none"
            ? "pointer-events-disabled"
            : overlayReason || "",
    };
  });
}

function dedupeOverlayTargets(targets = []) {
  const byKey = new Map();
  for (const target of targets) {
    const rect = target.rects?.[0];
    const key = [
      target.latex || target.display || target.text || "",
      target.role || target.kind || target.type || "",
      rect ? Math.round(rect.left) : "",
      rect ? Math.round(rect.top) : "",
      rect ? Math.round(rect.width) : "",
      rect ? Math.round(rect.height) : "",
    ].join("|");
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, target);
      continue;
    }
    const currentHasSource = Boolean(current.sourceRange);
    const nextHasSource = Boolean(target.sourceRange);
    if (nextHasSource && !currentHasSource) {
      byKey.set(key, target);
    }
  }
  return [...byKey.values()];
}

function duplicateEntries(values = []) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
}

function logMathPipelineInvariant(name, details = {}) {
  if (!import.meta.env.DEV) return;
  console.error("[omnimath:math-pipeline-invariant]", {
    invariant: name,
    ...details,
  });
}

function assertUniqueSemanticIds(nodes = [], context = {}) {
  if (!import.meta.env.DEV) return;
  const duplicates = duplicateEntries(nodes.map((node) => node.id));
  if (duplicates.length === 0) return;
  const diagnostic = {
    ...context,
    duplicateSemanticIds: duplicates,
    stepIds: [...new Set(nodes.map((node) => node.stepId).filter(Boolean))],
    semanticNodeCount: nodes.length,
  };
  logMathPipelineInvariant("duplicate semantic IDs", diagnostic);
  throw new Error(`Duplicate semantic IDs in ${context.chunkId || "math chunk"}`);
}

function isRenderedMeaningfulSemanticLeafDiagnostic(leaf = {}) {
  if (leaf.missingReason === "non-rendered-syntax-operator") return false;
  if (!semanticText(leaf.latex || leaf.sourceText || leaf.text || "")) return false;
  return true;
}

function compareDiagnosticPhase(previous = null, current = {}) {
  const previousIds = new Set(previous?.hitboxLeafIds || []);
  const currentIds = new Set(current.hitboxLeafIds || []);
  return {
    newlyAddedLeafIds: [...currentIds].filter((id) => !previousIds.has(id)),
    missingSincePreviousPhase: [...previousIds].filter((id) => !currentIds.has(id)),
  };
}

function isFractionPartGroupTarget(target = {}) {
  const role = target.role || target.kind || target.type || "";
  return (role === "numerator" || role === "denominator")
    && !isLeafSemanticTarget(target)
    && (target.rects || []).some((rect) => rectArea(rect) > 0);
}

function textNodeAtOffset(textIndex, offset) {
  return textIndex?.nodes?.find((item) => offset >= item.start && offset < item.end) || null;
}

function rectsAreVisuallyAdjacent(leftRect, rightRect) {
  if (!leftRect || !rightRect) return true;
  const leftCenterY = leftRect.top + leftRect.height / 2;
  const rightCenterY = rightRect.top + rightRect.height / 2;
  const minHeight = Math.min(leftRect.height || 0, rightRect.height || 0);
  const maxHeight = Math.max(leftRect.height || 0, rightRect.height || 0);
  const verticalOffset = Math.abs(leftCenterY - rightCenterY);
  const smallerIsRaised = (
    rightRect.height < leftRect.height * 0.86
    && rightCenterY < leftCenterY - Math.max(3, minHeight * 0.2)
  ) || (
    leftRect.height < rightRect.height * 0.86
    && leftCenterY < rightCenterY - Math.max(3, minHeight * 0.2)
  );
  if (smallerIsRaised && verticalOffset > Math.max(3, maxHeight * 0.16)) return false;
  const rowTolerance = Math.max(4, minHeight * 0.72);
  if (verticalOffset > rowTolerance) return false;
  const gap = rightRect.left - leftRect.right;
  return gap >= -2 && gap <= Math.max(3, minHeight * 0.25);
}

function isVisualBoundaryCompatibleTextMatch(textIndex, foundAt, targetText, matchRect, startNode = null, endNode = null, options = {}) {
  if (options.allowNumericSubstring && /^-?\d+(?:\.\d+)?$/.test(String(targetText || ""))) return true;
  if (targetText === "-") {
    const after = textIndex.text[foundAt + targetText.length] || "";
    if (/[\d.]/.test(after)) {
      const afterNode = textNodeAtOffset(textIndex, foundAt + targetText.length);
      if (afterNode?.node && afterNode.node === endNode?.node) return false;
      return !rectsAreVisuallyAdjacent(matchRect, afterNode?.rect);
    }
    return true;
  }
  if (isBoundaryCompatibleTextMatch(textIndex.text, foundAt, targetText)) return true;
  if (!/^-?\d+(?:\.\d+)?$/.test(String(targetText || ""))) return false;

  const before = textIndex.text[foundAt - 1] || "";
  const after = textIndex.text[foundAt + targetText.length] || "";
  if (/[\d.]/.test(before) || (!targetText.startsWith("-") && before === "-")) {
    const beforeNode = textNodeAtOffset(textIndex, foundAt - 1);
    if (beforeNode?.node && beforeNode.node === startNode?.node) return false;
    if (!rectsAreVisuallyAdjacent(beforeNode?.rect, matchRect)) return true;
  }
  if (/[\d.]/.test(after)) {
    const afterNode = textNodeAtOffset(textIndex, foundAt + targetText.length);
    if (afterNode?.node && afterNode.node === endNode?.node) return false;
    if (!rectsAreVisuallyAdjacent(matchRect, afterNode?.rect)) return true;
  }
  return false;
}

function getTextRangeMatches(textIndex, targetText, parentRect = null, options = {}) {
  if (!targetText || !textIndex?.text || textIndex.nodes.length === 0 || typeof document === "undefined") return [];
  const matches = [];
  let searchFrom = 0;
  let foundAt = textIndex.text.indexOf(targetText, searchFrom);
  let occurrenceIndex = 0;

  while (foundAt >= 0) {
    const foundEnd = foundAt + targetText.length;
    const startNode = textIndex.nodes.find((item) => foundAt >= item.start && foundAt < item.end);
    const endNode = [...textIndex.nodes].reverse().find((item) => foundEnd > item.start && foundEnd <= item.end);

    if (startNode && endNode) {
      const range = document.createRange();
      const startIndex = Math.max(0, Math.min(startNode.normalized.length, foundAt - startNode.start));
      const endIndex = Math.max(0, Math.min(endNode.normalized.length, foundEnd - endNode.start));
      const startOffset = Math.max(0, Math.min(startNode.raw.length, startNode.rawOffsets?.[startIndex] ?? startIndex));
      const endOffset = Math.max(0, Math.min(endNode.raw.length, endNode.rawOffsets?.[endIndex] ?? endIndex));
      range.setStart(startNode.node, startOffset);
      range.setEnd(endNode.node, endOffset);
      const merged = getMergedRect(getElementRects(range));
      const elements = [startNode.node.parentElement, endNode.node.parentElement].filter(Boolean);
      range.detach?.();
      if (
        merged
        && isVisualBoundaryCompatibleTextMatch(textIndex, foundAt, targetText, merged, startNode, endNode, options)
        && (!parentRect || rectIntersects(merged, parentRect))
      ) {
        matches.push({ rect: merged, foundAt, occurrenceIndex, elements });
      }
    }

    searchFrom = foundAt + 1;
    foundAt = textIndex.text.indexOf(targetText, searchFrom);
    occurrenceIndex += 1;
  }

  return matches;
}

function getTextRangeRects(textIndex, targetText, parentRect = null) {
  return getTextRangeMatches(textIndex, targetText, parentRect).map((match) => match.rect);
}

function renderedLineBucket(rect, baselineHeight = 18) {
  if (!rect) return 0;
  return Math.round((rect.top + rect.height / 2) / Math.max(1, baselineHeight));
}

function sortMatchesByRenderedOrder(matches = [], baselineHeight = 18) {
  return [...matches].sort((left, right) => {
    const leftRect = left.rect;
    const rightRect = right.rect;
    return (
      renderedLineBucket(leftRect, baselineHeight) - renderedLineBucket(rightRect, baselineHeight)
      || (leftRect?.left ?? 0) - (rightRect?.left ?? 0)
      || (left.foundAt ?? 0) - (right.foundAt ?? 0)
    );
  });
}

function textMatchKey(match = {}) {
  const rect = normalizeSemanticRect(match.rect);
  return [
    match.foundAt ?? "",
    rect ? Math.round(rect.left * 100) : "",
    rect ? Math.round(rect.top * 100) : "",
    rect ? Math.round(rect.width * 100) : "",
    rect ? Math.round(rect.height * 100) : "",
  ].join(":");
}

function annotateMeasuredElements(elements = [], semanticId) {
  for (const element of elements) {
    if (!element?.setAttribute) continue;
    element.setAttribute("data-semantic-id", semanticId);
    element.setAttribute("data-leaf-id", semanticId);
  }
}

function distanceFromPointToRect(rect, x, y) {
  const normalized = normalizeSemanticRect(rect);
  if (!normalized) return Number.POSITIVE_INFINITY;
  const dx = x < normalized.left ? normalized.left - x : x > normalized.right ? x - normalized.right : 0;
  const dy = y < normalized.top ? normalized.top - y : y > normalized.bottom ? y - normalized.bottom : 0;
  return Math.hypot(dx, dy);
}

function domDepth(element) {
  let depth = 0;
  let current = element;
  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function describeHitboxElement(element) {
  if (!element) return null;
  return {
    tag: element.tagName?.toLowerCase?.() || "",
    className: elementClassName(element),
    depth: domDepth(element),
    inspectable: element.getAttribute?.("data-inspectable") || null,
    targetKind: element.getAttribute?.("data-target-kind") || null,
    tokenRole: element.getAttribute?.("data-token-role") || null,
    rectSource: element.getAttribute?.("data-rect-source") || null,
    unionRect: element.getAttribute?.("data-union-rect") || null,
    semanticId: element.getAttribute?.("data-semantic-id") || null,
  };
}

function candidateDebugPayload(target = {}, rect = null, pointer = {}, score = null, index = null) {
  const safeTarget = target || {};
  const normalizedRect = normalizeSemanticRect(rect || safeTarget?.rects?.[0]);
  const x = Number(pointer.x);
  const y = Number(pointer.y);
  return {
    index,
    semanticNodeId: safeTarget?.semanticId || safeTarget?.semanticNodeId || safeTarget?.id || null,
    id: safeTarget?.id || null,
    expression: safeTarget?.latex || safeTarget?.display || safeTarget?.text || "",
    sourceRange: safeTarget?.sourceRange || null,
    nodeKind: safeTarget?.role || safeTarget?.kind || safeTarget?.type || "node",
    type: safeTarget?.type || safeTarget?.kind || null,
    role: safeTarget?.role || null,
    dom: safeTarget?.debugDom || null,
    semanticDepth: safeTarget?.depth ?? null,
    rect: rectSnapshot(normalizedRect),
    rectangleArea: rectArea(normalizedRect),
    paintedRects: safeList(safeTarget?.paintedRects).map(rectSnapshot).filter(Boolean),
    paintedArea: safeTarget?.paintedArea ?? null,
    geometryQuality: safeTarget?.geometryQuality || null,
    geometryRejectionReasons: safeList(safeTarget?.geometryRejectionReasons),
    pointerInsideRect: normalizedRect && Number.isFinite(x) && Number.isFinite(y)
      ? rectContainsPoint(normalizedRect, x, y)
      : false,
    distanceFromPointer: Number.isFinite(x) && Number.isFinite(y)
      ? Math.round(distanceFromPointToRect(normalizedRect, x, y) * 100) / 100
      : null,
    targetClass: isLeafSemanticTarget(safeTarget) ? "leaf" : isAggregateHoverTarget(safeTarget) ? "parent" : "container",
    rectSource: safeTarget?.rectSource || safeTarget?.debugDom?.rectSource || "unknown",
    rankingScore: Number.isFinite(Number(score?.score)) ? Math.round(Number(score.score) * 1000) / 1000 : null,
    rankingTuple: score ? {
      exact: score.exact ?? null,
      paintedExact: score.paintedExact ?? null,
      geometryQualityRank: score.geometryQualityRank ?? null,
      area: score.area ?? null,
      semanticDepth: score.target?.depth ?? null,
      domDepth: score.domDepth ?? null,
      leaf: score.leaf ?? null,
      sourceRangeLength: score.sourceRangeLength ?? null,
      paintedDistance: score.paintedDistance ?? null,
      distance: score.distance ?? null,
    } : null,
    rejectionReason: score?.rejectionReason || safeTarget?.rejectionReason || null,
    exact: score?.exact ?? null,
    paintedExact: score?.paintedExact ?? null,
    leaf: score?.leaf ?? isLeafSemanticTarget(safeTarget),
  };
}

function sanitizeHoverDiagnostic(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof Element !== "undefined" && value instanceof Element) return describeHitboxElement(value);
  if (typeof DOMRect !== "undefined" && value instanceof DOMRect) return rectSnapshot(value);
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeHoverDiagnostic(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "elements") {
        result.elements = safeList(entry).map(describeHitboxElement).filter(Boolean);
        continue;
      }
      result[key] = sanitizeHoverDiagnostic(entry, depth + 1);
    }
    return result;
  }
  return value;
}

function logHoverTarget(details) {
  if (!DEBUG_HOVER_TARGETS) return;
  const diagnostic = sanitizeHoverDiagnostic({
    timestamp: Date.now(),
    ...details,
  });
  if (typeof window !== "undefined") {
    const diagnosticWindow = /** @type {any} */ (window);
    diagnosticWindow.__OMNIMATH_LAST_HOVER_DIAGNOSTIC__ = diagnostic;
    diagnosticWindow.__OMNIMATH_HOVER_DIAGNOSTICS__ = [
      ...safeList(diagnosticWindow.__OMNIMATH_HOVER_DIAGNOSTICS__),
      diagnostic,
    ].slice(-200);
  }
  console.info("[omnimath:hover-target]", diagnostic);
}

function geometryTargetDebugPayload(target = {}) {
  return {
    id: target.id || null,
    semanticId: target.semanticId || target.semanticNodeId || target.id || null,
    latex: target.latex || target.display || target.text || "",
    role: target.role || target.kind || target.type || "node",
    type: target.type || target.kind || null,
    parentId: target.parentId || null,
    childIds: safeList(target.childIds),
    sourceRange: target.sourceRange || null,
    rectSource: target.rectSource || "unknown",
    geometryQuality: target.geometryQuality || null,
    geometryValid: target.geometryValid ?? null,
    rejectionReasons: safeList(target.geometryRejectionReasons),
    clientRectCount: target.clientRectCount ?? safeList(target.rects).length,
    domMatchCount: target.domMatchCount ?? null,
    chosenDomKey: target.chosenDomKey || null,
    rects: safeList(target.rects).map(rectSnapshot).filter(Boolean),
    paintedRects: safeList(target.paintedRects).map(rectSnapshot).filter(Boolean),
    paintedArea: target.paintedArea ?? null,
    depth: target.depth ?? null,
    leaf: isLeafSemanticTarget(target),
    aggregate: isAggregateHoverTarget(target),
  };
}

function recordGeometrySnapshotDiagnostic(snapshot = {}, details = {}) {
  if (!DEBUG_MATH_HOVER_DIAGNOSTICS || typeof window === "undefined") return;
  const diagnosticWindow = /** @type {any} */ (window);
  const diagnostic = sanitizeHoverDiagnostic({
    timestamp: Date.now(),
    ...details,
    valid: snapshot.valid,
    revision: snapshot.revision,
    reason: snapshot.reason || "",
    phase: snapshot.phase || details.phase || "",
    coordinateSpace: snapshot.coordinateSpace || "viewport",
    rootRect: snapshot.rootRect || null,
    visualRect: snapshot.visualRect || null,
    acceptedTargets: safeList(snapshot.childTargets).map(geometryTargetDebugPayload),
    rejectedTargets: safeList(snapshot.rejectedTargets).map(geometryTargetDebugPayload),
    overlayTargets: safeList(snapshot.overlayTargets).map(geometryTargetDebugPayload),
  });
  diagnosticWindow.__OMNIMATH_LAST_GEOMETRY_SNAPSHOT__ = diagnostic;
  diagnosticWindow.__OMNIMATH_GEOMETRY_SNAPSHOTS__ = [
    ...safeList(diagnosticWindow.__OMNIMATH_GEOMETRY_SNAPSHOTS__),
    diagnostic,
  ].slice(-80);
  console.info("[omnimath:geometry-snapshot]", diagnostic);
}

function syntheticCoefficientChildren(node, token) {
  if (safeList(token.children).length > 0 || node.role !== "product") return [];
  const latex = String(node.latex || node.display || "").replace(/^\s+/, "");
  const coefficient = latex.match(/^\d+(?:\.\d+)?/);
  if (!coefficient) return [];
  const nextLatex = latex.slice(coefficient[0].length);
  if (!/^\\(?:int|iint|iiint|oint)(?=_|\^|\{|\\|\(|$|\s)/.test(nextLatex)) return [];

  return [{
    id: `${node.id}-coefficient-${coefficient[0].replace(/\./g, "-")}`,
    display: coefficient[0],
    latex: coefficient[0],
    text: coefficient[0],
    role: "coefficient",
    kind: "coefficient",
    short: "Coefficient",
    medium: `${coefficient[0]} is the coefficient multiplying the following expression.`,
    deep: "A leading coefficient scales the entire expression that follows it.",
    relatedTokenIds: [],
    children: [],
    parentId: node.id,
    parentRole: node.role,
    siblingIndex: -1,
    siblingCount: safeList(token.children).length + 1,
    depth: node.depth + 1,
  }];
}

function createSyntheticNode(base, overrides = {}) {
  const latex = overrides.latex || base.latex || base.display || base.text || "";
  return {
    ...base,
    id: overrides.id || `${base.id}-synthetic-${cleanSyntheticId(latex)}`,
    display: latex,
    latex,
    text: overrides.text || latex,
    role: overrides.role || base.role || "group",
    kind: overrides.kind || base.kind || "group",
    short: overrides.short || base.short || "Expression",
    medium: overrides.medium || base.medium || `${latex} is the selected expression.`,
    deep: overrides.deep || base.deep || `${latex} is the selected expression in this step.`,
    relatedTokenIds: safeList(base.relatedTokenIds),
    children: [],
    childIds: overrides.childIds || [],
    parentId: overrides.parentId ?? base.parentId ?? null,
    parentRole: overrides.parentRole ?? base.parentRole ?? null,
    siblingIndex: overrides.siblingIndex ?? base.siblingIndex ?? -1,
    siblingCount: overrides.siblingCount ?? base.siblingCount ?? 1,
    depth: overrides.depth ?? base.depth,
    sourceRange: overrides.sourceRange ?? base.sourceRange,
    start: overrides.start ?? base.start,
    end: overrides.end ?? base.end,
    synthetic: true,
  };
}

function cleanSyntheticId(value = "") {
  return String(value || "group")
    .replace(/\\/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    || "group";
}

function reconstructedSiblingGroups(nodes = []) {
  const groups = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index];
    const next = nodes[index + 1];
    const afterNext = nodes[index + 2];

    if (current?.role === "function" && next?.role === "argument") {
      const name = current.latex || current.display || "";
      const argument = next.latex || next.display || "";
      const latex = /^\(.+\)$/.test(argument) ? `${name}${argument}` : `${name}(${argument})`;
      groups.push(createSyntheticNode(current, {
        id: `${current.id}-call-${cleanSyntheticId(argument)}`,
        latex,
        role: "function",
        kind: "function_call",
        depth: Math.max(Number(current.depth) || 1, Number(next.depth) || 1),
        siblingIndex: current.siblingIndex,
        siblingCount: current.siblingCount,
      }));
    }

    if (current?.role === "function" && next?.role === "exponent" && afterNext?.role === "argument") {
      const latex = `${current.latex || current.display || ""}^${next.latex || next.display || ""}${afterNext.latex || afterNext.display || ""}`;
      groups.push(createSyntheticNode(current, {
        id: `${current.id}-power-call-${cleanSyntheticId(latex)}`,
        latex,
        role: "function",
        kind: "function_power",
        depth: Math.max(Number(current.depth) || 1, Number(next.depth) || 1, Number(afterNext.depth) || 1),
        siblingIndex: current.siblingIndex,
        siblingCount: current.siblingCount,
      }));
    }

    if ((current?.role === "function" || current?.role === "product") && next?.latex === "=" && afterNext?.latex === "0") {
      const latex = `${current.latex || current.display || ""}=0`;
      if (/\\sin\s*\(?0\)?|\(0\)|\b0\b/.test(latex)) {
        groups.push(createSyntheticNode(current, {
          id: `${current.id}-zero-simplification`,
          latex,
          role: "simplification",
          kind: "zero_product",
          short: "Zero product simplification",
          medium: `${latex} shows the expression vanishes because one factor is zero.`,
          deep: "When a product contains a zero factor, the whole product is zero.",
          depth: Math.max(Number(current.depth) || 1, Number(afterNext.depth) || 1),
          siblingIndex: current.siblingIndex,
          siblingCount: current.siblingCount,
        }));
      }
    }

    const currentLatex = String(current?.latex || current?.display || "");
    const zeroProductMatch = currentLatex.match(/\(0\)\(-2\\sin\\theta\)/);
    if (zeroProductMatch) {
      const relativeStart = zeroProductMatch.index || 0;
      const absoluteStart = Number(current?.sourceRange?.start ?? current?.start ?? 0) + relativeStart;
      const absoluteEnd = absoluteStart + zeroProductMatch[0].length;
      groups.push(createSyntheticNode(current, {
        id: `${current.id}-zero-product-factor`,
        latex: zeroProductMatch[0],
        role: "product",
        kind: "zero_product_factor",
        short: "Zero product",
        medium: `${zeroProductMatch[0]} contains a zero factor.`,
        deep: "A product with a zero factor evaluates to zero.",
        sourceRange: { start: absoluteStart, end: absoluteEnd },
        start: absoluteStart,
        end: absoluteEnd,
        siblingIndex: current.siblingIndex,
        siblingCount: current.siblingCount,
        depth: (Number(current.depth) || 1) + 1,
        childIds: [current.id],
      }));
    }
  }
  return groups;
}

function flattenSemanticNodes(parts = [], parent = null, depth = 1) {
  const normalizedParts = safeList(parts);
  const flattened = normalizedParts.flatMap((part, index) => {
    const token = normalizeRenderableToken(part, `${parent?.id || "semantic"}-${index}`);
    const node = {
      ...token,
      parentId: parent?.id || null,
      parentRole: parent?.role || null,
      siblingIndex: index,
      siblingCount: safeList(parts).length,
      depth,
    };
    const syntheticChildren = node.role === "integral" && /^\\(?:int|iint|iiint|oint)/.test(node.latex)
      ? [{
          id: `${node.id}-integral-symbol`,
          display: node.latex.match(/^\\(?:int|iint|iiint|oint)/)?.[0] || "\\int",
          latex: node.latex.match(/^\\(?:int|iint|iiint|oint)/)?.[0] || "\\int",
          text: "integral",
          role: "operator",
          kind: "integral_symbol",
          short: "Integral symbol",
          medium: "What is this? The integral sign marks accumulation. Why is it here? It tells OmniMath to combine values over the bounds or domain. How does it connect? The integrand and differential specify what is accumulated.",
          deep: "What is this? The integral sign marks accumulation. Why is it here? It tells OmniMath to combine values over the bounds or domain. How does it connect? The integrand and differential specify what is accumulated.",
          relatedTokenIds: [],
          children: [],
          parentId: node.id,
          parentRole: node.role,
          siblingIndex: -1,
          siblingCount: token.children.length + 1,
          depth: depth + 1,
        }]
      : [];
    const coefficientChildren = syntheticCoefficientChildren(node, token);
    return [
      node,
      ...syntheticChildren,
      ...coefficientChildren,
      ...(node.role === "differential"
        ? []
        : flattenSemanticNodes(token.children, node, depth + 1)),
    ];
  });
  return [
    ...flattened,
    ...reconstructedSiblingGroups(flattened.filter((node) => node.parentId === (parent?.id || null) && !node.synthetic)),
  ];
}

function mergeSemanticTargets(...groups) {
  const seen = new Set();
  const rangedLeafKeys = new Set(groups.flat()
    .filter((node) => node?.sourceRange)
    .map((node) => [
      node.latex || node.display || node.text || "",
      node.role || node.kind || node.type || "",
    ].join("|")));
  const rangedLeafLatex = new Set(groups.flat()
    .filter((node) => node?.sourceRange)
    .map((node) => node.latex || node.display || node.text || "")
    .filter(Boolean));
  return groups.flat().filter((node) => {
    if (!node?.id) return false;
    const leafKey = [
      node.latex || node.display || node.text || "",
      node.role || node.kind || node.type || "",
    ].join("|");
    if (!node.sourceRange && (rangedLeafKeys.has(leafKey) || rangedLeafLatex.has(node.latex || node.display || node.text || ""))) return false;
    const range = node.sourceRange ? `${node.sourceRange.start}-${node.sourceRange.end}` : "";
    const key = [
      node.latex || node.display || node.text || "",
      node.role || node.kind || node.type || "",
      range,
      node.parentId || "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function MathSubToken({ part, parentChunk, stepId, depth = 0, tokenClassName = "" }) {
  const safePart = useMemo(
    () => normalizeRenderableToken(part, `subtoken-${stepId || "step"}-${depth}`),
    [depth, part, stepId]
  );
  const safeParentChunk = useMemo(
    () => normalizeRenderableToken(parentChunk, `parent-${stepId || "step"}`),
    [parentChunk, stepId]
  );
  const {
    activeChunkId,
    activeChunkData,
    inspectedConceptId,
    relatedConceptIds = [],
    pinnedChunkIds = [],
    openReferenceIds = [],
    handleChunkEnter = noop,
    handleChunkMove = noop,
    handleChunkLeave = noop,
    handleChunkRightClick = noop,
    selectChunk = noop,
    registerToken = noop,
    beginTokenSelection = noop,
    extendTokenSelection = noop,
    finishTokenSelection = noop,
    selectedTokenIds = [],
  } = useHover() || {};
  const concept = getConceptForChunk(safePart);
  const isActive = activeChunkId === safePart.id;
  const isConceptActive = concept?.id && concept.id === inspectedConceptId;
  const isConceptRelated = concept?.id && safeList(relatedConceptIds).includes(concept.id);
  const isExplicitlyRelated = safeList(activeChunkData?.relatedTokenIds).includes(safePart.id)
    || safePart.relatedTokenIds.includes(activeChunkId)
    || safePart.relatedTokenIds.includes(safeParentChunk.id);
  const isPinned = safeList(pinnedChunkIds).includes(safePart.id);
  const hasWindow = safeList(openReferenceIds).includes(safePart.id);
  const isSelected = safeList(selectedTokenIds).includes(safePart.id);
  const childParts = safePart.children;
  const hasChildParts = childParts.length > 0;
  const isPowerGroup = isPowerToken(safePart) && childParts.length >= 2;
  const isFractionGroup = isFractionToken(safePart, childParts);
  const isFunctionGroup = isFunctionToken(safePart, childParts);
  const isGroupActive = hasChildParts && (isActive || isPinned || hasWindow || isConceptActive);
  const isHoverEligible = isHoverEligibleTarget(safePart);
  const canRecurse = depth < 8;
  const hitboxWeight = tokenHitboxWeight(safePart);
  const parentExpression = safeParentChunk.display || safeParentChunk.latex || safeParentChunk.text || "";
  const inspectablePart = useMemo(() => ({
    ...safePart,
    parentExpression,
    parentTokenId: safeParentChunk.id,
  }), [parentExpression, safeParentChunk.id, safePart]);
  const isDirectSubTokenTarget = (event) => {
    const closestToken = typeof Element !== "undefined" && event.target instanceof Element
      ? event.target.closest("[data-subtoken='true']")
      : null;
    return closestToken === event.currentTarget;
  };
  const accessibleTitle = userFacingTooltipTitle({
    title: safePart.short,
    selectedText: safePart.display || safePart.text,
    display: safePart.display,
    latex: safePart.latex,
    role: safePart.role,
  });

  const handleEnter = (event) => {
    event.stopPropagation();
    if (!isHoverEligible) return;
    if (!isDirectSubTokenTarget(event)) return;
    extendTokenSelection(inspectablePart, stepId);
    handleChunkEnter(inspectablePart, stepId, event);
  };

  const handleMove = (event) => {
    event.stopPropagation();
    if (!isHoverEligible) return;
    if (!isDirectSubTokenTarget(event)) return;
    if (activeChunkId !== safePart.id) {
      handleChunkEnter(inspectablePart, stepId, event);
    }
    handleChunkMove(event);
  };

  const handleLeave = (event) => {
    event.stopPropagation();
    handleChunkLeave(event);
  };

  const handleFocus = (event) => {
    if (!isHoverEligible) return;
    handleChunkEnter(inspectablePart, stepId, event);
  };

  const handleBlur = (event) => {
    handleChunkLeave(event);
  };

  useEffect(() => registerToken(inspectablePart, stepId, safeParentChunk.id), [registerToken, inspectablePart, safeParentChunk.id, stepId]);

  return (
    <span
      data-subtoken="true"
      data-token-id={safePart.id}
      data-token-latex={safePart.latex}
      data-token-depth={depth}
      data-token-role={safePart.role || "other"}
      data-explainable={isHoverEligible ? "true" : undefined}
      data-inspectable={isHoverEligible ? "math-subtoken" : undefined}
      tabIndex={isHoverEligible ? 0 : undefined}
      aria-label={accessibleTitle}
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onMouseDown={(event) => {
        if (isHoverEligible) beginTokenSelection(inspectablePart, stepId, event);
      }}
      onMouseUp={finishTokenSelection}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={(event) => {
        event.stopPropagation();
        if (!isHoverEligible) return;
        selectChunk(inspectablePart, stepId);
      }}
      onContextMenu={(event) => {
        event.stopPropagation();
        if (!isHoverEligible) return;
        handleChunkRightClick(inspectablePart, stepId, event);
      }}
      className={cn(
        "math-subtoken relative inline-block rounded-sm transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45",
        isHoverEligible && "explainable-token cursor-help",
        hasChildParts ? "math-subtoken-group px-0.5 pb-0.5 pt-0" : "math-subtoken-leaf px-0.5",
        isPowerGroup && "math-power-group",
        isFractionGroup && "math-fraction-group",
        isFunctionGroup && "math-function-group",
        isOperatorToken(safePart) && "math-subtoken-operator",
        isSelected && "omni-token-selected",
        isGroupActive && "math-subtoken-group-active",
        (isConceptRelated || isExplicitlyRelated) && !isConceptActive && "omni-related-subtoken",
        tokenClassName
      )}
      style={{
        zIndex: depth + 3,
        transform: `translateY(calc(var(--math-subtoken-offset-y, 0em) + ${
          isActive || isConceptActive || isPinned || hasWindow ? "-1px" : "0px"
        }))`,
        color: isActive || isConceptActive || isPinned || hasWindow ? "#ccfbf1" : "inherit",
        textDecorationLine: isActive || isConceptActive || isPinned || hasWindow ? "underline" : "none",
        textDecorationColor: "rgba(94, 234, 212, 0.55)",
        textUnderlineOffset: "0.18em",
        flex: `${hitboxWeight} 1 0`,
        filter: isActive || isConceptActive || isPinned || hasWindow
          ? "drop-shadow(0 0 8px rgba(45, 212, 191, 0.42))"
          : "none",
      }}
    >
      {isPowerGroup && canRecurse ? (
        <span className="math-power-layout">
          <MathSubToken
            part={childParts[0]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-power-base"
          />
          <MathSubToken
            part={childParts[1]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-power-exponent"
          />
          {childParts.slice(2).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-child-${index + 2}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
            />
          ))}
        </span>
      ) : isFractionGroup && canRecurse ? (
        <span className="math-fraction-layout">
          <span className="math-fraction-row math-fraction-num">
            <MathSubToken
              part={childParts[0]}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-fraction-part"
            />
          </span>
          <span className="math-fraction-rule" aria-hidden="true" />
          <span className="math-fraction-row math-fraction-den">
            <MathSubToken
              part={childParts[1]}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-fraction-part"
            />
          </span>
          {childParts.slice(2).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-child-${index + 2}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
            />
          ))}
        </span>
      ) : isFunctionGroup && canRecurse ? (
        <span className="math-function-layout">
          <MathSubToken
            part={childParts[0]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-function-name"
          />
          {childParts.slice(1).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-arg-${index + 1}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-function-argument"
            />
          ))}
        </span>
      ) : hasChildParts && canRecurse ? (
        childParts.map((child, index) => (
          <MathSubToken
            key={child.id || `${safePart.id}-child-${index}`}
            part={child}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
          />
        ))
      ) : (
        <InlineMath math={safePart.display} className="font-serif italic" />
      )}
      {(isPinned || hasWindow) && (
        <span
          className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-teal-200 shadow-[0_0_8px_rgba(94,234,212,0.8)]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function MathChunk({ chunk, stepId }) {
  const tokenRef = useRef(null);
  const mathVisualRef = useRef(null);
  const semanticTargetsRef = useRef([]);
  const geometrySnapshotRef = useRef(emptyGeometrySnapshot());
  const measuredTargetCleanupRef = useRef(null);
  const measureFrameRef = useRef(0);
  const measurementRevisionRef = useRef(0);
  const invalidationSignaturesRef = useRef({});
  const hoverDiagnosticsRef = useRef(null);
  const hoverPhaseLoggedRef = useRef(false);
  const dragPhaseLoggedRef = useRef(false);
  const lastResolvedHoverIdRef = useRef(null);
  const lastMovedHoverIdRef = useRef(null);
  const pointerResolveRetryFrameRef = useRef(0);
  const handleAnnotatedMoveRef = useRef((_event) => {});
  const [overlayTargets, setOverlayTargets] = useState([]);
  const safeChunk = useMemo(
    () => normalizeRenderableToken(chunk, `chunk-${stepId || "step"}`),
    [chunk, stepId]
  );
  const renderSignature = [
    stepId || "",
    safeChunk.id || "",
    safeChunk.latex || "",
    safeChunk.display || "",
    safeChunk.text || "",
  ].join("::");
  const renderRevisionStateRef = useRef({ signature: "", revision: 0 });
  if (renderRevisionStateRef.current.signature !== renderSignature) {
    renderRevisionStateRef.current = {
      signature: renderSignature,
      revision: renderRevisionStateRef.current.revision + 1,
    };
  }
  const renderRevision = renderRevisionStateRef.current.revision;
  const {
    activeChunkId,
    activeChunkData,
    inspectedConceptId,
    relatedConceptIds = [],
    pinnedChunkIds = [],
    openReferenceIds = [],
    handleChunkEnter = noop,
    handleChunkMove = noop,
    handleChunkLeave = noop,
    handleChunkRightClick = noop,
    selectChunk = noop,
    registerToken = noop,
    registerMeasuredTargets = noop,
    beginTokenSelection = noop,
    extendTokenSelection = noop,
    finishTokenSelection = noop,
    clearHoverLens = noop,
    selectedTokenIds = [],
    settings,
  } = useHover() || {};

  const concept = getConceptForChunk(safeChunk);
  const isActive = activeChunkId === safeChunk.id;
  const isConceptActive = concept?.id && concept.id === inspectedConceptId;
  const isConceptRelated = concept?.id && safeList(relatedConceptIds).includes(concept.id);
  const isExplicitlyRelated = safeList(activeChunkData?.relatedTokenIds).includes(safeChunk.id);
  const isPinned = safeList(pinnedChunkIds).includes(safeChunk.id);
  const hasWindow = safeList(openReferenceIds).includes(safeChunk.id);
  const isSelected = safeList(selectedTokenIds).includes(safeChunk.id);
  const accessibleTitle = userFacingTooltipTitle({
    title: safeChunk.short,
    selectedText: safeChunk.display || safeChunk.text,
    display: safeChunk.display,
    latex: safeChunk.latex,
    role: safeChunk.role,
  });
  const isSiblingActive = activeChunkId && activeChunkId !== safeChunk.id;
  const mathColor = isActive || isConceptActive || isPinned || hasWindow ? "#ccfbf1" : "rgba(224, 242, 254, 0.9)";
  const parts = safeChunk.parts;
  const hasParts = parts.length > 0;
  const isOperator = isOperatorToken(safeChunk);
  const deferToSubTokens = isLargeAnnotatedToken(safeChunk, parts);
  const semanticLatexInput = useMemo(() => normalizeSemanticLatexInput(
    safeChunk.latex || safeChunk.display || safeChunk.text
  ), [safeChunk.display, safeChunk.latex, safeChunk.text]);
  const canonicalSemanticTree = useMemo(() => {
    const baseStepId = `${safeChunk.id}-${stepId || "step"}`;
    const candidates = [];
    if (safeChunk.semanticTree || safeChunk.semantic) {
      candidates.push({
        source: "supplied-semantic-tree",
        tree: buildSemanticTree({
          stepId: `${baseStepId}-supplied`,
          displayLatex: semanticLatexInput,
          explicitTree: safeChunk.semanticTree || safeChunk.semantic,
          tokens: [safeChunk],
        }),
      });
    }
    if (parts.length > 0) {
      candidates.push({
        source: "explicit-parts",
        tree: buildSemanticTree({
          stepId: `${baseStepId}-parts`,
          displayLatex: semanticLatexInput,
          explicitTree: safeChunk,
          tokens: [safeChunk],
        }),
      });
    }
    candidates.push({
      source: "latex-parser",
      tree: buildSemanticTree({
        stepId: baseStepId,
        displayLatex: semanticLatexInput,
        explicitTree: null,
        tokens: null,
      }),
    });

    const selected = chooseSemanticTreeCandidate(candidates);
    const canonical = normalizeCanonicalSemanticTree(selected?.tree);
    return canonical ? { ...canonical, canonicalSource: selected?.source || "none" } : null;
  }, [parts.length, safeChunk, semanticLatexInput, stepId]);
  const semanticNodes = useMemo(() => {
    const treeTargets = canonicalSemanticTree
      ? flattenSemanticTreeForTargets(canonicalSemanticTree).map(attachLocalSemanticExplanation)
      : [];
    if (treeTargets.length > 1) return treeTargets;
    // The canonical tree above is the normal representation. This flattening path
    // remains for older normalized chunks that only carry ad hoc part arrays.
    return flattenSemanticNodes(parts);
  }, [canonicalSemanticTree, parts]);
  useMemo(() => {
    if (!import.meta.env.DEV) return null;
    const semanticDiagnostics = {
      stage: "semantic tree generation",
      stepId,
      chunkId: safeChunk.id,
      stepIds: [stepId].filter(Boolean),
      canonicalSource: canonicalSemanticTree?.canonicalSource || "none",
      canonicalNodeCount: canonicalSemanticTree?.flatNodes?.length || 0,
      semanticNodeCount: semanticNodes.length,
      leafTokenCount: semanticNodes.filter(isLeafSemanticTarget).length,
      annotatedTokenCount: parts.length,
      generatedHitboxCount: overlayTargets.length,
      duplicateFinalAnswerNodes: 0,
      skippedNodes: [],
      parserFailures: canonicalSemanticTree ? [] : [{ chunkId: safeChunk.id, latex: semanticLatexInput }],
      fallbackUsage: [
        canonicalSemanticTree?.fallback ? "canonical semantic tree fallback" : null,
        semanticNodes.length <= 1 ? "subtoken flatten fallback or no semantic leaves" : null,
      ].filter(Boolean),
      retries: 0,
      exceptions: [],
    };
    console.info("[omnimath:math-pipeline]", semanticDiagnostics);
    if (!canonicalSemanticTree && !parts.length) {
      logMathPipelineInvariant("rendered math expression has no semantic tree", semanticDiagnostics);
    }
    assertUniqueSemanticIds(semanticNodes, { stepId, chunkId: safeChunk.id });
    return null;
  }, [canonicalSemanticTree, overlayTargets.length, parts.length, safeChunk.id, semanticLatexInput, semanticNodes, stepId]);
  const hasSemanticTargets = semanticNodes.length > 1;
  const hasInteractiveTargets = hasParts || hasSemanticTargets;
  const semanticNodeById = useMemo(() => new Map(semanticNodes.map((node) => [
    node.id,
    (() => {
      const parentNode = node.parentId ? semanticNodes.find((parent) => parent.id === node.parentId) : null;
      const siblingIds = safeList(parentNode?.childIds);
      return {
        ...node,
        parentRole: node.parentRole || parentNode?.role || null,
        siblingIndex: Number.isFinite(Number(node.siblingIndex)) && Number(node.siblingIndex) >= 0
          ? node.siblingIndex
          : siblingIds.indexOf(node.id),
        siblingCount: Number.isFinite(Number(node.siblingCount)) && Number(node.siblingCount) > 0
          ? node.siblingCount
          : siblingIds.length,
      parentExpression: safeChunk.display || safeChunk.latex || safeChunk.text || "",
      parentTokenId: safeChunk.id,
      };
    })(),
  ])), [safeChunk.display, safeChunk.id, safeChunk.latex, safeChunk.text, semanticNodes]);

  const replaceGeometrySnapshot = useCallback((reason = "invalidated") => {
    geometrySnapshotRef.current = {
      ...emptyGeometrySnapshot(reason),
      revision: measurementRevisionRef.current,
      renderRevision,
      chunkId: safeChunk.id,
      stepId,
    };
    semanticTargetsRef.current = [];
  }, [renderRevision, safeChunk.id, stepId]);

  const commitGeometrySnapshot = useCallback(({
    phase = "measure",
    rootRect = null,
    visualRect = null,
    targets = [],
    overlayTargets: nextOverlayTargets = [],
    rejectedTargets = [],
  } = {}) => {
    const preparedTargets = targets
      .map((target) => prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id));
    const acceptedTargets = preparedTargets.filter((target) => target.geometryValid);
    const rejected = [
      ...preparedTargets.filter((target) => !target.geometryValid),
      ...safeList(rejectedTargets).map((target) => ({
        ...prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id),
        geometryValid: false,
      })),
    ];
    const signature = semanticSnapshotSignature({ rootRect, visualRect, targets: acceptedTargets });
    const previous = geometrySnapshotRef.current;
    const revision = previous.signature === signature && previous.valid
      ? previous.revision
      : previous.revision + 1;
    measurementRevisionRef.current = revision;
    const childTargets = acceptedTargets.filter((target) => target.id !== safeChunk.id);
    const targetById = new Map(acceptedTargets.map((target) => [target.id, target]));
    const rectEntries = childTargets.flatMap((target) => (
      safeList(target.rects).map((rect) => ({ target, rect }))
    ));
    const snapshot = {
      valid: true,
      revision,
      renderRevision,
      chunkId: safeChunk.id,
      stepId,
      domOwner: tokenRef.current,
      scrollState: readSnapshotScrollState(tokenRef.current, mathVisualRef.current),
      reason: "",
      phase,
      rootRect: rectSnapshot(rootRect),
      visualRect: rectSnapshot(visualRect),
      targets: acceptedTargets,
      childTargets,
      targetById,
      rectEntries,
      rejectedTargets: rejected,
      overlayTargets: nextOverlayTargets,
      signature,
      createdAt: Date.now(),
      coordinateSpace: "viewport",
    };
    geometrySnapshotRef.current = snapshot;
    semanticTargetsRef.current = acceptedTargets;
    recordSemanticHoverPerf("geometrySnapshotCommitted", {
      phase,
      stepId,
      chunkId: safeChunk.id,
      revision,
      acceptedCount: acceptedTargets.length,
      rejectedCount: rejected.length,
    });
    recordGeometrySnapshotDiagnostic(snapshot, {
      phase,
      stepId,
      chunkId: safeChunk.id,
    });
    return snapshot;
  }, [renderRevision, safeChunk.id, semanticNodeById, stepId]);

  const measureSemanticTargets = useCallback((phase = "measure") => {
    const measurementStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const measurementRevision = measurementRevisionRef.current;
    recordSemanticHoverPerf("geometryMeasurement", {
      phase,
      stepId,
      chunkId: safeChunk.id,
      measurementRevision,
      semanticNodeCount: semanticNodes.length,
    });
    const root = tokenRef.current;
    const visualRoot = mathVisualRef.current;
    if (!root || !visualRoot || semanticNodes.length === 0) {
      replaceGeometrySnapshot("missing-render-root-or-semantic-nodes");
      measuredTargetCleanupRef.current?.();
      measuredTargetCleanupRef.current = null;
      setOverlayTargets([]);
      return [];
    }

    recordSemanticHoverCounter("getBoundingClientRectCalls", 1, { reason: "measure-root", phase });
    const rootRect = normalizeSemanticRect(root.getBoundingClientRect());
    recordSemanticHoverCounter("getBoundingClientRectCalls", 1, { reason: "measure-visual-root", phase });
    const visualRect = normalizeSemanticRect(visualRoot.getBoundingClientRect());
    const katexRoot = visualRoot.querySelector(".katex-html") || visualRoot.querySelector(".katex") || visualRoot;
    const leafNodes = semanticNodes.filter(isLeafSemanticTarget);
    const deterministicMeasurement = measureAnnotatedSemanticTargets({
      katexRoot,
      semanticNodes,
      semanticNodeById,
      visualRect,
      rootRect,
    });
    if (deterministicMeasurement.annotatedDomCount > 0) {
      const measuredTargetsAll = buildAggregateRectsFromDescendants(deterministicMeasurement.targets).map((target) => (
        isAggregateHoverTarget(target)
          ? { ...target, isAggregateTarget: true, aggregate: true, leaf: false }
          : target
      ));
      const measuredTargets = measuredTargetsAll
        .filter((target) => target.rects.length > 0)
        .map((target) => attachMeasurementRoot(target, rootRect));

      const parentTarget = {
        ...safeChunk,
        depth: 0,
        rects: [visualRect || rootRect].filter(Boolean),
        rectSource: "chunk-visual-root",
      };
      const rawSnapshotTargets = [...measuredTargets, attachMeasurementRoot(parentTarget, rootRect)];
      const provisionalSnapshotTargets = rawSnapshotTargets
        .map((target) => prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id));
      const provisionalAcceptedTargets = provisionalSnapshotTargets.filter((target) => target.geometryValid);
      const snapshotRejectedTargets = [
        ...provisionalSnapshotTargets.filter((target) => !target.geometryValid),
        ...measuredTargetsAll
          .filter((target) => !measuredTargets.some((measured) => measured.id === target.id))
          .map((target) => prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id)),
      ];
      const snapshotTargets = provisionalAcceptedTargets.filter((target) => target.id !== safeChunk.id);
      const selectableTargets = dedupeOverlayTargets(snapshotTargets.filter(isSelectableLeafTarget));
      measuredTargetCleanupRef.current?.();
      measuredTargetCleanupRef.current = registerMeasuredTargets(stepId, selectableTargets, safeChunk.id);
      let finalOverlayTargetCount = 0;

      if (rootRect) {
        const debugOverlay = DEBUG_SEMANTIC_HITBOXES || settings?.interaction?.debugSemanticHitboxes;
        const selectableTargetIds = new Set(selectableTargets.map((target) => target.id));
        const aggregateTargets = dedupeOverlayTargets(snapshotTargets.filter((target) => (
          !selectableTargetIds.has(target.id)
          && isAggregateHoverTarget(target)
        )).map((target) => ({ ...target, isAggregateTarget: true, aggregate: true, leaf: false })));
        const aggregateTargetIds = new Set(aggregateTargets.map((target) => target.id));
        const passiveRadicalTargets = dedupeOverlayTargets(snapshotTargets.filter((target) => (
          !selectableTargetIds.has(target.id)
          && !aggregateTargetIds.has(target.id)
          && isCompactRadicalParent(target)
        )));
        const passivePowerTargets = dedupeOverlayTargets(snapshotTargets.filter((target) => (
          !selectableTargetIds.has(target.id)
          && !aggregateTargetIds.has(target.id)
          && isCompactPowerParent(target)
        )));
        const passiveFractionPartTargets = dedupeOverlayTargets(snapshotTargets.filter((target) => (
          !selectableTargetIds.has(target.id)
          && !aggregateTargetIds.has(target.id)
          && isFractionPartGroupTarget(target)
        )));
        const passiveDifferentialTargets = dedupeOverlayTargets(snapshotTargets.filter((target) => (
          !selectableTargetIds.has(target.id)
          && !aggregateTargetIds.has(target.id)
          && (target.role === "differential" || target.type === "differential" || target.kind === "differential")
        )));
        const passiveGroupTargetIds = new Set([
          ...aggregateTargets.map((target) => target.id),
          ...passiveRadicalTargets.map((target) => target.id),
          ...passivePowerTargets.map((target) => target.id),
          ...passiveFractionPartTargets.map((target) => target.id),
          ...passiveDifferentialTargets.map((target) => target.id),
        ]);
        const debugOnlyTargets = debugOverlay
          ? dedupeOverlayTargets(snapshotTargets.filter((target) => !selectableTargetIds.has(target.id) && !passiveGroupTargetIds.has(target.id)))
          : [];
        const rejectedDebugTargets = debugOverlay
          ? dedupeOverlayTargets(snapshotRejectedTargets.filter((target) => safeList(target.rects).length > 0).map((target) => ({
            ...target,
            isRejectedGeometry: true,
          })))
          : [];
        const finalOverlayTargets = [
          ...selectableTargets,
          ...aggregateTargets,
          ...passiveRadicalTargets,
          ...passivePowerTargets,
          ...passiveFractionPartTargets,
          ...passiveDifferentialTargets,
          ...debugOnlyTargets,
          ...rejectedDebugTargets,
        ];
        finalOverlayTargetCount = finalOverlayTargets.length;
        const snapshot = commitGeometrySnapshot({
          phase,
          rootRect,
          visualRect,
          targets: rawSnapshotTargets,
          overlayTargets: finalOverlayTargets,
          rejectedTargets: snapshotRejectedTargets,
        });
        const coverageAudit = buildSemanticCoverageAudit({
          chunkId: safeChunk.id,
          visibleLeaves: [],
          semanticLeafTargets: snapshot.childTargets.filter(isLeafSemanticTarget),
          semanticTargets: snapshot.childTargets,
          overlayTargets: finalOverlayTargets,
          overlayRoot: tokenRef.current,
          visualRect,
          rootRect,
        });

        if (import.meta.env.DEV) {
          const selectableWithNoRect = leafNodes
            .filter((leaf) => isHoverEligibleTarget(leaf))
            .map((leaf) => deterministicMeasurement.measuredById.get(leaf.id) || leaf)
            .filter((target) => !safeList(target.rects).some((rect) => rectArea(rect) > 0))
            .map((target) => target.id);
          const diagnostic = {
            stage: "DOM measurement / hitbox generation",
            mode: "deterministic-semantic-dom",
            phase,
            stepId,
            chunkId: safeChunk.id,
            measurementRevision,
              canonicalSource: canonicalSemanticTree?.canonicalSource || "none",
              semanticNodeCount: semanticNodes.length,
              leafTokenCount: leafNodes.length,
              annotatedDomNodeCount: deterministicMeasurement.annotatedDomCount,
              missingSemanticIds: deterministicMeasurement.missingSemanticIds,
              duplicateDomMappings: deterministicMeasurement.duplicateDomMappings,
              targetedFallbackMappings: deterministicMeasurement.fallbackSemanticMappings || [],
              selectableNodesWithNoVisibleRect: selectableWithNoRect,
              generatedHitboxCount: finalOverlayTargets.length,
              acceptedSemanticCandidateCount: snapshot.childTargets.length,
              rejectedSemanticCandidates: snapshot.rejectedTargets.map((target) => ({
                id: target.id,
                role: target.role || target.kind || target.type || "node",
                reasons: target.geometryRejectionReasons || [],
              })),
              legacyFallbackUsed: false,
              coverage: coverageAudit,
            };
          if (DEBUG_MATH_HOVER_DIAGNOSTICS || debugOverlay) {
            console.info("[omnimath:semantic-dom-hitboxes]", {
              ...diagnostic,
              targets: measuredTargetsAll.map((target) => ({
                id: target.id,
                role: target.role || target.kind || target.type || "node",
                latex: target.latex || target.display || target.text || "",
                rectCount: target.rects?.length || 0,
                domMatchCount: target.domMatchCount || 0,
                rectSource: target.rectSource || "unmeasured",
              })),
            });
          }
          if (selectableWithNoRect.length > 0 || deterministicMeasurement.missingSemanticIds.length > 0) {
            console.warn("[omnimath:semantic-dom-hitboxes-warning]", diagnostic);
          }
        }

        setOverlayTargets(finalOverlayTargets.map((target) => ({
          ...target,
          measurementRevision,
          isLeafTarget: isLeafSemanticTarget(target),
          rectSource: target.rectSource || "unknown",
          rects: target.rects.map((rect) => ({
            left: rect.left - rootRect.left,
            top: rect.top - rootRect.top,
            width: rect.width,
            height: rect.height,
          })),
        })));
      }

      recordSemanticHoverPerf("geometryMeasurementComplete", {
        phase,
        stepId,
        chunkId: safeChunk.id,
        measurementRevision: measurementRevisionRef.current,
        elapsedMs: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - measurementStartedAt) * 100) / 100,
        targetCount: semanticTargetsRef.current.length,
        overlayTargetCount: finalOverlayTargetCount,
        annotatedDomCount: deterministicMeasurement.annotatedDomCount,
      });
      return semanticTargetsRef.current;
    }

    if (import.meta.env.DEV) {
      console.warn("[omnimath:semantic-hitbox-legacy-fallback]", {
        phase,
        stepId,
        chunkId: safeChunk.id,
        semanticNodeCount: semanticNodes.length,
        reason: "no-annotated-semantic-dom-nodes",
      });
    }

    const textIndex = collectTextNodes(katexRoot);
    const structuralIndex = collectKatexStructuralCandidates(katexRoot);

    const measuredById = new Map();
    const leafOccurrenceById = new Map();
    const leafTextCounts = new Map();
    const occurrenceOrderedLeafNodes = [...leafNodes].sort((left, right) => {
      const leftStart = Number(left.sourceRange?.start);
      const rightStart = Number(right.sourceRange?.start);
      const leftHasRange = Number.isFinite(leftStart);
      const rightHasRange = Number.isFinite(rightStart);
      if (leftHasRange && rightHasRange) return leftStart - rightStart || Number(left.order ?? 0) - Number(right.order ?? 0);
      if (leftHasRange) return -1;
      if (rightHasRange) return 1;
      return Number(left.order ?? 0) - Number(right.order ?? 0);
    });
    for (const node of occurrenceOrderedLeafNodes) {
      const targetText = semanticText(node.latex || node.display || node.text);
      const count = leafTextCounts.get(targetText) || 0;
      leafOccurrenceById.set(node.id, count);
      if (node.sourceRange) {
        leafTextCounts.set(targetText, count + 1);
      }
    }
    const visibleMathLeaves = collectVisibleMathLeaves(katexRoot);
    const elements = visibleMathLeaves;
    const leafElements = visibleMathLeaves;
    const rawLeafRects = leafElements.flatMap((item) => item.rects.length > 0 ? item.rects : [item.rect]);
    const leafMedianHeight = medianRectHeight(rawLeafRects) || medianRectHeight(elements.map((item) => item.rect)) || 0;
    const textMatchAllocationById = new Map();
    const claimedTextMatchKeys = new Set();
    const claimedStructuralCandidateKeys = new Set();
    const measurementDiagnosticsById = new Map();
    const sourceLeafGroups = new Map();
    for (const node of occurrenceOrderedLeafNodes.filter((leaf) => leaf.sourceRange)) {
      const targetText = semanticText(node.latex || node.display || node.text);
      if (!targetText || node.role === "radical" || node.latex === "\\sqrt") continue;
      const group = sourceLeafGroups.get(targetText) || [];
      group.push(node);
      sourceLeafGroups.set(targetText, group);
    }
    for (const [targetText, nodes] of sourceLeafGroups) {
      const allowNumericSubstring = /^-?\d+(?:\.\d+)?$/.test(targetText)
        && nodes.some((node) => node.role === "coefficient");
      const matches = sortMatchesByRenderedOrder(
        getTextRangeMatches(textIndex, targetText, null, { allowNumericSubstring }),
        Math.max(1, leafMedianHeight * 1.35 || 18)
      );
      const orderedNodes = [...nodes].sort((left, right) => (
        Number(left.sourceRange?.start ?? left.order ?? 0) - Number(right.sourceRange?.start ?? right.order ?? 0)
        || Number(left.order ?? 0) - Number(right.order ?? 0)
      ));
      for (let index = 0; index < orderedNodes.length; index += 1) {
        if (matches[index]) {
          textMatchAllocationById.set(orderedNodes[index].id, matches[index]);
        }
      }
    }

    const recordMeasurementDiagnostic = (node, measurement = {}, extra = {}) => {
      const rawClientRects = safeList(measurement.elements).flatMap(getElementRects);
      const finalUnion = unionSemanticRects(measurement.rects || []);
      const zeroAreaRectCount = safeList(measurement.rects).filter((rect) => !normalizeSemanticRect(rect)).length;
      const outsideContainer = Boolean(finalUnion && (visualRect || rootRect) && !rectWithinRect(finalUnion, visualRect || rootRect, 2));
      const reason = measurement.noGeometryReason
        || extra.noGeometryReason
        || (!measurement.elements?.length && !measurement.chosenDomKey && !measurement.domMatchCount ? "no-matched-dom-node" : "")
        || (!safeList(measurement.rects).length ? "no-valid-final-rect" : "")
        || (outsideContainer ? "rect-outside-math-container" : "")
        || (zeroAreaRectCount > 0 ? "zero-area-rect-filtered" : "")
        || null;
      const diagnostic = {
        id: node.id,
        role: node.role || node.kind || node.type || "node",
        type: node.type || node.kind || "",
        sourceRange: node.sourceRange || null,
        sourceText: node.latex || node.display || node.text || "",
        normalizedSourceText: semanticText(node.latex || node.display || node.text || ""),
        matchStrategy: measurement.rectSource || "unmeasured",
        matchedDomElements: safeList(measurement.elements).map(describeDomElement).filter(Boolean),
        domMatchCount: measurement.domMatchCount ?? 0,
        chosenDomKey: measurement.chosenDomKey || null,
        rawClientRectCount: rawClientRects.length,
        finalRectCount: safeList(measurement.rects).length,
        finalUnionRect: rectSnapshot(finalUnion),
        outsideContainer,
        zeroAreaRectCount,
        discardedRectCount: Math.max(0, rawClientRects.length - safeList(measurement.rects).length),
        fallbackUsed: /fallback|ancestor/.test(String(measurement.rectSource || "")),
        noGeometryReason: reason,
        ...extra,
      };
      measurementDiagnosticsById.set(node.id, diagnostic);
      return diagnostic;
    };

    const allocateStructuralCandidate = (node, candidates = [], options = {}) => {
      const targetText = options.targetText ?? semanticText(node.latex || node.display || node.text);
      const parentRect = options.parentRect || null;
      const expectedOccurrence = leafOccurrenceById.get(node.id);
      const scored = candidates
        .filter((candidate) => candidate?.rect)
        .filter((candidate) => !options.side || candidate.side === options.side)
        .filter((candidate) => !parentRect || rectIntersects(candidate.rect, parentRect))
        .filter((candidate) => {
          if (!targetText) return true;
          if (candidate.text === targetText) return true;
          if (options.allowContains && (candidate.text?.includes(targetText) || targetText.includes(candidate.text))) return true;
          return false;
        })
        .map((candidate, index) => {
          const key = candidateKey(candidate);
          const claimed = claimedStructuralCandidateKeys.has(key);
          const exact = candidate.text === targetText;
          const textDelta = Math.abs(String(candidate.text || "").length - String(targetText || "").length);
          return {
            candidate,
            key,
            score: (
              Number(claimed) * 100000
              + Number(!exact) * 1000
              + textDelta * 20
              + Math.abs(index - Number(expectedOccurrence || 0)) * 4
              + rectArea(candidate.rect) / 10000
            ),
          };
        })
        .sort((left, right) => left.score - right.score);
      const winner = scored[0];
      if (!winner) {
        return {
          rects: [],
          rectSource: options.rectSource || "katex-structure",
          elements: [],
          domMatchCount: 0,
          noGeometryReason: candidates.length > 0 ? "no-compatible-structural-candidate" : "no-structural-candidates",
        };
      }
      claimedStructuralCandidateKeys.add(winner.key);
      annotateMeasuredElements(winner.candidate.elements || [winner.candidate.element].filter(Boolean), node.id);
      const rawRects = winner.candidate.rects?.length ? winner.candidate.rects : [winner.candidate.rect];
      const filteredRects = filterLeafRects(rawRects, node, {
        medianLeafHeight: leafMedianHeight,
        containerRect: visualRect || rootRect,
      });
      return {
        rects: filteredRects,
        rectSource: options.rectSource || "katex-structure",
        hitboxRole: options.hitboxRole || null,
        elements: winner.candidate.elements || [winner.candidate.element].filter(Boolean),
        chosenDomKey: winner.key,
        domMatchCount: scored.length,
        usedAllocatedMatch: !winner.score || !claimedStructuralCandidateKeys.has(winner.key),
        rawRectCount: rawRects.filter(Boolean).length,
        discardedRectCount: Math.max(0, rawRects.filter(Boolean).length - filteredRects.length),
        noGeometryReason: filteredRects.length ? null : "structural-rects-filtered",
      };
    };

    const structuralMeasurementForLeaf = (node) => {
      const targetText = semanticText(node.latex || node.display || node.text);
      const role = node.role || node.kind || node.type || "";
      const parentRole = node.parentRole || semanticNodeById.get(node.parentId)?.role || "";
      const parentRect = getMergedRect(measuredById.get(node.parentId)?.rects || []) || null;

      if (role === "functionName") {
        const measured = allocateStructuralCandidate(node, structuralIndex.functionName, {
          targetText,
          parentRect: parentRect || visualRect || rootRect,
          allowContains: true,
          rectSource: "katex-function",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "integralSymbol" || (role === "operator" && /^[∫∬∭∮]$/.test(targetText))) {
        const measured = allocateStructuralCandidate(node, structuralIndex.integralSymbol, {
          targetText,
          parentRect: parentRect || visualRect || rootRect,
          rectSource: "katex-operator",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "radical" || node.latex === "\\sqrt") {
        const measured = allocateStructuralCandidate(node, structuralIndex.radical, {
          targetText: "√",
          side: "sign",
          parentRect: parentRect || visualRect || rootRect,
          rectSource: "katex-radical",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "radicand") {
        const measured = allocateStructuralCandidate(node, structuralIndex.radicand, {
          targetText,
          side: "radicand",
          parentRect: parentRect || visualRect || rootRect,
          allowContains: true,
          rectSource: "katex-radicand",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "operator" || role === "equality") {
        const measured = allocateStructuralCandidate(node, structuralIndex.operator, {
          targetText,
          parentRect: parentRect || visualRect || rootRect,
          rectSource: "katex-operator",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "exponent" || parentRole === "exponent") {
        const measured = allocateStructuralCandidate(node, structuralIndex.script, {
          targetText,
          side: "upper",
          parentRect: parentRect || visualRect || rootRect,
          rectSource: "katex-script",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "upperBound" || parentRole === "upperBound" || role === "bound" || parentRole === "bound") {
        const measured = allocateStructuralCandidate(node, structuralIndex.script, {
          targetText,
          side: "upper",
          parentRect: parentRect || visualRect || rootRect,
          allowContains: true,
          rectSource: "katex-limit",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "lowerBound" || parentRole === "lowerBound") {
        const measured = allocateStructuralCandidate(node, structuralIndex.script, {
          targetText,
          side: "lower",
          parentRect: parentRect || visualRect || rootRect,
          allowContains: true,
          rectSource: "katex-limit",
        });
        if (measured?.rects?.length) return measured;
      }

      if (role === "numerator" || parentRole === "numerator" || role === "denominator" || parentRole === "denominator") {
        const side = role === "denominator" || parentRole === "denominator" ? "denominator" : "numerator";
        const parentNode = semanticNodeById.get(node.parentId);
        const exposesAdditiveNumeratorSide = side === "numerator"
          && role === "constant"
          && parentNode?.role === "numerator"
          && /\+/.test(String(parentNode.latex || parentNode.display || parentNode.text || ""));
        const measured = allocateStructuralCandidate(node, structuralIndex.fractionPart, {
          targetText,
          side,
          parentRect: parentRect || visualRect || rootRect,
          allowContains: true,
          rectSource: "katex-fraction",
          hitboxRole: exposesAdditiveNumeratorSide ? "numerator" : null,
        });
        if (measured?.rects?.length) return measured;
      }

      return null;
    };

    const measureLeafRect = (node) => {
      node = semanticNodeById.get(node.id) || node;
      const targetText = semanticText(node.latex || node.display || node.text);
      if (!targetText) return { rects: [], rectSource: "dom-leaf", elements: [] };
      const expectedOccurrence = leafOccurrenceById.get(node.id);

      const mergeNegativeNumberRects = (rects) => {
        if (!/^-?\d/.test(String(node.latex || node.display || node.text || "")) || !targetText.startsWith("-")) {
          return rects;
        }
        const baseRect = getMergedRect(rects);
        if (!baseRect) return rects;
        const absoluteText = targetText.slice(1);
        const digitMatch = getTextRangeMatches(textIndex, absoluteText, null, { allowNumericSubstring: true })
          .map((match) => ({
            ...match,
            rects: filterLeafRects([match.rect], node, {
              medianLeafHeight: leafMedianHeight,
              containerRect: visualRect || rootRect,
            }),
          }))
          .filter((match) => match.rects.length > 0)
          .filter((match) => {
            const rect = getMergedRect(match.rects);
            if (!rect) return false;
            const sameLine = Math.abs((rect.top + rect.height / 2) - (baseRect.top + baseRect.height / 2)) <= Math.max(6, leafMedianHeight * 0.6);
            return sameLine && rect.left >= baseRect.left && rect.left <= baseRect.right + Math.max(24, leafMedianHeight * 1.8);
          })
          .sort((left, right) => {
            const leftRect = getMergedRect(left.rects);
            const rightRect = getMergedRect(right.rects);
            return (leftRect?.left ?? 0) - (rightRect?.left ?? 0);
          })[0];
        const digitRect = getMergedRect(digitMatch?.rects || []);
        const merged = digitRect ? unionSemanticRects([baseRect, digitRect]) : null;
        return merged ? [merged] : rects;
      };

      const measureSplitNegativeNumber = () => {
        if (!/^-?\d/.test(String(node.latex || node.display || node.text || "")) || !targetText.startsWith("-")) {
          return null;
        }
        const absoluteText = targetText.slice(1);
        const digitMatch = getTextRangeMatches(textIndex, absoluteText, null, { allowNumericSubstring: true })
          .map((match) => ({
            ...match,
            rects: filterLeafRects([match.rect], node, {
              medianLeafHeight: leafMedianHeight,
              containerRect: visualRect || rootRect,
            }),
          }))
          .filter((match) => match.rects.length > 0)
          .sort((left, right) => Math.abs(left.foundAt - Number(node.sourceRange?.start ?? 0)) - Math.abs(right.foundAt - Number(node.sourceRange?.start ?? 0)))[0];
        const digitRect = getMergedRect(digitMatch?.rects || []);
        if (!digitRect) return null;
        const minusRect = elements
          .filter((item) => item.text === "-")
          .map((item) => item.rect)
          .filter((rect) => {
            const sameLine = Math.abs((rect.top + rect.height / 2) - (digitRect.top + digitRect.height / 2)) <= Math.max(6, leafMedianHeight * 0.6);
            return sameLine && rect.right <= digitRect.left + Math.max(3, digitRect.width * 0.35);
          })
          .sort((left, right) => Math.abs(left.right - digitRect.left) - Math.abs(right.right - digitRect.left))[0];
        const merged = unionSemanticRects([minusRect, digitRect].filter(Boolean));
        return merged ? {
          rects: filterLeafRects([merged], node, {
            medianLeafHeight: leafMedianHeight,
            containerRect: visualRect || rootRect,
          }),
          elements: digitMatch?.elements || [],
        } : null;
      };

      const structuralMeasurement = structuralMeasurementForLeaf(node);
      if (structuralMeasurement?.rects?.length) return structuralMeasurement;

      if (node.role === "radical" || node.latex === "\\sqrt") {
        const radicalCandidates = queryElements(katexRoot, ".sqrt")
          .map((element) => deriveRadicalOperatorCandidate(katexRoot, element, leafMedianHeight))
          .filter((item) => item.rect)
          .sort((left, right) => (
            renderedLineBucket(left.rect, Math.max(1, leafMedianHeight * 1.35 || 18))
            - renderedLineBucket(right.rect, Math.max(1, leafMedianHeight * 1.35 || 18))
            || left.rect.left - right.rect.left
            || rectArea(left.rect) - rectArea(right.rect)
          ));
        const radicalElement = radicalCandidates[Math.min(Number(expectedOccurrence) || 0, radicalCandidates.length - 1)] || radicalCandidates[0];
        if (radicalElement) {
          annotateMeasuredElements([radicalElement.element], node.id);
          return {
            rects: filterLeafRects([radicalElement.rect], node, {
              medianLeafHeight: leafMedianHeight,
              containerRect: visualRect || rootRect,
            }),
            rectSource: "dom-leaf",
            elements: [radicalElement.element],
          };
        }
      }

      if (node.role === "operator" && (node.latex === "\\approx" || semanticText(node.latex) === "≈")) {
        const approxRect = elements
          .filter((item) => item.text === semanticText(node.latex) || item.text === "≈")
          .map((item) => item.rect)
          .filter(Boolean)
          .sort((left, right) => rectArea(left) - rectArea(right))[0];
        if (approxRect) {
          return {
            rects: filterLeafRects([approxRect], node, {
              medianLeafHeight: leafMedianHeight,
              containerRect: visualRect || rootRect,
            }),
            rectSource: "dom-leaf",
            elements: [],
          };
        }
      }

      const allocatedMatch = textMatchAllocationById.get(node.id) || null;
      const allocatedMatchKey = allocatedMatch ? textMatchKey(allocatedMatch) : null;
      const allowNumericSubstring = node.role === "coefficient" && /^-?\d+(?:\.\d+)?$/.test(targetText);
      const rawTextMatches = getTextRangeMatches(textIndex, targetText, null, { allowNumericSubstring });
      const textMatches = rawTextMatches
        .map((match) => ({
          ...match,
          matchKey: textMatchKey(match),
          rects: filterLeafRects([match.rect], node, {
            medianLeafHeight: leafMedianHeight,
            containerRect: visualRect || rootRect,
          }),
        }))
        .filter((match) => match.rects.length > 0)
        .filter((match) => !claimedTextMatchKeys.has(match.matchKey) || match.matchKey === allocatedMatchKey)
        .sort((left, right) => (
          Number(right.matchKey === allocatedMatchKey) - Number(left.matchKey === allocatedMatchKey)
          || Number(claimedTextMatchKeys.has(left.matchKey)) - Number(claimedTextMatchKeys.has(right.matchKey))
          || Math.abs(left.occurrenceIndex - expectedOccurrence) - Math.abs(right.occurrenceIndex - expectedOccurrence)
          || rectArea(left.rect) - rectArea(right.rect)
        ));

      if (textMatches[0]) {
        claimedTextMatchKeys.add(textMatches[0].matchKey);
        annotateMeasuredElements(textMatches[0].elements, node.id);
        return {
          rects: mergeNegativeNumberRects(textMatches[0].rects),
          rectSource: "dom-leaf",
          elements: textMatches[0].elements,
          domMatchCount: rawTextMatches.length,
          chosenDomKey: textMatches[0].matchKey,
          usedAllocatedMatch: textMatches[0].matchKey === allocatedMatchKey,
        };
      }

      const splitSignedFallback = findSplitSignedNumberFallback({
        target: node,
        targetText,
        textIndex,
        semanticNodes,
        measuredById,
        containerRect: visualRect || rootRect,
      });
      if (splitSignedFallback?.rect) {
        const rects = filterLeafRects([splitSignedFallback.rect], node, {
          medianLeafHeight: leafMedianHeight,
          containerRect: visualRect || rootRect,
        });
        if (rects.length > 0) {
          annotateMeasuredElements(splitSignedFallback.elements, node.id);
          return {
            rects,
            rectSource: "dom-leaf",
            elements: splitSignedFallback.elements,
            domMatchCount: splitSignedFallback.candidateCount,
            chosenDomKey: splitSignedFallback.key,
          };
        }
      }

      const splitNegativeNumber = measureSplitNegativeNumber();
      if (splitNegativeNumber?.rects?.length) {
        annotateMeasuredElements(splitNegativeNumber.elements, node.id);
        return {
          rects: splitNegativeNumber.rects,
          rectSource: "dom-leaf",
          elements: splitNegativeNumber.elements,
        };
      }

      const elementMatches = leafElements
        .filter((item) => item.text === targetText)
        .map((item) => ({
          ...item,
          rects: filterLeafRects(item.rects.length > 0 ? item.rects : [item.rect], node, {
            medianLeafHeight: leafMedianHeight,
            containerRect: visualRect || rootRect,
          }),
        }))
        .filter((item) => item.rects.length > 0)
        .sort((left, right) => rectArea(getMergedRect(left.rects)) - rectArea(getMergedRect(right.rects)));

      if (elementMatches[0]) {
        annotateMeasuredElements([elementMatches[0].element], node.id);
        return {
          rects: mergeNegativeNumberRects(elementMatches[0].rects),
          rectSource: "dom-leaf",
          elements: [elementMatches[0].element],
        };
      }
      const direct = nearestElementRect(node, visualRect || rootRect);
      if (direct) {
        return { rects: filterLeafRects([direct], node, {
          medianLeafHeight: leafMedianHeight,
          containerRect: visualRect || rootRect,
        }), rectSource: "dom-leaf", elements: [] };
      }

      return { rects: [], rectSource: "dom-leaf", elements: [] };
    };

    const nearestElementRect = (node, parentRect = null) => {
      const targetText = semanticText(node.latex || node.display || node.text);
      if (!targetText) return null;
      const textRangeRects = getTextRangeRects(textIndex, targetText, parentRect);
      if (textRangeRects.length > 0) {
        return textRangeRects
          .sort((left, right) => rectArea(left) - rectArea(right))[0];
      }
      const candidates = elements
        .filter((item) => {
          if (!item.text) return false;
          if (parentRect && !rectIntersects(item.rect, parentRect)) return false;
          if (node.role === "fraction" && /^\\frac/.test(node.latex || "")) {
            const requiredGlyphs = [...new Set(targetText.split(""))];
            return requiredGlyphs.every((glyph) => item.text.includes(glyph))
              && item.text.length <= targetText.length + 4;
          }
          return item.text === targetText || item.text.includes(targetText);
        })
        .map((item) => {
          const exact = item.text === targetText ? 0 : 1;
          const lengthPenalty = Math.abs(item.text.length - targetText.length);
          return { ...item, score: exact * 1000 + lengthPenalty * 10 + rectArea(item.rect) / 1000 };
        })
        .sort((left, right) => left.score - right.score || rectArea(left.rect) - rectArea(right.rect));
      return candidates[0]?.rect || null;
    };

    const estimateGroupRect = (node) => {
      const childRects = safeList(node.childIds)
        .flatMap((childId) => measuredById.get(childId)?.rects || [])
        .filter(Boolean);
      const childUnion = getMergedRect(childRects);
      if (childUnion) return { rects: [childUnion], rectSource: "child-union" };

      const parent = node.parentId ? measuredById.get(node.parentId) : null;
      const parentRect = getMergedRect(parent?.rects || []) || (!node.parentId ? visualRect : null);
      if (parentRect && node.parentRole === "fraction") {
        const verticalIndex = node.role === "denominator" ? 1 : 0;
        const split = splitRectVertically(parentRect, 2, verticalIndex);
        return { rects: split ? [split] : [], rectSource: "fallback" };
      }

      if (parentRect && node.role === "coefficient" && /^(\d+(?:\.\d+)?)\\(?:int|iint|iiint|oint)(?=_|\^|\{|\\|\(|$|\s)/.test(semanticNodeById.get(node.parentId)?.latex || "")) {
        return { rects: [normalizeSemanticRect({
          left: parentRect.left,
          right: parentRect.left + Math.max(8, Math.min(parentRect.width * 0.18, 18)),
          top: parentRect.top,
          bottom: parentRect.bottom,
        })].filter(Boolean), rectSource: "fallback" };
      }

      if ((parentRect || visualRect) && node.role === "differential") {
        const scopeRect = visualRect || parentRect;
        const directDifferential = elements
          .filter((item) => item.text.includes(semanticText(node.latex)) && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (directDifferential) return { rects: [directDifferential], rectSource: "fallback" };
        const dRect = elements
          .filter((item) => item.text === "d" && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (dRect) {
          return { rects: [normalizeSemanticRect({
            left: dRect.left,
            right: Math.min(scopeRect.right, dRect.right + Math.max(14, dRect.width * 2.6)),
            top: dRect.top,
            bottom: dRect.bottom,
          })].filter(Boolean), rectSource: "fallback" };
        }
        const variableText = semanticText(String(node.latex || "").replace(/^d/, ""));
        const variableRect = elements
          .filter((item) => item.text === variableText && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (variableRect) {
          return { rects: [normalizeSemanticRect({
            left: Math.max(scopeRect.left, variableRect.left - Math.max(10, variableRect.width * 1.2)),
            right: variableRect.right,
            top: variableRect.top,
            bottom: variableRect.bottom,
          })].filter(Boolean), rectSource: "fallback" };
        }
      }

      if (parentRect && node.role === "functionName") {
        const functionRect = elements
          .filter((item) => item.text.includes(semanticText(node.latex)) && rectIntersects(item.rect, visualRect || parentRect))
          .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0]?.rect;
        if (functionRect) return { rects: [functionRect], rectSource: "dom-leaf" };
      }

      if (
        parentRect
        && ["variable", "constant", "coefficient", "operator"].includes(node.role)
        && (node.parentRole === "argument" || semanticNodeById.get(node.parentId)?.role === "argument")
      ) {
        const argumentRect = elements
          .filter((item) => item.text === semanticText(node.latex) && rectIntersects(item.rect, visualRect || parentRect))
          .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0]?.rect;
        if (argumentRect) return { rects: [argumentRect], rectSource: "dom-leaf" };
      }

      const direct = nearestElementRect(node, parentRect);
      if (direct) return { rects: [direct], rectSource: "fallback" };

      if (parentRect && node.role === "exponent") {
        return { rects: [normalizeSemanticRect({
          left: parentRect.left + parentRect.width * 0.48,
          right: parentRect.right,
          top: parentRect.top,
          bottom: parentRect.top + parentRect.height * 0.55,
        })].filter(Boolean), rectSource: "fallback" };
      }

      if (parentRect && node.role === "argument") {
        return { rects: [normalizeSemanticRect({
          left: parentRect.left + parentRect.width * 0.42,
          right: parentRect.right,
          top: parentRect.top,
          bottom: parentRect.bottom,
        })].filter(Boolean), rectSource: "fallback" };
      }

      if (parentRect && (node.role === "domain" || node.role === "bound")) {
        const isUpper = node.role === "bound";
        return { rects: [normalizeSemanticRect({
          left: parentRect.left,
          right: parentRect.left + Math.max(parentRect.width * 0.35, 18),
          top: isUpper ? parentRect.top : parentRect.top + parentRect.height * 0.5,
          bottom: isUpper ? parentRect.top + parentRect.height * 0.5 : parentRect.bottom,
        })].filter(Boolean), rectSource: "fallback" };
      }

      if (parentRect && node.siblingCount > 1 && node.siblingIndex >= 0) {
        const split = splitRectHorizontally(parentRect, node.siblingCount, node.siblingIndex);
        return { rects: split ? [split] : [], rectSource: "fallback" };
      }

      return { rects: [], rectSource: "fallback" };
    };

    const orderedNodes = [
      ...leafNodes,
      ...semanticNodes
        .filter((node) => !isLeafSemanticTarget(node))
        .sort((left, right) => Number(right.depth || 0) - Number(left.depth || 0)),
    ];

    const measuredTargetsAll = orderedNodes.map((node) => {
      const measurement = isLeafSemanticTarget(node)
        ? measureLeafRect(node)
        : estimateGroupRect(node);
      const finalRects = mergeToSingleRect(measurement.rects || []);
      const finalMeasurement = {
        ...measurement,
        rects: finalRects,
        noGeometryReason: finalRects.length ? null : measurement.noGeometryReason,
      };
      const measured = {
        ...semanticNodeById.get(node.id),
        depth: node.depth,
        rects: finalRects,
        rectSource: finalMeasurement.rectSource,
        hitboxRole: measurement.hitboxRole || null,
        domMatchCount: measurement.domMatchCount ?? 0,
        chosenDomKey: measurement.chosenDomKey || null,
        usedAllocatedMatch: Boolean(measurement.usedAllocatedMatch),
        clientRectCount: measurement.rawRectCount ?? safeList(measurement.rects).length,
      };
      measuredById.set(node.id, measured);
      recordMeasurementDiagnostic(node, finalMeasurement);
      return measured;
    });
    patchMissingSharedMinusTargets({
      targets: measuredTargetsAll,
      semanticNodes,
      measuredById,
      rectSource: "dom-leaf",
    });

    const findSmallestMeasuredAncestor = (node) => {
      const ancestors = [];
      let current = node?.parentId ? semanticNodeById.get(node.parentId) : null;
      while (current) {
        const measured = measuredById.get(current.id);
        const rect = unionSemanticRects(measured?.rects || []);
        const role = measured?.role || measured?.kind || measured?.type || "";
        if (rect && measured?.parentId && role !== "equation" && role !== "expression") {
          ancestors.push({ measured, rect });
        }
        current = current.parentId ? semanticNodeById.get(current.parentId) : null;
      }
      return ancestors.sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0] || null;
    };

    for (const leaf of leafNodes) {
      const measured = measuredById.get(leaf.id);
      if (measured?.rects?.length) continue;
      const leafLatex = String(leaf.latex || leaf.display || leaf.text || "").trim();
      const leafRole = leaf.role || leaf.kind || leaf.type || "";
      if (leafRole === "operator" && /^(?:\^|_|\/)$/.test(leafLatex)) {
        recordMeasurementDiagnostic(leaf, measured || {}, {
          noGeometryReason: "non-rendered-syntax-operator",
        });
        continue;
      }
      const ancestor = findSmallestMeasuredAncestor(semanticNodeById.get(leaf.id) || leaf);
      if (!ancestor?.rect) continue;
      const fallbackRect = compactLeafFallbackRect(semanticNodeById.get(leaf.id) || leaf, ancestor.rect, visualRect || rootRect, leafMedianHeight);
      if (!fallbackRect) continue;
      const patched = {
        ...measured,
        rects: [fallbackRect],
        rectSource: "ancestor-fallback",
        ancestorFallbackId: ancestor.measured.id,
      };
      measuredById.set(leaf.id, patched);
      const index = measuredTargetsAll.findIndex((target) => target.id === leaf.id);
      if (index >= 0) measuredTargetsAll[index] = patched;
      recordMeasurementDiagnostic(leaf, {
        rects: [fallbackRect],
        rectSource: "ancestor-fallback",
        elements: [],
        domMatchCount: measured?.domMatchCount ?? 0,
        chosenDomKey: measured?.chosenDomKey || null,
      }, {
        ancestorFallbackId: ancestor.measured.id,
        noGeometryReason: null,
      });
    }
    refineMeasuredDifferentialHighlights({
      targets: measuredTargetsAll,
      measuredById,
      semanticNodeById,
      textIndex,
      containerRect: visualRect || rootRect,
    });
    const measuredTargets = measuredTargetsAll
      .filter((target) => target.rects.length > 0)
      .map((target) => (
        isAggregateHoverTarget(target)
          ? { ...target, isAggregateTarget: true, aggregate: true, leaf: false }
          : target
      ))
      .map((target) => attachMeasurementRoot(target, rootRect));

    const parentTarget = {
      ...safeChunk,
      depth: 0,
      rects: [visualRect || rootRect].filter(Boolean),
      rectSource: "chunk-visual-root",
    };
    const rawSnapshotTargets = [...measuredTargets, attachMeasurementRoot(parentTarget, rootRect)];
    const provisionalSnapshotTargets = rawSnapshotTargets
      .map((target) => prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id));
    const provisionalAcceptedTargets = provisionalSnapshotTargets.filter((target) => target.geometryValid);
    const snapshotRejectedTargets = [
      ...provisionalSnapshotTargets.filter((target) => !target.geometryValid),
      ...measuredTargetsAll
        .filter((target) => !measuredTargets.some((measured) => measured.id === target.id))
        .map((target) => prepareSnapshotTarget(target, rootRect, semanticNodeById, safeChunk.id)),
    ];
    const targets = provisionalAcceptedTargets.filter((target) => target.id !== safeChunk.id);
    const selectableTargets = dedupeOverlayTargets(targets.filter(isSelectableLeafTarget));
    measuredTargetCleanupRef.current?.();
    measuredTargetCleanupRef.current = registerMeasuredTargets(stepId, selectableTargets, safeChunk.id);

    if (rootRect) {
      const debugOverlay = DEBUG_SEMANTIC_HITBOXES || settings?.interaction?.debugSemanticHitboxes;
      const uncoveredGlyphTargets = debugOverlay
        ? leafElements
          .filter((item) => !targets.some((target) => (
            isLeafSemanticTarget(target)
            && target.rects.some((rect) => rectIntersects(rect, item.rect))
          )))
          .map((item, index) => ({
            id: `${safeChunk.id}-uncovered-glyph-${index}`,
            latex: item.text || item.label,
            display: item.text || item.label,
            text: item.label || item.text,
            role: "uncoveredGlyph",
            rectSource: "missing-glyph",
            rects: [item.rect],
            isUncoveredGlyph: true,
          }))
        : [];

      const selectableTargetIds = new Set(selectableTargets.map((target) => target.id));
      const aggregateTargets = dedupeOverlayTargets(targets.filter((target) => (
        !selectableTargetIds.has(target.id)
        && isAggregateHoverTarget(target)
      )).map((target) => ({ ...target, isAggregateTarget: true, aggregate: true, leaf: false })));
      const aggregateTargetIds = new Set(aggregateTargets.map((target) => target.id));
      const passiveRadicalTargets = dedupeOverlayTargets(targets.filter((target) => (
        !selectableTargetIds.has(target.id)
        && !aggregateTargetIds.has(target.id)
        && isCompactRadicalParent(target)
      )));
      const passivePowerTargets = dedupeOverlayTargets(targets.filter((target) => (
        !selectableTargetIds.has(target.id)
        && !aggregateTargetIds.has(target.id)
        && isCompactPowerParent(target)
      )));
      const passiveFractionPartTargets = dedupeOverlayTargets(targets.filter((target) => (
        !selectableTargetIds.has(target.id)
        && !aggregateTargetIds.has(target.id)
        && isFractionPartGroupTarget(target)
      )));
      const passiveDifferentialTargets = dedupeOverlayTargets(targets.filter((target) => (
        !selectableTargetIds.has(target.id)
        && !aggregateTargetIds.has(target.id)
        && (target.role === "differential" || target.type === "differential" || target.kind === "differential")
      )));
      const passiveGroupTargetIds = new Set([
        ...aggregateTargets.map((target) => target.id),
        ...passiveRadicalTargets.map((target) => target.id),
        ...passivePowerTargets.map((target) => target.id),
        ...passiveFractionPartTargets.map((target) => target.id),
        ...passiveDifferentialTargets.map((target) => target.id),
      ]);
      const debugOnlyTargets = debugOverlay
        ? dedupeOverlayTargets(targets.filter((target) => !selectableTargetIds.has(target.id) && !passiveGroupTargetIds.has(target.id)))
        : [];
      const rejectedDebugTargets = debugOverlay
        ? dedupeOverlayTargets(snapshotRejectedTargets.filter((target) => safeList(target.rects).length > 0).map((target) => ({
          ...target,
          isRejectedGeometry: true,
        })))
        : [];
      const finalOverlayTargets = [
        ...selectableTargets,
        ...aggregateTargets,
        ...passiveRadicalTargets,
        ...passivePowerTargets,
        ...passiveFractionPartTargets,
        ...passiveDifferentialTargets,
        ...debugOnlyTargets,
        ...rejectedDebugTargets,
        ...uncoveredGlyphTargets,
      ];
      const snapshot = commitGeometrySnapshot({
        phase,
        rootRect,
        visualRect,
        targets: rawSnapshotTargets,
        overlayTargets: finalOverlayTargets,
        rejectedTargets: snapshotRejectedTargets,
      });
      const coverageAudit = buildSemanticCoverageAudit({
        chunkId: safeChunk.id,
        visibleLeaves: leafElements,
        semanticLeafTargets: snapshot.childTargets.filter(isLeafSemanticTarget),
        semanticTargets: snapshot.childTargets,
        overlayTargets: finalOverlayTargets,
        overlayRoot: tokenRef.current,
        visualRect,
        rootRect,
      });
      if (debugOverlay || DEBUG_MATH_HOVER_DIAGNOSTICS) {
        console.info("[omnimath:semantic-node-rects]", {
          phase,
          stepId,
          chunkId: safeChunk.id,
          nodes: measuredTargetsAll.map((target) => ({
            id: target.id,
            role: target.role || target.kind || target.type || "node",
            latex: target.latex || target.display || target.text || "",
            text: target.text || target.display || target.latex || "",
            rectCount: target.rects?.length || 0,
            rectSource: target.rectSource || "unmeasured",
          })),
        });
      }
      if (DEBUG_MATH_HOVER_DIAGNOSTICS) {
        const leafDiagnostics = buildSemanticLeafDiagnostics({
          semanticLeaves: leafNodes,
          measuredById,
          overlayTargets: finalOverlayTargets,
          selectionTargets: selectableTargets,
          overlayRoot: tokenRef.current,
          visualRect,
          rootRect,
          measurementDiagnosticsById,
        });
        const duplicateSemanticIds = duplicateEntries(leafNodes.map((leaf) => leaf.id));
        const duplicateDomBindings = duplicateEntries(leafDiagnostics.map((leaf) => leaf.chosenDomKey));
        const currentSnapshot = {
          phase,
          semanticLeafCount: leafNodes.length,
          measurableDomLeafCount: leafElements.length,
          validNonZeroBboxCount: leafDiagnostics.filter((leaf) => leaf.bboxMeasured && leaf.zeroSizeRectCount === 0).length,
          hitboxCount: finalOverlayTargets.filter((target) => !target.isUncoveredGlyph).length,
          selectionTargetCount: selectableTargets.length,
          missingLeafIds: leafDiagnostics.filter((leaf) => !leaf.hitboxCreated || !leaf.hoverable || !leaf.selectable).map((leaf) => leaf.id),
          hitboxLeafIds: finalOverlayTargets.filter((target) => !target.isUncoveredGlyph).map((target) => target.id),
        };
        const phaseComparison = compareDiagnosticPhase(hoverDiagnosticsRef.current, currentSnapshot);
        hoverDiagnosticsRef.current = currentSnapshot;
        console.info("[omnimath:semantic-hover]", {
          phase,
          stepId,
          chunkId: safeChunk.id,
          totalSemanticLeaves: currentSnapshot.semanticLeafCount,
          totalMeasurableDomLeaves: currentSnapshot.measurableDomLeafCount,
          validNonZeroBboxCount: currentSnapshot.validNonZeroBboxCount,
          totalHitboxesCreated: currentSnapshot.hitboxCount,
          selectionTargetCount: currentSnapshot.selectionTargetCount,
          missingLeafIds: currentSnapshot.missingLeafIds,
          newlyAddedLeafIdsSincePreviousPhase: phaseComparison.newlyAddedLeafIds,
          missingSincePreviousPhase: phaseComparison.missingSincePreviousPhase,
          missingHitboxes: leafDiagnostics.filter((leaf) => !leaf.hitboxCreated),
          duplicateSemanticIds,
          duplicateDomBindings,
          zeroSizeRects: leafDiagnostics.filter((leaf) => leaf.zeroSizeRectCount > 0),
          hiddenBehindParentOrOverlay: leafDiagnostics.filter((leaf) => leaf.coveringElement || leaf.missingReason === "pointer-events-disabled"),
          skippedByFirstMatchBehavior: leafDiagnostics.filter((leaf) => leaf.domMatchCount > 1 && !leaf.usedAllocatedMatch),
          excludedFromSelectionModel: leafDiagnostics.filter((leaf) => leaf.excludedFromSelection),
          coverage: coverageAudit,
          geometryPipeline: {
            phase,
            rootRect: rectSnapshot(rootRect),
            visualRect: rectSnapshot(visualRect),
            textIndexLength: textIndex.text.length,
            structuralCandidateCounts: Object.fromEntries(Object.entries(structuralIndex).map(([key, value]) => [key, safeList(value).length])),
          },
          leaves: leafDiagnostics,
          missingLeaves: leafDiagnostics.filter((leaf) => leaf.missingReason),
        });
      }

      const leafDiagnostics = buildSemanticLeafDiagnostics({
        semanticLeaves: leafNodes,
        measuredById,
        overlayTargets: finalOverlayTargets,
        selectionTargets: selectableTargets,
        overlayRoot: tokenRef.current,
        visualRect,
        rootRect,
        measurementDiagnosticsById,
      });
      const missingLeafHitboxes = leafDiagnostics
        .filter(isRenderedMeaningfulSemanticLeafDiagnostic)
        .filter((leaf) => !leaf.hitboxCreated || !leaf.bboxMeasured);
      const invalidHitboxes = finalOverlayTargets
        .filter((target) => !target.isUncoveredGlyph)
        .filter((target) => !safeList(target.rects).every((rect) => rectWithinRect(rect, visualRect || rootRect, 2)));
      console.info("[omnimath:math-pipeline]", {
        stage: "DOM measurement / hitbox generation",
        phase,
        stepId,
        chunkId: safeChunk.id,
        measurementRevision,
          stepIds: [stepId].filter(Boolean),
          semanticNodeCount: semanticNodes.length,
          leafTokenCount: leafNodes.length,
          annotatedTokenCount: parts.length,
          generatedHitboxCount: finalOverlayTargets.filter((target) => !target.isUncoveredGlyph).length,
          acceptedSemanticCandidateCount: snapshot.childTargets.length,
          rejectedSemanticCandidates: snapshot.rejectedTargets.map((target) => ({
            id: target.id,
            role: target.role || target.kind || target.type || "node",
            reasons: target.geometryRejectionReasons || [],
          })),
          duplicateFinalAnswerNodes: 0,
          skippedNodes: leafDiagnostics.filter((leaf) => leaf.missingReason),
          parserFailures: [],
        fallbackUsage: leafDiagnostics.filter((leaf) => /fallback/.test(String(leaf.rectSource))).map((leaf) => ({
          id: leaf.id,
          rectSource: leaf.rectSource,
        })),
        retries: 0,
        exceptions: [],
      });
      if (missingLeafHitboxes.length > 0) {
        logMathPipelineInvariant("semantic leaf missing hitbox", {
          phase,
          stepId,
          chunkId: safeChunk.id,
          missingLeafHitboxes,
          semanticLeafCount: leafNodes.length,
          hitboxCount: finalOverlayTargets.length,
        });
      }
      if (invalidHitboxes.length > 0) {
        logMathPipelineInvariant("hitbox outside equation container", {
          phase,
          stepId,
          chunkId: safeChunk.id,
          invalidHitboxes: invalidHitboxes.map((target) => ({
            id: target.id,
            latex: target.latex || target.display || target.text || "",
            rects: target.rects,
            rectSource: target.rectSource,
          })),
          visualRect,
          rootRect,
        });
      }

      if (DEBUG_HOVER_TARGETS && uncoveredGlyphTargets.length > 0) {
        console.warn("[omnimath:semantic-coverage]", {
          chunkId: safeChunk.id,
          uncoveredGlyphs: uncoveredGlyphTargets.map((target) => ({
            id: target.id,
            text: target.text,
            rect: target.rects[0],
          })),
        });
      }

      setOverlayTargets(finalOverlayTargets.map((target) => ({
        ...target,
        measurementRevision,
        isLeafTarget: isLeafSemanticTarget(target),
        rectSource: target.rectSource || "unknown",
        rects: target.rects.map((rect) => ({
          left: rect.left - rootRect.left,
          top: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
        })),
      })));
    }

    recordSemanticHoverPerf("geometryMeasurementComplete", {
      phase,
      stepId,
      chunkId: safeChunk.id,
      measurementRevision: measurementRevisionRef.current,
      elapsedMs: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - measurementStartedAt) * 100) / 100,
      targetCount: semanticTargetsRef.current.length,
      overlayTargetCount: targets.length,
      legacyFallbackUsed: true,
    });
    return semanticTargetsRef.current;
  }, [canonicalSemanticTree, commitGeometrySnapshot, registerMeasuredTargets, replaceGeometrySnapshot, safeChunk, semanticNodeById, semanticNodes, settings?.interaction?.debugSemanticHitboxes, stepId]);

  const resolvePointerToken = useCallback((event) => {
    const resolveStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    recordSemanticHoverPerf("pointerResolve", {
      stepId,
      chunkId: safeChunk.id,
      x: Math.round(Number(event?.clientX) || 0),
      y: Math.round(Number(event?.clientY) || 0),
      measurementRevision: measurementRevisionRef.current,
    });
    if (!event) return null;
    const snapshot = geometrySnapshotRef.current;
    const staleSnapshotReason = !snapshot?.valid
      ? snapshot?.reason || "semantic-hitboxes-not-ready"
      : snapshot.chunkId !== safeChunk.id
        ? "snapshot-owned-by-different-chunk"
        : snapshot.stepId !== stepId
          ? "snapshot-owned-by-different-step"
          : snapshot.renderRevision !== renderRevision
            ? "snapshot-render-revision-stale"
            : snapshot.domOwner !== tokenRef.current
              ? "snapshot-dom-owner-stale"
              : !tokenRef.current?.isConnected
                ? "snapshot-dom-detached"
                : !sameSnapshotScrollState(snapshot.scrollState, readSnapshotScrollState(tokenRef.current, mathVisualRef.current))
                  ? "snapshot-scroll-stale"
                  : snapshot.childTargets.length === 0
                    ? "no-child-targets"
                    : "";
    if (staleSnapshotReason) {
      logHoverTarget({
        pointer: { x: event.clientX, y: event.clientY },
        finalTarget: null,
        rejectedFallbackReason: staleSnapshotReason,
      });
      recordSemanticHoverPerf("pointerResolveComplete", {
        stepId,
        chunkId: safeChunk.id,
        elapsedMs: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - resolveStartedAt) * 100) / 100,
        candidateCount: 0,
        selectedId: null,
        reason: staleSnapshotReason,
        source: "cached-snapshot",
        layoutReadCount: 0,
      });
      return null;
    }
    const childTargets = snapshot.childTargets;
    const targetById = snapshot.targetById;
    const annotateResolvedTarget = (target, resolution = null) => {
      if (!target) return null;
      const ancestors = [];
      let parentId = target.parentId;
      const seen = new Set([target.id]);
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = targetById.get(parentId);
        if (!parent) break;
        ancestors.push({
          id: parent.id,
          semanticNodeId: parent.semanticNodeId || parent.id,
          type: parent.type || parent.kind || "",
          kind: parent.kind || parent.type || "",
          role: parent.role || "",
          source: parent.source || parent.latex || parent.display || parent.text || "",
          normalizedSource: parent.normalizedSource || parent.latex || parent.display || parent.text || "",
          sourceRange: parent.sourceRange || null,
          start: parent.start ?? parent.sourceRange?.start ?? null,
          end: parent.end ?? parent.sourceRange?.end ?? null,
        });
        parentId = parent.parentId;
      }
      return {
        ...target,
        isAggregateTarget: isAggregateHoverTarget(target),
        isLeafTarget: isLeafSemanticTarget(target),
        aggregate: isAggregateHoverTarget(target),
        leaf: isLeafSemanticTarget(target),
        resolutionReason: resolution?.reason || null,
        ancestors,
        semanticAncestors: ancestors,
        resolverDiagnostics: resolution
          ? {
              reason: resolution.reason,
              candidateScores: (resolution.candidateScores || []).slice(0, 12).map((candidate) => ({
                id: candidate.target?.id,
                role: candidate.role || candidate.target?.role || candidate.target?.kind || candidate.target?.type,
                type: candidate.target?.type || candidate.target?.kind,
                score: Number(candidate.score?.toFixed?.(3) ?? candidate.score),
                exact: candidate.exact,
                paintedExact: candidate.paintedExact,
                leaf: candidate.leaf,
                area: candidate.area,
                paintedDistance: candidate.paintedDistance,
                geometryQuality: candidate.geometryQuality,
                geometryQualityRank: candidate.geometryQualityRank,
                rejectionReason: candidate.rejectionReason || null,
                depth: candidate.target?.depth,
                rect: candidate.rect,
              })),
            }
          : null,
      };
    };
    const targetDebugPayload = (target, rect = null) => ({
      id: target?.id || null,
      semanticId: target?.semanticId || target?.semanticNodeId || target?.id || null,
      role: target?.role || target?.kind || target?.type || null,
      type: target?.type || target?.kind || null,
      selectedText: target?.latex || target?.display || target?.text || null,
      sourceRange: target?.sourceRange || null,
      rectSource: target?.rectSource || null,
      geometryQuality: target?.geometryQuality || null,
      paintedRects: safeList(target?.paintedRects).map(rectSnapshot).filter(Boolean),
      domBoundingRect: rect || target?.rects?.[0] || null,
      highlightRect: target?.rects?.[0] || null,
      explanationTarget: target?.id || null,
	      aggregate: target ? isAggregateHoverTarget(target) : false,
	      leaf: target ? isLeafSemanticTarget(target) : false,
	      resolutionReason: target?.resolutionReason || null,
	    });
    recordSemanticHoverCounter("pointerLayoutReadCount", 0, { reason: "cached-snapshot-resolution" });
    const containingCandidates = safeList(snapshot.rectEntries)
      .filter(({ rect }) => rectContainsPoint(rect, event.clientX, event.clientY) && rectArea(rect) > 0);
    const resolution = resolveSemanticTarget({
      pointer: { x: event.clientX, y: event.clientY },
      candidates: childTargets,
      currentTarget: null,
      interactionMode: "hover",
    });
    const hit = resolution.target;
    logHoverTarget({
      stepId,
      chunkId: safeChunk.id,
      pointer: { x: event.clientX, y: event.clientY },
      renderedLatex: safeChunk.display || safeChunk.latex || safeChunk.text || "",
      semanticSourceLatex: canonicalSemanticTree?.canonicalSource || semanticLatexInput || safeChunk.latex || "",
      selected: targetDebugPayload(hit, hit?.rects?.[0]),
      candidates: containingCandidates.map(({ target, rect }, index) => candidateDebugPayload(
        target,
        rect,
        { x: event.clientX, y: event.clientY },
        null,
        index
      )),
      chosenNodeId: hit?.id || null,
      winningNodeId: hit?.id || null,
      winningDepth: hit?.depth ?? null,
      chosenRole: hit?.role || hit?.kind || hit?.type || null,
      chosenBBox: hit?.rects?.[0] || null,
      chosenLatex: hit?.latex || hit?.display || hit?.text || null,
      chosenText: hit?.text || hit?.display || hit?.latex || null,
      winningCandidate: candidateDebugPayload(
        hit,
        hit?.rects?.[0],
        { x: event.clientX, y: event.clientY },
        resolution.candidateScores?.[0] || null,
        0
      ),
      finalTarget: hit?.id || null,
      finalExpressionForExplainToken: hit?.latex || hit?.display || hit?.text || null,
      resolverReason: resolution.reason,
      candidateScores: safeList(resolution.candidateScores).map((score, index) => candidateDebugPayload(
        score.target,
        score.rect,
        { x: event.clientX, y: event.clientY },
        score,
        index
      )),
      fallbackUsed: resolution.reason === "current-target-fallback",
      parentFallbackReason: hit ? null : (childTargets.length > 0 ? "no-precise-highlightable-target-under-pointer" : "no-child-targets"),
      rejectedFallbackReason: hit ? null : (childTargets.length > 0 ? "no-precise-highlightable-target-under-pointer" : "no-child-targets"),
      candidateRectCount: containingCandidates.length,
      winnerSelectionReason: resolution.reason,
    });
    const cleanedHit = hit ? cleanSemanticTarget(hit, targetById, null) : null;
    if (cleanedHit?.id && hit?.id && cleanedHit.id !== hit.id) {
      logHoverTarget({
        stepId,
        chunkId: safeChunk.id,
        pointer: { x: event.clientX, y: event.clientY },
        renderedLatex: safeChunk.display || safeChunk.latex || safeChunk.text || "",
        semanticSourceLatex: canonicalSemanticTree?.canonicalSource || semanticLatexInput || safeChunk.latex || "",
        selectedSemanticId: hit.id,
        attemptedReplacementId: cleanedHit.id,
        reason: "post-hit-cleanup-blocked",
      });
    }
    recordSemanticHoverPerf("pointerResolveComplete", {
      stepId,
      chunkId: safeChunk.id,
      elapsedMs: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - resolveStartedAt) * 100) / 100,
      candidateCount: childTargets.length,
      containingCandidateCount: containingCandidates.length,
      selectedId: hit?.id || null,
      reason: resolution.reason,
      source: "cached-snapshot",
      geometryRevision: snapshot.revision,
      layoutReadCount: 0,
    });
    return annotateResolvedTarget(hit, resolution);
  }, [canonicalSemanticTree?.canonicalSource, renderRevision, safeChunk, semanticLatexInput, stepId]);

  const resolvePointerTokenOrChunk = useCallback((event) => (
    resolvePointerToken(event) || safeChunk
  ), [resolvePointerToken, safeChunk]);

  const activateResolvedHoverTarget = useCallback((token, event, { move = true } = {}) => {
    if (!token) return false;
    const tokenEvent = token.rects?.[0]
      ? { clientX: event.clientX, clientY: event.clientY, anchorRect: token.rects[0] }
      : event;
    lastResolvedHoverIdRef.current = token.id;
    extendTokenSelection(token, stepId);
    handleChunkEnter(token, stepId, tokenEvent);
    if (move) {
      handleChunkMove(tokenEvent);
      lastMovedHoverIdRef.current = token.id;
    } else {
      lastMovedHoverIdRef.current = null;
    }
    return true;
  }, [extendTokenSelection, handleChunkEnter, handleChunkMove, stepId]);

  const schedulePointerResolveRetry = useCallback((event, reason = "snapshot-invalid") => {
    if (pointerResolveRetryFrameRef.current) return false;
    if (typeof requestAnimationFrame !== "function") return false;
    const pointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      target: tokenRef.current,
      currentTarget: tokenRef.current,
    };
    pointerResolveRetryFrameRef.current = requestAnimationFrame(() => {
      pointerResolveRetryFrameRef.current = 0;
      recordSemanticHoverPerf("pointerResolveRetry", {
        stepId,
        chunkId: safeChunk.id,
        reason,
        snapshotReason: geometrySnapshotRef.current?.reason || "",
        geometryRevision: geometrySnapshotRef.current?.revision || 0,
      });
      if (hasInteractiveTargets) {
        measureSemanticTargets(`pointer-resolve-retry:${reason}`);
      }
      const token = resolvePointerToken(pointer);
      if (token) {
        activateResolvedHoverTarget(token, pointer, { move: true });
      }
    });
    return true;
  }, [activateResolvedHoverTarget, hasInteractiveTargets, measureSemanticTargets, resolvePointerToken, safeChunk.id, stepId]);

  const handleClick = (event) => {
    event.stopPropagation();
    const token = hasInteractiveTargets ? resolvePointerToken(event) : resolvePointerTokenOrChunk(event);
    if (token) selectChunk(token, stepId);
  };

  useEffect(() => {
    if (hasInteractiveTargets) return undefined;
    const node = tokenRef.current;
    if (!node) return undefined;

    const handleNativeEnter = (event) => {
      node.dataset.hoverActive = "true";
      extendTokenSelection(safeChunk, stepId);
      handleChunkEnter(safeChunk, stepId, event);
    };

    const handleNativeMove = (event) => {
      const shouldActivate = node.dataset.hoverActive !== "true" || activeChunkId !== safeChunk.id;
      node.dataset.hoverActive = "true";
      if (shouldActivate) {
        handleChunkEnter(safeChunk, stepId, event);
      }
      handleChunkMove(event);
    };

    const handleNativeLeave = (event) => {
      node.dataset.hoverActive = "false";
      handleChunkLeave(event);
    };

    const handleDocumentMove = (event) => {
      if (node.dataset.hoverActive !== "true") return;
      const target = event.target;
      const isOverToken = typeof Node !== "undefined" && target instanceof Node && node.contains(target);
      const floatingElement = typeof Element !== "undefined" && target instanceof Element
        ? target.closest(".omni-floating-window, .omni-quick-tooltip")
        : null;
      if (isOverToken) return;
      if (floatingElement?.classList?.contains("omni-quick-tooltip") && pointerHasUnderlyingNode(event, node)) {
        handleNativeMove(event);
        return;
      }
      if (floatingElement) return;
      node.dataset.hoverActive = "false";
      handleChunkLeave(event);
    };

    node.addEventListener("mouseenter", handleNativeEnter);
    node.addEventListener("mousemove", handleNativeMove);
    node.addEventListener("mouseleave", handleNativeLeave);
    document.addEventListener("mousemove", handleDocumentMove, true);

    return () => {
      node.removeEventListener("mouseenter", handleNativeEnter);
      node.removeEventListener("mousemove", handleNativeMove);
      node.removeEventListener("mouseleave", handleNativeLeave);
      document.removeEventListener("mousemove", handleDocumentMove, true);
    };
  }, [activeChunkId, extendTokenSelection, safeChunk, handleChunkEnter, handleChunkLeave, handleChunkMove, hasInteractiveTargets, stepId]);

  useEffect(() => {
    if (!hasInteractiveTargets) return undefined;
    const node = tokenRef.current;
    if (!node) return undefined;

    const handleDocumentMove = (event) => {
      const target = event.target;
      const isOverToken = typeof Node !== "undefined" && target instanceof Node && node.contains(target);
      const floatingElement = typeof Element !== "undefined" && target instanceof Element
        ? target.closest(".omni-floating-window, .omni-quick-tooltip")
        : null;
      if (isOverToken) return;
      if (floatingElement?.classList?.contains("omni-quick-tooltip") && pointerHasUnderlyingNode(event, node)) {
        handleAnnotatedMoveRef.current(event);
        return;
      }
      if (floatingElement) return;
      lastResolvedHoverIdRef.current = null;
      handleChunkLeave(event);
    };

    document.addEventListener("mousemove", handleDocumentMove, true);
    return () => {
      document.removeEventListener("mousemove", handleDocumentMove, true);
    };
  }, [handleChunkLeave, hasInteractiveTargets]);

  const logReadinessSnapshot = useCallback((phase) => {
    if (!DEBUG_MATH_HOVER_DIAGNOSTICS) return;
    const snapshot = geometrySnapshotRef.current;
    const childTargets = snapshot?.childTargets || [];
    const hitboxIds = childTargets.map((target) => target.id).filter(Boolean);
    const selectableTargets = childTargets.filter(isSelectableLeafTarget);
    const currentSnapshot = {
      phase,
      semanticLeafCount: semanticNodes.filter(isLeafSemanticTarget).length,
      measurableDomLeafCount: childTargets.length,
      validNonZeroBboxCount: childTargets.filter((target) => (target.rects || []).some((rect) => rectArea(rect) > 0.25)).length,
      hitboxCount: snapshot?.overlayTargets?.length || childTargets.length,
      selectionTargetCount: selectableTargets.length,
      missingLeafIds: semanticNodes
        .filter(isLeafSemanticTarget)
        .map((leaf) => leaf.id)
        .filter((id) => !hitboxIds.includes(id)),
      hitboxLeafIds: hitboxIds,
    };
    const phaseComparison = compareDiagnosticPhase(hoverDiagnosticsRef.current, currentSnapshot);
    console.info("[omnimath:semantic-hover]", {
      phase,
      stepId,
      chunkId: safeChunk.id,
      totalSemanticLeaves: currentSnapshot.semanticLeafCount,
      totalMeasurableDomLeaves: currentSnapshot.measurableDomLeafCount,
      validNonZeroBboxCount: currentSnapshot.validNonZeroBboxCount,
      totalHitboxesCreated: currentSnapshot.hitboxCount,
      selectionTargetCount: currentSnapshot.selectionTargetCount,
      missingLeafIds: currentSnapshot.missingLeafIds,
      newlyAddedLeafIdsSincePreviousPhase: phaseComparison.newlyAddedLeafIds,
      missingSincePreviousPhase: phaseComparison.missingSincePreviousPhase,
      readOnlySnapshot: true,
    });
    hoverDiagnosticsRef.current = currentSnapshot;
  }, [safeChunk.id, semanticNodes, stepId]);

  const handleAnnotatedEnter = (event) => {
    if (!hoverPhaseLoggedRef.current) {
      hoverPhaseLoggedRef.current = true;
      logReadinessSnapshot("first-hover");
    }
    const token = resolvePointerToken(event);
    if (!token) {
      schedulePointerResolveRetry(event, "annotated-enter-no-target");
      clearHoverLens();
      return;
    }
    activateResolvedHoverTarget(token, event, { move: false });
  };

  const handleAnnotatedMove = (event) => {
    recordSemanticHoverPerf("annotatedMouseMove", {
      stepId,
      chunkId: safeChunk.id,
      measurementRevision: measurementRevisionRef.current,
    });
    if (!hoverPhaseLoggedRef.current) {
      hoverPhaseLoggedRef.current = true;
      logReadinessSnapshot("first-hover");
    }
    const token = resolvePointerToken(event);
    if (!token) {
      if (schedulePointerResolveRetry(event, "annotated-move-no-target")) return;
      if (lastResolvedHoverIdRef.current !== null) {
        lastResolvedHoverIdRef.current = null;
        lastMovedHoverIdRef.current = null;
        clearHoverLens();
      }
      return;
    }
    const sameResolvedTarget = activeChunkId === token.id
      && lastResolvedHoverIdRef.current === token.id
      && lastMovedHoverIdRef.current === token.id;
    if (!sameResolvedTarget) {
      activateResolvedHoverTarget(token, event, { move: true });
      return;
    }
    recordSemanticHoverPerf("sameTargetMoveSkipped", {
      stepId,
      chunkId: safeChunk.id,
      targetId: token.id,
      geometryRevision: geometrySnapshotRef.current?.revision || 0,
    });
  };
  handleAnnotatedMoveRef.current = handleAnnotatedMove;

  const handleAnnotatedLeave = (event) => {
    if (pointerResolveRetryFrameRef.current) {
      cancelAnimationFrame(pointerResolveRetryFrameRef.current);
      pointerResolveRetryFrameRef.current = 0;
    }
    lastResolvedHoverIdRef.current = null;
    lastMovedHoverIdRef.current = null;
    handleChunkLeave(event);
  };

  const handleFocus = (event) => {
    handleChunkEnter(safeChunk, stepId, event);
  };

  const handleBlur = (event) => {
    handleChunkLeave(event);
  };

  const handleAnnotatedMouseUp = (event) => {
    finishTokenSelection(event);
    if (!dragPhaseLoggedRef.current) {
      dragPhaseLoggedRef.current = true;
      requestAnimationFrame(() => logReadinessSnapshot("after-drag-selection"));
    }
  };

  useEffect(() => registerToken(safeChunk, stepId, safeChunk.id), [registerToken, safeChunk, stepId]);

  const debugSemanticHitboxes = DEBUG_SEMANTIC_HITBOXES || settings?.interaction?.debugSemanticHitboxes;

  useEffect(() => {
    if (!hasInteractiveTargets) return undefined;
    const cleanups = semanticNodes.map((node) => {
      const token = semanticNodeById.get(node.id);
      return token ? registerToken(token, stepId, safeChunk.id) : undefined;
    }).filter(Boolean);
    return () => cleanups.forEach((cleanup) => cleanup?.());
  }, [hasInteractiveTargets, registerToken, safeChunk.id, semanticNodeById, semanticNodes, stepId]);

  useLayoutEffect(() => {
    if (!hasInteractiveTargets) return undefined;
    let disposed = false;
    let scheduledFrame = 0;
    let pendingPhase = "";
    const clearFrames = () => {
      if (scheduledFrame) cancelAnimationFrame(scheduledFrame);
      scheduledFrame = 0;
      pendingPhase = "";
      measureFrameRef.current = 0;
    };
    const shouldIgnoreUnchangedInvalidation = (phase, signature) => {
      if (!signature) return false;
      const previousSignature = invalidationSignaturesRef.current[phase];
      invalidationSignaturesRef.current[phase] = signature;
      const unchanged = previousSignature === signature;
      if (unchanged) {
        recordSemanticHoverPerf("geometryInvalidationSkipped", {
          phase,
          stepId,
          chunkId: safeChunk.id,
          signature,
        });
      }
      return unchanged;
    };
    const scheduleMeasure = (phase = "scheduled", signature = "") => {
      if (disposed) return;
      if (shouldIgnoreUnchangedInvalidation(phase, signature)) return;
      pendingPhase = pendingPhase ? `${pendingPhase}+${phase}` : phase;
      const currentSnapshot = geometrySnapshotRef.current;
      if (currentSnapshot?.valid) {
        geometrySnapshotRef.current = {
          ...currentSnapshot,
          valid: false,
          reason: `invalidated:${phase}`,
        };
      }
      recordSemanticHoverPerf("geometryInvalidated", {
        phase,
        stepId,
        chunkId: safeChunk.id,
        coalesced: Boolean(scheduledFrame),
        previousRevision: measurementRevisionRef.current,
      });
      if (scheduledFrame) return;
      scheduledFrame = requestAnimationFrame(() => {
        const framePhase = pendingPhase || phase;
        scheduledFrame = 0;
        pendingPhase = "";
        measureFrameRef.current = 0;
        if (!disposed) measureSemanticTargets(framePhase);
      });
      measureFrameRef.current = scheduledFrame;
    };
    const windowResizeSignature = () => (
      typeof window === "undefined"
        ? ""
        : `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`
    );
    const scrollSignature = () => (
      typeof window === "undefined"
        ? ""
        : [
            window.scrollX,
            window.scrollY,
            tokenRef.current?.scrollLeft || 0,
            tokenRef.current?.scrollTop || 0,
            mathVisualRef.current?.scrollLeft || 0,
            mathVisualRef.current?.scrollTop || 0,
            ...scrollableAncestorsForSnapshot(tokenRef.current, mathVisualRef.current)
              .flatMap((element) => [element.scrollLeft || 0, element.scrollTop || 0]),
          ].join(":")
    );

    replaceGeometrySnapshot("render-commit");
    measuredTargetCleanupRef.current?.();
    measuredTargetCleanupRef.current = null;
    hoverDiagnosticsRef.current = null;
    hoverPhaseLoggedRef.current = false;
    dragPhaseLoggedRef.current = false;
    setOverlayTargets([]);

    measureSemanticTargets("layout-effect-commit");

    const resizeObserver = typeof ResizeObserver !== "undefined" && tokenRef.current
      ? new ResizeObserver((entries) => {
        const contentRect = entries[0]?.contentRect;
        const signature = contentRect
          ? `${Math.round(contentRect.width * 100) / 100}x${Math.round(contentRect.height * 100) / 100}`
          : "";
        scheduleMeasure("resize-observer", signature);
      })
      : null;
    resizeObserver?.observe(tokenRef.current);
    const mutationObserver = typeof MutationObserver !== "undefined" && mathVisualRef.current
      ? new MutationObserver(() => scheduleMeasure("katex-mutation"))
      : null;
    mutationObserver?.observe(mathVisualRef.current, { childList: true, subtree: true, characterData: true });
    const handleResize = () => scheduleMeasure("window-resize", windowResizeSignature());
    const handleScroll = () => scheduleMeasure("scroll", scrollSignature());
    const scrollAncestors = scrollableAncestorsForSnapshot(tokenRef.current, mathVisualRef.current);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    tokenRef.current?.addEventListener?.("scroll", handleScroll, true);
    mathVisualRef.current?.addEventListener?.("scroll", handleScroll, true);
    scrollAncestors.forEach((element) => element.addEventListener?.("scroll", handleScroll, true));
    document.fonts?.ready?.then(() => {
      scheduleMeasure("fonts-ready");
    }).catch(() => {});
    const diagnosticWindow = DEBUG_MATH_HOVER_PERF && typeof window !== "undefined"
      ? /** @type {any} */ (window)
      : null;
    const diagnosticStore = diagnosticWindow ? semanticHoverPerfStore() : null;
    if (diagnosticWindow) {
      diagnosticStore.invalidateSemanticGeometryByChunk = diagnosticStore.invalidateSemanticGeometryByChunk || {};
      diagnosticStore.invalidateSemanticGeometryByChunk[safeChunk.id] = (phase = "debug-invalidation") => {
        scheduleMeasure(phase);
      };
      diagnosticStore.invalidateSemanticGeometry = (phase = "debug-invalidation", chunkId = "") => {
        const registry = diagnosticStore.invalidateSemanticGeometryByChunk || {};
        const invalidate = chunkId ? registry[chunkId] : Object.values(registry)[0];
        if (typeof invalidate === "function") invalidate(phase);
      };
    }

    return () => {
      disposed = true;
      clearFrames();
      if (pointerResolveRetryFrameRef.current) {
        cancelAnimationFrame(pointerResolveRetryFrameRef.current);
        pointerResolveRetryFrameRef.current = 0;
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
      tokenRef.current?.removeEventListener?.("scroll", handleScroll, true);
      mathVisualRef.current?.removeEventListener?.("scroll", handleScroll, true);
      scrollAncestors.forEach((element) => element.removeEventListener?.("scroll", handleScroll, true));
      if (diagnosticStore?.invalidateSemanticGeometryByChunk) {
        delete diagnosticStore.invalidateSemanticGeometryByChunk[safeChunk.id];
        if (Object.keys(diagnosticStore.invalidateSemanticGeometryByChunk).length === 0) {
          delete diagnosticStore.invalidateSemanticGeometryByChunk;
          delete diagnosticStore.invalidateSemanticGeometry;
        }
      }
    };
  }, [hasInteractiveTargets, measureSemanticTargets, replaceGeometrySnapshot, safeChunk.id, stepId]);

  useEffect(() => () => {
    measuredTargetCleanupRef.current?.();
    measuredTargetCleanupRef.current = null;
  }, []);

  return (
    <span
      ref={tokenRef}
      data-explainable="true"
      data-inspectable="math-token"
      data-token-id={safeChunk.id}
      data-math-chunk-owner={safeChunk.id}
      data-token-latex={safeChunk.latex}
      data-token-role={safeChunk.role || (isOperator ? "operator" : "other")}
      data-hover-active="false"
      tabIndex={0}
      aria-label={accessibleTitle}
      onMouseEnter={hasInteractiveTargets ? handleAnnotatedEnter : undefined}
      onMouseMove={hasInteractiveTargets ? handleAnnotatedMove : undefined}
      onMouseLeave={hasInteractiveTargets ? handleAnnotatedLeave : undefined}
      onMouseDown={(event) => {
        const token = hasInteractiveTargets ? resolvePointerToken(event) : resolvePointerTokenOrChunk(event);
        if (token) beginTokenSelection(token, stepId, event);
      }}
      onMouseUp={handleAnnotatedMouseUp}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onContextMenu={(event) => {
        const token = hasInteractiveTargets ? resolvePointerToken(event) : resolvePointerTokenOrChunk(event);
        const tokenEvent = token?.rects?.[0]
          ? {
              clientX: event.clientX,
              clientY: event.clientY,
              anchorRect: token.rects[0],
              preventDefault: () => event.preventDefault(),
              stopPropagation: () => event.stopPropagation(),
              target: event.target,
              currentTarget: event.currentTarget,
            }
          : event;
        if (token) handleChunkRightClick(token, stepId, tokenEvent);
      }}
      onClick={handleClick}
      className={cn(
        "math-token explainable-token relative -mx-0.5 inline-block cursor-help select-none rounded-sm px-0.5 py-0 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45",
        hasInteractiveTargets && "math-token-group",
        deferToSubTokens && "math-token-defer-subtokens cursor-default",
        isOperator && "math-token-operator",
        isSelected && "omni-token-selected",
        isSiblingActive && !isPinned && !isConceptRelated && "opacity-45",
        (isConceptRelated || isExplicitlyRelated) && !isConceptActive && "omni-related-token"
      )}
      style={{
        transitionProperty: "opacity, background-color, transform, box-shadow, color",
        transform: isActive || isConceptActive || isPinned || hasWindow ? "translateY(-1px)" : "translateY(0)",
        ...(isActive || isConceptActive || isPinned || hasWindow
          ? {
              backgroundColor: "transparent",
              boxShadow: "none",
            }
          : {}),
      }}
    >
      <span
        ref={mathVisualRef}
        style={{
          color: mathColor,
          filter: isActive || isConceptActive || isPinned || hasWindow ? "drop-shadow(0 0 8px rgba(45, 212, 191, 0.38))" : "none",
          textDecorationLine: isActive || isConceptActive || isPinned || hasWindow ? "underline" : "none",
          textDecorationColor: "rgba(94, 234, 212, 0.55)",
          textUnderlineOffset: "0.18em",
        }}
        className={cn("katex-chunk math-visual-layer", hasInteractiveTargets && "annotated-katex-chunk")}
      >
        <InlineMath
          math={safeChunk.display}
          className="font-serif italic"
          semanticTree={canonicalSemanticTree}
          interactive={hasInteractiveTargets}
        />
      </span>
      {hasInteractiveTargets && (
        <span
          className={cn(
            "math-semantic-overlay-layer",
            debugSemanticHitboxes && "math-semantic-overlay-debug"
          )}
          aria-hidden="true"
        >
          {overlayTargets.flatMap((target) => target.rects.map((rect, rectIndex) => (
            <span
              key={`${target.id}-${rectIndex}`}
              className={cn(
                "math-semantic-hitbox",
                safeList(selectedTokenIds).includes(target.id) && "omni-token-selected"
              )}
              data-inspectable={
                !target.isRejectedGeometry
                && !isBoundInternalTarget(target, semanticNodeById)
                && (
                  target.isLeafTarget
                  || target.role === "differential"
                  || target.type === "differential"
                  || target.kind === "differential"
                )
                  ? "math-subtoken"
                  : "math-group"
              }
              data-explainable="true"
              data-token-id={target.id}
              data-token-latex={target.latex}
              data-semantic-id={target.semanticId || target.semanticNodeId || target.id}
              data-semantic-type={target.type || target.kind || target.role || "node"}
              data-source-range={target.sourceRange ? `${target.sourceRange.start}:${target.sourceRange.end}` : undefined}
              data-source-text={target.latex || target.display || target.text || ""}
              data-client-rect-count={target.clientRectCount ?? target.rects?.length ?? 0}
              data-union-rect={`${Math.round(rect.left * 100) / 100},${Math.round(rect.top * 100) / 100},${Math.round(rect.width * 100) / 100},${Math.round(rect.height * 100) / 100}`}
              data-token-depth={target.depth}
              data-token-role={target.hitboxRole || target.role || target.kind || "other"}
              data-target-kind={target.isRejectedGeometry ? "rejected" : target.isUncoveredGlyph ? "uncovered" : target.isLeafTarget ? "leaf" : "group"}
              data-coverage-state={target.isRejectedGeometry ? "rejected" : target.isUncoveredGlyph ? "missing" : target.isLeafTarget ? "covered" : "structural"}
              data-rect-source={target.rectSource || "unknown"}
              data-geometry-quality={target.geometryQuality || undefined}
              data-geometry-valid={target.isRejectedGeometry ? "false" : target.geometryValid === false ? "false" : "true"}
              data-rejection-reason={safeList(target.geometryRejectionReasons).join(",") || undefined}
              data-painted-area={target.paintedArea ?? undefined}
              data-measurement-revision={target.measurementRevision}
              data-ancestor-fallback-id={target.ancestorFallbackId || undefined}
              onMouseEnter={!target.isRejectedGeometry && !target.isUncoveredGlyph ? handleAnnotatedEnter : undefined}
              onMouseMove={!target.isRejectedGeometry && !target.isUncoveredGlyph ? handleAnnotatedMove : undefined}
              {...(debugSemanticHitboxes
                ? {
                    "data-debug-label": `${target.id} | ${target.latex || target.display || target.text || ""} | ${target.role || target.kind || target.type || "node"} | ${target.rectSource || "unknown"}`,
                  }
                : {})}
              data-active-target={activeChunkId === target.id ? "true" : undefined}
              style={{
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                zIndex: target.depth + 1,
              }}
            >
              {debugSemanticHitboxes && (
                  <span className="math-semantic-hitbox-label">
                  {`${target.semanticId || target.semanticNodeId || target.id} | ${target.latex || target.display || target.text || ""} | ${target.role || target.kind || target.type || "node"} | ${target.sourceRange ? `${target.sourceRange.start}:${target.sourceRange.end}` : "no-range"} | ${target.rectSource || "unknown"} | ${Math.round(rect.width * 10) / 10}x${Math.round(rect.height * 10) / 10}`}
                </span>
              )}
            </span>
          )))}
          {debugSemanticHitboxes && activeChunkId && (
            <span className="math-semantic-active-label">
              {`${activeChunkId}${activeChunkData?.sourceRange ? ` | ${activeChunkData.sourceRange.start}:${activeChunkData.sourceRange.end}` : ""}${activeChunkData?.sourceText ? ` | ${activeChunkData.sourceText}` : ""}`}
            </span>
          )}
        </span>
      )}
      {(isPinned || hasWindow) && (
        <span
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-teal-200 shadow-[0_0_10px_rgba(94,234,212,0.8)]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function ExplainableToken(props) {
  return <MathChunk {...props} />;
}

export default MathChunk;
