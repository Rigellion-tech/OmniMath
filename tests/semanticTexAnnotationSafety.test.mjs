import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import {
  createSemanticKatexTrust,
  serializeSemanticTreeToLatex,
  validateSemanticTreeRanges,
} from "../src/lib/semanticMathRenderer.js";

const CORPUS = [
  ["binomial", String.raw`\binom{n}{k}`, false, 2],
  ["overbrace", String.raw`\overbrace{a+b+c}^{n\text{ terms}}`, false, 5],
  ["underbrace", String.raw`\underbrace{x+\cdots+x}_{n}`, false, 5],
  ["cube-root", String.raw`\sqrt[3]{1+x}`, false, 3],
  ["indexed-root", String.raw`\sqrt[n+1]{x^2+y^2}`, false, 7],
  ["norm", String.raw`\left\lVert x+y \right\rVert`, true, 3],
  ["substack-limit", String.raw`\lim_{\substack{x\to0\\x>0}} f(x)`, false, 4],
  ["overset", String.raw`\overset{!}{=}`, false, 1],
  ["underset-operator", String.raw`\underset{x}{\operatorname{argmax}} f(x)`, false, 4],
  ["accents", String.raw`\vec{x}, \hat{x}, \bar{x}, \dot{x}, \ddot{x}`, false, 9],
  ["operatorname", String.raw`\operatorname{erf}(x)`, true, 3],
  ["text", String.raw`\text{if } x>0`, false, 4],
  ["matrix", String.raw`\begin{pmatrix}\frac{a_1}{b^2}&x^{y_z}\\\sqrt{q}&r\end{pmatrix}`, false, 8],
  ["cases", String.raw`\begin{cases}x^2&x>0\\-x&x\le0\end{cases}`, true, 8],
  ["aligned", String.raw`\begin{aligned}a&=b+c\\d&=e-f\end{aligned}`, false, 6],
];

function render(latex, trust = false) {
  return katex.renderToString(latex, {
    throwOnError: true,
    strict: "ignore",
    ...(trust ? { trust: createSemanticKatexTrust() } : {}),
  });
}

function crossing(left, right) {
  return (
    left.start < right.start && right.start < left.end && left.end < right.end
  ) || (
    right.start < left.start && left.start < right.end && right.end < left.end
  );
}

describe("TeX-grammar-safe semantic annotation", () => {
  for (const [name, latex, completelyAnnotatable, minimumOwners] of CORPUS) {
    it(`preserves valid KaTeX and local semantic ownership for ${name}`, () => {
      assert.doesNotThrow(() => render(latex), "the original corpus input must be valid KaTeX");

      const tree = buildSemanticTree({ stepId: `tex-safety-${name}`, displayLatex: latex, enabled: true });
      const first = serializeSemanticTreeToLatex(tree);
      const second = serializeSemanticTreeToLatex(
        buildSemanticTree({ stepId: `tex-safety-${name}`, displayLatex: latex, enabled: true }),
      );

      assert.equal(first.error, "");
      assert.equal(first.annotationPlan.originalKatexValid, true);
      assert.equal(first.rangeValidation.valid, true, "the corpus should not emit invalid semantic source ranges");
      assert.equal(first.annotationPlan.completeAnnotationValid, completelyAnnotatable);
      assert.equal(first.latex, second.latex, "annotation output must be deterministic");
      assert.deepEqual(first.annotatedNodeIds, second.annotatedNodeIds, "semantic identities must be deterministic");
      assert.ok(first.annotatedNodeCount >= minimumOwners, `${name} should retain useful local ownership`);

      assert.doesNotThrow(() => render(first.latex, true));
      const html = render(first.latex, true);
      const ownerIds = new Set([...html.matchAll(/data-semantic-id="([^"]+)"/gu)].map((match) => match[1]));
      assert.equal(ownerIds.size, first.annotatedNodeCount, "every accepted annotation must produce a DOM owner");

      const acceptedRanges = first.annotatedNodeIds
        .map((id) => tree.nodeMap[id]?.sourceRange)
        .filter(Boolean);
      for (let left = 0; left < acceptedRanges.length; left += 1) {
        for (let right = left + 1; right < acceptedRanges.length; right += 1) {
          assert.equal(crossing(acceptedRanges[left], acceptedRanges[right]), false, "render ranges must be nested or disjoint");
        }
      }

      const syntaxOwners = first.annotationPlan.syntaxRanges
        .filter((syntax) => ["environment-marker", "alignment-marker", "row-separator", "script-marker", "group-marker", "optional-argument-marker"].includes(syntax.kind))
        .filter((syntax) => acceptedRanges.some((range) => range.start === syntax.start && range.end === syntax.end));
      assert.deepEqual(syntaxOwners, [], "pure TeX grammar tokens must not be interactive");

      if (!completelyAnnotatable) {
        assert.ok(
          first.nodeDiagnostics.some((item) => [
            "inside-layout-sensitive-script-structure",
            "katex-rejected-wrapper-boundary",
            "pure-tex-syntax",
            "tex-layout-changed",
            "tex-parse-structure-changed",
          ].includes(item.reason) || item.reason.startsWith("contains-tex-structural-syntax:")),
          `${name} should expose its local degradation`,
        );
        assert.ok(first.annotatedNodeCount > 0, `${name} must not degrade the whole expression`);
      }
    });
  }

  it("keeps safe substack atoms while diagnosing operator script-layout changes", () => {
    const latex = String.raw`\lim_{\substack{x\to0\\x>0}} f(x)`;
    const tree = buildSemanticTree({ stepId: "scripted-structure", displayLatex: latex, enabled: true });
    const rendered = serializeSemanticTreeToLatex(tree);
    const limit = tree.flatNodes.find((node) => node.role === "limitOperator");
    const innerCondition = tree.flatNodes.find((node) => node.role === "leftSide" && node.latex === "x");
    assert.equal(rendered.nodeDiagnostics.find((item) => item.semanticId === limit.id)?.reason, "tex-layout-changed");
    assert.ok(rendered.annotatedNodeIds.includes(innerCondition.id));
    assert.doesNotThrow(() => render(rendered.latex, true));
  });

  it("rejects crossing ownership ranges locally while preserving a disjoint target", () => {
    const source = "a+b+c";
    const tree = {
      displayLatex: source,
      rootId: "root",
      semanticTree: { id: "root", role: "expression", type: "expression", latex: source, sourceRange: { start: 0, end: 5 }, childIds: ["left", "crossing", "tail"] },
      flatNodes: [
        { id: "root", role: "expression", type: "expression", latex: source, sourceRange: { start: 0, end: 5 }, childIds: ["left", "crossing", "tail"] },
        { id: "left", parentId: "root", role: "term", type: "symbol", latex: "a+b", sourceRange: { start: 0, end: 3 }, childIds: [] },
        { id: "crossing", parentId: "root", role: "term", type: "symbol", latex: "b+c", sourceRange: { start: 2, end: 5 }, childIds: [] },
        { id: "tail", parentId: "root", role: "variable", type: "symbol", latex: "c", sourceRange: { start: 4, end: 5 }, childIds: [] },
      ],
    };

    const validation = validateSemanticTreeRanges(tree);
    assert.equal(validation.valid, true, "crossing is an annotation-plan concern, not a source-slice error");
    const rendered = serializeSemanticTreeToLatex(tree);
    assert.doesNotThrow(() => render(rendered.latex, true));
    assert.ok(rendered.annotatedNodeIds.includes("tail"));
    assert.equal(rendered.nodeDiagnostics.filter((item) => item.reason.startsWith("crossing-semantic-range:")).length, 1);
  });
});
