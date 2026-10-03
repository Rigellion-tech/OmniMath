import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, ChevronUp, GripHorizontal, Loader2, MessageCircle, PanelRightOpen, Pin, X } from "lucide-react";
import MathText from "./MathText";
import ConversationText from "./ConversationText";
import { explainPin, explainToken } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { useHoverActions, useLensWorkspace, useHoverTooltipState } from "@/lib/HoverContext";
import {
  getHoverTargetIdentity,
  createStableLazyPayload,
  resolveLazyExplanationForTarget,
  shouldApplyLazyExplanation,
} from "@/lib/hoverTargetIdentity";
import { userFacingTooltipTitle } from "@/lib/presentationLabels";
import { getProblemLabel } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import { getSolutionSteps } from "@/lib/solutionSteps";
import {
  HOVER_LOADING_DELAY_MS,
  HOVER_TIMEOUT_MESSAGE,
  HOVER_STILL_GENERATING_DELAY_MS,
  HOVER_TIMEOUT_MS,
  INITIAL_LAZY_EXPLANATION_STATE,
  PIN_TIMEOUT_MS,
  createLazyRequestDescriptor,
  getLazyLoadingMessage,
  isCurrentLazyRequest,
  reduceLazyExplanationLifecycle,
} from "@/lib/lazyExplanationLifecycle";
import { clampTooltipPosition, getTooltipPositionFromRect } from "@/lib/tooltipPosition";
import { cn } from "@/lib/utils";
import ScopedConversation from "./ScopedConversation";
import MathRenderer from "./MathRenderer";
import { clampCanvasPosition, MAX_CANVAS_EXTENT, lensTargetIsCurrent, presentationDepth, resolveLensPositions } from "@/lib/lensWorkspace";
import { classifyHoverRequestFailure, recordHoverRequestLifecycle } from "@/lib/hoverRequestLifecycle";
import { endOmniMeasure, recordOmniDiagnostic, startOmniMeasure } from "@/lib/performanceDiagnostics";

const HOVER_DEBOUNCE_MS = 400;
const HOVER_RATE_LIMIT_MS = 1000;
const RATE_LIMIT_MESSAGE = "Explanation paused. Try again in a few seconds.";
const PINNED_CARD_PADDING = 12;
const lazyExplanationCache = new Map();
const inFlightExplanations = new Map();
const pinExplanationCache = new Map();
const inFlightPinRequests = new Map();
const pinRequestLocks = new Set();
const requestCooldownUntil = new Map();
let activeHoverRequest = null;
let nextHoverRequestAt = 0;
let tooltipDomInstanceSequence = 0;
let lazyExplanationOwnerSequence = 0;
const DEBUG_SOLUTION_STATE = import.meta.env.DEV
  && import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true";
const DEBUG_MATH_HOVER = import.meta.env.DEV
  && (
    import.meta.env.VITE_DEBUG_MATH_HOVER === "true"
    || import.meta.env.VITE_DEBUG_MATH_HOVER === "1"
    || import.meta.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true"
  );

function logSolutionState(event, details = {}) {
  if (!DEBUG_SOLUTION_STATE) return;
  console.info("[omnimath:solution-state]", {
    event,
    ...details,
  });
}

function stableHash(value = "") {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createDebugRequestId(mode, requestId, cacheKey) {
  return `${mode}-${requestId}-${stableHash(cacheKey)}`;
}

function logLazyExplanation(event, details = {}) {
  if (!import.meta.env.DEV) return;
  console.info("[omnimath:lazy-explanation]", {
    event,
    ...details,
  });
}

function recordHoverLifecycle(state, details = {}) {
  return recordHoverRequestLifecycle(state, details, {
    debug: DEBUG_MATH_HOVER,
  });
}

function logExplanationTarget(event, details = {}) {
  if (!DEBUG_SOLUTION_STATE && !DEBUG_MATH_HOVER) return;
  console.info("[omnimath:explanation-target]", {
    event,
    ...details,
  });
}

function getViewportSize() {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  return {
    width: window.visualViewport?.width || window.innerWidth,
    height: window.visualViewport?.height || window.innerHeight,
  };
}

function getInitialClampedTooltipPosition(hoverLens, padding = 12) {
  const viewport = getViewportSize();
  const maxSize = {
    width: Math.min(360, Math.max(160, viewport.width - padding * 2)),
    height: Math.max(80, viewport.height - padding * 2),
  };
  return clampTooltipPosition(hoverLens?.x || padding, hoverLens?.y || padding, maxSize, viewport, padding);
}

function getProblemLatex(problem, context) {
  return context?.problem?.expression
    || context?.problem?.problem
    || problem?.expression
    || problem?.problem
    || problem?.originalProblem
    || "";
}

function cleanKeyPart(value, fallback = "unknown") {
  return String(value || fallback)
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9_:\\.^-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    || fallback;
}

function getProblemId(problem, context) {
  return cleanKeyPart(
    context?.problem?.id
      || context?.problem?.sessionId
      || problem?.id
      || problem?.sessionId
      || getProblemLatex(problem, context),
    "problem"
  );
}

function getStepLatex(item) {
  return item?.context?.currentStep?.math
    || item?.context?.currentStep?.latex
    || item?.display
    || item?.selectedText
    || "";
}

function getParentExpression(item) {
  return item?.parentExpression
    || item?.selectedTokens?.[0]?.parentExpression
    || item?.display
    || item?.selectedText
    || getStepLatex(item);
}

function getAnchorId(item) {
  const identity = item?.semanticIdentity || null;
  if (identity?.semanticId || identity?.targetId) return identity.semanticId || identity.targetId;
  const semanticSelection = item?.semanticSelection || item?.selectedSemanticRange || item?.context?.semanticSelection || null;
  if (semanticSelection?.id) return semanticSelection.id;
  return item?.selectedTokens?.[0]?.anchorId
    || item?.selectedTokens?.[0]?.id
    || item?.referenceId
    || item?.selectedText
    || item?.display
    || "";
}

function getLazyCacheKey(item, problem, mode, explanationLevel = "default") {
  const identity = getHoverTargetIdentity(item);
  const problemId = getProblemId(problem, item?.context);
  const stepId = item?.stepId || item?.context?.stepId || "step";
  const anchorId = identity.semanticId || identity.targetId || getAnchorId(item);
  const selected = identity.sourceText || item?.selectedText || item?.display || "";
  const parentExpression = getParentExpression(item);
  const contextHash = stableHash([
    getProblemLatex(problem, item?.context),
    getStepLatex(item),
    parentExpression,
    item?.stepTitle || item?.context?.stepTitle || "",
  ].join("\n"));

  return [
    mode,
    problemId,
    item?.targetRevision || "current",
    stepId,
    cleanKeyPart(anchorId, "anchor"),
    cleanKeyPart(selected, "selected"),
    contextHash,
    mode === "pin" ? "pin" : explanationLevel,
  ].join("::");
}

function createLazyPayload(item, problem) {
  const identity = getHoverTargetIdentity(item);
  const currentStep = getStepLatex(item);
  const selectedLatex = identity.sourceText || item?.selectedText || item?.display || currentStep;
  const parentExpression = getParentExpression(item);
  const semanticSelection = item?.semanticSelection || item?.selectedSemanticRange || item?.context?.semanticSelection || null;
  const selectedTokenId = identity.targetId || semanticSelection?.id || item?.selectedTokens?.[0]?.id || item?.referenceId || "";

  logExplanationTarget("payload", {
    referenceType: item?.referenceType || "token",
    semanticId: identity.semanticId || identity.targetId,
    targetId: identity.targetId,
    sourceRange: identity.sourceRange,
    sourceText: identity.sourceText,
    tooltipTitle: identity.tooltipTitle || identity.label,
    selectedLatex,
    semanticSelection,
    selectedSemanticRange: semanticSelection,
  });

  return createStableLazyPayload(item, {
    problemId: getProblemId(problem, item?.context),
    problemContext: getProblemLabel(problem || item?.context?.problem, "Math problem"),
    stepLatex: currentStep,
    selectedLatex,
    parentExpression,
    stepHeading: item?.stepTitle || item?.context?.stepTitle || item?.title || "",
    stepId: item?.stepId || item?.context?.stepId || "",
    anchorId: identity.semanticId || semanticSelection?.anchorId || selectedTokenId,
    selectedTokenId,
  });
}

function readSessionCache(cacheKey) {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(`omnimath:explanation:${cacheKey}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSessionCache(cacheKey, value) {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(`omnimath:explanation:${cacheKey}`, JSON.stringify(value));
  } catch {
    // Session cache is best-effort; memory cache still protects this tab.
  }
}

function getMemoryCache(mode) {
  return mode === "pin" ? pinExplanationCache : lazyExplanationCache;
}

function getInFlightMap(mode) {
  return mode === "pin" ? inFlightPinRequests : inFlightExplanations;
}

function getCachedHoverFallback(item, problem) {
  const levels = ["beginner", "intermediate", "advanced", "default"];
  for (const level of levels) {
    const cached = lazyExplanationCache.get(getLazyCacheKey(item, problem, "hover", level));
    if (cached && shouldApplyLazyExplanation(item, cached)) return cached;
  }
  return null;
}

function isRateLimitError(error) {
  const message = String(error?.message || error?.body?.message || error?.body?.error || "");
  return error?.status === 429 || /too many requests|rate limit/i.test(message);
}

function normalizeLazyError(error) {
  if (error?.name === "AbortError") return "";
  if (isRateLimitError(error)) return RATE_LIMIT_MESSAGE;
  return error?.message || "Could not load this explanation.";
}

function getLazyTargetId(item) {
  const identity = item?.semanticIdentity || null;
  return identity?.semanticId
    || identity?.targetId
    || item?.semanticSelection?.id
    || item?.selectedSemanticRange?.id
    || item?.context?.semanticSelection?.id
    || item?.selectedTokens?.[0]?.id
    || item?.selectedTokens?.[0]?.semanticNodeId
    || item?.referenceId
    || item?.id
    || "";
}

function createLazyRequest({ cacheKey, mode, item, problem, getToken, signal, requestDescriptor = null }) {
  const inFlightMap = getInFlightMap(mode);
  const cache = getMemoryCache(mode);
  const existing = inFlightMap.get(cacheKey);
  if (existing) {
    logLazyExplanation(mode === "pin" ? "pin request reused" : "request reused", {
      mode,
      cacheKey,
      requestId: requestDescriptor?.requestId || null,
      transportRequestId: existing.transportRequestId,
      targetId: requestDescriptor?.targetId || null,
    });
    return {
      promise: existing.promise,
      shared: true,
      transportRequestId: existing.transportRequestId,
    };
  }

  const request = mode === "pin" ? explainPin : explainToken;
  const startedAt = performance.now();
  const transportRequestId = createDebugRequestId(mode, requestDescriptor?.requestId || "request", cacheKey);
  const payload = {
    ...createLazyPayload(item, problem),
    debugRequestId: transportRequestId,
  };
  logLazyExplanation(mode === "pin" ? "pin API fired" : "API call fired", {
    mode,
    cacheKey,
    requestId: requestDescriptor?.requestId || null,
    debugRequestId: transportRequestId,
    semanticNodeId: payload.semanticId,
    selectedText: payload.semanticSourceText || payload.targetSourceText || "",
    sourceRange: payload.targetSourceRange || payload.semanticSourceRange || null,
  });
  logLazyExplanation("request-start", {
    mode,
    cacheKey,
    requestId: requestDescriptor?.requestId || null,
    debugRequestId: transportRequestId,
    targetId: requestDescriptor?.targetId || null,
  });
  recordHoverLifecycle("request_started", {
    scope: "transport",
    requestId: null,
    transportRequestId,
    ownerId: null,
    cacheKeyHash: stableHash(cacheKey),
    semanticId: requestDescriptor?.targetId || null,
    mode,
  });
  const promise = request({ payload, getToken, signal })
    .then((data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw Object.assign(new Error("Hover explanation response had an invalid shape."), {
          code: "CLIENT_RESPONSE_SHAPE_INVALID",
        });
      }
      recordHoverLifecycle("api_parsed", {
        scope: "transport",
        requestId: null,
        transportRequestId,
        ownerId: null,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: data.semanticId || data.targetId || requestDescriptor?.targetId || null,
      });
      logLazyExplanation("response arrival", {
        mode,
        cacheKey,
        requestId: requestDescriptor?.requestId || null,
        debugRequestId: transportRequestId,
        responseSemanticId: data.semanticId || data.targetId || null,
        responseTitle: data.title || "",
        serverResponseTextLength: Number(data.responseTextLength || data.explanationLength || 0) || String(data.explanation || "").length,
        clientReceivedTextLength: String(data.explanation || "").length,
      });
      const resolved = resolveLazyExplanationForTarget(data, item);
      cache.set(cacheKey, resolved);
      writeSessionCache(cacheKey, resolved);
      recordHoverLifecycle("cached", {
        scope: "transport",
        terminal: true,
        requestId: null,
        transportRequestId,
        ownerId: null,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: resolved.semanticId || resolved.targetId || requestDescriptor?.targetId || null,
        explanationLength: String(resolved.explanation || "").length,
      });
      logLazyExplanation("API completed", {
        mode,
        cacheKey,
        requestId: requestDescriptor?.requestId || null,
        debugRequestId: transportRequestId,
        responseSemanticId: resolved.semanticId || resolved.targetId || null,
        storedHoverExplanationLength: String(resolved.explanation || "").length,
        durationMs: Math.round(performance.now() - startedAt),
        cached: Boolean(data.cached),
      });
      logLazyExplanation("request-complete", {
        mode,
        cacheKey,
        requestId: requestDescriptor?.requestId || null,
        debugRequestId: transportRequestId,
        targetId: requestDescriptor?.targetId || null,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return resolved;
    })
    .catch((error) => {
      if (isRateLimitError(error)) {
        logLazyExplanation("API returned 429", { mode, cacheKey });
      }
      if (mode === "pin") {
        logLazyExplanation("pin API failed", {
          mode,
          cacheKey,
          requestId: requestDescriptor?.requestId || null,
          debugRequestId: payload.debugRequestId,
          status: error?.status || null,
          message: error?.message || "Request failed",
          durationMs: Math.round(performance.now() - startedAt),
        });
      } else {
        logLazyExplanation("API failed", {
          mode,
          cacheKey,
          requestId: requestDescriptor?.requestId || null,
          debugRequestId: payload.debugRequestId,
          status: error?.status || null,
          message: error?.message || "Request failed",
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      recordHoverLifecycle(classifyHoverRequestFailure(error), {
        scope: "transport",
        terminal: true,
        requestId: null,
        transportRequestId,
        ownerId: null,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: requestDescriptor?.targetId || null,
        status: error?.status || null,
        errorCode: error?.body?.code || error?.code || null,
      });
      throw error;
    })
    .finally(() => {
      if (inFlightMap.get(cacheKey)?.promise === promise) inFlightMap.delete(cacheKey);
      if (mode === "pin") pinRequestLocks.delete(cacheKey);
    });

  inFlightMap.set(cacheKey, { promise, mode, transportRequestId });
  return { promise, shared: false, transportRequestId };
}

function useLazyExplanation(item, problem, mode, getToken, enabled = true, explanationLevel = "default") {
  const [state, setState] = useState(INITIAL_LAZY_EXPLANATION_STATE);
  const [committedLifecycle, setCommittedLifecycle] = useState(null);
  const cacheKey = item && enabled ? getLazyCacheKey(item, problem, mode, explanationLevel) : "";
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(null);
  const pendingCommitRef = useRef(null);
  const requestInputsRef = useRef({ item, problem, getToken });
  requestInputsRef.current = { item, problem, getToken };

  useEffect(() => {
    const {
      item: requestItem,
      problem: requestProblem,
    } = requestInputsRef.current;

    if (!requestItem || !enabled || !cacheKey) {
      activeRequestRef.current = null;
      pendingCommitRef.current = null;
      setCommittedLifecycle(null);
      setState((current) => reduceLazyExplanationLifecycle(current, { type: "idle" }));
      return undefined;
    }

    const cache = getMemoryCache(mode);
    const cached = cache.get(cacheKey) || readSessionCache(cacheKey);
    if (cached && shouldApplyLazyExplanation(requestItem, cached)) {
      cache.set(cacheKey, cached);
      logLazyExplanation(mode === "pin" ? "pin cache hit" : "cache hit", { mode, cacheKey });
      recordHoverLifecycle("cached", {
        requestId: null,
        ownerId: `${mode}:cache`,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: getLazyTargetId(requestItem) || null,
        reason: "memory-or-session-cache",
      });
      activeRequestRef.current = null;
      setState((current) => reduceLazyExplanationLifecycle(current, { type: "cache_hit", data: cached }));
      return undefined;
    }

    const cooldownUntil = requestCooldownUntil.get(cacheKey) || 0;
    if (cooldownUntil > Date.now()) {
      logLazyExplanation("API returned 429", { mode, cacheKey, paused: true });
      activeRequestRef.current = null;
      setState({
        loading: false,
        error: RATE_LIMIT_MESSAGE,
        data: null,
        phase: "error",
        request: null,
      });
      return undefined;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    lazyExplanationOwnerSequence += 1;
    const ownerId = `${mode}-owner-${lazyExplanationOwnerSequence}`;
    const request = {
      ...createLazyRequestDescriptor({
      requestId,
      cacheKey,
      mode,
      targetId: getLazyTargetId(requestItem),
      }),
      ownerId,
      transportRequestId: null,
    };
    activeRequestRef.current = request;
    let cancelled = false;
    const controller = new AbortController();
    const hoverFallback = mode === "pin" ? getCachedHoverFallback(requestItem, requestProblem) : null;
    const debounceMs = mode === "hover" ? HOVER_DEBOUNCE_MS : 0;
    let timerId = null;
    let loadingTimerId = null;
    let stillGeneratingTimerId = null;
    let timeoutId = null;
    let requestSettled = false;
    let ownerCommitted = false;
    let ownerTerminalState = "";

    const recordOwnerTerminal = (terminalState, details = {}) => {
      if (ownerTerminalState) return;
      ownerTerminalState = terminalState;
      recordHoverLifecycle(terminalState, {
        scope: "owner",
        terminal: true,
        requestId,
        transportRequestId: request.transportRequestId,
        ownerId,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: request.targetId || null,
        ...details,
      });
    };

    const identity = getHoverTargetIdentity(requestItem);
    logLazyExplanation(`${mode} requested`, {
      mode,
      cacheKey,
      requestId,
      targetId: request.targetId,
      semanticNodeId: identity.semanticId || identity.targetId || null,
      selectedText: identity.sourceText || requestItem?.selectedText || requestItem?.display || "",
      sourceRange: identity.sourceRange || null,
    });
    setState((current) => reduceLazyExplanationLifecycle(current, {
      type: "request_started",
      request,
      fallback: hoverFallback,
    }));
    pendingCommitRef.current = null;
    setCommittedLifecycle(null);
    logLazyExplanation("state update", {
      mode,
      cacheKey,
      requestId,
      transition: "request_started",
      phase: "pending",
      targetId: request.targetId,
    });
    recordHoverLifecycle("request_started", {
      scope: "owner",
      requestId,
      ownerId,
      ownerRevision: requestItem?.context?.revision ?? requestItem?.targetRevision ?? null,
      sessionId: requestItem?.context?.sessionId || requestItem?.sessionId || null,
      cacheKeyHash: stableHash(cacheKey),
      semanticId: request.targetId || null,
      mode,
    });

    const isCurrent = () => !cancelled && isCurrentLazyRequest(activeRequestRef.current, request);

    const startHoverLoadingTimers = () => {
      if (mode !== "hover") return;
      loadingTimerId = window.setTimeout(() => {
        if (!isCurrent()) return;
        setState((current) => reduceLazyExplanationLifecycle(current, {
          type: "loading_delay",
          request,
        }));
        logLazyExplanation("state update", {
          mode,
          cacheKey,
          requestId,
          transition: "loading_delay",
          phase: "loading",
          targetId: request.targetId,
        });
      }, HOVER_LOADING_DELAY_MS);
      stillGeneratingTimerId = window.setTimeout(() => {
        if (!isCurrent()) return;
        setState((current) => reduceLazyExplanationLifecycle(current, {
          type: "still_generating",
          request,
        }));
        logLazyExplanation("state update", {
          mode,
          cacheKey,
          requestId,
          transition: "still_generating",
          phase: "still-generating",
          targetId: request.targetId,
        });
      }, HOVER_STILL_GENERATING_DELAY_MS);
    };

    const runRequest = () => {
      if (cancelled) return;

      if (mode === "pin") {
        const cachedBeforePin = pinExplanationCache.get(cacheKey) || readSessionCache(cacheKey);
        if (cachedBeforePin) {
          pinExplanationCache.set(cacheKey, cachedBeforePin);
          logLazyExplanation("pin cache hit", { mode, cacheKey });
          recordHoverLifecycle("cached", {
            requestId,
            ownerId,
            cacheKeyHash: stableHash(cacheKey),
            semanticId: request.targetId || null,
            reason: "memory-or-session-cache",
          });
          if (shouldApplyLazyExplanation(requestItem, cachedBeforePin)) {
            activeRequestRef.current = null;
            setState((current) => reduceLazyExplanationLifecycle(current, {
              type: "cache_hit",
              data: cachedBeforePin,
            }));
          }
          return;
        }

        if (inFlightPinRequests.has(cacheKey)) {
          const requestHandle = createLazyRequest({
            cacheKey,
            mode,
            item: requestItem,
            problem: requestProblem,
            getToken: requestInputsRef.current.getToken,
            signal: controller.signal,
            requestDescriptor: request,
          });
          request.transportRequestId = requestHandle.transportRequestId;
          requestHandle.promise
            .then((resolved) => {
              requestSettled = true;
              if (!isCurrent()) {
                recordOwnerTerminal("stale_discarded", {
                  reason: "request-no-longer-current",
                });
                return;
              }
              const applies = shouldApplyLazyExplanation(requestItem, resolved);
              if (!applies) {
                recordOwnerTerminal("stale_discarded", {
                  responseSemanticId: resolved.targetId || resolved.semanticId || null,
                  reason: "target-mismatch",
                });
              } else {
                pendingCommitRef.current = {
                  request,
                  data: resolved,
                  ownerId,
                  markCommitted: () => { ownerCommitted = true; },
                };
              }
              logLazyExplanation("state update", {
                mode,
                cacheKey,
                requestId,
                transition: "request_succeeded",
                applies,
                reason: applies ? null : "target_mismatch",
                targetId: request.targetId,
                responseTargetId: resolved.targetId || null,
              });
              setState((current) => reduceLazyExplanationLifecycle(current, {
                type: "request_succeeded",
                request,
                data: resolved,
                applies,
                reason: applies ? null : "target_mismatch",
              }));
            })
            .catch((error) => {
              requestSettled = true;
              if (!isCurrent() || error?.name === "AbortError") {
                logLazyExplanation("request abort ignored", {
                  mode,
                  cacheKey,
                  requestId,
                  reason: error?.name === "AbortError" ? "AbortError" : "not-current",
                  targetId: request.targetId,
                });
                if (!isCurrent()) {
                  recordOwnerTerminal("stale_discarded", {
                    reason: "request-no-longer-current",
                  });
                }
                return;
              }
              if (isRateLimitError(error)) requestCooldownUntil.set(cacheKey, Date.now() + 5000);
              recordOwnerTerminal(classifyHoverRequestFailure(error), {
                status: error?.status || null,
                errorCode: error?.body?.code || error?.code || null,
              });
              logLazyExplanation("state update", {
                mode,
                cacheKey,
                requestId,
                transition: "request_failed",
                error: normalizeLazyError(error),
                targetId: request.targetId,
              });
              setState((current) => reduceLazyExplanationLifecycle(current, {
                type: "request_failed",
                request,
                error: normalizeLazyError(error),
                fallback: hoverFallback,
              }));
            });
          return;
        }

        if (pinRequestLocks.has(cacheKey)) {
          logLazyExplanation("pin request blocked duplicate", { mode, cacheKey });
          return;
        }
        pinRequestLocks.add(cacheKey);
      }

      if (mode === "hover") {
        activeHoverRequest = request;
        const waitMs = Math.max(0, nextHoverRequestAt - Date.now());
        if (waitMs > 0) {
          timerId = window.setTimeout(runRequest, waitMs);
          return;
        }
        nextHoverRequestAt = Date.now() + HOVER_RATE_LIMIT_MS;
      }

      startHoverLoadingTimers();
      timeoutId = window.setTimeout(() => {
        if (!isCurrent()) return;
        controller.abort();
        setState((current) => reduceLazyExplanationLifecycle(current, {
          type: "request_failed",
          request,
          error: HOVER_TIMEOUT_MESSAGE,
          fallback: hoverFallback,
        }));
        logLazyExplanation("request timed out", {
          mode,
          cacheKey,
          requestId,
          reason: "timeout",
          targetId: request.targetId,
        });
        recordOwnerTerminal("aborted", {
          reason: "ui-timeout",
        });
      }, mode === "hover" ? HOVER_TIMEOUT_MS : PIN_TIMEOUT_MS);

      const requestHandle = createLazyRequest({
        cacheKey,
        mode,
        item: requestItem,
        problem: requestProblem,
        getToken: requestInputsRef.current.getToken,
        signal: controller.signal,
        requestDescriptor: request,
      });
      request.transportRequestId = requestHandle.transportRequestId;
      requestHandle.promise
        .then((resolved) => {
          requestSettled = true;
          if (!isCurrent()) {
            logLazyExplanation("response-discarded", {
              mode,
              cacheKey,
              requestId,
              reason: "request-no-longer-current",
              targetId: request.targetId,
            });
            recordOwnerTerminal("stale_discarded", {
              reason: "request-no-longer-current",
            });
            return;
          }
          const applies = shouldApplyLazyExplanation(requestItem, resolved);
          if (!applies) {
            recordOwnerTerminal("stale_discarded", {
              responseSemanticId: resolved.targetId || resolved.semanticId || null,
              reason: "target-mismatch",
            });
          } else {
            pendingCommitRef.current = {
              request,
              data: resolved,
              ownerId,
              markCommitted: () => { ownerCommitted = true; },
            };
          }
          logLazyExplanation(applies ? "response-applied" : "response-discarded", {
            mode,
            cacheKey,
            requestId,
            reason: applies ? "target-matched" : "target-mismatch",
            targetId: request.targetId,
            responseTargetId: resolved.targetId || null,
          });
          logLazyExplanation("state update", {
            mode,
            cacheKey,
            requestId,
            transition: "request_succeeded",
            applies,
            reason: applies ? null : "target_mismatch",
            targetId: request.targetId,
            responseTargetId: resolved.targetId || null,
          });
          setState((current) => reduceLazyExplanationLifecycle(current, {
            type: "request_succeeded",
            request,
            data: resolved,
            applies,
            reason: applies ? null : "target_mismatch",
          }));
        })
        .catch((error) => {
          requestSettled = true;
          if (!isCurrent() || error?.name === "AbortError") {
            logLazyExplanation("request abort ignored", {
              mode,
              cacheKey,
              requestId,
              reason: error?.name === "AbortError" ? "AbortError" : "not-current",
              targetId: request.targetId,
            });
            if (!isCurrent()) {
              recordOwnerTerminal("stale_discarded", {
                reason: "request-no-longer-current",
              });
            }
            return;
          }
          if (isRateLimitError(error)) {
            requestCooldownUntil.set(cacheKey, Date.now() + 5000);
          }
          recordOwnerTerminal(classifyHoverRequestFailure(error), {
            status: error?.status || null,
            errorCode: error?.body?.code || error?.code || null,
          });
          logLazyExplanation("state update", {
            mode,
            cacheKey,
            requestId,
            transition: "request_failed",
            error: normalizeLazyError(error),
            targetId: request.targetId,
          });
          setState((current) => reduceLazyExplanationLifecycle(current, {
            type: "request_failed",
            request,
            error: normalizeLazyError(error),
            fallback: hoverFallback,
          }));
        })
        .finally(() => {
          if (timeoutId) {
            window.clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (loadingTimerId) {
            window.clearTimeout(loadingTimerId);
            loadingTimerId = null;
          }
          if (stillGeneratingTimerId) {
            window.clearTimeout(stillGeneratingTimerId);
            stillGeneratingTimerId = null;
          }
          if (isCurrentLazyRequest(activeRequestRef.current, request)) {
            activeRequestRef.current = null;
          }
          if (isCurrentLazyRequest(activeHoverRequest, request)) {
            activeHoverRequest = null;
          }
        })
        .catch(() => {
          // The preceding catch classifies and handles the UI transition. The
          // final cleanup branch must not create an unhandled rejection.
        });
    };

    timerId = window.setTimeout(runRequest, debounceMs);

    return () => {
      cancelled = true;
      if (!requestSettled && request.transportRequestId) {
        recordOwnerTerminal("hidden_before_completion", { reason: "effect-cleanup" });
      } else if (!requestSettled && !request.transportRequestId) {
        recordOwnerTerminal("owner_gone", { reason: "before-transport-start" });
      } else if (!ownerCommitted && !ownerTerminalState) {
        recordOwnerTerminal("owner_gone", { reason: "before-ui-commit" });
      }
      if (timerId) window.clearTimeout(timerId);
      if (loadingTimerId) window.clearTimeout(loadingTimerId);
      if (stillGeneratingTimerId) window.clearTimeout(stillGeneratingTimerId);
      if (timeoutId) window.clearTimeout(timeoutId);
      if (isCurrentLazyRequest(activeRequestRef.current, request)) {
        activeRequestRef.current = null;
      }
      if (mode === "hover") {
        if (isCurrentLazyRequest(activeHoverRequest, request)) activeHoverRequest = null;
        logLazyExplanation("hover cancelled", {
          mode,
          cacheKey,
          requestId,
          reason: "unmounted or changed",
          targetId: request.targetId,
        });
      }
      if (mode === "pin" && !inFlightPinRequests.has(cacheKey)) {
        pinRequestLocks.delete(cacheKey);
      }
    };
  }, [cacheKey, enabled, explanationLevel, mode]);

  useEffect(() => {
    const pending = pendingCommitRef.current;
    if (!pending || state.phase !== "ready" || state.data !== pending.data) return;
    pendingCommitRef.current = null;
    pending.markCommitted();
    const lifecycle = {
      requestId: pending.request.requestId,
      transportRequestId: pending.request.transportRequestId,
      ownerId: pending.ownerId,
      cacheKeyHash: stableHash(pending.request.cacheKey),
      semanticId: pending.request.targetId || null,
    };
    recordHoverLifecycle("committed_to_ui", {
      scope: "owner",
      terminal: false,
      ...lifecycle,
    });
    setCommittedLifecycle(lifecycle);
  }, [state.data, state.phase]);

  return { ...state, lifecycle: committedLifecycle };
}

let lensStackSequence = 80;

const FloatingWindow = React.memo(/** @param {{item:any,index:number,problem:any,getToken:any,position:any,onMeasure:any,canvas:HTMLElement,presentation:string,visible:boolean,onInspectCollapse:any}} props */ function FloatingWindow({ item, index, problem, getToken, position, onMeasure, canvas, presentation, visible, onInspectCollapse }) {
  const { clearHoverLens, closeExplanationWindow, updateExplanationWindow } = useHoverActions();
  const { settings } = useSettings();
  const reducedMotion = useReducedMotion();
  const windowRef = useRef(null);
  const bodyContentRef = useRef(null);
  const [bodyHeight, setBodyHeight] = useState(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const inspector = presentation === "inspector";
  const collapsed = !inspector && Boolean(item.collapsed);
  const currentTarget = lensTargetIsCurrent(item, problem);
  useLayoutEffect(() => {
    recordOmniDiagnostic("react.commit.lens-card", { lensId: item.id });
  });
  useLayoutEffect(() => {
    const content = bodyContentRef.current;
    if (!content || !visible) return undefined;
    const measure = () => {
      const height = content.offsetHeight;
      if (height) setBodyHeight((previous) => previous === height ? previous : height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [visible, presentation]);
  const lazyState = useLazyExplanation(item, problem, "pin", getToken, item.referenceType !== "concept" && currentTarget, "standard");
  const explanationText = item.lastDisplayedExplanation || lazyState.data?.explanation
    || item.content?.intermediate || item.title;
  const identity = getHoverTargetIdentity(item);
  const selectedMath = identity.sourceText || item.sourceText || item.selectedText || item.display
    || item.provenanceSnapshot?.origin?.currentStep?.math || "";
  useEffect(() => {
    if (!lazyState.data?.explanation || item.lastDisplayedExplanation) return;
    updateExplanationWindow(item.id, { lastDisplayedExplanation: lazyState.data.explanation });
  }, [lazyState.data, item.id, item.lastDisplayedExplanation, updateExplanationWindow]);
  const persistConversation = useCallback(({ messages, draft, status }) => {
    updateExplanationWindow(item.id, { chatHistory: messages, conversationDraft: draft, conversationStatus: status });
  }, [item.id, updateExplanationWindow]);
  useLayoutEffect(() => {
    const element = windowRef.current;
    if (!element) return undefined;
    const reportSize = () => {
      if (!inspector && visible && element.offsetWidth) onMeasure(item.id, { width: element.offsetWidth, height: element.offsetHeight });
    };
    reportSize();
    const observer = new ResizeObserver(reportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [item.id, onMeasure, inspector, visible]);
  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag?.frameId) cancelAnimationFrame(drag.frameId);
    if (drag) document.body.style.userSelect = drag.previousUserSelect;
  }, []);
  const applyDrag = useCallback((drag) => {
    if (!windowRef.current || !drag) return;
    const measurement = startOmniMeasure("lens.drag-frame", { lensId: item.id });
    const rect = canvas.getBoundingClientRect();
    const next = clampCanvasPosition(drag.clientX - drag.offsetX - rect.left, drag.clientY - drag.offsetY - rect.top, canvas.clientWidth, drag.size);
    drag.x = next.x; drag.y = next.y;
    canvas.style.setProperty("--omni-lens-extent", `${Math.min(MAX_CANVAS_EXTENT, Math.max(drag.extent, drag.y + drag.size.height + 32))}px`);
    windowRef.current.style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0)`;
    endOmniMeasure(measurement);
  }, [canvas, item.id]);
  useLayoutEffect(() => { if (dragRef.current) applyDrag(dragRef.current); });
  const savePosition = (x, y, size) => {
    const available = Math.max(1, canvas.clientWidth - size.width - 24);
    const next = clampCanvasPosition(x, y, canvas.clientWidth, size);
    updateExplanationWindow(item.id, { placementMode: "manual", coordinateSpace: "canvas-v1", ...next,
      xRatio: Math.max(0, Math.min(1, (x - 12) / available)),
      positionAnchor: null });
  };
  const finishDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.frameId) cancelAnimationFrame(drag.frameId);
    drag.clientX = event.clientX; drag.clientY = event.clientY;
    applyDrag(drag);
    savePosition(drag.x, drag.y, drag.size);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.style.userSelect = drag.previousUserSelect;
    dragRef.current = null; setDragging(false);
  };
  const moveDrag = (event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); drag.clientX = event.clientX; drag.clientY = event.clientY;
    if (settings.interaction.lensDragSmoothness === "precise") { applyDrag(drag); return; }
    if (drag.frameId) return;
    drag.frameId = requestAnimationFrame(() => { drag.frameId = 0; applyDrag(drag); });
  };
  const startDrag = (event) => {
    if (event.button !== 0 || inspector) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault(); event.stopPropagation(); clearHoverLens();
    event.currentTarget.focus(); event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      extent: Number.parseFloat(canvas.style.getPropertyValue("--omni-lens-extent")) || 0,
      size: { width: rect.width, height: rect.height }, frameId: 0, previousUserSelect: document.body.style.userSelect };
    updateExplanationWindow(item.id, { stackOrder: ++lensStackSequence });
    document.body.style.userSelect = "none"; setDragging(true);
  };
  // Canvas coordinates own the transform; layout projection must not overwrite them.
  return (
    <motion.article ref={windowRef} data-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-tooltip-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-source-range={identity.sourceRange ? `${identity.sourceRange.start}:${identity.sourceRange.end}` : undefined}
      data-pinned-lens={item.lensId || item.id} data-coordinate-space="canvas-v1"
      data-lens-presentation={presentation} data-presentation-visible={visible ? "true" : "false"}
      aria-hidden={!visible || undefined} {...(!visible ? { inert: "" } : {})}
      data-placement-mode={item.placementMode === "manual" ? "manual" : "stacked"}
      data-spawn-state={position.spawnState || "organized"} data-collapsed={collapsed ? "true" : "false"}
      layout={false}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: reducedMotion ? 1 : .98 }}
      transition={{ duration: reducedMotion ? 0 : .18, ease: "easeOut" }}
      className={cn("omni-floating-window omni-pinned-card absolute left-0 top-0 flex flex-col overflow-hidden rounded-xl", dragging && "omni-floating-window-dragging")}
      style={{ transform: inspector ? "none" : `translate3d(${position.x}px, ${position.y}px, 0)`, zIndex: item.stackOrder || 70 + index }}>
      <div className="omni-lens-header flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2.5">
        <div data-pinned-drag-handle role={inspector ? undefined : "button"} tabIndex={inspector ? undefined : 0} aria-label={inspector ? undefined : "Move explanation with arrow keys"} className="flex min-w-0 flex-1 touch-none cursor-grab items-center gap-2"
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
          onKeyDown={(event) => {
            const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!direction || inspector) return;
            event.preventDefault(); const rect = windowRef.current.getBoundingClientRect();
            savePosition(Math.max(12, position.x + direction[0] * (event.shiftKey ? 40 : 10)), Math.max(12, position.y + direction[1] * (event.shiftKey ? 40 : 10)), { width: rect.width, height: rect.height });
          }}>
          {!inspector && <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
          <h3 data-lens-target-preview className="omni-lens-target-preview" aria-label={selectedMath}>
            <MathRenderer math={selectedMath} displayMode={false} />
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => inspector ? onInspectCollapse() : updateExplanationWindow(item.id, { collapsed: !collapsed })} aria-label={inspector ? "Collapse inspector" : collapsed ? "Expand explanation" : "Collapse explanation"} aria-expanded={!collapsed} aria-controls={`lens-body-${item.id}`} className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100">
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <button type="button" onClick={() => closeExplanationWindow(item.id)} aria-label="Unpin explanation" className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100"><Pin className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => closeExplanationWindow(item.id)} aria-label="Close explanation" className="rounded-lg p-1.5 text-neutral-500 hover:bg-rose-50"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <motion.div id={`lens-body-${item.id}`} className="omni-lens-body" initial={false}
        animate={{ height: collapsed ? 0 : bodyHeight ?? "auto", opacity: collapsed ? 0 : 1 }} transition={{ duration: reducedMotion ? 0 : .2, ease: [.2, .8, .2, 1] }}
        aria-hidden={collapsed || undefined} {...(collapsed ? { inert: "" } : {})}>
        <div ref={bodyContentRef}>
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <select value={presentationDepth(item.depth)} onChange={(event) => updateExplanationWindow(item.id, { depth: event.target.value })} aria-label="Response detail" className="omni-lens-depth">
            <option value="concise">Concise</option><option value="standard">Standard</option><option value="detailed">Detailed</option>
          </select>
          <button type="button" aria-label="Ask follow-up" title="Ask about this mathematics" onClick={() => windowRef.current?.querySelector("input")?.focus()} className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100"><MessageCircle className="h-3.5 w-3.5" /></button>
        </div>
        <div className="omni-lens-explanation omni-scrollbar px-3 py-3 text-sm leading-6 text-neutral-800">
          {lazyState.loading && !item.lastDisplayedExplanation && !lazyState.data ? <div role="status" className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading explanation…</div>
            : <ConversationText>{explanationText}</ConversationText>}
          {lazyState.error && <p role="alert" className="omni-conversation-error">{lazyState.error}</p>}
          {!currentTarget && <p role="status" className="text-xs text-amber-700">The source solution changed. This conversation remains bound to its original object.</p>}
        </div>
        <ScopedConversation item={item} problem={problem} getToken={getToken} displayedExplanation={explanationText}
          presentationDepth={presentationDepth(item.depth)} onConversationChange={persistConversation} disabled={!currentTarget} />
        </div>
      </motion.div>
    </motion.article>
  );
});

export function ExplanationPopover() {
  const {
    explanationLevel,
    hoverLens,
  } = useHoverTooltipState();
  const {
    holdHoverLens,
    releaseHoverLens,
    reconcileHoverOwnership,
    reportHoverLifecycle,
  } = useHoverActions();
  const { getToken } = useAuthToken();
  const tooltipRef = useRef(null);
  const tooltipPointerInsideRef = useRef(false);
  const tooltipDomInstanceRef = useRef({ lensId: null, identity: "" });
  if (hoverLens?.id && tooltipDomInstanceRef.current.lensId !== hoverLens.id) {
    tooltipPointerInsideRef.current = false;
    tooltipDomInstanceSequence += 1;
    tooltipDomInstanceRef.current = {
      lensId: hoverLens.id,
      identity: `quick-tooltip-${tooltipDomInstanceSequence}`,
    };
  }
  const [adjustedPosition, setAdjustedPosition] = useState(null);
  const [maxTooltipHeight, setMaxTooltipHeight] = useState(null);
  const hoverDepth = explanationLevel >= 2 ? "intermediate" : "beginner";
  const lazyState = useLazyExplanation(
    hoverLens,
    hoverLens?.context?.problem,
    "hover",
    getToken,
    Boolean(hoverLens),
    hoverDepth
  );
  const content = hoverLens
    ? (explanationLevel >= 2 ? hoverLens.content?.intermediate : hoverLens.content?.beginner)
    : "";
  const identity = hoverLens ? getHoverTargetIdentity(hoverLens) : {};
  const displayTitle = hoverLens ? userFacingTooltipTitle({
    title: identity.tooltipTitle || identity.label || hoverLens.title,
    selectedText: identity.sourceText || hoverLens.selectedText || hoverLens.display,
    display: hoverLens.display,
    latex: hoverLens.latex,
    role: hoverLens.role,
  }) : "";
  const lazyContent = lazyState.data?.explanation || content || displayTitle;
  const loadingMessage = getLazyLoadingMessage("hover", lazyState.phase);
  const renderedLifecycleKeyRef = useRef("");
  const hoverUiObservationRef = useRef(null);

  useEffect(() => {
    if (!hoverLens) {
      renderedLifecycleKeyRef.current = "";
    }
  }, [hoverLens?.id]);

  useEffect(() => {
    if (!hoverLens) return undefined;
    const identity = getHoverTargetIdentity(hoverLens);
    const tooltipDomIdentity = tooltipDomInstanceRef.current.identity;
    logLazyExplanation("tooltip mount", {
      semanticNodeId: identity.semanticId || identity.targetId || null,
      selectedText: identity.sourceText || hoverLens.selectedText || hoverLens.display || "",
      sourceRange: identity.sourceRange || null,
      tooltipId: hoverLens.id,
    });
    reportHoverLifecycle("tooltip-mounted", {
      tokenStableId: identity.semanticId || identity.targetId || null,
      tooltipDomIdentity,
    });
    reconcileHoverOwnership("tooltip-mounted");
    return () => {
      logLazyExplanation("tooltip unmount", {
        semanticNodeId: identity.semanticId || identity.targetId || null,
        selectedText: identity.sourceText || hoverLens.selectedText || hoverLens.display || "",
        sourceRange: identity.sourceRange || null,
        tooltipId: hoverLens.id,
      });
      reportHoverLifecycle("tooltip-unmounted", {
        tokenStableId: identity.semanticId || identity.targetId || null,
        tooltipDomIdentity,
      });
    };
  }, [hoverLens?.id, reconcileHoverOwnership, reportHoverLifecycle]);

  useEffect(() => {
    const tooltip = tooltipRef.current;
    const lifecycle = lazyState.lifecycle;
    const providerExplanation = String(lazyState.data?.explanation || "").trim();
    if (!hoverLens || !lifecycle || lazyState.phase !== "ready") {
      return undefined;
    }
    const cacheKey = getLazyCacheKey(hoverLens, hoverLens?.context?.problem, "hover", hoverDepth);
    const identity = getHoverTargetIdentity(hoverLens);
    const observationKey = `${lifecycle.ownerId}:${lifecycle.transportRequestId}`;
    const previousObservation = hoverUiObservationRef.current;
    if (previousObservation?.key === observationKey && previousObservation.terminal) return undefined;
    if (previousObservation && previousObservation.key !== observationKey && !previousObservation.terminal) {
      previousObservation.finish("owner_gone", { reason: "lifecycle-replaced-before-ui-observation" });
    }
    const observation = {
      key: observationKey,
      terminal: false,
      finish: null,
    };
    const finishObservation = (state, details = {}) => {
      if (observation.terminal) return;
      observation.terminal = true;
      recordHoverLifecycle(state, {
        scope: "owner",
        terminal: true,
        requestId: lifecycle.requestId,
        transportRequestId: lifecycle.transportRequestId,
        ownerId: lifecycle.ownerId,
        cacheKeyHash: stableHash(cacheKey),
        semanticId: identity.semanticId || identity.targetId || null,
        tooltipDomIdentity: tooltipDomInstanceRef.current.identity,
        ...details,
      });
    };
    observation.finish = finishObservation;
    hoverUiObservationRef.current = observation;

    if (!providerExplanation) {
      finishObservation("render_input_empty", {
        explanationLength: String(lazyState.data?.explanation || "").length,
      });
      return undefined;
    }
    if (!tooltip || !tooltip.isConnected) {
      finishObservation("owner_gone", { reason: "tooltip-not-connected" });
      return undefined;
    }
    const emitRendered = () => {
      const providerBody = tooltip.querySelector("[data-hover-provider-explanation='true']");
      const renderedText = String(providerBody?.textContent || "").trim();
      if (!renderedText) return false;
      const key = `${tooltipDomInstanceRef.current.identity}:${lifecycle.ownerId}:${cacheKey}:${renderedText}`;
      if (renderedLifecycleKeyRef.current === key) return true;
      renderedLifecycleKeyRef.current = key;
      finishObservation("rendered", {
        renderedTextLength: renderedText.length,
      });
      return true;
    };
    emitRendered();
    const frameId = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => {
          if (emitRendered() || observation.terminal) return;
          const providerBody = tooltip.querySelector("[data-hover-provider-explanation='true']");
          finishObservation(tooltip.isConnected ? "rendered_empty" : "owner_gone", {
            reason: tooltip.isConnected
              ? (providerBody ? "provider-body-empty" : "provider-body-missing")
              : "tooltip-disconnected-before-ui-observation",
            renderedTextLength: 0,
          });
        })
      : null;
    const observer = typeof MutationObserver === "function"
      ? new MutationObserver(emitRendered)
      : null;
    observer?.observe(tooltip, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frameId !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
      observer?.disconnect();
      queueMicrotask(() => {
        if (hoverUiObservationRef.current === observation && !observation.terminal) {
          finishObservation("owner_gone", { reason: "tooltip-unmounted-before-ui-observation" });
        }
      });
    };
  }, [hoverDepth, hoverLens, lazyState.data?.explanation, lazyState.lifecycle, lazyState.phase]);

  useLayoutEffect(() => {
    setAdjustedPosition(null);
  }, [hoverLens?.id, hoverLens?.x, hoverLens?.y]);

  const recalculateTooltipPosition = useCallback(() => {
    const tooltip = tooltipRef.current;
    const anchor = hoverLens?.anchor;
    if (!tooltip || !anchor || typeof window === "undefined") return;

    const viewport = {
      width: window.visualViewport?.width || window.innerWidth,
      height: window.visualViewport?.height || window.innerHeight,
    };
    if (tooltipPointerInsideRef.current) return;
    const padding = 12;
    const tooltipRect = tooltip.getBoundingClientRect();
    const size = {
      width: Math.min(Math.ceil(tooltipRect.width || 280), Math.max(160, viewport.width - padding * 2)),
      height: Math.min(Math.ceil(tooltipRect.height || 120), Math.max(80, viewport.height - padding * 2)),
    };
    const next = getTooltipPositionFromRect(anchor, {
      size,
      viewport,
      gap: 12,
      padding,
    });
    const clamped = clampTooltipPosition(next.x, next.y, size, viewport, padding);
    setMaxTooltipHeight(Math.max(80, viewport.height - padding * 2));
    setAdjustedPosition((current) => (
      current && Math.abs(current.x - clamped.x) < 1 && Math.abs(current.y - clamped.y) < 1
        ? current
        : clamped
    ));
    logLazyExplanation("tooltip measurement", {
      tooltipMeasuredWidth: tooltipRect.width,
      tooltipMeasuredHeight: tooltipRect.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      anchor,
      chosenX: next.x,
      chosenY: next.y,
      finalClampedX: clamped.x,
      finalClampedY: clamped.y,
      scrollWidth: tooltip.scrollWidth,
      clientWidth: tooltip.clientWidth,
      scrollHeight: tooltip.scrollHeight,
      clientHeight: tooltip.clientHeight,
      responseTextLength: String(lazyState.data?.explanation || "").length,
      renderedTextLength: tooltip.textContent?.length || 0,
    });
    reportHoverLifecycle("tooltip-resized", {
      tokenStableId: identity.semanticId || identity.targetId || null,
      tooltipDomIdentity: tooltipDomInstanceRef.current.identity,
      tooltipRect: {
        left: tooltipRect.left,
        top: tooltipRect.top,
        width: tooltipRect.width,
        height: tooltipRect.height,
      },
      responseTextLength: String(lazyState.data?.explanation || "").length,
    });
    requestAnimationFrame(() => reconcileHoverOwnership("tooltip-resized-or-repositioned"));
  }, [hoverLens?.anchor, identity.semanticId, identity.targetId, lazyState.data?.explanation, reconcileHoverOwnership, reportHoverLifecycle]);

  const handleTooltipPointerEnter = useCallback((event) => {
    tooltipPointerInsideRef.current = true;
    holdHoverLens(event);
  }, [holdHoverLens]);

  const handleTooltipPointerMove = useCallback((event) => {
    tooltipPointerInsideRef.current = true;
    holdHoverLens(event);
  }, [holdHoverLens]);

  const handleTooltipPointerLeave = useCallback((event) => {
    tooltipPointerInsideRef.current = false;
    releaseHoverLens(event);
  }, [releaseHoverLens]);

  useLayoutEffect(() => {
    if (!hoverLens) return undefined;
    recalculateTooltipPosition();
    let frame = requestAnimationFrame(recalculateTooltipPosition);
    const tooltip = tooltipRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined" && tooltip
      ? new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(recalculateTooltipPosition);
        })
      : null;
    resizeObserver?.observe(tooltip);
    const handleViewportChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recalculateTooltipPosition);
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener?.("resize", handleViewportChange);
    window.visualViewport?.addEventListener?.("scroll", handleViewportChange);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener?.("resize", handleViewportChange);
      window.visualViewport?.removeEventListener?.("scroll", handleViewportChange);
    };
  }, [hoverLens, lazyContent, lazyState.error, lazyState.loading, lazyState.phase, recalculateTooltipPosition]);

  if (!hoverLens) return null;
  const initialPosition = adjustedPosition || getInitialClampedTooltipPosition(hoverLens);
  const lazyTargetId = lazyState.request?.targetId
    || lazyState.data?.semanticId
    || lazyState.data?.targetId
    || null;

  const tooltipNode = (
    <motion.div
      ref={tooltipRef}
      data-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-tooltip-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-lazy-target-id={lazyTargetId || undefined}
      data-lazy-phase={lazyState.phase}
      data-source-range={identity.sourceRange ? `${identity.sourceRange.start}:${identity.sourceRange.end}` : undefined}
      data-tooltip-dom-instance={tooltipDomInstanceRef.current.identity}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.14 }}
      className="omni-quick-tooltip fixed z-[80] w-max max-w-[min(360px,calc(100vw-24px))] rounded-xl px-3 py-2"
      style={{
        left: initialPosition.x,
        top: initialPosition.y,
        maxHeight: maxTooltipHeight ? `${maxTooltipHeight}px` : "calc(100vh - 24px)",
      }}
      onMouseEnter={handleTooltipPointerEnter}
      onMouseMove={handleTooltipPointerMove}
      onMouseLeave={handleTooltipPointerLeave}
    >
      <h3 className="mb-1 text-xs font-semibold text-neutral-900"><MathText>{displayTitle}</MathText></h3>
      {lazyState.error ? (
        <div className="text-xs leading-5 text-rose-700">
          {lazyState.error}
        </div>
      ) : lazyState.loading && loadingMessage ? (
        <div className="flex items-center gap-2 text-xs leading-5 text-neutral-600">
          <Loader2 className="h-3 w-3 animate-spin text-neutral-500" />
          {loadingMessage}
        </div>
      ) : (
        <div
          data-hover-provider-explanation={lazyState.data?.explanation ? "true" : undefined}
          className="omni-math-text max-w-full overflow-x-hidden break-words text-xs leading-5 text-neutral-700 omni-scrollbar"
        >
          <MathText>{lazyContent}</MathText>
        </div>
      )}
    </motion.div>
  );
  return typeof document !== "undefined" ? createPortal(tooltipNode, document.body) : tooltipNode;
}

export function PinnedLensLayer({ problem }) {
  const { lenses: pinnedLenses, selectedLensId, inspectorOpen, selectLens, collapseInspector } = useLensWorkspace();
  const { settings } = useSettings();
  const presentation = settings.interaction.explanationWorkspace;
  const { getToken } = useAuthToken();
  const [canvas, setCanvas] = useState(null);
  const [cardSizes, setCardSizes] = useState({});
  const [geometry, setGeometry] = useState({ width: 800, targetTops: {} });
  const membership = pinnedLenses.map((item) => `${item.id}:${item.stepId}`).join("|");
  const lensesRef = useRef(pinnedLenses);
  lensesRef.current = pinnedLenses;
  const handleMeasure = useCallback((id, size) => {
    const next = { width: Math.round(size.width), height: Math.round(size.height) };
    setCardSizes((current) => current[id]?.width === next.width && current[id]?.height === next.height ? current : { ...current, [id]: next });
  }, []);
  useLayoutEffect(() => { setCanvas(document.querySelector("[data-lens-canvas]")); }, []);
  useLayoutEffect(() => {
    if (!canvas) return undefined;
    let frame = 0;
    let previousWidth = -1;
    let previousContentWidth = -1;
    const content = canvas.firstElementChild;
    const measure = () => {
      const measurement = startOmniMeasure("lens.workspace-geometry");
      frame = 0;
      const rect = canvas.getBoundingClientRect();
      const targetTops = {};
      const steps = [...canvas.querySelectorAll("[data-step-id]")];
      for (const item of lensesRef.current) {
        const step = steps.find((node) => node.getAttribute("data-step-id") === item.stepId);
        if (step) targetTops[item.id] = step.getBoundingClientRect().top - rect.top;
      }
      previousWidth = canvas.clientWidth;
      previousContentWidth = content?.clientWidth ?? previousWidth;
      setGeometry({ width: previousWidth, targetTops });
      endOmniMeasure(measurement, { lenses: lensesRef.current.length });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(() => {
      // A streamed note changing paper height does not invalidate unchanged math.
      if (canvas.clientWidth !== previousWidth || (content?.clientWidth ?? canvas.clientWidth) !== previousContentWidth) schedule();
    });
    observer.observe(canvas);
    if (content) observer.observe(content);
    measure();
    window.addEventListener("resize", schedule);
    return () => { observer.disconnect(); window.removeEventListener("resize", schedule); cancelAnimationFrame(frame); };
  }, [canvas, membership, problem.id, problem.steps]);
  const spatialKey = pinnedLenses.map((item) => [item.id, item.collapsed, item.placementMode, item.x, item.y, item.xRatio, item.positionAnchor?.offsetY].join(":")).join("|");
  const previousPositionsRef = useRef({});
  const positions = useMemo(() => {
    const measurement = startOmniMeasure("lens.position-reflow");
    const resolved = resolveLensPositions(lensesRef.current, cardSizes, geometry.width, geometry.targetTops);
    Object.keys(resolved).forEach((id) => {
      resolved[id].targetTop = geometry.targetTops[id];
      const previous = previousPositionsRef.current[id];
      if (previous && Object.keys(resolved[id]).every((key) => previous[key] === resolved[id][key])) resolved[id] = previous;
    });
    previousPositionsRef.current = resolved;
    endOmniMeasure(measurement, { lenses: lensesRef.current.length });
    return resolved;
  }, [spatialKey, cardSizes, geometry]);
  useLayoutEffect(() => {
    if (!canvas) return;
    let timer;
    const desired = presentation === "canvas"
      ? Math.min(MAX_CANVAS_EXTENT, Math.max(0, ...Object.values(positions).map((point) => point.y + point.height + 32))) : 0;
    const apply = () => {
      const origin = canvas.getBoundingClientRect().top + window.scrollY;
      const visibleFloor = Math.max(0, window.scrollY - origin + window.innerHeight);
      const next = Math.min(MAX_CANVAS_EXTENT, Math.max(desired, visibleFloor));
      canvas.style.setProperty("--omni-lens-extent", `${next}px`);
      canvas.dataset.logicalCanvasExtent = String(Math.round(next));
    };
    const previous = Number.parseFloat(canvas.style.getPropertyValue("--omni-lens-extent")) || 0;
    if (desired >= previous) apply();
    else timer = window.setTimeout(apply, 240);
    window.addEventListener("scroll", apply, { passive: true });
    return () => { clearTimeout(timer); window.removeEventListener("scroll", apply); };
  }, [canvas, positions, presentation]);
  const notes = <div className={cn("omni-lens-layer", presentation === "inspector" && "omni-inspector-panel")} data-pinned-lens-layer data-explanation-workspace={presentation}>
    <AnimatePresence>{pinnedLenses.map((item, index) => <FloatingWindow key={item.lensId || item.id} item={item} index={index} problem={problem} getToken={getToken}
      canvas={canvas} position={positions[item.id] || { x: 12, y: 12 }} onMeasure={handleMeasure}
      presentation={presentation} visible={presentation === "canvas" || (inspectorOpen && item.id === selectedLensId)} onInspectCollapse={collapseInspector} />)}</AnimatePresence>
    {presentation === "inspector" && !inspectorOpen && selectedLensId && <button type="button" className="omni-inspector-reopen" aria-label="Open inspector" onClick={() => selectLens(selectedLensId)}><PanelRightOpen className="h-4 w-4" /></button>}
  </div>;
  return <>{canvas && createPortal(notes, canvas)}<AnimatePresence><ExplanationPopover /></AnimatePresence></>;
}

export default function ExplanationPanel({ problem }) {
  useEffect(() => {
    logSolutionState("ExplanationPanel props", {
      problemId: problem?.id,
      sessionId: problem?.sessionId,
      propStepCount: getSolutionSteps(problem || {}).length,
    });
  }, [problem]);
  return <PinnedLensLayer problem={problem} />;
}
