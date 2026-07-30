const DEBUG_SESSION_OPERATIONS = import.meta.env.DEV && (
  import.meta.env.VITE_DEBUG_SESSION_OPERATIONS === "true"
  || import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true"
);

export function createOperationId(prefix = "operation") {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function logSessionOperation(event, details = {}) {
  if (!DEBUG_SESSION_OPERATIONS) return;
  console.info("[omnimath:session-operation]", {
    event,
    operationId: details.operationId || details.operationContext?.operationId || null,
    originSessionId: details.originSessionId || details.operationContext?.originSessionId || null,
    activeSessionId: details.activeSessionId || null,
    revision: details.revision ?? details.operationContext?.revision ?? null,
    workflowType: details.workflowType || details.operationContext?.workflowType || null,
    imageHash: details.imageHash || details.operationContext?.imageHash || null,
    problemHash: details.problemHash || details.operationContext?.problemHash || null,
    reason: details.reason || null,
    applied: details.applied ?? null,
  });
}
