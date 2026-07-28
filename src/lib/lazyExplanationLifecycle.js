export const HOVER_LOADING_DELAY_MS = 650;
export const HOVER_STILL_GENERATING_DELAY_MS = 4200;
export const HOVER_TIMEOUT_MS = 55000;
export const PIN_TIMEOUT_MS = 12000;

export const HOVER_LOADING_MESSAGE = "Loading...";
export const HOVER_STILL_GENERATING_MESSAGE = "Still generating...";
export const HOVER_TIMEOUT_MESSAGE = "Explanation took too long. Try pinning or retry.";

export const INITIAL_LAZY_EXPLANATION_STATE = {
  loading: false,
  error: "",
  data: null,
  phase: "idle",
  request: null,
};

export function createLazyRequestDescriptor({ requestId, cacheKey, mode, targetId = "" }) {
  return {
    requestId,
    cacheKey,
    mode,
    targetId,
  };
}

export function isCurrentLazyRequest(currentRequest, request) {
  return Boolean(
    currentRequest
      && request
      && currentRequest.requestId === request.requestId
      && currentRequest.cacheKey === request.cacheKey
      && currentRequest.mode === request.mode
      && currentRequest.targetId === request.targetId
  );
}

export function getLazyLoadingMessage(mode, phase) {
  if (mode === "hover" && phase === "still-generating") return HOVER_STILL_GENERATING_MESSAGE;
  if (mode === "hover" && phase === "loading") return HOVER_LOADING_MESSAGE;
  return mode === "pin" ? "Loading explanation..." : "";
}

export function reduceLazyExplanationLifecycle(state = INITIAL_LAZY_EXPLANATION_STATE, event = {}) {
  switch (event.type) {
    case "idle":
      return { ...INITIAL_LAZY_EXPLANATION_STATE };

    case "cache_hit":
      return {
        loading: false,
        error: "",
        data: event.data || null,
        phase: "ready",
        request: null,
      };

    case "request_started":
      return {
        loading: true,
        error: "",
        data: event.fallback || null,
        phase: "pending",
        request: event.request || null,
      };

    case "loading_delay":
      if (!isCurrentLazyRequest(state.request, event.request)) return state;
      return {
        ...state,
        loading: true,
        error: "",
        phase: "loading",
      };

    case "still_generating":
      if (!isCurrentLazyRequest(state.request, event.request)) return state;
      return {
        ...state,
        loading: true,
        error: "",
        phase: "still-generating",
      };

    case "request_succeeded":
      if (!isCurrentLazyRequest(state.request, event.request)) return state;
      if (event.applies === false) {
        return {
          loading: false,
          error: "",
          data: state.data || null,
          phase: "stale",
          request: null,
          staleRequest: event.request || null,
          staleReason: event.reason || "target_mismatch",
        };
      }
      return {
        loading: false,
        error: "",
        data: event.data || null,
        phase: "ready",
        request: null,
      };

    case "request_failed":
      if (!isCurrentLazyRequest(state.request, event.request)) return state;
      if (event.cancelled) return state;
      return {
        loading: false,
        error: event.error || "Could not load this explanation.",
        data: event.fallback || state.data || null,
        phase: "error",
        request: null,
      };

    default:
      return state;
  }
}
