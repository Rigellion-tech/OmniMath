import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createMathExplanation, parseJsonResponse } from "../server/openai.js";
import { assertCompactSolveResponse, sanitizeGeneratedLatex } from "../server/mathExplanationSchema.js";
import { renderMathLatex } from "../server/mathAnnotator.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";

process.env.OPENAI_API_KEY ||= "test-key";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function providerBody(value, extra = {}) {
  return {
    status: "completed",
    model: "test-model",
    output_text: JSON.stringify(value),
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    ...extra,
  };
}

function response(value) {
  return { ok: true, status: 200, statusText: "OK", async text() { return JSON.stringify(value); } };
}

function full(finalAnswerLatex, steps = null) {
  return {
    title: "Solve a coupled system",
    problemLatex: "x+y=3",
    steps: steps || [{ id: "derive", heading: "Derive", latex: finalAnswerLatex, reasoning: "Solve both constraints.", anchors: [{ id: "pair", latex: "x=1", type: "equation", priority: "high" }] }],
    finalAnswerLatex,
    numericCheck: "",
  };
}

it("keeps a complete related-equation answer and its anchor without compact retry", async () => {
  const requests = [];
  const latex = String.raw`x=1,\quad y=2`;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response(providerBody(full(latex)));
  };
  const result = await createMathExplanation({ prompt: "Solve x+y=3", originalProblem: "x+y=3" });
  assert.equal(requests.length, 1);
  assert.equal(result.finalAnswerLatex, latex);
  assert.equal(result.steps[0].id, "derive");
  assert.equal(result.steps[0].chunks[0].parts[0].anchorId, "pair");
  assert.equal(result._aiCallCount, 1);
  assert.ok(result._omniWarnings.some((issue) => issue.endsWith("final_answer_contains_multiple_unrelated_equations")));
});

it("preserves an aligned two-row answer and row-break tokens without retry", async () => {
  const latex = String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return response(providerBody(full(latex))); };
  const result = await createMathExplanation({ prompt: "Solve a system", originalProblem: "x+y=3" });
  assert.equal(requests, 1);
  assert.equal(result.finalAnswerLatex, latex);
  assert.equal(result.steps[0].math, latex);
});

it("repairs a leading transport-escaped command without collapsing genuine later rows", () => {
  assert.equal(sanitizeGeneratedLatex(String.raw`\\frac{1}{2}`), String.raw`\frac{1}{2}`);
  assert.equal(renderMathLatex(String.raw`\\alpha`), String.raw`\alpha`);
  const rows = String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`;
  assert.equal(sanitizeGeneratedLatex(rows), rows);
  assert.equal(renderMathLatex(rows), rows);
});

it("retries truly malformed normalized math once and returns the usable compact candidate", async () => {
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return response(providerBody(requests.length === 1
      ? full(String.raw`\frac{1}{`)
      : { title: "Compact", problemLatex: "x+y=3", steps: [{ id: "final", heading: "Final", latex: "(x,y)=(1,2)", reasoning: "Solve the system.", anchors: [] }] }));
  };
  const result = await createMathExplanation({ prompt: "Solve x+y=3", originalProblem: "x+y=3" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].text.format.name, "math_compact_solve");
  assert.equal(result.finalAnswerLatex, "(x,y)=(1,2)");
  assert.equal(result._aiCallCount, 2);
});

it("rejects explicitly incomplete provider status even when JSON text is complete", () => {
  assert.throws(() => parseJsonResponse(providerBody(full("x=1"), { status: "incomplete" }), (value) => value),
    (error) => error.code === "AI_RESPONSE_TRUNCATED" && error.responseFailureType === "truncated");
});

it("compact normalization retains its actual last step beyond eight entries", () => {
  const steps = Array.from({ length: 9 }, (_, index) => ({
    id: `step-${index + 1}`,
    heading: index === 8 ? "Final" : "Derive",
    latex: index === 8 ? "x=9" : `x=${index}`,
    reasoning: "Continue the derivation.",
    anchors: [],
  }));
  const compact = assertCompactSolveResponse({ title: "Long compact solve", problemLatex: "x=9", steps });
  assert.equal(compact.steps.length, 9);
  assert.equal(compact.finalAnswerLatex, "x=9");
});

it("preserves tuple and parametric grouping with distinct semantic source ranges", () => {
  for (const latex of ["(x,y)=(1,2)", "x(t)=t,y(t)=t^2"]) {
    assert.equal(renderMathLatex(latex), latex);
    const tree = buildSemanticTree({ stepId: "grouped-result", displayLatex: latex, enabled: true });
    assert.ok(tree.flatNodes.length > 1);
    assert.equal(new Set(tree.flatNodes.map((node) => node.id)).size, tree.flatNodes.length);
    assert.ok(tree.flatNodes.every((node) => (
      Number.isInteger(node.start) && Number.isInteger(node.end)
      && node.start >= 0 && node.end <= latex.length && node.end >= node.start
      && latex.slice(node.start, node.end) === node.latex
    )));
  }
});
