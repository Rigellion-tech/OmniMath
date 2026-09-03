import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { auditSemanticCoverage } from "../src/lib/semanticCoverageAudit.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import {
  classifySemanticNodeInteraction,
  createSemanticKatexTrust,
  serializeSemanticTreeToLatex,
  validateSemanticTreeRanges,
} from "../src/lib/semanticMathRenderer.js";

const NOTATION_FIXTURES = [
  String.raw`a+b`,
  String.raw`a\le b`,
  String.raw`x\in A`,
  String.raw`-\frac14`,
  String.raw`-\frac14\sum_{n=1}^{\infty}\frac1{n^2}`,
  String.raw`\sqrt{x}`,
  String.raw`x^2`,
  String.raw`x_i`,
  String.raw`\sum_{n=1}^{\infty}`,
  String.raw`\prod_{k=1}^{n}`,
  String.raw`\int_0^1 f(x)\,dx`,
  String.raw`\lim_{x\to0}f(x)`,
  String.raw`\frac{\partial^2 f}{\partial x\partial y}`,
  String.raw`\Gamma(x)`,
  String.raw`\zeta(x)`,
  String.raw`\operatorname{Li}_2(x)`,
  String.raw`\hat{x}`,
  String.raw`\vec{v}`,
  String.raw`[0,\pi/2)`,
  String.raw`x=a,\ y=b,\ z=c`,
  String.raw`x = \tan t,\quad t \in [0,\pi/2),\quad I=-2J,\quad J:=\int_0^{\pi/2} t\ln(\cos t)\cot t\,dt`,
];

function renderFixture(latex, fixtureIndex) {
  const tree = buildSemanticTree({ stepId: `coverage-${fixtureIndex}`, displayLatex: latex });
  const validation = validateSemanticTreeRanges(tree);
  assert.equal(validation.valid, true, `${latex}: ${JSON.stringify(validation.errors)}`);
  const serialization = serializeSemanticTreeToLatex(tree);
  assert.equal(serialization.error, "", latex);
  const domHtml = katex.renderToString(serialization.latex, {
    throwOnError: true,
    strict: "ignore",
    trust: createSemanticKatexTrust(),
  });
  return { tree, serialization, domHtml };
}

describe("semantic coverage invariant", () => {
  it("serializes every interactive leaf in each notation class into authoritative KaTeX ownership", () => {
    for (const [fixtureIndex, latex] of NOTATION_FIXTURES.entries()) {
      const { tree, serialization, domHtml } = renderFixture(latex, fixtureIndex);
      const interactiveLeaves = tree.flatNodes.filter((node) => (
        classifySemanticNodeInteraction(node, tree.displayLatex).interactive
      ));
      const measuredTargets = interactiveLeaves.map((node) => ({
        ...node,
        rects: [{ left: 0, top: 0, right: 8, bottom: 12, width: 8, height: 12 }],
      }));
      const audit = auditSemanticCoverage({
        tree,
        serialization,
        domHtml,
        measuredTargets,
        geometryAcceptedTargets: measuredTargets,
        reachableTargets: measuredTargets,
      });

      assert.equal(audit.complete, true, `${latex}: ${JSON.stringify(audit.silentMissingNodes, null, 2)}`);
      assert.ok(interactiveLeaves.length > 0, latex);
      for (const node of audit.nodes) {
        if (node.interactionClassification === "interactive-leaf") {
          assert.equal(node.serialized, true, `${latex}: ${node.semanticId} was not serialized`);
          assert.equal(node.domAnnotationFound, true, `${latex}: ${node.semanticId} has no authoritative DOM owner`);
          assert.equal(node.reachable, true, `${latex}: ${node.semanticId} is not reachable`);
          assert.equal(node.failureReason, "", `${latex}: ${node.failureReason}`);
        } else {
          assert.ok(node.failureReason, `${latex}: ${node.semanticId} lacks an intentional classification reason`);
        }
      }

      const orderedLeaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
      for (let index = 1; index < orderedLeaves.length; index += 1) {
        assert.ok(
          orderedLeaves[index - 1].sourceRange.end <= orderedLeaves[index].sourceRange.start,
          `${latex}: conflicting leaf ranges for ${orderedLeaves[index - 1].id} and ${orderedLeaves[index].id}`,
        );
      }
    }
  });

  it("reports the first explicit pipeline reason instead of silently losing a visible leaf", () => {
    const { tree, serialization, domHtml } = renderFixture(String.raw`a+b`, 100);
    const leaves = tree.flatNodes.filter((node) => classifySemanticNodeInteraction(node, tree.displayLatex).interactive);
    const measuredTargets = leaves.slice(1).map((node) => ({
      ...node,
      rects: [{ left: 0, top: 0, right: 8, bottom: 12, width: 8, height: 12 }],
    }));
    const audit = auditSemanticCoverage({
      tree,
      serialization,
      domHtml,
      measuredTargets,
      geometryAcceptedTargets: measuredTargets,
      reachableTargets: measuredTargets,
    });

    assert.equal(audit.complete, false);
    assert.equal(audit.silentMissingNodes.length, 1);
    assert.equal(audit.silentMissingNodes[0].failureReason, "not-measured");
  });
});
