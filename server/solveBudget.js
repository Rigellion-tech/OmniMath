const DEFAULT_COMPLETION_RESERVE_MS = 2_000;
const DEFAULT_MIN_RECOVERY_MS = 5_000;
const MAX_RECOVERY_RESERVE_MS = 30_000;

function positiveMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function createSolveTimeoutError({
  timeoutSource = "total_solve_deadline",
  budgetLimitReason = null,
} = {}) {
  const totalDeadline = timeoutSource === "total_solve_deadline";
  return Object.assign(new Error(
    totalDeadline
      ? "The solve reached its total time limit."
      : "The model attempt did not complete in time.",
  ), {
    statusCode: 504,
    code: "AI_SOLVE_TIMEOUT",
    responseFailureType: totalDeadline ? "interactive_deadline_exceeded" : "request_timeout",
    timeoutScope: totalDeadline ? "total_solve" : "model_request",
    timeoutSource,
    budgetLimitReason,
    publicMessage: totalDeadline
      ? "The explanation did not complete before the solve deadline. Please try again."
      : "The AI model did not complete this attempt in time. Please try again.",
  });
}

export function createSolveBudget({
  deadlineAt = null,
  totalTimeoutMs = 90_000,
  signal: upstreamSignal = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  recoveryReserveMs = null,
  completionReserveMs = null,
  minRecoveryMs = DEFAULT_MIN_RECOVERY_MS,
} = {}) {
  const createdAt = now();
  const requestedTotalMs = positiveMs(totalTimeoutMs, 90_000);
  const resolvedDeadlineAt = Number.isFinite(Number(deadlineAt)) && Number(deadlineAt) > 0
    ? Number(deadlineAt)
    : createdAt + requestedTotalMs;
  const resolvedTotalMs = Math.max(1, Math.floor(resolvedDeadlineAt - createdAt));
  const completionReserve = Math.min(
    positiveMs(completionReserveMs, DEFAULT_COMPLETION_RESERVE_MS),
    Math.max(1, Math.floor(resolvedTotalMs * 0.1)),
  );
  const recoveryReserve = Math.min(
    positiveMs(recoveryReserveMs, Math.floor(resolvedTotalMs * 0.25)),
    MAX_RECOVERY_RESERVE_MS,
    Math.max(0, resolvedTotalMs - completionReserve - 1),
  );
  const primaryDeadlineAt = resolvedDeadlineAt - completionReserve - recoveryReserve;
  const recoveryDeadlineAt = resolvedDeadlineAt - completionReserve;
  const controller = new AbortController();
  const providerAttempts = [];
  let disposed = false;
  let activeRecoveryDeadlineAt = null;

  const abortWith = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onUpstreamAbort = () => {
    const reason = upstreamSignal.reason || new DOMException("The solve was cancelled upstream.", "AbortError");
    if (reason && typeof reason === "object") {
      try {
        if (!reason.timeoutSource) reason.timeoutSource = "upstream_abort";
        if (!reason.timeoutScope) reason.timeoutScope = "upstream";
      } catch { /* preserve non-extensible upstream reasons */ }
    }
    abortWith(reason);
  };
  if (upstreamSignal?.aborted) onUpstreamAbort();
  else upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });

  const deadlineDelayMs = Math.max(0, Math.ceil(resolvedDeadlineAt - now()));
  const deadlineTimer = setTimer(() => abortWith(createSolveTimeoutError()), deadlineDelayMs);
  deadlineTimer?.unref?.();

  function remainingMs({ recovery = false } = {}) {
    const stageDeadlineAt = recovery
      ? activeRecoveryDeadlineAt || Math.min(recoveryDeadlineAt, now() + recoveryReserve)
      : primaryDeadlineAt;
    const remaining = Math.max(0, Math.floor(stageDeadlineAt - now()));
    return remaining;
  }

  function canonicalRemainingMs() {
    return Math.max(0, Math.floor(resolvedDeadlineAt - now()));
  }

  function attemptBudget({ configuredTimeoutMs, recovery = false } = {}) {
    if (recovery && activeRecoveryDeadlineAt === null) {
      activeRecoveryDeadlineAt = Math.min(recoveryDeadlineAt, now() + recoveryReserve);
    }
    const configured = positiveMs(configuredTimeoutMs, 1);
    const remaining = remainingMs({ recovery });
    const effectiveTimeoutMs = Math.max(0, Math.min(configured, remaining));
    const stageSource = recovery ? "recovery_stage_budget" : "primary_stage_budget";
    const stageLimited = remaining <= configured;
    return {
      canStart: effectiveTimeoutMs > 0 && !controller.signal.aborted,
      configuredTimeoutMs: configured,
      effectiveTimeoutMs,
      remainingMs: remaining,
      deadlineAt: recovery ? activeRecoveryDeadlineAt : primaryDeadlineAt,
      timeoutSource: "provider_attempt_timeout",
      budgetLimitReason: stageLimited ? stageSource : null,
      recovery,
    };
  }

  function canStartRecovery() {
    return !controller.signal.aborted
      && remainingMs({ recovery: true }) >= positiveMs(minRecoveryMs, DEFAULT_MIN_RECOVERY_MS);
  }

  function throwIfExpired() {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (now() >= resolvedDeadlineAt) {
      const error = createSolveTimeoutError();
      abortWith(error);
      throw error;
    }
  }

  function recordProviderDispatch(fields = {}) {
    const entry = {
      model: fields.model || null,
      requestId: fields.requestId || null,
      attemptId: fields.attemptId || null,
      routeAttemptId: fields.routeAttemptId || null,
      routeAttemptIndex: fields.routeAttemptIndex ?? null,
      providerAttemptIndex: fields.providerAttemptIndex ?? fields.attempt ?? providerAttempts.length + 1,
      route: fields.route || fields.modelPath || null,
      attempt: fields.attempt ?? providerAttempts.length + 1,
      dispatchAt: fields.dispatchAt || new Date(now()).toISOString(),
      abortAt: null,
      timeoutSource: fields.timeoutSource || null,
      budgetLimitReason: fields.budgetLimitReason || null,
      providerRequestId: fields.providerRequestId || null,
      providerResponseId: fields.providerResponseId || null,
      estimatedInputTokens: fields.estimatedInputTokens !== null
        && fields.estimatedInputTokens !== undefined
        && Number.isFinite(Number(fields.estimatedInputTokens))
        ? Math.max(0, Math.ceil(Number(fields.estimatedInputTokens)))
        : null,
      usageStatus: "unknown_unreconciled",
    };
    providerAttempts.push(entry);
    console.info("[omnimath:provider-dispatch]", entry);
    return entry;
  }

  function recordProviderOutcome(entry, fields = {}) {
    if (!entry || !providerAttempts.includes(entry)) return entry;
    if (fields.providerRequestId) entry.providerRequestId = fields.providerRequestId;
    if (fields.providerResponseId) entry.providerResponseId = fields.providerResponseId;
    if (fields.timeoutSource) entry.timeoutSource = fields.timeoutSource;
    if (fields.aborted || fields.abortAt) {
      entry.abortAt = fields.abortAt || new Date(now()).toISOString();
    }
    entry.usageStatus = fields.usageStatus
      || (fields.usage ? "observed" : entry.abortAt ? "unknown_due_to_abort" : "unknown_unreconciled");
    console.info("[omnimath:provider-outcome]", entry);
    return entry;
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    clearTimer(deadlineTimer);
    upstreamSignal?.removeEventListener?.("abort", onUpstreamAbort);
  }

  return Object.freeze({
    deadlineAt: resolvedDeadlineAt,
    primaryDeadlineAt,
    recoveryDeadlineAt,
    totalTimeoutMs: resolvedTotalMs,
    signal: controller.signal,
    providerAttempts,
    attemptBudget,
    remainingMs,
    canonicalRemainingMs,
    canStartRecovery,
    throwIfExpired,
    recordProviderDispatch,
    recordProviderOutcome,
    cleanup,
  });
}
