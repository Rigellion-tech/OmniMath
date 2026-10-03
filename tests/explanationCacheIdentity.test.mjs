import assert from "node:assert/strict";
import test from "node:test";

import { createExplanationCacheKey } from "../server/explanationCache.js";

function canonicalSolveKey({ problem, canonicalInputHash, history = [] }) {
  return createExplanationCacheKey({
    userId: "identity-test-user",
    problem,
    canonicalInputHash,
    context: {
      inputSource: "typed",
      history,
    },
    type: "canonical-solve",
  });
}

test("canonical solve cache identity preserves case-sensitive mathematics", () => {
  const upper = canonicalSolveKey({
    problem: "Differentiate F(x) with respect to x.",
    canonicalInputHash: "upper-F",
  });
  const lower = canonicalSolveKey({
    problem: "Differentiate f(x) with respect to x.",
    canonicalInputHash: "lower-f",
  });

  assert.notEqual(upper, lower);
});

test("canonical solve cache identity includes conversation history", () => {
  const problem = "Continue the derivation.";
  const canonicalInputHash = "same-current-problem";
  const first = canonicalSolveKey({
    problem,
    canonicalInputHash,
    history: [{ role: "user", text: "Assume homogeneous boundary conditions." }],
  });
  const second = canonicalSolveKey({
    problem,
    canonicalInputHash,
    history: [{ role: "user", text: "Assume periodic boundary conditions." }],
  });

  assert.notEqual(first, second);
});
