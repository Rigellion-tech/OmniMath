import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSolveBudget } from "../server/solveBudget.js";

function fakeClock(start = 1_000_000) {
  let current = start;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => current,
    advance(ms) { current += ms; },
    setTimer(callback, ms) {
      const id = nextId++;
      timers.set(id, { callback, at: current + ms });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  };
}

describe("canonical solve budget", () => {
  it("keeps the total deadline outside the active primary attempt and reserves recovery time", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    const attempt = budget.attemptBudget({ configuredTimeoutMs: 120_000 });

    assert.equal(budget.deadlineAt, 1_090_000);
    assert.equal(attempt.effectiveTimeoutMs, 65_500);
    assert.equal(attempt.budgetLimitReason, "primary_stage_budget");
    assert.ok(attempt.deadlineAt < budget.deadlineAt);
    budget.cleanup();
  });

  it("clamps every attempt to the remaining stage budget", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    clock.advance(60_000);

    const attempt = budget.attemptBudget({ configuredTimeoutMs: 120_000 });
    assert.equal(attempt.remainingMs, 5_500);
    assert.equal(attempt.effectiveTimeoutMs, 5_500);
    assert.equal(attempt.timeoutSource, "provider_attempt_timeout");
    budget.cleanup();
  });

  it("uses a shorter configured role ceiling without consuming reserved time", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    const attempt = budget.attemptBudget({ configuredTimeoutMs: 5_000 });

    assert.equal(attempt.effectiveTimeoutMs, 5_000);
    assert.equal(attempt.budgetLimitReason, null);
    budget.cleanup();
  });

  it("leaves the recovery allocation usable after the primary allocation ends", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    clock.advance(65_500);

    assert.equal(budget.attemptBudget({ configuredTimeoutMs: 120_000 }).canStart, false);
    assert.equal(budget.canStartRecovery(), true);
    assert.equal(
      budget.attemptBudget({ configuredTimeoutMs: 120_000, recovery: true }).effectiveTimeoutMs,
      22_500,
    );
    assert.equal(budget.deadlineAt - budget.recoveryDeadlineAt, 2_000);
    budget.cleanup();
  });

  it("allows recovery only while a meaningful recovery budget remains", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });

    assert.equal(budget.canStartRecovery(), true);
    assert.equal(
      budget.attemptBudget({ configuredTimeoutMs: 120_000, recovery: true }).effectiveTimeoutMs,
      22_500,
    );
    clock.advance(18_000);
    assert.equal(budget.canStartRecovery(), false);
    budget.cleanup();
  });

  it("caps all recovery work to one aggregate reserved stage allocation", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });

    const first = budget.attemptBudget({ configuredTimeoutMs: 10_000, recovery: true });
    assert.equal(first.effectiveTimeoutMs, 10_000);
    clock.advance(10_000);
    const second = budget.attemptBudget({ configuredTimeoutMs: 120_000, recovery: true });
    assert.equal(second.effectiveTimeoutMs, 12_500);
    clock.advance(12_500);
    assert.equal(budget.attemptBudget({ configuredTimeoutMs: 1_000, recovery: true }).canStart, false);
    budget.cleanup();
  });

  it("marks dispatched attempts without usage as unknown rather than zero", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    const attempt = budget.recordProviderDispatch({
      requestId: "request-1",
      routeAttemptId: "request-1:route:1",
      model: "test-model",
      attempt: 1,
    });
    clock.advance(10);
    budget.recordProviderOutcome(attempt, {
      aborted: true,
      timeoutSource: "provider_attempt_timeout",
    });

    assert.equal(budget.providerAttempts.length, 1);
    assert.equal(attempt.usageStatus, "unknown_due_to_abort");
    assert.equal(attempt.timeoutSource, "provider_attempt_timeout");
    assert.ok(attempt.abortAt);
    assert.equal(attempt.estimatedInputTokens, null);
    budget.cleanup();
  });

  it("propagates an upstream abort through the authoritative signal", () => {
    const clock = fakeClock();
    const upstream = new AbortController();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, signal: upstream.signal, ...clock });
    const reason = new DOMException("Client disconnected.", "AbortError");
    upstream.abort(reason);

    assert.equal(budget.signal.aborted, true);
    assert.equal(budget.signal.reason, reason);
    assert.throws(() => budget.throwIfExpired(), (error) => error === reason);
    budget.cleanup();
  });

  it("classifies canonical total expiry as a typed total solve timeout", () => {
    const clock = fakeClock();
    const budget = createSolveBudget({ totalTimeoutMs: 90_000, ...clock });
    clock.advance(90_000);

    assert.throws(() => budget.throwIfExpired(), (error) => {
      assert.equal(error.code, "AI_SOLVE_TIMEOUT");
      assert.equal(error.statusCode, 504);
      assert.equal(error.timeoutSource, "total_solve_deadline");
      assert.equal(error.responseFailureType, "interactive_deadline_exceeded");
      return true;
    });
    budget.cleanup();
  });
});
