import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { GripHorizontal, Loader2, Pin, Send, X } from "lucide-react";
import InlineMath from "./InlineMath";
import MathText from "./MathText";
import { explainFollowup, explainPin, explainToken } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { useHoverActions, useHoverSemanticState, useHoverTooltipState } from "@/lib/HoverContext";
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
import {
  buildProvenanceSnapshot,
  buildFollowupPayload,
  getConversationId,
  getTargetRevision,
} from "@/lib/explanationProvenance";
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupRequestDescriptor,
  isSameFollowupRequest,
  recordFollowupLifecycle,
  reduceFollowupLifecycle,
  responseOwnsFollowupRequest,
} from "@/lib/followupLifecycle";
import { classifyHoverRequestFailure, recordHoverRequestLifecycle } from "@/lib/hoverRequestLifecycle";

const DEPTHS = [
  { key: "beginner", label: "Beginner" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
  { key: "exam", label: "Exam" },
  { key: "intuition", label: "Intuition" },
  { key: "professor", label: "Professor" },
];

const HOVER_DEBOUNCE_MS = 400;
const HOVER_RATE_LIMIT_MS = 1000;
const FOLLOWUP_TIMEOUT_MS = 35000;
const RATE_LIMIT_MESSAGE = "Explanation paused. Try again in a few seconds.";
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

let followupRequestSequence = 0;

function nextFollowupRequestId() {
  followupRequestSequence += 1;
  return `followup-${Date.now().toString(36)}-${followupRequestSequence.toString(36)}`;
}

function FollowupChat({ item, problem, getToken, displayedExplanation }) {
  const { updateExplanationWindow } = useHoverActions();
  const provenanceSnapshot = useMemo(() => buildProvenanceSnapshot({ item, problem }), [item, problem]);
  const targetRevision = item.targetRevision || getTargetRevision(provenanceSnapshot);
  const conversationId = item.conversationId || getConversationId(provenanceSnapshot);
  const followupReducer = /** @type {React.Reducer<any, any>} */ (reduceFollowupLifecycle);
  const [state, dispatch] = useReducer(followupReducer, {
    ...INITIAL_FOLLOWUP_STATE,
    messages: Array.isArray(item.chatHistory) ? item.chatHistory : [],
  });
  const activeRequestRef = useRef(null);
  const acceptedAnswerRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const mountedRef = useRef(true);
  const followupDebug = DEBUG_SOLUTION_STATE || DEBUG_MATH_HOVER;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRequestRef.current;
      if (active) {
        recordFollowupLifecycle("owner_gone", {
          requestId: active.requestId,
          conversationId: active.conversationId,
          targetRevision: active.targetRevision,
          reason: "component-unmounted",
        }, { debug: followupDebug });
      }
      activeRequestRef.current?.controller?.abort();
    };
  }, [followupDebug]);

  useEffect(() => {
    const previous = activeRequestRef.current;
    if (previous) {
      recordFollowupLifecycle("owner_gone", {
        requestId: previous.requestId,
        conversationId: previous.conversationId,
        targetRevision: previous.targetRevision,
        reason: "conversation-or-revision-changed",
      }, { debug: followupDebug });
    }
    activeRequestRef.current?.controller?.abort();
    activeRequestRef.current = null;
    acceptedAnswerRef.current = null;
    dispatch({ type: "reset", messages: Array.isArray(item.chatHistory) ? item.chatHistory : [] });
  }, [conversationId, followupDebug, targetRevision]);

  useLayoutEffect(() => {
    const accepted = acceptedAnswerRef.current;
    if (!accepted) return undefined;
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.role !== "assistant" || lastMessage.requestId !== accepted.requestId) return undefined;
    const messageElement = [...(chatMessagesRef.current?.querySelectorAll("[data-followup-request-id]") || [])]
      .find((element) => element.dataset.followupRequestId === accepted.requestId);
    if (!messageElement?.isConnected) return undefined;

    recordFollowupLifecycle("committed_to_ui", {
      ...accepted,
      messageCount: state.messages.length,
      domConnected: true,
    }, { debug: followupDebug });

    const frameId = window.requestAnimationFrame(() => {
      const renderedText = String(messageElement.textContent || "").trim();
      if (!mountedRef.current || !messageElement.isConnected || !renderedText) return;
      recordFollowupLifecycle("rendered", {
        ...accepted,
        messageCount: state.messages.length,
        renderedTextLength: renderedText.length,
      }, { debug: followupDebug });
      if (acceptedAnswerRef.current?.requestId === accepted.requestId) {
        acceptedAnswerRef.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [followupDebug, state.messages]);

  useEffect(() => {
    const correlatedRequestId = state.messages.at(-1)?.requestId || activeRequestRef.current?.requestId || null;
    recordFollowupLifecycle("local_window_update_requested", {
      requestId: correlatedRequestId,
      conversationId,
      targetRevision,
      messageCount: state.messages.length,
    }, { debug: followupDebug });
    updateExplanationWindow(item.id, {
      chatHistory: state.messages,
      conversationId,
      targetRevision,
    });
  }, [conversationId, followupDebug, item.id, state.messages, targetRevision, updateExplanationWindow]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = state.draft.trim();
    if (!trimmed || activeRequestRef.current) return;

    const request = createFollowupRequestDescriptor({
      requestId: nextFollowupRequestId(),
      conversationId,
      targetRevision,
    });
    const controller = new AbortController();
    const requestState = { ...request, controller };
    activeRequestRef.current = requestState;
    recordFollowupLifecycle("request_started", {
      ...request,
      questionLength: trimmed.length,
    }, { debug: followupDebug });
    dispatch({ type: "request_started", request, question: trimmed });
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FOLLOWUP_TIMEOUT_MS);

    try {
      const data = await explainFollowup({
        getToken,
        signal: controller.signal,
        payload: buildFollowupPayload({
          request,
          provenanceSnapshot,
          item,
          problem,
          displayedExplanation,
          question: trimmed,
          history: state.messages,
        }),
      });
      recordFollowupLifecycle("api_parsed", {
        ...request,
        answerLength: String(data.answer || "").length,
      }, { debug: followupDebug });
      if (!mountedRef.current) {
        recordFollowupLifecycle("owner_gone", { ...request, reason: "component-unmounted-before-response" }, { debug: followupDebug });
        return;
      }
      if (!isSameFollowupRequest(activeRequestRef.current, request)) {
        recordFollowupLifecycle("stale_discarded", { ...request, reason: "request-owner-changed" }, { debug: followupDebug });
        return;
      }
      if (!responseOwnsFollowupRequest(data, request)) {
        recordFollowupLifecycle("stale_discarded", { ...request, reason: "ownership-echo-mismatch" }, { debug: followupDebug });
        dispatch({
          type: "request_failed",
          request,
          error: "The answer no longer matched this selected object. Please retry.",
        });
        return;
      }
      const answer = String(data.answer || "").trim();
      if (!answer) {
        recordFollowupLifecycle("response_invalid", { ...request, reason: "empty-answer" }, { debug: followupDebug });
        dispatch({ type: "request_failed", request, error: "The follow-up returned an empty answer. Please retry." });
        return;
      }
      acceptedAnswerRef.current = { ...request, answerLength: answer.length };
      dispatch({ type: "request_succeeded", request, answer, ownsRequest: true });
    } catch (submitError) {
      if (!mountedRef.current) {
        recordFollowupLifecycle("owner_gone", { ...request, reason: "component-unmounted-during-request" }, { debug: followupDebug });
        return;
      }
      if (!isSameFollowupRequest(activeRequestRef.current, request)) {
        recordFollowupLifecycle("stale_discarded", { ...request, reason: "request-owner-changed-during-error" }, { debug: followupDebug });
        return;
      }
      if (submitError?.name === "AbortError" && !timedOut) {
        recordFollowupLifecycle("aborted", { ...request, reason: "owner-aborted" }, { debug: followupDebug });
        dispatch({ type: "request_aborted", request });
      } else {
        // At this boundary the browser only knows that its API request failed.
        // It cannot attribute the failure to the upstream provider.
        recordFollowupLifecycle(submitError?.name === "AbortError" ? "aborted" : "api_failed", {
          ...request,
          reason: timedOut ? "timeout" : submitError?.message || "request-failed",
          status: submitError?.status || null,
        }, { debug: followupDebug });
        dispatch({
          type: "request_failed",
          request,
          error: timedOut ? "The follow-up took too long. Please retry." : submitError.message || "Could not answer that follow-up.",
        });
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (isSameFollowupRequest(activeRequestRef.current, request)) activeRequestRef.current = null;
    }
  };

  return (
    <div className="border-t border-white/[0.055] px-3.5 py-3">
      {state.messages.length > 0 && (
        <div ref={chatMessagesRef} className="omni-scrollbar mb-2 max-h-36 space-y-2 overflow-y-auto pr-1">
          {state.messages.map((message, messageIndex) => (
            <div
              key={`${message.role}-${messageIndex}`}
              data-followup-request-id={message.requestId || undefined}
              className={cn(
                "rounded-lg px-2.5 py-2 text-xs leading-5",
                message.role === "user"
                  ? "bg-teal-300/[0.08] text-teal-50/90"
                  : "bg-white/[0.045] text-slate-200/82"
              )}
            >
              <MathText>{message.text}</MathText>
            </div>
          ))}
        </div>
      )}
      {state.error && (
        <p className="mb-2 rounded-md border border-rose-300/20 bg-rose-400/10 px-2.5 py-2 text-xs leading-5 text-rose-100/82">
          {state.error}
        </p>
      )}
      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <input
          value={state.draft}
          onChange={(event) => dispatch({ type: "draft_changed", draft: event.target.value })}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-2 text-xs text-slate-100/88 outline-none transition-colors placeholder:text-slate-500/70 focus:border-teal-300/38"
          placeholder="Ask about this"
          disabled={state.loading}
        />
        <button
          type="submit"
          disabled={state.loading || !state.draft.trim()}
          onPointerDown={(event) => event.stopPropagation()}
          className="rounded-lg border border-teal-300/20 bg-teal-300/10 p-2 text-teal-50 transition-colors hover:bg-teal-300/16 disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="Send follow-up"
        >
          {state.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}

function FloatingWindow({ item, index, problem, getToken }) {
  const { clearHoverLens, closeExplanationWindow, toggleWindowPin, setWindowDepth, moveExplanationWindow, updateExplanationWindow } = useHoverActions();
  const { settings } = useSettings();
  const windowRef = useRef(null);
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const lazyState = useLazyExplanation(
    item,
    problem,
    "pin",
    getToken,
    item.referenceType !== "concept",
    item.depth || "intermediate"
  );
  const explanationText = lazyState.data?.explanation
    || item.content?.[item.depth]
    || item.content?.intermediate
    || item.title;

  useEffect(() => {
    if (!explanationText || item.lastDisplayedExplanation === explanationText) return;
    updateExplanationWindow(item.id, { lastDisplayedExplanation: explanationText });
  }, [explanationText, item.id, item.lastDisplayedExplanation, updateExplanationWindow]);
  const identity = getHoverTargetIdentity(item);
  const displayTitle = userFacingTooltipTitle({
    title: identity.tooltipTitle || identity.label || item.title,
    selectedText: identity.sourceText || item.selectedText || item.display,
    display: item.display,
    latex: item.latex,
    role: item.role,
  });

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (drag?.frameId) cancelAnimationFrame(drag.frameId);
      if (drag) document.body.style.userSelect = drag.previousUserSelect;
    };
  }, []);

  const queueDragMove = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();

    drag.nextX = event.clientX - drag.offsetX;
    drag.nextY = event.clientY - drag.offsetY;

    if (settings.interaction.lensDragSmoothness === "precise") {
      moveExplanationWindow(item.id, drag.nextX, drag.nextY, drag.size);
      return;
    }

    if (settings.interaction.lensDragSmoothness === "fast" && drag.frameId) {
      cancelAnimationFrame(drag.frameId);
      drag.frameId = null;
    }

    if (drag.frameId) return;
    drag.frameId = requestAnimationFrame(() => {
      const currentDrag = dragRef.current;
      if (!currentDrag) return;
      currentDrag.frameId = null;
      moveExplanationWindow(item.id, currentDrag.nextX, currentDrag.nextY, currentDrag.size);
    });
  }, [item.id, moveExplanationWindow, settings.interaction.lensDragSmoothness]);

  const finishDrag = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    if (drag.frameId) cancelAnimationFrame(drag.frameId);
    moveExplanationWindow(item.id, event.clientX - drag.offsetX, event.clientY - drag.offsetY, drag.size);

    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.userSelect = drag.previousUserSelect;
    dragRef.current = null;
    setDragging(false);
  }, [item.id, moveExplanationWindow]);

  const handleDragStart = (event) => {
    if (event.button !== 0 || window.innerWidth < 640) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    clearHoverLens();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      size: {
        width: rect.width,
        height: rect.height,
      },
      nextX: item.x,
      nextY: item.y,
      frameId: null,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.userSelect = "none";
    setDragging(true);
  };

  return (
    <motion.article
      ref={windowRef}
      data-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-tooltip-semantic-id={identity.semanticId || identity.targetId || undefined}
      data-source-range={identity.sourceRange ? `${identity.sourceRange.start}:${identity.sourceRange.end}` : undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "omni-floating-window fixed left-0 top-0 z-[70] flex w-[320px] flex-col overflow-hidden rounded-xl opacity-85 transition-opacity duration-200 will-change-transform hover:opacity-100",
        dragging && "omni-floating-window-dragging"
      )}
      style={{
        transform: `translate3d(${item.x}px, ${item.y}px, 0)`,
        zIndex: 70 + index,
      }}
      
    >
      <div
        className={cn(
          "flex touch-none cursor-grab select-none items-center justify-between gap-3 border-b border-white/[0.055] px-3.5 py-3 active:cursor-grabbing",
          dragging && "bg-teal-300/[0.06]"
        )}
        onPointerDown={handleDragStart}
        onPointerMove={queueDragMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div className="flex min-w-0 items-center gap-2">
          <GripHorizontal className="h-4 w-4 shrink-0 text-teal-200/55" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-cyan-50/95"><MathText>{displayTitle}</MathText></h3>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => toggleWindowPin(item.id)}
            className="rounded-lg p-1.5 text-slate-300/60 transition-colors hover:bg-white/[0.06] hover:text-teal-100"
            aria-label="Unpin explanation"
          >
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => closeExplanationWindow(item.id)}
            className="rounded-lg p-1.5 text-slate-300/60 transition-colors hover:bg-rose-400/10 hover:text-rose-100"
            aria-label="Close explanation"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="border-b border-white/[0.055] px-3.5 py-2">
        <div className="grid grid-cols-3 gap-1">
          {DEPTHS.map((depth) => (
            <button
              key={depth.key}
              type="button"
              aria-pressed={item.depth === depth.key}
              onClick={() => setWindowDepth(item.id, depth.key)}
              className={cn(
                "rounded-md px-1.5 py-1 text-center text-[10px] font-medium transition-all duration-200",
                item.depth === depth.key
                  ? "bg-teal-300/[0.11] text-teal-50 shadow-[0_0_14px_rgba(45,212,191,0.12)]"
                  : "text-slate-400/70 hover:bg-white/[0.045] hover:text-slate-200"
              )}
            >
              {depth.label}
            </button>
          ))}
        </div>
      </div>

      <div className="omni-scrollbar max-h-[330px] space-y-3 overflow-y-auto overflow-x-hidden px-3.5 py-3.5">
        {item.display && (
          <div className="omni-math-block border-l border-teal-300/25 py-1 pl-3 font-serif text-lg italic leading-8 text-teal-50 omni-scrollbar">
            <InlineMath math={item.display} />
          </div>
        )}
        {lazyState.loading && !lazyState.data ? (
          <div className="flex items-center gap-2 text-sm leading-6 text-slate-200/72">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-100/80" />
            Loading explanation...
          </div>
        ) : lazyState.error ? (
          <p className="rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs leading-5 text-rose-100/82">
            {lazyState.error}
          </p>
        ) : (
          <>
            {lazyState.loading && lazyState.data && (
              <div className="flex items-center gap-2 text-[11px] leading-5 text-teal-100/62">
                <Loader2 className="h-3 w-3 animate-spin" />
                Refreshing pinned explanation...
              </div>
            )}
            <div className="omni-math-text text-sm leading-6 text-slate-200/82">
              <MathText>{explanationText}</MathText>
            </div>
          </>
        )}
      </div>
      <FollowupChat
        item={item}
        problem={problem}
        getToken={getToken}
        displayedExplanation={lazyState.data?.explanation || item.lastDisplayedExplanation || explanationText}
      />
    </motion.article>
  );
}

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
  const tooltipDomInstanceRef = useRef({ lensId: null, identity: "" });
  if (hoverLens?.id && tooltipDomInstanceRef.current.lensId !== hoverLens.id) {
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
      onMouseEnter={holdHoverLens}
      onMouseMove={holdHoverLens}
      onMouseLeave={releaseHoverLens}
    >
      <h3 className="mb-1 text-xs font-semibold text-cyan-50/95"><MathText>{displayTitle}</MathText></h3>
      {lazyState.error ? (
        <div className="text-xs leading-5 text-rose-100/82">
          {lazyState.error}
        </div>
      ) : lazyState.loading && loadingMessage ? (
        <div className="flex items-center gap-2 text-xs leading-5 text-slate-100/75">
          <Loader2 className="h-3 w-3 animate-spin text-teal-100/80" />
          {loadingMessage}
        </div>
      ) : (
        <div
          data-hover-provider-explanation={lazyState.data?.explanation ? "true" : undefined}
          className="omni-math-text max-w-full overflow-x-hidden break-words text-xs leading-5 text-slate-100/80 omni-scrollbar"
        >
          <MathText>{lazyContent}</MathText>
        </div>
      )}
    </motion.div>
  );
  return typeof document !== "undefined" ? createPortal(tooltipNode, document.body) : tooltipNode;
}

export function PinnedLensLayer({ problem }) {
  const { pinnedLenses } = useHoverSemanticState();
  const { getToken } = useAuthToken();

  return (
    <>
      <AnimatePresence>
        {pinnedLenses.map((item, index) => (
          <FloatingWindow key={item.id} item={item} index={index} problem={problem} getToken={getToken} />
        ))}
      </AnimatePresence>
      <AnimatePresence>
        <ExplanationPopover />
      </AnimatePresence>
    </>
  );
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
