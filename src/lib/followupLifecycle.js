export const INITIAL_FOLLOWUP_STATE = {
  messages: [],
  loading: false,
  error: "",
  draft: "",
  activeRequest: null,
  failedQuestion: "",
};

export const FOLLOWUP_REQUEST_STATES = new Set([
  "request_started",
  "api_parsed",
  "api_failed",
  "response_invalid",
  "aborted",
  "stale_discarded",
  "owner_gone",
  "committed_to_ui",
  "rendered",
  "local_window_update_requested",
]);

export function recordFollowupLifecycle(state, details = {}, {
  debug = false,
  windowRef = typeof window !== "undefined" ? window : null,
  consoleRef = typeof console !== "undefined" ? console : null,
} = {}) {
  if (!FOLLOWUP_REQUEST_STATES.has(state)) {
    throw new Error(`Unknown follow-up lifecycle state: ${state}`);
  }
  const entry = {
    at: Date.now(),
    state,
    requestId: details.requestId || null,
    conversationId: details.conversationId || null,
    targetRevision: details.targetRevision || null,
    ...details,
  };
  if (windowRef) {
    const events = windowRef["__OMNIMATH_FOLLOWUP_REQUEST_EVENTS__"] || [];
    events.push(entry);
    if (events.length > 500) events.splice(0, events.length - 500);
    windowRef["__OMNIMATH_FOLLOWUP_REQUEST_EVENTS__"] = events;
  }
  if (debug) consoleRef?.info?.("[omnimath:followup-request-lifecycle]", entry);
  return entry;
}

export function createFollowupRequestDescriptor({ requestId, conversationId, targetRevision }) {
  return { requestId, conversationId, targetRevision };
}

export function isSameFollowupRequest(left, right) {
  return Boolean(left && right
    && left.requestId === right.requestId
    && left.conversationId === right.conversationId
    && left.targetRevision === right.targetRevision);
}

export function responseOwnsFollowupRequest(response = {}, request) {
  return Boolean(request
    && response.requestId === request.requestId
    && response.conversationId === request.conversationId
    && response.targetRevision === request.targetRevision);
}

/**
 * @param {any} state
 * @param {any} event
 * @returns {any}
 */
export function reduceFollowupLifecycle(state = INITIAL_FOLLOWUP_STATE, event = {}) {
  switch (event.type) {
    case "reset":
      return { ...INITIAL_FOLLOWUP_STATE, messages: event.messages || [], draft: event.draft || "" };
    case "draft_changed":
      return { ...state, draft: event.draft || "", error: "" };
    case "request_started": {
      if (state.loading) return state;
      const question = String(event.question || "").trim();
      if (!question) return state;
      return {
        ...state,
        messages: [...state.messages, { role: "user", text: question }],
        loading: true,
        error: "",
        draft: "",
        activeRequest: { ...event.request, question, baseMessages: state.messages },
        failedQuestion: "",
      };
    }
    case "request_succeeded":
      if (!isSameFollowupRequest(state.activeRequest, event.request) || event.ownsRequest === false) return state;
      return {
        ...state,
        messages: [...state.messages, {
          role: "assistant",
          text: event.answer,
          requestId: event.request.requestId,
        }],
        loading: false,
        error: "",
        activeRequest: null,
        failedQuestion: "",
      };
    case "request_failed":
      if (!isSameFollowupRequest(state.activeRequest, event.request)) return state;
      return {
        ...state,
        messages: state.activeRequest.baseMessages || [],
        loading: false,
        error: event.error || "Could not answer that follow-up.",
        draft: state.activeRequest.question || "",
        activeRequest: null,
        failedQuestion: state.activeRequest.question || "",
      };
    case "request_aborted":
      if (!isSameFollowupRequest(state.activeRequest, event.request)) return state;
      return {
        ...state,
        messages: state.activeRequest.baseMessages || [],
        loading: false,
        error: "",
        draft: state.activeRequest.question || "",
        activeRequest: null,
        failedQuestion: state.activeRequest.question || "",
      };
    default:
      return state;
  }
}
