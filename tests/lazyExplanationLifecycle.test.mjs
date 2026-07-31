import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOVER_LOADING_MESSAGE,
  HOVER_STILL_GENERATING_MESSAGE,
  HOVER_TIMEOUT_MS,
  INITIAL_LAZY_EXPLANATION_STATE,
  PIN_TIMEOUT_MS,
  createLazyRequestDescriptor,
  getLazyLoadingMessage,
  reduceLazyExplanationLifecycle,
} from "../src/lib/lazyExplanationLifecycle.js";

function start(state, request, fallback = null) {
  return reduceLazyExplanationLifecycle(state, {
    type: "request_started",
    request,
    fallback,
  });
}

describe("lazy explanation lifecycle", () => {
  it("keeps browser guards longer than the lazy provider deadline", () => {
    assert.ok(HOVER_TIMEOUT_MS > 30000);
    assert.ok(PIN_TIMEOUT_MS > 30000);
  });

  it("ignores stale hover success for an older request", () => {
    const oldRequest = createLazyRequestDescriptor({
      requestId: 1,
      cacheKey: "hover::old",
      mode: "hover",
      targetId: "old-token",
    });
    const newRequest = createLazyRequestDescriptor({
      requestId: 2,
      cacheKey: "hover::new",
      mode: "hover",
      targetId: "new-token",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, oldRequest);
    state = start(state, newRequest);

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_succeeded",
      request: oldRequest,
      data: { explanation: "old" },
      applies: true,
    });

    assert.equal(state.loading, true);
    assert.equal(state.request.targetId, "new-token");
    assert.equal(state.data, null);
  });

  it("ignores timeout errors for a newer active token", () => {
    const oldRequest = createLazyRequestDescriptor({
      requestId: 3,
      cacheKey: "hover::a",
      mode: "hover",
      targetId: "a",
    });
    const newRequest = createLazyRequestDescriptor({
      requestId: 4,
      cacheKey: "hover::b",
      mode: "hover",
      targetId: "b",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, oldRequest);
    state = start(state, newRequest);

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_failed",
      request: oldRequest,
      error: "Explanation took too long. Try pinning or retry.",
    });

    assert.equal(state.error, "");
    assert.equal(state.request.targetId, "b");
  });

  it("accepts a late success only when it is still current", () => {
    const request = createLazyRequestDescriptor({
      requestId: 5,
      cacheKey: "hover::current",
      mode: "hover",
      targetId: "current-token",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, request);

    state = reduceLazyExplanationLifecycle(state, {
      type: "still_generating",
      request,
    });
    assert.equal(getLazyLoadingMessage("hover", state.phase), HOVER_STILL_GENERATING_MESSAGE);

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_succeeded",
      request,
      data: { explanation: "late but current" },
      applies: true,
    });

    assert.equal(state.loading, false);
    assert.equal(state.error, "");
    assert.equal(state.data.explanation, "late but current");
  });

  it("terminates loading when the current request succeeds for a stale target", () => {
    const request = createLazyRequestDescriptor({
      requestId: 7,
      cacheKey: "hover::stale-current",
      mode: "hover",
      targetId: "token-a",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, request);
    state = reduceLazyExplanationLifecycle(state, {
      type: "loading_delay",
      request,
    });

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_succeeded",
      request,
      data: { targetId: "token-b", explanation: "wrong target" },
      applies: false,
      reason: "target_mismatch",
    });

    assert.equal(state.loading, false);
    assert.equal(state.error, "");
    assert.equal(state.data, null);
    assert.equal(state.phase, "stale");
    assert.equal(state.request, null);
    assert.equal(state.staleRequest.targetId, "token-a");
    assert.equal(state.staleReason, "target_mismatch");
  });

  it("keeps request B loading when request A completes stale, then shows request B", () => {
    const requestA = createLazyRequestDescriptor({
      requestId: 8,
      cacheKey: "hover::a",
      mode: "hover",
      targetId: "token-a",
    });
    const requestB = createLazyRequestDescriptor({
      requestId: 9,
      cacheKey: "hover::b",
      mode: "hover",
      targetId: "token-b",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, requestA);
    state = reduceLazyExplanationLifecycle(state, {
      type: "loading_delay",
      request: requestA,
    });
    state = start(state, requestB);
    state = reduceLazyExplanationLifecycle(state, {
      type: "loading_delay",
      request: requestB,
    });

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_succeeded",
      request: requestA,
      data: { targetId: "token-a", explanation: "stale A" },
      applies: false,
      reason: "target_changed",
    });

    assert.equal(state.loading, true);
    assert.equal(state.phase, "loading");
    assert.equal(state.request.targetId, "token-b");
    assert.equal(state.data, null);

    state = reduceLazyExplanationLifecycle(state, {
      type: "request_succeeded",
      request: requestB,
      data: { targetId: "token-b", explanation: "current B" },
      applies: true,
    });

    assert.equal(state.loading, false);
    assert.equal(state.phase, "ready");
    assert.equal(state.request, null);
    assert.equal(state.data.explanation, "current B");
  });

  it("uses cached explanation without loading or error", () => {
    const state = reduceLazyExplanationLifecycle(INITIAL_LAZY_EXPLANATION_STATE, {
      type: "cache_hit",
      data: { explanation: "cached" },
    });

    assert.equal(state.loading, false);
    assert.equal(state.error, "");
    assert.equal(state.data.explanation, "cached");
    assert.equal(state.request, null);
  });

  it("stages hover loading messages before hard failure", () => {
    const request = createLazyRequestDescriptor({
      requestId: 6,
      cacheKey: "hover::staged",
      mode: "hover",
      targetId: "staged-token",
    });
    let state = start(INITIAL_LAZY_EXPLANATION_STATE, request);

    assert.equal(getLazyLoadingMessage("hover", state.phase), "");

    state = reduceLazyExplanationLifecycle(state, {
      type: "loading_delay",
      request,
    });
    assert.equal(getLazyLoadingMessage("hover", state.phase), HOVER_LOADING_MESSAGE);
  });
});
