import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GripHorizontal, Loader2, Pin, Send, X } from "lucide-react";
import InlineMath from "./InlineMath";
import MathText from "./MathText";
import { explainFollowup, explainPin, explainToken } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { useHover } from "@/lib/HoverContext";
import { userFacingTooltipTitle } from "@/lib/presentationLabels";
import { getProblemLabel } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import { getTooltipPositionFromRect } from "@/lib/tooltipPosition";
import { cn } from "@/lib/utils";

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
const HOVER_TIMEOUT_MS = 6500;
const PIN_TIMEOUT_MS = 12000;
const RATE_LIMIT_MESSAGE = "Explanation paused. Try again in a few seconds.";
const TIMEOUT_MESSAGE = "Explanation took too long. Try pinning or retry.";
const lazyExplanationCache = new Map();
const inFlightExplanations = new Map();
const pinExplanationCache = new Map();
const inFlightPinRequests = new Map();
const pinRequestLocks = new Set();
const requestCooldownUntil = new Map();
let activeHoverRequest = null;
let nextHoverRequestAt = 0;

function stableHash(value = "") {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function logLazyExplanation(event, details = {}) {
  if (!import.meta.env.DEV) return;
  console.info("[omnimath:lazy-explanation]", {
    event,
    ...details,
  });
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
  return item?.selectedTokens?.[0]?.anchorId
    || item?.selectedTokens?.[0]?.id
    || item?.referenceId
    || item?.selectedText
    || item?.display
    || "";
}

function getLazyCacheKey(item, problem, mode, explanationLevel = "default") {
  const problemId = getProblemId(problem, item?.context);
  const stepId = item?.stepId || item?.context?.stepId || "step";
  const anchorId = getAnchorId(item);
  const selected = item?.selectedText || item?.display || "";
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
  const currentStep = getStepLatex(item);
  const selectedLatex = item?.selectedText || item?.display || currentStep;
  const parentExpression = getParentExpression(item);

  return {
    problemId: getProblemId(problem, item?.context),
    problemContext: getProblemLabel(problem || item?.context?.problem, "Math problem"),
    stepLatex: currentStep,
    selectedLatex,
    parentExpression,
    stepHeading: item?.stepTitle || item?.context?.stepTitle || item?.title || "",
    stepId: item?.stepId || item?.context?.stepId || "",
    anchorId: item?.selectedTokens?.[0]?.anchorId || item?.selectedTokens?.[0]?.id || item?.referenceId || "",
    selectedTokenId: item?.selectedTokens?.[0]?.id || item?.referenceId || "",
  };
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
    if (cached) return cached;
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

function createLazyRequest({ cacheKey, mode, item, problem, getToken, signal }) {
  const inFlightMap = getInFlightMap(mode);
  const cache = getMemoryCache(mode);
  const existing = inFlightMap.get(cacheKey);
  if (existing) {
    logLazyExplanation(mode === "pin" ? "pin request reused" : "request reused", { mode, cacheKey });
    return existing.promise;
  }

  const request = mode === "pin" ? explainPin : explainToken;
  const startedAt = performance.now();
  logLazyExplanation(mode === "pin" ? "pin API fired" : "API call fired", { mode, cacheKey });
  const promise = request({ payload: createLazyPayload(item, problem), getToken, signal })
    .then((data) => {
      const resolved = {
        title: userFacingTooltipTitle({
          title: data.title || item.title,
          selectedText: item.selectedText || item.display,
          display: item.display,
          latex: item.latex,
          role: item.role,
        }),
        explanation: data.explanation || "",
      };
      cache.set(cacheKey, resolved);
      writeSessionCache(cacheKey, resolved);
      logLazyExplanation("API completed", {
        mode,
        cacheKey,
        durationMs: Math.round(performance.now() - startedAt),
        cached: Boolean(data.cached),
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
          status: error?.status || null,
          message: error?.message || "Request failed",
          durationMs: Math.round(performance.now() - startedAt),
        });
      } else {
        logLazyExplanation("API failed", {
          mode,
          cacheKey,
          status: error?.status || null,
          message: error?.message || "Request failed",
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      throw error;
    })
    .finally(() => {
      inFlightMap.delete(cacheKey);
      if (mode === "pin") pinRequestLocks.delete(cacheKey);
    });

  inFlightMap.set(cacheKey, { promise, mode });
  return promise;
}

function useLazyExplanation(item, problem, mode, getToken, enabled = true, explanationLevel = "default") {
  const [state, setState] = useState({ loading: false, error: "", data: null });
  const cacheKey = item && enabled ? getLazyCacheKey(item, problem, mode, explanationLevel) : "";
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!item || !enabled || !cacheKey) {
      setState({ loading: false, error: "", data: null });
      return undefined;
    }

    const cache = getMemoryCache(mode);
    const cached = cache.get(cacheKey) || readSessionCache(cacheKey);
    if (cached) {
      cache.set(cacheKey, cached);
      logLazyExplanation(mode === "pin" ? "pin cache hit" : "cache hit", { mode, cacheKey });
      setState({ loading: false, error: "", data: cached });
      return undefined;
    }

    const cooldownUntil = requestCooldownUntil.get(cacheKey) || 0;
    if (cooldownUntil > Date.now()) {
      logLazyExplanation("API returned 429", { mode, cacheKey, paused: true });
      setState({ loading: false, error: RATE_LIMIT_MESSAGE, data: null });
      return undefined;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    let cancelled = false;
    let timedOut = false;
    const controller = new AbortController();
    const hoverFallback = mode === "pin" ? getCachedHoverFallback(item, problem) : null;
    const debounceMs = mode === "hover" ? HOVER_DEBOUNCE_MS : 0;
    let timerId = null;
    let timeoutId = null;

    logLazyExplanation(`${mode} requested`, { mode, cacheKey });
    setState({ loading: true, error: "", data: hoverFallback });

    const runRequest = () => {
      if (cancelled) return;

      if (mode === "pin") {
        const cachedBeforePin = pinExplanationCache.get(cacheKey) || readSessionCache(cacheKey);
        if (cachedBeforePin) {
          pinExplanationCache.set(cacheKey, cachedBeforePin);
          logLazyExplanation("pin cache hit", { mode, cacheKey });
          setState({ loading: false, error: "", data: cachedBeforePin });
          return;
        }

        if (inFlightPinRequests.has(cacheKey)) {
          createLazyRequest({
            cacheKey,
            mode,
            item,
            problem,
            getToken,
            signal: controller.signal,
          })
            .then((resolved) => {
              if (cancelled || requestIdRef.current !== requestId) return;
              setState({ loading: false, error: "", data: resolved });
            })
            .catch((error) => {
              if (cancelled || requestIdRef.current !== requestId || error?.name === "AbortError") return;
              if (isRateLimitError(error)) requestCooldownUntil.set(cacheKey, Date.now() + 5000);
              setState({ loading: false, error: normalizeLazyError(error), data: hoverFallback });
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
        if (activeHoverRequest?.cacheKey && activeHoverRequest.cacheKey !== cacheKey) {
          activeHoverRequest.controller.abort();
          logLazyExplanation("hover cancelled", {
            mode,
            cacheKey: activeHoverRequest.cacheKey,
            reason: "new stable hover",
          });
        }
        activeHoverRequest = { cacheKey, controller };
        const waitMs = Math.max(0, nextHoverRequestAt - Date.now());
        if (waitMs > 0) {
          timerId = window.setTimeout(runRequest, waitMs);
          return;
        }
        nextHoverRequestAt = Date.now() + HOVER_RATE_LIMIT_MS;
      }

      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
        if (!cancelled && requestIdRef.current === requestId) {
          setState({
            loading: false,
            error: TIMEOUT_MESSAGE,
            data: hoverFallback,
          });
        }
        logLazyExplanation("request timed out", { mode, cacheKey });
      }, mode === "hover" ? HOVER_TIMEOUT_MS : PIN_TIMEOUT_MS);

      createLazyRequest({
        cacheKey,
        mode,
        item,
        problem,
        getToken,
        signal: controller.signal,
      })
        .then((resolved) => {
          if (cancelled || requestIdRef.current !== requestId) return;
          setState({ loading: false, error: "", data: resolved });
        })
        .catch((error) => {
          if (cancelled || requestIdRef.current !== requestId || error?.name === "AbortError") return;
          if (isRateLimitError(error)) {
            requestCooldownUntil.set(cacheKey, Date.now() + 5000);
          }
          setState({
            loading: false,
            error: normalizeLazyError(error),
            data: hoverFallback,
          });
        })
        .finally(() => {
          if (timeoutId) {
            window.clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (timedOut && !cancelled && requestIdRef.current === requestId) {
            setState({
              loading: false,
              error: TIMEOUT_MESSAGE,
              data: hoverFallback,
            });
          }
          if (activeHoverRequest?.cacheKey === cacheKey) {
            activeHoverRequest = null;
          }
        });
    };

    timerId = window.setTimeout(runRequest, debounceMs);

    return () => {
      cancelled = true;
      if (timerId) window.clearTimeout(timerId);
      if (timeoutId) window.clearTimeout(timeoutId);
      if (mode === "hover") {
        controller.abort();
        if (activeHoverRequest?.cacheKey === cacheKey) activeHoverRequest = null;
        logLazyExplanation("hover cancelled", { mode, cacheKey, reason: "unmounted or changed" });
      }
      if (mode === "pin" && !inFlightPinRequests.has(cacheKey)) {
        pinRequestLocks.delete(cacheKey);
      }
    };
  }, [cacheKey, enabled, explanationLevel, getToken, item, mode, problem]);

  return state;
}

function FollowupChat({ item, problem, getToken }) {
  const [messages, setMessages] = useState(Array.isArray(item.chatHistory) ? item.chatHistory : []);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentExplanation = item.content?.[item.depth] || item.content?.intermediate || item.title || "";

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    const nextMessages = [...messages, { role: "user", text: trimmed }];
    setMessages(nextMessages);
    setQuestion("");
    setError("");
    setLoading(true);

    try {
      const context = item.context || {};
      const data = await explainFollowup({
        getToken,
        payload: {
          problem: context.problem?.originalProblem || context.problem?.problem || problem?.originalProblem || problem?.problem || problem?.expression || "",
          solution: context.solution || problem,
          stepId: item.stepId || context.stepId,
          stepTitle: item.stepTitle || context.stepTitle,
          currentStep: context.currentStep || null,
          selectedText: item.selectedText || item.display || "",
          selectedTokens: item.selectedTokens || [],
          pinnedExplanation: currentExplanation,
          question: trimmed,
          history: messages,
        },
      });
      setMessages((current) => [...current, { role: "assistant", text: data.answer || "I could not produce a follow-up answer." }]);
    } catch (submitError) {
      setError(submitError.message || "Could not answer that follow-up.");
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t border-white/[0.055] px-3.5 py-3">
      {messages.length > 0 && (
        <div className="omni-scrollbar mb-2 max-h-36 space-y-2 overflow-y-auto pr-1">
          {messages.map((message, messageIndex) => (
            <div
              key={`${message.role}-${messageIndex}`}
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
      {error && (
        <p className="mb-2 rounded-md border border-rose-300/20 bg-rose-400/10 px-2.5 py-2 text-xs leading-5 text-rose-100/82">
          {error}
        </p>
      )}
      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2.5 py-2 text-xs text-slate-100/88 outline-none transition-colors placeholder:text-slate-500/70 focus:border-teal-300/38"
          placeholder="Ask about this"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          onPointerDown={(event) => event.stopPropagation()}
          className="rounded-lg border border-teal-300/20 bg-teal-300/10 p-2 text-teal-50 transition-colors hover:bg-teal-300/16 disabled:cursor-not-allowed disabled:opacity-45"
          aria-label="Send follow-up"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </form>
    </div>
  );
}

function FloatingWindow({ item, index, problem, getToken }) {
  const { clearHoverLens, closeExplanationWindow, toggleWindowPin, setWindowDepth, moveExplanationWindow } = useHover();
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
  const displayTitle = userFacingTooltipTitle({
    title: lazyState.data?.title || item.title,
    selectedText: item.selectedText || item.display,
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
      onMouseEnter={clearHoverLens}
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
      <FollowupChat item={item} problem={problem} getToken={getToken} />
    </motion.article>
  );
}

export function ExplanationPopover() {
  const { explanationLevel, hoverLens, holdHoverLens, releaseHoverLens } = useHover();
  const { getToken } = useAuthToken();
  const tooltipRef = useRef(null);
  const [adjustedPosition, setAdjustedPosition] = useState(null);
  const hoverDepth = explanationLevel >= 2 ? "intermediate" : "beginner";
  const lazyState = useLazyExplanation(
    hoverLens,
    hoverLens?.context?.problem,
    "hover",
    getToken,
    Boolean(hoverLens),
    hoverDepth
  );

  useLayoutEffect(() => {
    setAdjustedPosition(null);
  }, [hoverLens?.id, hoverLens?.x, hoverLens?.y]);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const anchor = hoverLens?.anchor;
    if (!tooltip || !anchor) return;

    const tooltipRect = tooltip.getBoundingClientRect();
    const hoveredRects = Array.from(document.querySelectorAll("[data-explainable='true']:hover, .omni-solution-line:hover"))
      .map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const collisionAnchor = hoveredRects.reduce((current, rect) => ({
      left: Math.min(current.left, rect.left),
      right: Math.max(current.right, rect.right),
      top: Math.min(current.top, rect.top),
      bottom: Math.max(current.bottom, rect.bottom),
      width: Math.max(current.right, rect.right) - Math.min(current.left, rect.left),
      height: Math.max(current.bottom, rect.bottom) - Math.min(current.top, rect.top),
    }), anchor);
    const intersects = (left, right) => !(
      left.right <= right.left
      || left.left >= right.right
      || left.bottom <= right.top
      || left.top >= right.bottom
    );

    if (!intersects(tooltipRect, collisionAnchor)) return;

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };
    const size = {
      width: tooltipRect.width,
      height: tooltipRect.height,
    };
    const candidates = [
      getTooltipPositionFromRect(collisionAnchor, { size, viewport, gap: 12, padding: 12 }),
      getTooltipPositionFromRect(collisionAnchor, { index: 1, size, viewport, gap: 12, padding: 12 }),
    ];
    const next = candidates.find((candidate) => {
      const rect = {
        left: candidate.x,
        right: candidate.x + size.width,
        top: candidate.y,
        bottom: candidate.y + size.height,
      };
      return !intersects(rect, collisionAnchor);
    }) || candidates[0];

    setAdjustedPosition((current) => (
      current && Math.abs(current.x - next.x) < 1 && Math.abs(current.y - next.y) < 1
        ? current
        : next
    ));
  }, [hoverLens]);

  if (!hoverLens) return null;

  const content = explanationLevel >= 2
    ? hoverLens.content?.intermediate
    : hoverLens.content?.beginner;
  const displayTitle = userFacingTooltipTitle({
    title: lazyState.data?.title || hoverLens.title,
    selectedText: hoverLens.selectedText || hoverLens.display,
    display: hoverLens.display,
    latex: hoverLens.latex,
    role: hoverLens.role,
  });
  const lazyContent = lazyState.data?.explanation || content || displayTitle;

  return (
    <motion.div
      ref={tooltipRef}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.14 }}
      className="omni-quick-tooltip fixed z-[80] max-w-[280px] rounded-xl px-3 py-2"
      style={{
        left: adjustedPosition?.x ?? hoverLens.x,
        top: adjustedPosition?.y ?? hoverLens.y,
      }}
      onMouseEnter={holdHoverLens}
      onMouseMove={holdHoverLens}
      onMouseLeave={releaseHoverLens}
    >
      <h3 className="mb-1 text-xs font-semibold text-cyan-50/95"><MathText>{displayTitle}</MathText></h3>
      {lazyState.loading ? (
        <div className="flex items-center gap-2 text-xs leading-5 text-slate-100/75">
          <Loader2 className="h-3 w-3 animate-spin text-teal-100/80" />
          Loading...
        </div>
      ) : lazyState.error ? (
        <div className="text-xs leading-5 text-rose-100/82">
          {lazyState.error}
        </div>
      ) : (
        <div className="omni-math-text max-w-full overflow-x-auto text-xs leading-5 text-slate-100/80 omni-scrollbar">
          <MathText>{lazyContent}</MathText>
        </div>
      )}
    </motion.div>
  );
}

export function PinnedLensLayer({ problem }) {
  const { pinnedLenses } = useHover();
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
  return <PinnedLensLayer problem={problem} />;
}
