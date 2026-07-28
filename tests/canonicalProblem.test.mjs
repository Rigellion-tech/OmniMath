import assert from "node:assert/strict";
import test from "node:test";

import {
  getCanonicalDisplayText,
  getCanonicalDisplayTextSource,
  getCanonicalMathInput,
  getCanonicalMathInputSource,
  getCanonicalSolverInput,
} from "../src/lib/canonicalProblem.js";

test("canonical display text prefers readable canonical text", () => {
  const payload = {
    canonicalText: "Evaluate the integral from 0 to infinity.",
    canonicalLatex: "\\int_0^\\infty f(x)\\,dx",
    problem: "Legacy problem field",
  };

  assert.equal(getCanonicalDisplayText(payload), "Evaluate the integral from 0 to infinity.");
  assert.equal(getCanonicalDisplayTextSource(payload), "canonicalText");
});

test("canonical math input prefers canonical LaTeX when available", () => {
  const payload = {
    canonicalText: "Evaluate the integral from 0 to infinity.",
    canonicalLatex: "\\int_0^\\infty f(x)\\,dx",
    problem: "Legacy problem field",
  };

  assert.equal(getCanonicalMathInput(payload), "\\int_0^\\infty f(x)\\,dx");
  assert.equal(getCanonicalMathInputSource(payload), "canonicalLatex");
});

test("canonical helpers preserve text-only and LaTeX-only payloads", () => {
  assert.equal(getCanonicalMathInput({ canonicalText: "Solve x+1=0." }), "Solve x+1=0.");
  assert.equal(getCanonicalMathInputSource({ canonicalText: "Solve x+1=0." }), "canonicalText");
  assert.equal(getCanonicalDisplayText({ canonicalLatex: "x+1=0" }, "Fallback text"), "Fallback text");
  assert.equal(getCanonicalDisplayTextSource({ canonicalLatex: "x+1=0" }, "Fallback text"), "fallback");
  assert.equal(getCanonicalMathInput({ canonicalLatex: "x+1=0" }), "x+1=0");
  assert.equal(getCanonicalMathInputSource({ canonicalLatex: "x+1=0" }), "canonicalLatex");
});

test("legacy canonical solver input remains canonicalText-first for compatibility", () => {
  const payload = {
    canonicalText: "Readable problem text",
    canonicalLatex: "x+1=0",
  };

  assert.equal(getCanonicalSolverInput(payload), "Readable problem text");
});
