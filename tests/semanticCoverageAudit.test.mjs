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
  it("detects source atoms omitted by the parser before annotation or geometry", () => {
    const latex = String.raw`\int x+y\,dx+\int z\,dS`;
    const tree = buildSemanticTree({ stepId: "source-atom-gap", displayLatex: latex, enabled: true });
    const complete = auditSemanticCoverage({ tree });
    assert.equal(complete.sourceAtomCoverageComplete, true);
    assert.deepEqual(complete.sourceAtomGaps, []);

    const secondIntegralStart = latex.indexOf("\\int", latex.indexOf("+\\int") + 1);
    const missingSuffix = {
      ...tree,
      flatNodes: tree.flatNodes.filter((node) => node.sourceRange.start < secondIntegralStart),
    };
    const audit = auditSemanticCoverage({ tree: missingSuffix });
    assert.equal(audit.sourceAtomCoverageComplete, false);
    assert.ok(audit.sourceAtomGaps.some((gap) => gap.latex === "z"));
    assert.ok(audit.sourceAtomGaps.every((gap) => gap.failureReason === "visible-source-atom-without-semantic-node"));
  });
  it("serializes safe leaves and explicitly reports layout-sensitive leaves in each notation class", () => {
    for (const [fixtureIndex, latex] of NOTATION_FIXTURES.entries()) {
      const { tree, serialization, domHtml } = renderFixture(latex, fixtureIndex);
      const interactiveLeaves = tree.flatNodes.filter((node) => (
        classifySemanticNodeInteraction(node, tree.displayLatex).interactive
      ));
      const measuredTargets = tree.flatNodes.filter((node) => serialization.annotatedNodeIds.includes(node.id)).map((node) => ({
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

      assert.equal(
        audit.complete,
        audit.silentMissingNodes.length === 0 && audit.sourceAtoms.every((atom) => atom.firstFailingLayer === 0)
      );
      for (const missing of audit.silentMissingNodes) {
        assert.match(missing.failureReason, /^(?:tex-layout-changed|tex-parse-structure-changed|katex-rejected-wrapper-boundary)$/,
          `${latex}: unexpected annotation loss for ${missing.semanticId}`);
      }
      assert.ok(interactiveLeaves.length > 0, latex);
      for (const node of audit.nodes) {
        if (node.interactionClassification === "interactive-leaf") {
          if (!node.serialized) {
            assert.equal(node.domAnnotationFound, false);
            assert.equal(node.reachable, false);
            continue;
          }
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

  it("covers every visible atom in the nonlinear variational PDE fixture through an exact or compact semantic owner", () => {
    const fixtures = [
      String.raw`-\nabla\cdot((1+\alpha|\nabla u_*|^4)\nabla u_*)+\beta u_*-\lambda|u_*|^{q-2}u_*=0`,
      String.raw`B_*=(1+\alpha|\nabla u_*|^4)I+4\alpha|\nabla u_*|^2\nabla u_*\otimes\nabla u_*`,
      String.raw`L_*v=-\nabla\cdot(B_*\nabla v)+[\beta-\lambda(q-1)|u_*|^{q-2}]v`,
      String.raw`J''[u_*](v,v)`,
      String.raw`\inf_{0\ne v\in H_0^1(\Omega)}\frac{J''[u_*](v,v)}{\int_\Omega v^2\,dx}`,
    ];

    for (const [index, latex] of fixtures.entries()) {
      const { tree, serialization, domHtml } = renderFixture(latex, `variational-${index}`);
      const measuredTargets = tree.flatNodes
        .filter((node) => serialization.annotatedNodeIds.includes(node.id))
        .map((node) => ({ ...node, rects: [{ left: 0, top: 0, right: 8, bottom: 12, width: 8, height: 12 }] }));
      const audit = auditSemanticCoverage({
        tree,
        serialization,
        domHtml,
        measuredTargets,
        geometryAcceptedTargets: measuredTargets,
        reachableTargets: measuredTargets,
      });

      assert.equal(audit.complete, true, `${latex}: ${JSON.stringify(audit.sourceAtoms.filter((atom) => atom.firstFailingLayer), null, 2)}`);
      assert.equal(audit.sourceAtoms.every((atom) => atom.semanticId && atom.firstFailingLayer === 0), true, latex);
    }
  });
});
