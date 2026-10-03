export function providerStreamingEnabled() {
  return import.meta.env?.VITE_PROGRESSIVE_SOLVE === "true"
    || (import.meta.env?.DEV && new URLSearchParams(globalThis.location?.search || "").has("providerStream"));
}

export function progressiveIdentityForOperation(operationContext, sessionId) {
  if (!operationContext?.operationId || !operationContext?.revision || !sessionId) return null;
  return {
    requestId: operationContext.operationId,
    attemptId: `${operationContext.operationId}:${operationContext.revision}`,
    sessionId,
    conversationId: sessionId,
    ...(operationContext.supersedesAttemptId ? { supersedesAttemptId: operationContext.supersedesAttemptId } : {}),
  };
}
