import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExplanationCacheKey } from "../server/explanationCache.js";
import { createCanonicalProblemPayload } from "../src/lib/canonicalProblem.js";

describe("canonical solve cache identity", () => {
  it("keeps case-sensitive mathematical inputs separate", () => {
    const upper = "Differentiate F(x) with respect to x.";
    const lower = "Differentiate f(x) with respect to x.";
    const upperCanonical = createCanonicalProblemPayload({ canonicalText: upper, source: "typed" });
    const lowerCanonical = createCanonicalProblemPayload({ canonicalText: lower, source: "typed" });

    const upperKey = createExplanationCacheKey({
      userId: "user-1",
      problem: upper,
      canonicalInputHash: upperCanonical.hash,
      type: "canonical-solve",
    });
    const lowerKey = createExplanationCacheKey({
      userId: "user-1",
      problem: lower,
      canonicalInputHash: lowerCanonical.hash,
      type: "canonical-solve",
    });

    assert.notEqual(upperCanonical.hash, lowerCanonical.hash);
    assert.notEqual(upperKey, lowerKey);
  });

  it("keeps different parsed solve histories separate", () => {
    const common = {
      userId: "user-1",
      problem: "Continue solving x^2=4.",
      canonicalInputHash: "canonical-hash",
      type: "canonical-solve",
    };
    const positiveBranch = createExplanationCacheKey({
      ...common,
      context: { inputSource: "typed", history: [{ role: "user", text: "Use the positive branch." }] },
    });
    const allBranches = createExplanationCacheKey({
      ...common,
      context: { inputSource: "typed", history: [{ role: "user", text: "Include every real branch." }] },
    });

    assert.notEqual(positiveBranch, allBranches);
  });

  it("is stable for equivalent parsed context objects", () => {
    const fields = {
      userId: "user-1",
      problem: "Differentiate x^2.",
      canonicalInputHash: "canonical-hash",
      type: "canonical-solve",
    };
    const left = createExplanationCacheKey({
      ...fields,
      context: { inputSource: "typed", history: [{ role: "user", text: "Show the rule." }] },
    });
    const right = createExplanationCacheKey({
      ...fields,
      context: { history: [{ text: "Show the rule.", role: "user" }], inputSource: "typed" },
    });

    assert.equal(left, right);
  });
});
