import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { explainProblem } from "../src/api/mathClient.js";
import { createCanonicalProblemPayload, getCanonicalSolverInput } from "../src/lib/canonicalProblem.js";
import { normalizeCanonicalProblem } from "../server/solveRequestContext.js";
import { buildMathExplanationPrompt } from "../server/mathPrompt.js";
import { serializePrimaryComposer, restorePrimaryComposerSource } from "../src/lib/primaryComposerSerialization.js";
import { variationalFunctionalLatex } from "./fixtures/composer/variationalFunctional.mjs";

describe("primary composer canonical input", () => {
  it("keeps the exact advanced source through the explain request and prompt boundary", async () => {
    const rawLatex = variationalFunctionalLatex;
    const prose = "Find the stationary points.";
    const serialized = serializePrimaryComposer({ prose, rawLatex, sourceMode: "raw" });
    assert.equal(serialized.canonicalLatex, rawLatex);
    assert.equal(serialized.canonicalText, `${prose}\n\n${rawLatex}`);

    const canonical = createCanonicalProblemPayload({
      canonicalText: serialized.canonicalText,
      canonicalLatex: rawLatex,
      source: "typed",
      composerSourceMode: "raw",
    });
    assert.equal(getCanonicalSolverInput(canonical), serialized.canonicalText);
    assert.equal(normalizeCanonicalProblem({ canonicalProblem: canonical }).canonicalText, serialized.canonicalText);
    assert.equal(buildMathExplanationPrompt({ problem: serialized.canonicalText }).includes(rawLatex), true);

    let request;
    const originalFetch = globalThis.fetch;
    mock.method(globalThis, "fetch", async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ explanation: { problemLatex: rawLatex, steps: [], finalAnswerLatex: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      await explainProblem({ problem: serialized.canonicalText, canonicalLatex: rawLatex });
    } finally {
      mock.restoreAll();
      globalThis.fetch = originalFetch;
    }
    assert.equal(request.url, "/api/explain");
    assert.equal(request.body.problemInput.problemText, serialized.canonicalText);
    assert.equal(request.body.problem, serialized.canonicalText);
    assert.equal(request.body.canonicalProblem.canonicalText, serialized.canonicalText);
    assert.equal(request.body.canonicalProblem.canonicalLatex, rawLatex);
    const normalizedRequest = normalizeCanonicalProblem(request.body);
    assert.equal(getCanonicalSolverInput(normalizedRequest), serialized.canonicalText);
    assert.equal(buildMathExplanationPrompt({ problem: getCanonicalSolverInput(normalizedRequest) }).includes(rawLatex), true);
    for (const coefficient of [String.raw`\frac{1}{2}`, String.raw`\frac{\alpha}{4}`, String.raw`\frac{\beta}{2}`, String.raw`\frac{\lambda}{p}`]) assert.ok(rawLatex.includes(coefficient));
  });

  it("restores raw Advanced LaTeX without changing its hash source", () => {
    const rawLatex = variationalFunctionalLatex;
    const visualSerialized = serializePrimaryComposer({ visualLatex: rawLatex, sourceMode: "visual" });
    assert.equal(visualSerialized.canonicalLatex, rawLatex);
    const serialized = serializePrimaryComposer({ rawLatex, sourceMode: "raw" });
    const canonical = createCanonicalProblemPayload({ canonicalText: serialized.canonicalText, canonicalLatex: rawLatex, source: "typed" });
    const restored = restorePrimaryComposerSource({ canonicalProblem: {
      ...canonical,
      composerSourceMode: "raw",
    } });
    assert.equal(restored.rawLatex, rawLatex);
    assert.equal(restored.sourceMode, "raw");
    const restoredSerialized = serializePrimaryComposer({ prose: restored.prose, rawLatex: restored.rawLatex, sourceMode: restored.sourceMode });
    assert.equal(restoredSerialized.canonicalText, serialized.canonicalText);
    assert.equal(createCanonicalProblemPayload({ canonicalText: restoredSerialized.canonicalText, canonicalLatex: restoredSerialized.canonicalLatex, source: "typed" }).hash, canonical.hash);
  });
});
