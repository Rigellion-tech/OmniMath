import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractOpenAiTextResponse } from "../server/openai.js";

function response(text, extra = {}) {
  return {
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    ...extra,
  };
}

describe("follow-up response normalization", () => {
  it("accepts complete nonempty provider text", () => {
    assert.equal(extractOpenAiTextResponse(response("  grounded answer  "), { requireComplete: true }), "grounded answer");
  });

  it("rejects whitespace-only provider text", () => {
    assert.throws(
      () => extractOpenAiTextResponse(response("   "), { requireComplete: true }),
      (error) => error.code === "AI_RESPONSE_INVALID" && error.responseFailureType === "empty_text",
    );
  });

  it("rejects partial text when the provider marks the response incomplete", () => {
    assert.throws(
      () => extractOpenAiTextResponse(response("partial but fluent", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }), { requireComplete: true }),
      (error) => error.code === "AI_RESPONSE_TRUNCATED",
    );
  });

  it("rejects a refusal instead of treating it as an answer", () => {
    assert.throws(
      () => extractOpenAiTextResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "cannot answer" }] }],
      }, { requireComplete: true }),
      (error) => error.code === "AI_REQUEST_REFUSED",
    );
  });
});
