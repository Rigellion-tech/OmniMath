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

const HoverContext = createContext(null);

// difficultyMode: "beginner" | "intermediate" | "advanced" | "exam" | "intuition" | "professor"
const DIFFICULTY_MAX_LEVEL = { beginner: 1, intermediate: 2, advanced: 3, exam: 1, intuition: 2, professor: 3 };
const WINDOW_SIZE = DEFAULT_FLOATING_LENS_SIZE;
const HOVER_DELAY_MS = 125;
const HOVER_CLEAR_DELAY_MS = 140;

function clampPosition(x, y, size = WINDOW_SIZE, padding = 12) {
  return clampTooltipPosition(x, y, size, null, padding);
}

function getEventAnchor(event) {
  const element = event?.currentTarget instanceof Element
    ? event.currentTarget
    : event?.target instanceof Element
      ? event.target.closest("[data-explainable='true']")
      : null;
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

function getHoverDelay(settings) {
  const configured = Number(settings?.interaction?.hoverDelay);
  if (!Number.isFinite(configured)) return HOVER_DELAY_MS;
  return Math.max(100, Math.min(150, configured));
}

function createChunkWindow(chunk, stepId, event, pinned, index, defaultDepth = "intermediate") {
  const anchor = getEventAnchor(event);
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
  const anchor = getEventAnchor(event);
  const position = getEventPosition(
    anchor.rect ? { anchorRect: anchor.rect } : event,
    index,
    pinned ? WINDOW_SIZE : DEFAULT_QUICK_TOOLTIP_SIZE
  );
  const selectedText = selection.selectedText || selection.tokens.map((token) => token.display || token.text || "").join(" ");

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
    display: selectedText,
    selectedText,
    selectedTokenIds: selection.tokenIds,
    selectedTokens: selection.tokens,
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
  const anchor = getEventAnchor(event);
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
  const anchor = getEventAnchor(event);
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
  const [selectionState, setSelectionState] = useState({
    isSelecting: false,
    selectionStartTokenId: null,
    selectionEndTokenId: null,
    selectedTokenIds: [],
    selectedText: "",
    selectedStepId: null,
  });
  const timerRefs = useRef({ short: null, medium: null, deep: null, preview: null, clear: null });
  const hoverPointerRef = useRef(null);
  const hoverAnchorRef = useRef({ element: null, rect: null, size: DEFAULT_QUICK_TOOLTIP_SIZE });
  const tokenRegistryRef = useRef(new Map());

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

  const registerToken = useCallback((token, stepId) => {
    if (!token?.id || !stepId) return () => {};
    const current = tokenRegistryRef.current.get(stepId) || [];
    const existingIndex = current.findIndex((item) => item.id === token.id);
    const item = { ...token, stepId };
    if (existingIndex >= 0) current[existingIndex] = item;
    else current.push(item);
    tokenRegistryRef.current.set(stepId, current);

    return () => {
      const list = tokenRegistryRef.current.get(stepId) || [];
      tokenRegistryRef.current.set(stepId, list.filter((entry) => entry.id !== token.id));
    };
  }, []);

  const buildSelection = useCallback((stepId, startId, endId) => {
    const tokens = tokenRegistryRef.current.get(stepId) || [];
    const startIndex = tokens.findIndex((token) => token.id === startId);
    const endIndex = tokens.findIndex((token) => token.id === endId);
    if (startIndex < 0 || endIndex < 0) return null;
    const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const selectedTokens = tokens.slice(from, to + 1);
    const selectedText = selectedTokens.map((token) => token.display || token.text || token.latex || "").filter(Boolean).join(" ");
    const context = getStepContext(stepId);
    return {
      id: `selection-${stepId}-${selectedTokens.map((token) => token.id).join("-")}`,
      stepId,
      stepTitle: context.stepTitle,
      tokenIds: selectedTokens.map((token) => token.id),
      tokens: selectedTokens,
      selectedText,
      context,
    };
  }, [getStepContext]);

  const updateSelectionRange = useCallback((stepId, startId, endId) => {
    const selection = buildSelection(stepId, startId, endId);
    if (!selection) return null;
    setSelectionState((current) => ({
      ...current,
      selectionStartTokenId: startId,
      selectionEndTokenId: endId,
      selectedTokenIds: selection.tokenIds,
      selectedText: selection.selectedText,
      selectedStepId: stepId,
    }));
    return selection;
  }, [buildSelection]);

  const clearTokenSelection = useCallback(() => {
    setSelectionState({
      isSelecting: false,
      selectionStartTokenId: null,
      selectionEndTokenId: null,
      selectedTokenIds: [],
      selectedText: "",
      selectedStepId: null,
    });
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
      setActivePointer({ x: pointer.clientX, y: pointer.clientY });
    }
    const pointer = hoverPointerRef.current;
    const previewEvent = pointer
      ? { clientX: pointer.clientX, clientY: pointer.clientY, anchorRect: anchor.rect }
      : event;
    setHoverLens(factory(previewEvent));
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
    if (selectionState.isSelecting) {
      updateSelectionRange(stepId, selectionState.selectionStartTokenId, chunk.id);
      return;
    }
    const context = getStepContext(stepId);
    const contextualChunk = { ...chunk, context };
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
  }, [clearActiveHover, difficultyMode, getStepContext, selectionState.isSelecting, selectionState.selectionStartTokenId, settings, settings?.learning?.defaultLensLevel, showHoverLens, startTimers, updateSelectionRange]);

  const handleChunkMove = useCallback((event) => {
    cancelHoverClear();
    hoverPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setActivePointer({ x: event.clientX, y: event.clientY });
    setHoverLens((current) => {
      if (!current) return current;
      const anchor = getEventAnchor(event);
      const rect = anchor.rect || hoverAnchorRef.current.rect;
      if (!rect) return current;
      hoverAnchorRef.current = { ...anchor, rect, size: DEFAULT_QUICK_TOOLTIP_SIZE };
      const position = getTooltipPositionFromRect(rect, { size: DEFAULT_QUICK_TOOLTIP_SIZE });
      return { ...current, x: position.x, y: position.y, anchor: rect };
    });
  }, [cancelHoverClear]);

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
    setSelectionState({
      isSelecting: true,
      selectionStartTokenId: chunk.id,
      selectionEndTokenId: chunk.id,
      selectedTokenIds: [chunk.id],
      selectedText: chunk.display || chunk.text || chunk.latex || "",
      selectedStepId: stepId,
    });
  }, [clearActiveHover]);

  const extendTokenSelection = useCallback((chunk, stepId) => {
    if (!selectionState.isSelecting || selectionState.selectedStepId !== stepId) return;
    updateSelectionRange(stepId, selectionState.selectionStartTokenId, chunk.id);
  }, [selectionState.isSelecting, selectionState.selectedStepId, selectionState.selectionStartTokenId, updateSelectionRange]);

  const finishTokenSelection = useCallback((event) => {
    if (!selectionState.isSelecting || !selectionState.selectedStepId) return;
    const selection = buildSelection(
      selectionState.selectedStepId,
      selectionState.selectionStartTokenId,
      selectionState.selectionEndTokenId
    );
    setSelectionState((current) => ({ ...current, isSelecting: false }));
    if (!selection || selection.tokenIds.length <= 1) return;
    setActiveChunkId(selection.id);
    setActiveChunkData({
      id: selection.id,
      display: selection.selectedText,
      short: "Selected region",
      medium: selection.tokens.map((token) => token.medium || token.short).filter(Boolean).join(" "),
      deep: selection.tokens.map((token) => token.deep || token.medium || token.short).filter(Boolean).join(" "),
      relatedTokenIds: selection.tokenIds,
    });
    setActiveStepId(selection.stepId);
    showHoverLens(
      (previewEvent) => createSelectionWindow(selection, previewEvent, false, 0, settings?.learning?.defaultLensLevel),
      event,
      DEFAULT_QUICK_TOOLTIP_SIZE
    );
    startTimers(difficultyMode);
  }, [
    buildSelection,
    difficultyMode,
    selectionState.isSelecting,
    selectionState.selectedStepId,
    selectionState.selectionEndTokenId,
    selectionState.selectionStartTokenId,
    settings?.learning?.defaultLensLevel,
    showHoverLens,
    startTimers,
  ]);

  const addPinnedChunkLens = useCallback((chunk, stepId, event) => {
    const selectedIds = selectionState.selectedStepId === stepId ? selectionState.selectedTokenIds : [];
    if (selectedIds.length > 1 && selectedIds.includes(chunk.id)) {
      const selection = buildSelection(stepId, selectionState.selectionStartTokenId, selectionState.selectionEndTokenId);
      if (selection) {
        clearActiveHover();
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
    setPinnedLenses((prev) => (
      prev.some((window) => samePinnedReference(window, "token", chunk.id, stepId))
        ? prev
        : [
            ...prev,
            createChunkWindow({ ...chunk, context }, stepId, event, true, prev.length, settings?.learning?.defaultLensLevel),
          ]
    ));
  }, [
    buildSelection,
    clearActiveHover,
    getStepContext,
    selectionState.selectedStepId,
    selectionState.selectedTokenIds,
    selectionState.selectionEndTokenId,
    selectionState.selectionStartTokenId,
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
    const handleMouseUp = (event) => finishTokenSelection(event);
    document.addEventListener("mouseup", handleMouseUp, true);
    return () => document.removeEventListener("mouseup", handleMouseUp, true);
  }, [finishTokenSelection, selectionState.isSelecting]);

  useEffect(() => {
    const handleMouseDown = (event) => {
      if (isEditableTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-explainable='true'], .omni-floating-window")) return;
      clearTokenSelection();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    return () => document.removeEventListener("mousedown", handleMouseDown, true);
  }, [clearTokenSelection]);

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
