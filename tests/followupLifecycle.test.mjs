import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupRequestDescriptor,
  recordFollowupLifecycle,
  reduceFollowupLifecycle,
  responseOwnsFollowupRequest,
} from "../src/lib/followupLifecycle.js";

function request(requestId, conversationId = "conversation-a", targetRevision = "revision-a") {
  return createFollowupRequestDescriptor({ requestId, conversationId, targetRevision });
}

function started(question = "why?", descriptor = request("request-a"), state = INITIAL_FOLLOWUP_STATE) {
  return reduceFollowupLifecycle(state, { type: "request_started", request: descriptor, question });
}

describe("follow-up lifecycle", () => {
  it("rejects duplicate submits while one request owns the thread", () => {
    const active = started();
    const duplicate = reduceFollowupLifecycle(active, {
      type: "request_started",
      request: request("request-b"),
      question: "duplicate",
    });
    assert.equal(duplicate, active);
    assert.equal(active.messages.length, 1);
  });

  it("discards late A after B becomes the active owner", () => {
    const a = request("a", "conversation-a", "revision-a");
    const b = request("b", "conversation-b", "revision-b");
    let state = started("about A", a);
    state = reduceFollowupLifecycle(state, { type: "reset", messages: [] });
    state = started("about B", b, state);
    const afterLateA = reduceFollowupLifecycle(state, {
      type: "request_succeeded",
      request: a,
      answer: "stale A",
      ownsRequest: true,
    });
    assert.equal(afterLateA, state);
    assert.equal(afterLateA.activeRequest.targetRevision, "revision-b");
  });

  it("keeps A conversations distinct across A to B to A switching", () => {
    const a1 = request("a1", "conversation-a", "revision-a");
    const b = request("b", "conversation-b", "revision-b");
    const a2 = request("a2", "conversation-a", "revision-a");
    assert.equal(responseOwnsFollowupRequest({ ...a1 }, a1), true);
    assert.equal(responseOwnsFollowupRequest({ ...a1, conversationId: b.conversationId }, a1), false);
    assert.equal(responseOwnsFollowupRequest({ ...a1, requestId: a2.requestId }, a1), false);
  });

  it("restores the exact failed question for timeout, provider error, and retry", () => {
    const descriptor = request("timeout");
    let state = started("show the exact calculation", descriptor);
    state = reduceFollowupLifecycle(state, {
      type: "request_failed",
      request: descriptor,
      error: "The follow-up took too long. Please retry.",
    });
    assert.equal(state.loading, false);
    assert.equal(state.draft, "show the exact calculation");
    assert.equal(state.failedQuestion, "show the exact calculation");
    assert.deepEqual(state.messages, []);

    const retry = request("retry");
    state = reduceFollowupLifecycle(state, { type: "request_started", request: retry, question: state.draft });
    state = reduceFollowupLifecycle(state, { type: "request_succeeded", request: retry, answer: "calculation", ownsRequest: true });
    assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(state.error, "");
  });

  it("restores an aborted question without surfacing an error", () => {
    const descriptor = request("abort");
    let state = started("why negative?", descriptor);
    state = reduceFollowupLifecycle(state, { type: "request_aborted", request: descriptor });
    assert.equal(state.loading, false);
    assert.equal(state.error, "");
    assert.equal(state.draft, "why negative?");
  });

  it("recovers from a provider error without retaining the optimistic user message", () => {
    const descriptor = request("provider-error");
    let state = started("where did that number come from?", descriptor);
    state = reduceFollowupLifecycle(state, {
      type: "request_failed",
      request: descriptor,
      error: "Provider unavailable",
    });
    assert.deepEqual(state.messages, []);
    assert.equal(state.draft, "where did that number come from?");
    assert.equal(state.error, "Provider unavailable");
  });

  it("does not apply a response with a mismatched ownership echo", () => {
    const descriptor = request("owned");
    assert.equal(responseOwnsFollowupRequest({
      requestId: "owned",
      conversationId: "conversation-a",
      targetRevision: "wrong-revision",
    }, descriptor), false);
  });

  it("commits a successful answer when request ownership matches", () => {
    const descriptor = request("success");
    const pending = started("why did this cancel?", descriptor);
    const committed = reduceFollowupLifecycle(pending, {
      type: "request_succeeded",
      request: descriptor,
      answer: "The provider answer is available.",
      ownsRequest: true,
    });

    assert.deepEqual(committed.messages.at(-1), {
      role: "assistant",
      text: "The provider answer is available.",
      requestId: "success",
    });
    assert.equal(committed.loading, false);
  });

  it("records explicit ownership and API terminal states without claiming provider attribution", () => {
    const windowRef = {};
    recordFollowupLifecycle("request_started", request("trace"), { windowRef });
    recordFollowupLifecycle("api_failed", { ...request("trace"), reason: "HTTP 503" }, { windowRef });
    recordFollowupLifecycle("stale_discarded", { ...request("trace"), reason: "revision-changed" }, { windowRef });
    assert.deepEqual(windowRef.__OMNIMATH_FOLLOWUP_REQUEST_EVENTS__.map((event) => event.state), [
      "request_started",
      "api_failed",
      "stale_discarded",
    ]);
  });
});
