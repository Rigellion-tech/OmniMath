export const HOVER_REQUEST_STATES = new Set([
  "request_started",
  "api_parsed",
  "provider_failed",
  "http_failed",
  "network_failed",
  "parse_failed",
  "shape_failed",
  "aborted",
  "stale_discarded",
  "owner_gone",
  "cached",
  "committed_to_ui",
  "render_input_empty",
  "rendered",
  "rendered_empty",
  "hidden_before_completion",
]);

export function classifyHoverRequestFailure(error) {
  if (error?.name === "AbortError") return "aborted";
  if (error instanceof SyntaxError || error?.name === "SyntaxError") return "parse_failed";
  if (error?.code === "CLIENT_RESPONSE_SHAPE_INVALID") return "shape_failed";
  const code = String(error?.body?.code || error?.code || "").toUpperCase();
  if (/^(?:AI_PROVIDER_|AI_SERVICE_)/.test(code)) return "provider_failed";
  if (Number.isFinite(Number(error?.status))) return "http_failed";
  return "network_failed";
}

export function recordHoverRequestLifecycle(state, details = {}, {
  debug = false,
  windowRef = typeof window !== "undefined" ? window : null,
  consoleRef = typeof console !== "undefined" ? console : null,
} = {}) {
  if (!HOVER_REQUEST_STATES.has(state)) {
    throw new Error(`Unknown hover request lifecycle state: ${state}`);
  }
  const entry = {
    at: Date.now(),
    state,
    scope: details.scope || "owner",
    terminal: details.terminal === true,
    requestId: details.requestId || null,
    transportRequestId: details.transportRequestId || null,
    ownerId: details.ownerId || null,
    ownerRevision: details.ownerRevision ?? null,
    sessionId: details.sessionId || null,
    cacheKeyHash: details.cacheKeyHash || null,
    semanticId: details.semanticId || details.targetId || null,
    ...details,
  };
  if (windowRef) {
    const events = windowRef["__OMNIMATH_HOVER_REQUEST_EVENTS__"] || [];
    events.push(entry);
    if (events.length > 500) events.splice(0, events.length - 500);
    windowRef["__OMNIMATH_HOVER_REQUEST_EVENTS__"] = events;
  }
  if (debug) consoleRef?.info?.("[omnimath:hover-request-lifecycle]", entry);
  return entry;
}
