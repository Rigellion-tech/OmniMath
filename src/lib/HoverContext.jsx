import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { getConceptById, getConceptForChunk, getConceptsForStep, getRelatedConceptIds } from "@/data/conceptGraph";
import {
  DEFAULT_FLOATING_LENS_SIZE,
  DEFAULT_QUICK_TOOLTIP_SIZE,
  clampTooltipPosition,
  getRectSnapshot,
  getTooltipPositionFromRect,
} from "@/lib/tooltipPosition";
import { userFacingText, userFacingTooltipTitle } from "@/lib/presentationLabels";
import { assertSemanticIdentityConsistency, createSemanticIdentity } from "@/lib/hoverTargetIdentity";
import {
  getTargetsIntersectingRect,
  rectIntersectsRect,
  reconstructTextFromTargets,
  sortTargetsByRenderedOrder,
  unionSemanticRects,
} from "@/lib/semanticHitboxes";

const HoverContext = createContext(null);

// difficultyMode: "beginner" | "intermediate" | "advanced" | "exam" | "intuition" | "professor"
const DIFFICULTY_MAX_LEVEL = { beginner: 1, intermediate: 2, advanced: 3, exam: 1, intuition: 2, professor: 3 };
const WINDOW_SIZE = DEFAULT_FLOATING_LENS_SIZE;
const HOVER_DELAY_MS = 125;
const HOVER_CLEAR_DELAY_MS = 140;
const DEBUG_MATH_HOVER = import.meta.env.DEV
  && (
    import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
    || import.meta.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true"
    || import.meta.env.VITE_DEBUG_MATH_HITBOXES === "true"
  );

function normalizeDragRect(start, end) {
  if (!start || !end) return null;
  let left = Math.min(start.x, end.x);
  let right = Math.max(start.x, end.x);
  let top = Math.min(start.y, end.y);
  let bottom = Math.max(start.y, end.y);
  const minSize = 8;
  if (right - left < minSize) {
    const center = (left + right) / 2;
    left = center - minSize / 2;
    right = center + minSize / 2;
  }
  if (bottom - top < minSize) {
    const center = (top + bottom) / 2;
    top = center - minSize / 2;
    bottom = center + minSize / 2;
  }
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function logSemanticSelection(settings, event, details = {}) {
  if (!DEBUG_MATH_HOVER && !settings?.interaction?.debugSemanticHitboxes) return;
  console.info("[omnimath:semantic-selection]", {
    event,
    ...details,
  });
}

function tokenOrder(token = {}) {
  const order = Number(token.order ?? token.leafStart);
  return Number.isFinite(order) ? order : null;
}

function createSemanticRangeFromTokens({
  stepId,
  selectedTokens = [],
  tokenRegistry = [],
  anchorId = null,
  focusId = null,
  selectedText = "",
  source = "range",
  rect = null,
}) {
  const orderedLeaves = selectedTokens
    .filter((token) => token?.id)
    .map((token) => ({ token, order: tokenOrder(token) }))
    .filter((item) => Number.isFinite(item.order))
    .sort((left, right) => left.order - right.order);

  if (orderedLeaves.length === 0) return null;

  const startOrder = orderedLeaves[0].order;
  const endOrder = orderedLeaves.at(-1).order;
  const normalizedNode = tokenRegistry
    .filter((token) => (
      Number(token.leafStart) === startOrder
      && Number(token.leafEnd) === endOrder
    ))
    .sort((left, right) => Number(right.depth || 0) - Number(left.depth || 0))[0] || null;
  const leafIds = orderedLeaves.map((item) => item.token.id);

  return {
    id: `sel-${stepId}-${source}-${startOrder}-${endOrder}`,
    stepId,
    kind: normalizedNode ? "semantic" : "range",
    source,
    nodeIds: normalizedNode ? [normalizedNode.id] : leafIds,
    leafIds,
    anchorId: anchorId || leafIds[0] || null,
    focusId: focusId || leafIds.at(-1) || null,
    normalizedToNodeId: normalizedNode?.id || null,
    selectedText: normalizedNode?.display || normalizedNode?.latex || selectedText,
    sourceRange: normalizedNode?.sourceRange || null,
    range: {
      startOrder,
      endOrder,
      leafIds,
    },
    rect,
  };
}

function clampPosition(x, y, size = WINDOW_SIZE, padding = 12) {
  return clampTooltipPosition(x, y, size, null, padding);
}

function getEventAnchor(event) {
  const eventElement = event?.currentTarget instanceof Element
    ? event.currentTarget
    : event?.target instanceof Element
      ? event.target.closest("[data-explainable='true']")
      : null;
  const element = eventElement?.closest?.("[data-inspectable='math-token']") || eventElement;
  const rect = element?.getBoundingClientRect?.();
  return {
    element,
    rect: getRectSnapshot(rect),
  };
}

function getEventPosition(event, index = 0, size = WINDOW_SIZE) {
  const anchor = event?.anchorRect ? { rect: event.anchorRect } : getEventAnchor(event);
  if (anchor.rect) {
    return getTooltipPositionFromRect(anchor.rect, { index, size });
  }

  const baseX = event?.clientX ?? (typeof window !== "undefined" ? window.innerWidth / 2 : 240);
  const baseY = event?.clientY ?? (typeof window !== "undefined" ? window.innerHeight / 2 : 180);
  const offset = (index % 6) * 18;
  const canOpenRight = typeof window === "undefined" || baseX + size.width + 28 < window.innerWidth;
  const canOpenBelow = typeof window === "undefined" || baseY + size.height + 28 < window.innerHeight;
  const x = canOpenRight ? baseX + 20 + offset : baseX - size.width - 18 - offset;
  const y = canOpenBelow ? baseY + 18 + offset : baseY - Math.min(size.height, 180) - 18 - offset;
  return clampPosition(x, y, size);
}

function samePointer(left = null, right = null) {
  return Boolean(left && right) && left.x === right.x && left.y === right.y;
}

function sameRect(left = null, right = null) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height;
}

function emptySelectionState() {
  return {
    isSelecting: false,
    selectionStartTokenId: null,
    selectionEndTokenId: null,
    selectedTokenIds: [],
    selectedText: "",
    selectedStepId: null,
    selectionMode: null,
    selectionRect: null,
    dragStartPoint: null,
    dragCurrentPoint: null,
    fallbackToken: null,
    semanticSelection: null,
    selectedSemanticRange: null,
    activeSelection: null,
  };
}

function getHoverDelay(settings) {
  const configured = Number(settings?.interaction?.hoverDelay);
  if (!Number.isFinite(configured)) return HOVER_DELAY_MS;
  return Math.max(100, Math.min(150, configured));
}

function countActiveTimers(timerRefs = {}) {
  return Object.values(timerRefs).filter(Boolean).length;
}

function countRegisteredTokens(registry = new Map()) {
  return [...registry.values()].reduce((total, tokens) => total + tokens.length, 0);
}

function countRegisteredMeasuredTargets(registry = new Map()) {
  return [...registry.values()].reduce((total, targets) => total + targets.size, 0);
}

function countRegisteredChunkOwners(registry = new Map()) {
  const owners = new Set();
  for (const tokens of registry.values()) {
    for (const token of tokens) {
      if (token.ownerId) owners.add(token.ownerId);
    }
  }
  return owners.size;
}

function selectionRectKey(rect = {}) {
  return [
    Math.round(Number(rect.left || 0) * 10),
    Math.round(Number(rect.top || 0) * 10),
    Math.round(Number(rect.width || 0) * 10),
    Math.round(Number(rect.height || 0) * 10),
  ].join(":");
}

function createChunkWindow(chunk, stepId, event, pinned, index, defaultDepth = "intermediate") {
  const anchor = event?.anchorRect ? { element: null, rect: event.anchorRect } : getEventAnchor(event);
  const position = getEventPosition(
    anchor.rect ? { anchorRect: anchor.rect } : event,
    index,
    pinned ? WINDOW_SIZE : DEFAULT_QUICK_TOOLTIP_SIZE
  );
  const concept = getConceptForChunk(chunk);
  const title = userFacingTooltipTitle({
    title: chunk.short,
    selectedText: chunk.display || chunk.text || chunk.latex,
    display: chunk.display,
    latex: chunk.latex,
    role: chunk.role,
  });
  const medium = userFacingText(chunk.medium, title);
  const deep = userFacingText(chunk.deep, medium);
  const semanticIdentity = createSemanticIdentity({
    ...chunk,
    stepId,
    title,
    selectedText: chunk.display || chunk.text || chunk.latex || "",
  });
  assertSemanticIdentityConsistency("tooltip-window", chunk.semanticIdentity || semanticIdentity, semanticIdentity, {
    stepId,
    chunkId: chunk.id,
  });

  return {
    id: `chunk-${chunk.id}-${Date.now()}-${index}`,
    referenceId: chunk.id,
    referenceType: "token",
    conceptId: concept?.id || null,
    stepId,
    x: position.x,
    y: position.y,
    anchor: anchor.rect,
    pinned,
    depth: defaultDepth,
    title,
    semanticIdentity,
    semanticId: semanticIdentity.semanticId,
    semanticType: semanticIdentity.semanticType || semanticIdentity.role,
    sourceRange: semanticIdentity.sourceRange,
    sourceText: semanticIdentity.sourceText,
    display: chunk.display,
    selectedText: chunk.display || chunk.text || "",
    selectedTokens: [chunk],
    context: chunk.context || null,
    content: {
      beginner: userFacingText(chunk.short, title),
      intermediate: medium,
      advanced: deep,
      exam: userFacingText(concept?.lensContent?.exam, title),
      intuition: userFacingText(concept?.lensContent?.intuition, medium),
      professor: userFacingText(concept?.lensContent?.professor, deep),
    },
  };
}

function createSelectionWindow(selection, event, pinned, index, defaultDepth = "intermediate") {
  const anchor = event?.anchorRect ? { element: null, rect: event.anchorRect } : getEventAnchor(event);
  const position = getEventPosition(
    anchor.rect ? { anchorRect: anchor.rect } : event,
    index,
    pinned ? WINDOW_SIZE : DEFAULT_QUICK_TOOLTIP_SIZE
  );
  const selectedText = selection.selectedText || selection.tokens.map((token) => token.display || token.text || "").join(" ");
  const semanticIdentity = createSemanticIdentity({
    id: selection.id,
    referenceId: selection.id,
    referenceType: "selection",
    stepId: selection.stepId,
    title: "Selected region",
    selectedText,
    display: selectedText,
    selectedTokens: selection.tokens,
    semanticSelection: selection.semanticSelection || null,
    context: selection.context || null,
  });

  return {
    id: `selection-${selection.stepId}-${Date.now()}-${index}`,
    referenceId: selection.id,
    referenceType: "selection",
    conceptId: null,
    stepId: selection.stepId,
    stepTitle: selection.stepTitle,
    x: position.x,
    y: position.y,
    anchor: anchor.rect,
    pinned,
    depth: defaultDepth,
    title: "Selected region",
    semanticIdentity,
    semanticId: semanticIdentity.semanticId,
    semanticType: semanticIdentity.semanticType || semanticIdentity.role,
    sourceRange: semanticIdentity.sourceRange,
    sourceText: semanticIdentity.sourceText,
    display: selectedText,
    selectedText,
    selectedTokenIds: selection.tokenIds,
    selectedTokens: selection.tokens,
    semanticSelection: selection.semanticSelection || null,
    selectedSemanticRange: selection.semanticSelection || null,
    context: selection.context || null,
    content: {
      beginner: `This selection combines ${selection.tokens.length} inspectable parts from the step.`,
      intermediate: selection.tokens.map((token) => token.medium || token.short).filter(Boolean).join(" "),
      advanced: selection.tokens.map((token) => token.deep || token.medium || token.short).filter(Boolean).join(" "),
      exam: "Treat the highlighted selection as one mathematical region in this step.",
      intuition: "Read the highlighted tokens together; their meaning comes from how they interact in the expression.",
      professor: selection.tokens.map((token) => token.deep || token.medium || token.short).filter(Boolean).join(" "),
    },
  };
}

function createStepWindow(step, event, pinned, index, defaultDepth = "intermediate") {
  const anchor = event?.anchorRect ? { element: null, rect: event.anchorRect } : getEventAnchor(event);
  const position = getEventPosition(
    anchor.rect ? { anchorRect: anchor.rect } : event,
    index,
    pinned ? WINDOW_SIZE : DEFAULT_QUICK_TOOLTIP_SIZE
  );
  const stepConcepts = getConceptsForStep(step);
  const primaryConcept = stepConcepts[0] || null;
  const chunkSummary = step.chunks
    ?.slice(0, 4)
    .map((chunk) => chunk.deep)
    .filter(Boolean)
    .join(" ");

  return {
    id: `step-${step.id}-${Date.now()}-${index}`,
    referenceId: step.id,
    referenceType: "step",
    conceptId: primaryConcept?.id || null,
    conceptIds: stepConcepts.map((concept) => concept.id),
    stepId: step.id,
    x: position.x,
    y: position.y,
    anchor: anchor.rect,
    pinned,
    depth: defaultDepth,
    title: userFacingTooltipTitle({
      title: step.label || step.title,
      selectedText: step.math,
      display: step.math,
      fallback: "Solution Step",
    }),
    display: step.math,
    selectedText: step.math || step.label || "",
    selectedTokens: [],
    context: {
      stepId: step.id,
      stepTitle: step.label || step.title || "",
      currentStep: step,
    },
    content: {
      beginner: step.summary || step.label,
      intermediate: step.summary || chunkSummary || step.label,
      advanced: chunkSummary || step.summary || step.label,
      exam: step.summary || primaryConcept?.lensContent?.exam || step.label,
      intuition: primaryConcept?.lensContent?.intuition || step.summary || step.label,
      professor: chunkSummary || primaryConcept?.lensContent?.professor || step.summary || step.label,
    },
  };
}

function createConceptWindow(conceptId, event, pinned, index, defaultDepth = "intermediate") {
  const concept = getConceptById(conceptId);
  const anchor = event?.anchorRect ? { element: null, rect: event.anchorRect } : getEventAnchor(event);
  const size = pinned ? { width: 300, height: 180 } : DEFAULT_QUICK_TOOLTIP_SIZE;
  const position = getEventPosition(anchor.rect ? { anchorRect: anchor.rect } : event, index, size);

  return {
    id: `concept-${conceptId}-${Date.now()}-${index}`,
    referenceId: conceptId,
    referenceType: "concept",
    conceptId,
    x: position.x,
    y: position.y,
    anchor: anchor.rect,
    pinned,
    depth: defaultDepth,
    title: userFacingTooltipTitle({
      title: concept?.label,
      selectedText: concept?.shortLabel || concept?.label,
      fallback: "Related Concept",
    }),
    display: null,
    content: {
      beginner: concept?.lensContent?.exam || concept?.shortLabel || concept?.label,
      intermediate: concept?.lensContent?.intuition || concept?.lensContent?.exam || concept?.label,
      advanced: concept?.lensContent?.professor || concept?.lensContent?.intuition || concept?.label,
      exam: concept?.lensContent?.exam || concept?.label,
      intuition: concept?.lensContent?.intuition || concept?.label,
      professor: concept?.lensContent?.professor || concept?.label,
    },
  };
}

function samePinnedReference(window, referenceType, referenceId, stepId = null) {
  return window?.pinned
    && window.referenceType === referenceType
    && window.referenceId === referenceId
    && (stepId === null || window.stepId === stepId);
}

function isEditableTarget(target) {
  return target?.isContentEditable
    || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
}

function tokenIdFromEventTarget(event) {
  const target = event?.target;
  if (target instanceof Element) {
    const directId = target.closest("[data-token-id]")?.getAttribute("data-token-id");
    if (directId) return directId;
  }
  if (typeof document === "undefined" || typeof document.elementsFromPoint !== "function") return null;
  const x = Number(event?.clientX);
  const y = Number(event?.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return document.elementsFromPoint(x, y)
    .map((element) => element.closest?.(".math-semantic-hitbox[data-token-id]"))
    .find(Boolean)
    ?.getAttribute("data-token-id") || null;
}

export function HoverProvider({ children, initialWindows = [], onWindowsChange, settings, problem }) {
  const normalizedInitialWindows = initialWindows.map((window) => ({ ...window, pinned: true }));
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [activeChunkData, setActiveChunkData] = useState(null);
  const [activePointer, setActivePointer] = useState(null);
  const [explanationLevel, setExplanationLevel] = useState(0);
  const [activeStepId, setActiveStepId] = useState(null);
  const [activeConceptId, setActiveConceptId] = useState(null);
  const [selectedChunkData, setSelectedChunkData] = useState(null);
  const [selectedChunkStepId, setSelectedChunkStepId] = useState(null);
  const [selectedConceptId, setSelectedConceptId] = useState(null);
  const [difficultyMode, setDifficultyMode] = useState(settings?.learning?.explanationDepth || "intermediate");
  const [hoverLens, setHoverLens] = useState(null);
  const [pinnedLenses, setPinnedLenses] = useState(normalizedInitialWindows);
  const [selectionState, setSelectionState] = useState(emptySelectionState);
  const selectionStateRef = useRef(selectionState);
  selectionStateRef.current = selectionState;
  const timerRefs = useRef({ short: null, medium: null, deep: null, preview: null, clear: null });
  const hoverPointerRef = useRef(null);
  const hoverAnchorRef = useRef({ element: null, rect: null, size: DEFAULT_QUICK_TOOLTIP_SIZE });
  const tokenRegistryRef = useRef(new Map());
  const measuredLeafRegistryRef = useRef(new Map());

  const getStepContext = useCallback((stepId) => {
    const currentStep = problem?.steps?.find((step) => step.id === stepId) || null;
    return {
      problem,
      solution: problem,
      stepId,
      stepTitle: currentStep?.label || currentStep?.title || "",
      currentStep,
    };
  }, [problem]);

  useEffect(() => {
    onWindowsChange?.(pinnedLenses);
  }, [pinnedLenses, onWindowsChange]);

  useEffect(() => {
    if (!DEBUG_MATH_HOVER || typeof window === "undefined") return undefined;
    window["__OMNIMATH_HOVER_STATE__"] = {
      activeChunkId,
      activeStepId,
      hoverState: hoverLens ? {
        id: hoverLens.referenceId || hoverLens.id,
        stepId: hoverLens.stepId || null,
        semanticId: hoverLens.semanticId || null,
        selectedText: hoverLens.selectedText || hoverLens.display || "",
      } : null,
      selectionState: selectionStateRef.current,
      registeredListenerCount: 1,
      registeredChunkCount: countRegisteredChunkOwners(tokenRegistryRef.current),
      registeredTokenCount: countRegisteredTokens(tokenRegistryRef.current),
      registeredStepCount: tokenRegistryRef.current.size,
      registeredMeasuredTargetCount: countRegisteredMeasuredTargets(measuredLeafRegistryRef.current),
      registeredMeasuredStepCount: measuredLeafRegistryRef.current.size,
      activeTimerCount: countActiveTimers(timerRefs.current),
    };
    return undefined;
  }, [activeChunkId, activeStepId, hoverLens, selectionState]);

  const cancelHoverClear = useCallback(() => {
    if (timerRefs.current.clear) {
      clearTimeout(timerRefs.current.clear);
      timerRefs.current.clear = null;
    }
  }, []);

  const clearActiveHover = useCallback(() => {
    Object.values(timerRefs.current).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    timerRefs.current = { short: null, medium: null, deep: null, preview: null, clear: null };
    setActiveChunkId(null);
    setActiveChunkData(null);
    setActivePointer(null);
    hoverPointerRef.current = null;
    hoverAnchorRef.current = { element: null, rect: null, size: DEFAULT_QUICK_TOOLTIP_SIZE };
    setHoverLens(null);
    setExplanationLevel(0);
    setActiveStepId(null);
    setActiveConceptId(null);
  }, []);

  const registerToken = useCallback((token, stepId, ownerId = "") => {
    if (!token?.id || !stepId) return () => {};
    const entryOwnerId = ownerId || token.ownerId || token.parentTokenId || token.id;
    const current = tokenRegistryRef.current.get(stepId) || [];
    const existingIndex = current.findIndex((item) => item.id === token.id && item.ownerId === entryOwnerId);
    const item = { ...token, stepId, ownerId: entryOwnerId };
    if (existingIndex >= 0) current[existingIndex] = item;
    else current.push(item);
    tokenRegistryRef.current.set(stepId, current);

    return () => {
      const list = tokenRegistryRef.current.get(stepId) || [];
      const next = list.filter((entry) => !(entry.id === token.id && entry.ownerId === entryOwnerId));
      if (next.length > 0) tokenRegistryRef.current.set(stepId, next);
      else tokenRegistryRef.current.delete(stepId);
    };
  }, []);

  const registerMeasuredTargets = useCallback((stepId, targets = [], ownerId = "") => {
    if (!stepId) return () => {};
    const entryOwnerId = ownerId || "unknown-owner";
    const current = measuredLeafRegistryRef.current.get(stepId) || new Map();
    const registeredIds = [];

    for (const target of targets) {
      if (!target?.id || !Array.isArray(target.rects) || target.rects.length === 0) continue;
      current.set(target.id, { ...target, stepId, ownerId: entryOwnerId });
      registeredIds.push(target.id);
    }
    measuredLeafRegistryRef.current.set(stepId, current);

    return () => {
      const latest = measuredLeafRegistryRef.current.get(stepId);
      if (!latest) return;
      for (const id of registeredIds) {
        if (latest.get(id)?.ownerId === entryOwnerId) latest.delete(id);
      }
      if (latest.size === 0) measuredLeafRegistryRef.current.delete(stepId);
    };
  }, []);

  const buildSelection = useCallback((stepId, startId, endId) => {
    const tokens = tokenRegistryRef.current.get(stepId) || [];
    const startIndex = tokens.findIndex((token) => token.id === startId);
    const endIndex = tokens.findIndex((token) => token.id === endId);
    if (startIndex < 0 || endIndex < 0) return null;
    const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const startToken = tokens[startIndex];
    const endToken = tokens[endIndex];
    const startOrder = Number(startToken?.order ?? startToken?.leafStart);
    const endOrder = Number(endToken?.order ?? endToken?.leafEnd);
    const hasSemanticOrder = Number.isFinite(startOrder) && Number.isFinite(endOrder);
    const selectedTokens = hasSemanticOrder
      ? tokens
        .filter((token) => {
          const order = Number(token.order);
          return Number.isFinite(order) && order >= Math.min(startOrder, endOrder) && order <= Math.max(startOrder, endOrder);
        })
        .sort((left, right) => Number(left.order) - Number(right.order))
      : tokens.slice(from, to + 1);
    const normalizedNode = hasSemanticOrder
      ? tokens
        .filter((token) => Number(token.leafStart) === Math.min(startOrder, endOrder) && Number(token.leafEnd) === Math.max(startOrder, endOrder))
        .sort((left, right) => Number(right.depth) - Number(left.depth))[0]
      : null;
    const selectedText = selectedTokens.map((token) => token.display || token.text || token.latex || "").filter(Boolean).join(" ");
    const context = getStepContext(stepId);
    const semanticSelection = hasSemanticOrder
      ? {
          ...createSemanticRangeFromTokens({
            stepId,
            selectedTokens,
            tokenRegistry: tokens,
            anchorId: startId,
            focusId: endId,
            selectedText,
            source: "range",
          }),
          id: `sel-${stepId}-${Math.min(startOrder, endOrder)}-${Math.max(startOrder, endOrder)}`,
        }
      : null;
    logSemanticSelection(settings, "range-selection-built", {
      stepId,
      selectedSemanticRange: semanticSelection,
      selectedNodeIds: semanticSelection?.nodeIds || [],
      selectedLeafIds: semanticSelection?.leafIds || [],
    });
    return {
      id: semanticSelection?.id || `selection-${stepId}-${selectedTokens.map((token) => token.id).join("-")}`,
      stepId,
      stepTitle: context.stepTitle,
      tokenIds: selectedTokens.map((token) => token.id),
      tokens: selectedTokens,
      selectedText: normalizedNode?.display || normalizedNode?.latex || selectedText,
      semanticSelection,
      context: {
        ...context,
        semanticSelection,
        selectedSemanticRange: semanticSelection,
        normalizedSelectionNode: normalizedNode || null,
      },
    };
  }, [getStepContext, settings]);

  const buildGeometrySelection = useCallback((stepId, selectionRect, fallbackToken = null) => {
    const measuredTargets = [...(measuredLeafRegistryRef.current.get(stepId)?.values() || [])];
    const tokens = tokenRegistryRef.current.get(stepId) || [];
    const selectedLeaves = sortTargetsByRenderedOrder(getTargetsIntersectingRect(measuredTargets, selectionRect)
      .flatMap((target) => (target.rects || [])
        .filter((rect) => rectIntersectsRect(rect, selectionRect))
        .map((rect, rectIndex) => ({
          ...target,
          rects: [rect],
          visualSelectionKey: `${target.id}:${rectIndex}:${selectionRectKey(rect)}`,
        }))));
    const selectedTokenByKey = new Map(selectedLeaves.map((token) => [token.visualSelectionKey || token.id, token]));
    const fallbackTokens = (Array.isArray(fallbackToken) ? fallbackToken : [fallbackToken]).filter(Boolean);
    for (const token of fallbackTokens) {
      const key = token?.visualSelectionKey || `${token.id}:${selectionRectKey(token.rects?.[0])}`;
      if (token?.id && !selectedTokenByKey.has(key)) {
        selectedTokenByKey.set(key, token);
      }
    }
    const selectedTokens = sortTargetsByRenderedOrder([...selectedTokenByKey.values()]);
    if (selectedTokens.length === 0) return null;

    const selectedText = selectedTokens.length > 0
      ? reconstructTextFromTargets(selectedTokens)
      : (fallbackToken?.display || fallbackToken?.text || fallbackToken?.latex || "");
    const context = getStepContext(stepId);
    const selectionBounds = unionSemanticRects(selectedTokens.flatMap((token) => token.rects || [])) || selectionRect;
    const semanticSelection = createSemanticRangeFromTokens({
      stepId,
      selectedTokens,
      tokenRegistry: tokens,
      anchorId: selectedTokens[0]?.id || fallbackTokens[0]?.id || null,
      focusId: selectedTokens.at(-1)?.id || fallbackTokens.at(-1)?.id || null,
      selectedText,
      source: "geometry",
      rect: selectionBounds,
    }) || {
      id: `sel-${stepId}-geometry-${selectedTokens.map((token) => token.id).join("-")}`,
      stepId,
      kind: "range",
      source: "geometry",
      nodeIds: selectedTokens.map((token) => token.id),
      leafIds: selectedTokens.map((token) => token.id),
      anchorId: selectedTokens[0]?.id || fallbackTokens[0]?.id || null,
      focusId: selectedTokens.at(-1)?.id || fallbackTokens.at(-1)?.id || null,
      normalizedToNodeId: null,
      selectedText,
      range: { leafIds: selectedTokens.map((token) => token.id) },
      rect: selectionBounds,
    };
    logSemanticSelection(settings, "geometry-selection-built", {
      stepId,
      selectedSemanticRange: semanticSelection,
      selectedNodeIds: semanticSelection.nodeIds,
      selectedLeafIds: semanticSelection.leafIds,
    });

    return {
      id: semanticSelection.id,
      stepId,
      stepTitle: context.stepTitle,
      tokenIds: selectedTokens.map((token) => token.id),
      tokens: selectedTokens,
      selectedText: semanticSelection.selectedText || selectedText,
      semanticSelection,
      context: {
        ...context,
        semanticSelection,
        selectedSemanticRange: semanticSelection,
        normalizedSelectionNode: semanticSelection.normalizedToNodeId
          ? tokens.find((token) => token.id === semanticSelection.normalizedToNodeId) || null
          : null,
      },
      anchorRect: selectionBounds,
    };
  }, [getStepContext, settings]);

  const updateGeometrySelection = useCallback((stepId, startPoint, endPoint, fallbackToken = null) => {
    const rect = normalizeDragRect(startPoint, endPoint);
    if (!rect) return null;
    const selection = buildGeometrySelection(stepId, rect, fallbackToken);
    if (!selection) return null;
    const current = selectionStateRef.current;
    const next = {
      ...current,
      selectedTokenIds: selection.tokenIds,
      selectedText: selection.selectedText,
      selectedStepId: stepId,
      selectionEndTokenId: selection.tokenIds.at(-1) || current.selectionEndTokenId,
      selectionRect: rect,
      semanticSelection: selection.semanticSelection,
      selectedSemanticRange: selection.semanticSelection,
      activeSelection: selection,
    };
    selectionStateRef.current = next;
    setSelectionState(next);
    return selection;
  }, [buildGeometrySelection]);

  const updateSelectionRange = useCallback((stepId, startId, endId) => {
    const selection = buildSelection(stepId, startId, endId);
    if (!selection) return null;
    const next = {
      ...selectionStateRef.current,
      selectionStartTokenId: startId,
      selectionEndTokenId: endId,
      selectedTokenIds: selection.tokenIds,
      selectedText: selection.selectedText,
      selectedStepId: stepId,
      semanticSelection: selection.semanticSelection,
      selectedSemanticRange: selection.semanticSelection,
      activeSelection: selection,
    };
    selectionStateRef.current = next;
    setSelectionState(next);
    return selection;
  }, [buildSelection]);

  const clearTokenSelection = useCallback(() => {
    const next = emptySelectionState();
    selectionStateRef.current = next;
    setSelectionState(next);
  }, []);

  const scheduleActiveHoverClear = useCallback(() => {
    cancelHoverClear();
    if (timerRefs.current.preview) {
      clearTimeout(timerRefs.current.preview);
      timerRefs.current.preview = null;
    }
    timerRefs.current.clear = setTimeout(() => {
      clearActiveHover();
    }, HOVER_CLEAR_DELAY_MS);
  }, [cancelHoverClear, clearActiveHover]);

  useEffect(() => {
    if (settings?.interaction?.hoverLens === false) {
      clearActiveHover();
    }
  }, [clearActiveHover, settings?.interaction?.hoverLens]);

  useEffect(() => () => {
    Object.values(timerRefs.current).forEach((timer) => {
      if (timer) clearTimeout(timer);
    });
    timerRefs.current = { short: null, medium: null, deep: null, preview: null, clear: null };
    hoverPointerRef.current = null;
    hoverAnchorRef.current = { element: null, rect: null, size: DEFAULT_QUICK_TOOLTIP_SIZE };
    selectionStateRef.current = emptySelectionState();
    tokenRegistryRef.current.clear();
    measuredLeafRegistryRef.current.clear();
    if (DEBUG_MATH_HOVER && typeof window !== "undefined") {
      delete window["__OMNIMATH_HOVER_STATE__"];
    }
  }, []);

  useEffect(() => {
    if (settings?.learning?.explanationDepth) {
      setDifficultyMode(settings.learning.explanationDepth);
    }
  }, [settings?.learning?.explanationDepth]);

  const startTimers = useCallback((mode) => {
    cancelHoverClear();
    const max = DIFFICULTY_MAX_LEVEL[mode] ?? 3;
    const baseDelay = getHoverDelay(settings);
    setExplanationLevel(0);
    if (max >= 1) timerRefs.current.short = setTimeout(() => setExplanationLevel(1), baseDelay);
    if (max >= 2) timerRefs.current.medium = setTimeout(() => setExplanationLevel(2), baseDelay + 500);
    if (max >= 3) timerRefs.current.deep = setTimeout(() => setExplanationLevel(3), baseDelay + 1200);
  }, [cancelHoverClear, settings?.interaction?.hoverDelay]);

  const updateHoverLensFromAnchor = useCallback((size = DEFAULT_QUICK_TOOLTIP_SIZE) => {
    const element = hoverAnchorRef.current.element;
    const rect = getRectSnapshot(element?.getBoundingClientRect?.()) || hoverAnchorRef.current.rect;
    if (!rect) return;
    hoverAnchorRef.current = { element, rect, size };
    const position = getTooltipPositionFromRect(rect, { size });
    setHoverLens((current) => current ? { ...current, x: position.x, y: position.y, anchor: rect } : current);
  }, []);

  const showHoverLens = useCallback((factory, event, size = DEFAULT_QUICK_TOOLTIP_SIZE) => {
    cancelHoverClear();
    const anchor = getEventAnchor(event);
    hoverAnchorRef.current = { ...anchor, size };
    if (event) {
      const pointer = { clientX: event.clientX, clientY: event.clientY };
      hoverPointerRef.current = pointer;
      setActivePointer((current) => {
        const next = { x: pointer.clientX, y: pointer.clientY };
        return samePointer(current, next) ? current : next;
      });
    }
    const pointer = hoverPointerRef.current;
    const previewEvent = pointer
      ? { clientX: pointer.clientX, clientY: pointer.clientY, anchorRect: anchor.rect }
      : event;
    setHoverLens((current) => {
      const next = factory(previewEvent);
      return current
        && next
        && current.referenceId === next.referenceId
        && current.referenceType === next.referenceType
        && current.stepId === next.stepId
        && current.x === next.x
        && current.y === next.y
        && sameRect(current.anchor, next.anchor)
        ? current
        : next;
    });
  }, [cancelHoverClear]);

  useEffect(() => {
    if (!hoverLens) return undefined;
    const handleViewportChange = () => {
      updateHoverLensFromAnchor(hoverAnchorRef.current.size || DEFAULT_QUICK_TOOLTIP_SIZE);
    };
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [hoverLens, updateHoverLensFromAnchor]);

  const handleChunkEnter = useCallback((chunk, stepId, event) => {
    const currentSelectionState = selectionStateRef.current;
    if (currentSelectionState.isSelecting) {
      if (currentSelectionState.selectionMode !== "geometry") {
        updateSelectionRange(stepId, currentSelectionState.selectionStartTokenId, chunk.id);
      }
      return;
    }
    if (currentSelectionState.activeSelection?.tokenIds?.length > 1) {
      const selection = currentSelectionState.activeSelection;
      const hoveredSelectedToken = chunk?.id && selection.tokenIds.includes(chunk.id);
      const hoveringSelectionPreview = chunk?.id === selection.id;
      if (!hoveredSelectedToken && !hoveringSelectionPreview) {
        clearTokenSelection();
      } else {
      if (activeChunkId === selection.id && hoverLens) {
        cancelHoverClear();
        return;
      }
      const selectionEvent = selection.anchorRect
        ? {
            clientX: event?.clientX,
            clientY: event?.clientY,
            anchorRect: selection.anchorRect,
            target: event?.target,
            currentTarget: event?.currentTarget,
          }
        : event;
      flushSync(() => {
        clearActiveHover();
        const semanticIdentity = createSemanticIdentity({
          id: selection.id,
          referenceId: selection.id,
          referenceType: "selection",
          stepId: selection.stepId,
          selectedText: selection.selectedText,
          display: selection.selectedText,
          selectedTokens: selection.tokens,
          semanticSelection: selection.semanticSelection,
          context: selection.context,
        });
        setActiveChunkId(selection.id);
        setActiveChunkData({
          id: selection.id,
          semanticIdentity,
          semanticId: semanticIdentity.semanticId,
          semanticType: semanticIdentity.semanticType || semanticIdentity.role,
          sourceRange: semanticIdentity.sourceRange,
          sourceText: semanticIdentity.sourceText,
          display: selection.selectedText,
          selectedText: selection.selectedText,
          short: "Selected region",
          medium: selection.tokens.map((token) => token.medium || token.short).filter(Boolean).join(" "),
          deep: selection.tokens.map((token) => token.deep || token.medium || token.short).filter(Boolean).join(" "),
          relatedTokenIds: selection.tokenIds,
          selectedTokenIds: selection.tokenIds,
          selectedTokens: selection.tokens,
          semanticSelection: selection.semanticSelection,
          selectedSemanticRange: selection.semanticSelection,
          context: selection.context,
        });
        setActiveStepId(selection.stepId);
        setActiveConceptId(null);
        showHoverLens(
          (previewEvent) => createSelectionWindow(selection, previewEvent, false, 0, settings?.learning?.defaultLensLevel),
          selectionEvent,
          DEFAULT_QUICK_TOOLTIP_SIZE
        );
      });
      logSemanticSelection(settings, "selection-overrides-hover", {
        hoveredNodeId: chunk?.id || null,
        selectedSemanticRange: selection.semanticSelection,
        finalExplanationTarget: selection.id,
      });
      startTimers(difficultyMode);
      return;
      }
    }
    const context = getStepContext(stepId);
    const semanticIdentity = createSemanticIdentity({ ...chunk, stepId, context });
    const contextualChunk = {
      ...chunk,
      context,
      semanticIdentity,
      semanticId: semanticIdentity.semanticId,
      semanticType: semanticIdentity.semanticType || semanticIdentity.role,
      sourceRange: semanticIdentity.sourceRange,
      sourceText: semanticIdentity.sourceText,
    };
    flushSync(() => {
      clearActiveHover();
      setActiveChunkId(contextualChunk.id);
      setActiveChunkData(contextualChunk);
      setActiveStepId(stepId);
      setActiveConceptId(getConceptForChunk(contextualChunk)?.id || null);
      showHoverLens(
        (previewEvent) => createChunkWindow(contextualChunk, stepId, previewEvent, false, 0, settings?.learning?.defaultLensLevel),
        event,
        DEFAULT_QUICK_TOOLTIP_SIZE
      );
    });
    startTimers(difficultyMode);
  }, [activeChunkId, cancelHoverClear, clearActiveHover, clearTokenSelection, difficultyMode, getStepContext, hoverLens, selectionState.activeSelection, selectionState.isSelecting, selectionState.selectionMode, selectionState.selectionStartTokenId, settings, settings?.learning?.defaultLensLevel, showHoverLens, startTimers, updateSelectionRange]);

  const handleChunkMove = useCallback((event) => {
    cancelHoverClear();
    if (selectionStateRef.current.activeSelection?.tokenIds?.length > 1 && hoverLens?.referenceType === "selection") {
      return;
    }
    const nextPointer = { clientX: event.clientX, clientY: event.clientY };
    hoverPointerRef.current = nextPointer;
    setActivePointer((current) => {
      const next = { x: nextPointer.clientX, y: nextPointer.clientY };
      return samePointer(current, next) ? current : next;
    });
    setHoverLens((current) => {
      if (!current) return current;
      const anchor = event?.anchorRect ? { element: null, rect: event.anchorRect } : getEventAnchor(event);
      const rect = anchor.rect || hoverAnchorRef.current.rect;
      if (!rect) return current;
      hoverAnchorRef.current = { ...anchor, rect, size: DEFAULT_QUICK_TOOLTIP_SIZE };
      const position = getTooltipPositionFromRect(rect, { size: DEFAULT_QUICK_TOOLTIP_SIZE });
      if (
        current.x === position.x
        && current.y === position.y
        && sameRect(current.anchor, rect)
      ) {
        return current;
      }
      return { ...current, x: position.x, y: position.y, anchor: rect };
    });
  }, [cancelHoverClear, hoverLens?.referenceType]);

  const handleChunkLeave = useCallback(() => {
    scheduleActiveHoverClear();
  }, [scheduleActiveHoverClear]);

  const selectChunk = useCallback((chunk, stepId) => {
    const concept = getConceptForChunk(chunk);
    setSelectedChunkData(chunk);
    setSelectedChunkStepId(stepId);
    setSelectedConceptId(concept?.id || null);
  }, []);

  const beginTokenSelection = useCallback((chunk, stepId, event) => {
    if (event?.button !== 0 || isEditableTarget(event?.target)) return;
    event.preventDefault();
    event.stopPropagation();
    clearActiveHover();
    const next = {
      isSelecting: true,
      selectionStartTokenId: chunk.id,
      selectionEndTokenId: chunk.id,
      selectedTokenIds: [chunk.id],
      selectedText: chunk.display || chunk.text || chunk.latex || "",
      selectedStepId: stepId,
      selectionMode: "geometry",
      selectionRect: null,
      dragStartPoint: { x: event.clientX, y: event.clientY },
      dragCurrentPoint: { x: event.clientX, y: event.clientY },
      fallbackToken: chunk,
      semanticSelection: null,
      selectedSemanticRange: null,
      activeSelection: null,
    };
    selectionStateRef.current = next;
    setSelectionState(next);
  }, [clearActiveHover]);

  const extendTokenSelection = useCallback((chunk, stepId) => {
    const currentSelectionState = selectionStateRef.current;
    if (!currentSelectionState.isSelecting || currentSelectionState.selectedStepId !== stepId) return;
    if (currentSelectionState.selectionMode === "geometry") return;
    updateSelectionRange(stepId, currentSelectionState.selectionStartTokenId, chunk.id);
  }, [updateSelectionRange]);

  const finishTokenSelection = useCallback((event) => {
    const currentSelectionState = selectionStateRef.current;
    if (!currentSelectionState.isSelecting || !currentSelectionState.selectedStepId) return;
    const endpointTokenId = tokenIdFromEventTarget(event);
    const endpointToken = endpointTokenId
      ? (
          measuredLeafRegistryRef.current.get(currentSelectionState.selectedStepId)?.get(endpointTokenId)
          || (tokenRegistryRef.current.get(currentSelectionState.selectedStepId) || [])
            .find((token) => token.id === endpointTokenId)
          || null
        )
      : null;
    const selection = currentSelectionState.selectionMode === "geometry"
      ? buildGeometrySelection(
        currentSelectionState.selectedStepId,
        currentSelectionState.selectionRect || normalizeDragRect(
          currentSelectionState.dragStartPoint,
          event ? { x: event.clientX, y: event.clientY } : currentSelectionState.dragCurrentPoint
        ),
        [currentSelectionState.fallbackToken, endpointToken].filter(Boolean)
      )
      : buildSelection(
        currentSelectionState.selectedStepId,
        currentSelectionState.selectionStartTokenId,
        currentSelectionState.selectionEndTokenId
      );
      if (!selection || selection.tokenIds.length <= 1) {
        const singleToken = endpointToken || currentSelectionState.fallbackToken || null;
        const singleTokenId = singleToken?.id || null;
      
        const next = {
          isSelecting: false,
          selectionStartTokenId: null,
          selectionEndTokenId: null,
          selectedTokenIds: singleTokenId ? [singleTokenId] : [],
          selectedText: singleToken
            ? (
                singleToken.selectedText
                || singleToken.display
                || singleToken.latex
                || singleToken.text
                || ""
              )
            : "",
          selectedStepId: singleTokenId
            ? currentSelectionState.selectedStepId
            : null,
          selectionMode: null,
          selectionRect: null,
          dragStartPoint: null,
          dragCurrentPoint: null,
          fallbackToken: null,
          semanticSelection: null,
          selectedSemanticRange: null,
          activeSelection: null,
        };
      
        selectionStateRef.current = next;
        setSelectionState(next);
        return;
      }
    const next = {
      ...currentSelectionState,
      isSelecting: false,
      selectedTokenIds: selection.tokenIds,
      selectedText: selection.selectedText,
      selectedStepId: selection.stepId,
      semanticSelection: selection.semanticSelection,
      selectedSemanticRange: selection.semanticSelection,
      activeSelection: selection,
    };
    selectionStateRef.current = next;
    setSelectionState(next);
    const semanticIdentity = createSemanticIdentity({
      id: selection.id,
      referenceId: selection.id,
      referenceType: "selection",
      stepId: selection.stepId,
      selectedText: selection.selectedText,
      display: selection.selectedText,
      selectedTokens: selection.tokens,
      semanticSelection: selection.semanticSelection,
      context: selection.context,
    });
    logSemanticSelection(settings, "selection-finalized", {
      stepId: selection.stepId,
      selectedSemanticRange: selection.semanticSelection,
      finalExplanationTarget: selection.id,
      selectedText: selection.selectedText,
    });
    const selectionEvent = selection.anchorRect
      ? {
          clientX: event?.clientX,
          clientY: event?.clientY,
          anchorRect: selection.anchorRect,
          target: event?.target,
          currentTarget: event?.currentTarget,
        }
      : event;
    const selectionWindow = createSelectionWindow(
      selection,
      selectionEvent,
      false,
      0,
      settings?.learning?.defaultLensLevel
    );
    cancelHoverClear();
    hoverAnchorRef.current = {
      element: null,
      rect: selectionWindow.anchor,
      size: DEFAULT_QUICK_TOOLTIP_SIZE,
    };
    if (selectionEvent) {
      const pointer = { clientX: selectionEvent.clientX, clientY: selectionEvent.clientY };
      hoverPointerRef.current = pointer;
      setActivePointer({ x: pointer.clientX, y: pointer.clientY });
    }
    flushSync(() => {
      setActiveChunkId(selection.id);
      setActiveChunkData({
        id: selection.id,
        semanticIdentity,
        semanticId: semanticIdentity.semanticId,
        semanticType: semanticIdentity.semanticType || semanticIdentity.role,
        sourceRange: semanticIdentity.sourceRange,
        sourceText: semanticIdentity.sourceText,
        display: selection.selectedText,
        selectedText: selection.selectedText,
        short: "Selected region",
        medium: selection.tokens.map((token) => token.medium || token.short).filter(Boolean).join(" "),
        deep: selection.tokens.map((token) => token.deep || token.medium || token.short).filter(Boolean).join(" "),
        relatedTokenIds: selection.tokenIds,
        selectedTokenIds: selection.tokenIds,
        selectedTokens: selection.tokens,
        semanticSelection: selection.semanticSelection,
        selectedSemanticRange: selection.semanticSelection,
        context: selection.context,
      });
      setActiveStepId(selection.stepId);
      setHoverLens(selectionWindow);
    });
    startTimers(difficultyMode);
  }, [
    buildGeometrySelection,
    buildSelection,
    cancelHoverClear,
    difficultyMode,
    settings,
    settings?.learning?.defaultLensLevel,
    startTimers,
  ]);

  const addPinnedChunkLens = useCallback((chunk, stepId, event) => {
    const selectedIds = selectionState.selectedStepId === stepId ? selectionState.selectedTokenIds : [];
    if (selectedIds.length > 1) {
      const selection = selectionState.activeSelection || (selectionState.selectionMode === "geometry"
        ? buildGeometrySelection(stepId, selectionState.selectionRect, selectionState.fallbackToken)
        : buildSelection(stepId, selectionState.selectionStartTokenId, selectionState.selectionEndTokenId));
      if (selection) {
        clearActiveHover();
        logSemanticSelection(settings, "selection-pinned", {
          stepId,
          selectedSemanticRange: selection.semanticSelection,
          finalExplanationTarget: selection.id,
        });
        setPinnedLenses((prev) => (
          prev.some((window) => samePinnedReference(window, "selection", selection.id, stepId))
            ? prev
            : [
                ...prev,
                createSelectionWindow(selection, event, true, prev.length, settings?.learning?.defaultLensLevel),
              ]
        ));
        return;
      }
    }
    clearActiveHover();
    const context = getStepContext(stepId);
    const semanticIdentity = createSemanticIdentity({ ...chunk, stepId, context });
    const pinnedChunk = {
      ...chunk,
      context,
      semanticIdentity,
      semanticId: semanticIdentity.semanticId,
      semanticType: semanticIdentity.semanticType || semanticIdentity.role,
      sourceRange: semanticIdentity.sourceRange,
      sourceText: semanticIdentity.sourceText,
    };
    setPinnedLenses((prev) => (
      prev.some((window) => samePinnedReference(window, "token", chunk.id, stepId))
        ? prev
        : [
            ...prev,
            createChunkWindow(pinnedChunk, stepId, event, true, prev.length, settings?.learning?.defaultLensLevel),
          ]
    ));
  }, [
    buildGeometrySelection,
    buildSelection,
    clearActiveHover,
    getStepContext,
    selectionState.activeSelection,
    selectionState.selectedStepId,
    selectionState.selectedTokenIds,
    selectionState.selectionEndTokenId,
    selectionState.selectionStartTokenId,
    selectionState.selectionMode,
    selectionState.selectionRect,
    selectionState.fallbackToken,
    settings,
    settings?.learning?.defaultLensLevel,
  ]);

  const handleChunkRightClick = useCallback((chunk, stepId, e) => {
    e.preventDefault();
    e.stopPropagation();
    addPinnedChunkLens(chunk, stepId, e);
  }, [addPinnedChunkLens]);

  const handleStepEnter = useCallback((step, event) => {
    if (selectionState.isSelecting) return;
    flushSync(() => {
      clearActiveHover();
      setActiveStepId(step.id);
      const stepConcepts = getConceptsForStep(step);
      setActiveConceptId(stepConcepts[0]?.id || null);
      showHoverLens(
        (previewEvent) => createStepWindow(step, previewEvent, false, 0, settings?.learning?.defaultLensLevel),
        event,
        DEFAULT_QUICK_TOOLTIP_SIZE
      );
    });
    startTimers(difficultyMode);
  }, [clearActiveHover, difficultyMode, selectionState.isSelecting, settings?.learning?.defaultLensLevel, showHoverLens, startTimers]);

  const handleStepMove = useCallback((event) => {
    cancelHoverClear();
    hoverPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setActivePointer({ x: event.clientX, y: event.clientY });
    setHoverLens((current) => {
      if (!current || current.referenceType !== "step") return current;
      const anchor = getEventAnchor(event);
      const rect = anchor.rect || hoverAnchorRef.current.rect;
      if (!rect) return current;
      hoverAnchorRef.current = { ...anchor, rect, size: DEFAULT_QUICK_TOOLTIP_SIZE };
      const position = getTooltipPositionFromRect(rect, { size: DEFAULT_QUICK_TOOLTIP_SIZE });
      return { ...current, x: position.x, y: position.y, anchor: rect };
    });
  }, [cancelHoverClear]);

  const handleStepLeave = useCallback(() => {
    scheduleActiveHoverClear();
  }, [scheduleActiveHoverClear]);

  const addPinnedStepLens = useCallback((step, event) => {
    clearActiveHover();
    setPinnedLenses((prev) => (
      prev.some((window) => samePinnedReference(window, "step", step.id, step.id))
        ? prev
        : [
            ...prev,
            createStepWindow(step, event, true, prev.length, settings?.learning?.defaultLensLevel),
          ]
    ));
  }, [clearActiveHover, settings?.learning?.defaultLensLevel]);

  const handleStepRightClick = useCallback((step, event) => {
    event.preventDefault();
    event.stopPropagation();
    addPinnedStepLens(step, event);
  }, [addPinnedStepLens]);

  const handleConceptEnter = useCallback((conceptId, event) => {
    flushSync(() => {
      clearActiveHover();
      setActiveConceptId(conceptId);
      showHoverLens(
        (previewEvent) => createConceptWindow(conceptId, previewEvent, false, 0, settings?.learning?.defaultLensLevel),
        event,
        DEFAULT_QUICK_TOOLTIP_SIZE
      );
    });
    startTimers(difficultyMode);
  }, [clearActiveHover, difficultyMode, settings?.learning?.defaultLensLevel, showHoverLens, startTimers]);

  const handleConceptMove = useCallback((event) => {
    cancelHoverClear();
    hoverPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setActivePointer({ x: event.clientX, y: event.clientY });
    setHoverLens((current) => {
      if (!current || current.referenceType !== "concept") return current;
      const anchor = getEventAnchor(event);
      const rect = anchor.rect || hoverAnchorRef.current.rect;
      if (!rect) return current;
      hoverAnchorRef.current = { ...anchor, rect, size: DEFAULT_QUICK_TOOLTIP_SIZE };
      const position = getTooltipPositionFromRect(rect, { size: DEFAULT_QUICK_TOOLTIP_SIZE });
      return { ...current, x: position.x, y: position.y, anchor: rect };
    });
  }, [cancelHoverClear]);

  const handleConceptLeave = useCallback(() => {
    scheduleActiveHoverClear();
  }, [scheduleActiveHoverClear]);

  const addPinnedConceptLens = useCallback((conceptId, event) => {
    clearActiveHover();
    setPinnedLenses((prev) => (
      prev.some((window) => samePinnedReference(window, "concept", conceptId))
        ? prev
        : [
            ...prev,
            createConceptWindow(conceptId, event, true, prev.length, settings?.learning?.defaultLensLevel),
          ]
    ));
  }, [clearActiveHover, settings?.learning?.defaultLensLevel]);

  const handleConceptRightClick = useCallback((conceptId, event) => {
    event.preventDefault();
    event.stopPropagation();
    addPinnedConceptLens(conceptId, event);
  }, [addPinnedConceptLens]);

  const closeExplanationWindow = useCallback((id) => {
    setPinnedLenses((prev) => prev.filter((window) => window.id !== id));
  }, []);

  const toggleWindowPin = useCallback((id) => {
    closeExplanationWindow(id);
  }, [closeExplanationWindow]);

  const clearHoverLens = useCallback(() => {
    clearActiveHover();
  }, [clearActiveHover]);

  const holdHoverLens = useCallback(() => {
    cancelHoverClear();
  }, [cancelHoverClear]);

  const releaseHoverLens = useCallback(() => {
    scheduleActiveHoverClear();
  }, [scheduleActiveHoverClear]);

  const clearSelectedConcept = useCallback(() => {
    setSelectedChunkData(null);
    setSelectedChunkStepId(null);
    setSelectedConceptId(null);
  }, []);

  const setWindowDepth = useCallback((id, depth) => {
    setPinnedLenses((prev) =>
      prev.map((window) =>
        window.id === id ? { ...window, depth } : window
      )
    );
  }, []);

  const moveExplanationWindow = useCallback((id, x, y, size = WINDOW_SIZE) => {
    const position = clampPosition(x, y, size, 0);
    setPinnedLenses((prev) => {
      let changed = false;
      const next = prev.map((window) => {
        if (window.id !== id) return window;
        if (window.x === position.x && window.y === position.y) return window;
        changed = true;
        return { ...window, x: position.x, y: position.y };
      });

      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    if (!selectionState.isSelecting) return undefined;
    const handleMouseMove = (event) => {
      if (selectionState.selectionMode !== "geometry" || !selectionState.selectedStepId || !selectionState.dragStartPoint) return;
      const currentPoint = { x: event.clientX, y: event.clientY };
      setSelectionState((current) => ({ ...current, dragCurrentPoint: currentPoint }));
      updateGeometrySelection(
        selectionState.selectedStepId,
        selectionState.dragStartPoint,
        currentPoint,
        selectionState.fallbackToken
      );
    };
    const handleMouseUp = (event) => finishTokenSelection(event);
    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
    };
  }, [
    finishTokenSelection,
    selectionState.dragStartPoint,
    selectionState.fallbackToken,
    selectionState.isSelecting,
    selectionState.selectedStepId,
    selectionState.selectionMode,
    updateGeometrySelection,
  ]);

  useEffect(() => {
    const handleMouseDown = (event) => {
      if (isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-explainable='true'], .omni-floating-window, .omni-quick-tooltip")) return;
      clearActiveHover();
      clearTokenSelection();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [clearActiveHover, clearTokenSelection]);

  const displayChunkData = activeChunkData;
  const displayLevel = explanationLevel;
  const inspectedConceptId = activeConceptId || selectedConceptId;
  const relatedConceptIds = inspectedConceptId ? getRelatedConceptIds(inspectedConceptId) : [];
  const openReferenceIds = pinnedLenses.map((window) => window.referenceId);
  const pinnedReferenceIds = openReferenceIds;
  const pinnedChunkIds = pinnedLenses
    .filter((window) => window.referenceType === "token")
    .map((window) => window.referenceId);
  const explanationWindows = pinnedLenses;

  return (
    <HoverContext.Provider
      value={{
        activeChunkId,
        activeChunkData: displayChunkData,
        explanationLevel: displayLevel,
        activeStepId,
        activeConceptId,
        activePointer,
        selectionState,
        selectedTokenIds: selectionState.selectedTokenIds,
        selectedText: selectionState.selectedText,
        semanticSelection: selectionState.semanticSelection,
        selectedSemanticRange: selectionState.selectedSemanticRange,
        selectedStepId: selectionState.selectedStepId,
        selectedChunkData,
        selectedChunkStepId,
        selectedConceptId,
        inspectedConceptId,
        relatedConceptIds,
        pinnedChunkIds,
        pinnedReferenceIds,
        difficultyMode,
        hoverLens,
        settings,
        pinnedLenses,
        explanationWindows,
        openReferenceIds,
        setDifficultyMode,
        handleChunkEnter,
        handleChunkMove,
        handleChunkLeave,
        selectChunk,
        clearSelectedConcept,
        addPinnedChunkLens,
        addPinnedStepLens,
        addPinnedConceptLens,
        handleChunkRightClick,
    registerToken,
    registerMeasuredTargets,
        beginTokenSelection,
        extendTokenSelection,
        finishTokenSelection,
        clearTokenSelection,
        handleStepEnter,
        handleStepMove,
        handleStepLeave,
        handleStepRightClick,
        handleConceptEnter,
        handleConceptMove,
        handleConceptLeave,
        handleConceptRightClick,
        holdHoverLens,
        releaseHoverLens,
        clearHoverLens,
        closeExplanationWindow,
        toggleWindowPin,
        setWindowDepth,
        moveExplanationWindow,
      }}
    >
      {children}
    </HoverContext.Provider>
  );
}

export function useHover() {
  const ctx = useContext(HoverContext);
  if (!ctx) throw new Error("useHover must be used inside HoverProvider");
  return ctx;
}
