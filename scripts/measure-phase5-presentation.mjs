// Offline, deterministic source/annotated-HTML observation. No network/provider/browser calls.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import katex from "katex";
import { makePhase5KktFixture } from "../tests/fixtures/phase5FinalAnswer.mjs";
import { assessFinalAnswerPresentation, presentSolutionSteps } from "../src/lib/finalAnswerPresentation.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { serializeSemanticTreeToLatex, createSemanticKatexTrust } from "../src/lib/semanticMathRenderer.js";

function measure(steps) {
  const records = steps.map((step) => {
    const source = step.math || step.latex;
    const started = performance.now();
    const tree = buildSemanticTree({ stepId: step.id, displayLatex: source, enabled: true });
    const prepared = serializeSemanticTreeToLatex(tree);
    const html = katex.renderToString(prepared.latex, {
      displayMode: true, throwOnError: true, strict: "ignore", trust: createSemanticKatexTrust(),
    });
    return {
      stepId: step.id, sourceLength: source.length, semanticNodes: tree.flatNodes.length,
      annotatedNodes: prepared.annotatedNodeCount,
      renderedOwnerAttributes: (html.match(/data-semantic-id=/gu) || []).length,
      preparationAndStringRenderMs: Number((performance.now() - started).toFixed(2)),
    };
  });
  return {
    records,
    totalSemanticNodes: records.reduce((sum, row) => sum + row.semanticNodes, 0),
    totalRenderedOwnerAttributes: records.reduce((sum, row) => sum + row.renderedOwnerAttributes, 0),
    totalPreparationAndStringRenderMs: Number(records.reduce((sum, row) => sum + row.preparationAndStringRenderMs, 0).toFixed(2)),
  };
}
const original = makePhase5KktFixture();
const snapshot = JSON.stringify(original);
const policy = assessFinalAnswerPresentation(original);
const projected = presentSolutionSteps(original.steps, policy);
if (snapshot !== JSON.stringify(original)) throw new Error("Projection mutated canonical fixture.");
const before = measure(original.steps);
const after = measure(projected);
const observation = {
  method: "Same-process sequential before/after buildSemanticTree(enabled:true), serializeSemanticTreeToLatex, KaTeX string rendering with semantic trust. All expressions measured once; after benefits from warmed caches. Timings are observations, not comparative browser benchmarks.",
  limitations: "No browser DOM/fallback ownership, geometry, long tasks, initial interactive timing, or horizontal-scroll interaction measured. Browser launch remains blocked by libnspr4.so. No general performance fix claimed.",
  policyAction: policy.action,
  canonicalUnchanged: snapshot === JSON.stringify(original),
  before, after,
  removedSemanticNodes: before.totalSemanticNodes - after.totalSemanticNodes,
  removedRenderedOwnerAttributes: before.totalRenderedOwnerAttributes - after.totalRenderedOwnerAttributes,
};
writeFileSync(new URL("../test-artifacts/phase5-after-semantic-counts.json", import.meta.url), `${JSON.stringify(observation, null, 2)}\n`);
console.log(JSON.stringify({ action: policy.action, beforeNodes: before.totalSemanticNodes, afterNodes: after.totalSemanticNodes, removedNodes: observation.removedSemanticNodes, removedOwners: observation.removedRenderedOwnerAttributes }));
