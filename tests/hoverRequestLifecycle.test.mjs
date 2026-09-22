import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyHoverRequestFailure,
  recordHoverRequestLifecycle,
} from "../src/lib/hoverRequestLifecycle.js";

describe("hover request lifecycle diagnostics", () => {
  it("distinguishes client, generic HTTP, explicit provider, and network failures", () => {
    assert.equal(classifyHoverRequestFailure(Object.assign(new Error("cancelled"), { name: "AbortError" })), "aborted");
    assert.equal(classifyHoverRequestFailure(new SyntaxError("invalid JSON")), "parse_failed");
    assert.equal(classifyHoverRequestFailure(Object.assign(new Error("invalid response"), { code: "CLIENT_RESPONSE_SHAPE_INVALID" })), "shape_failed");
    assert.equal(classifyHoverRequestFailure(Object.assign(new Error("gateway failed"), { status: 502 })), "http_failed");
    assert.equal(classifyHoverRequestFailure(Object.assign(new Error("provider unavailable"), {
      status: 502,
      body: { code: "AI_SERVICE_UNAVAILABLE" },
    })), "provider_failed");
    assert.equal(classifyHoverRequestFailure(new TypeError("fetch failed")), "network_failed");
  });

  it("keeps a bounded correlation buffer without raw request content", () => {
    const windowRef = {};
    for (let index = 0; index < 510; index += 1) {
      recordHoverRequestLifecycle("cached", {
        requestId: `request-${index}`,
        ownerId: "tooltip",
        cacheKeyHash: "safe-hash",
        semanticId: "semantic-x",
      }, { windowRef, consoleRef: null });
    }
    assert.equal(windowRef.__OMNIMATH_HOVER_REQUEST_EVENTS__.length, 500);
    assert.equal(windowRef.__OMNIMATH_HOVER_REQUEST_EVENTS__[0].requestId, "request-10");
    assert.equal(windowRef.__OMNIMATH_HOVER_REQUEST_EVENTS__[0].transportRequestId, null);
  });

});
