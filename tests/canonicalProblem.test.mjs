import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanonicalProblemPayload,
  getCanonicalDisplayText,
  getCanonicalDisplayTextSource,
  getCanonicalMathInput,
  getCanonicalMathInputSource,
  getCanonicalSolverInput,
} from "../src/lib/canonicalProblem.js";

test("canonical content identity is source-neutral while provenance identity is not", () => {
  const typed = createCanonicalProblemPayload({ canonicalText: "Solve x+2=3", source: "typed" });
  const ocr = createCanonicalProblemPayload({
    canonicalText: "Solve x+2=3",
    source: "ocr-reviewed",
    extractionConfidence: 88,
  });

  assert.equal(typed.contentHash, ocr.contentHash);
  assert.notEqual(typed.hash, ocr.hash);
});

const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

test("canonical problem normalization removes terminal formatting without changing LaTeX", () => {
  const latex = "\\int_0^\\infty f(x)\\,dx";
  const payload = createCanonicalProblemPayload({
    canonicalText: `\u001b[1mEvaluate the integral.\u001b[0m`,
    canonicalLatex: `\u001b[1m${latex}\u001b[0m`,
  });

  assert.equal(payload.canonicalText, "Evaluate the integral.");
  assert.equal(payload.canonicalLatex, latex);
  assert.doesNotMatch(payload.canonicalLatex, DISALLOWED_CONTROL);
});

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
