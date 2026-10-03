import assert from "node:assert/strict";
import test from "node:test";
import { getConciseProblemTitle, getSessionLabel } from "../src/lib/problemLabels.js";

test("concise problem titles use existing context without provider calls", () => {
  assert.equal(getConciseProblemTitle({ problem: "Derive the constrained Euler-Lagrange equation with a Lagrange multiplier." }), "Constrained Euler-Lagrange");
  assert.equal(getConciseProblemTitle({ problem: "Find the eigenvalues of the matrix A." }), "Matrix Eigenvalue Problem");
  assert.equal(getConciseProblemTitle({ problem: "Use Stokes' theorem on the upper surface." }), "Stokes Surface Integral");
});

test("a stored custom session name takes precedence over generated classification", () => {
  assert.equal(getSessionLabel({
    title: "Vector Field Boundary",
    problem: { problem: "Use Stokes' theorem." },
  }), "Vector Field Boundary");
});
