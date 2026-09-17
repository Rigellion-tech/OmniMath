import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { createSemanticKatexTrust, serializeSemanticTreeToLatex } from "../src/lib/semanticMathRenderer.js";
import { createTexAnnotationGrammar } from "../src/lib/texAnnotationGrammar.js";
import { resolveSemanticTarget } from "../src/lib/semanticHitboxes.js";
import { reconcileLogicalHoverOwnership } from "../src/lib/hoverOwnership.js";
import { semanticRenderingCorpus } from "./fixtures/semanticRenderingCorpus.mjs";
import { inspectSemanticRenderTarget } from "../src/lib/semanticRenderDiagnostics.js";

const trust = createSemanticKatexTrust();
for (const { name, latex } of semanticRenderingCorpus) {
  test(`adversarial rendering: ${name}`, () => {
    assert.doesNotThrow(() => katex.renderToString(latex, { throwOnError: true, strict: "ignore" }));
    const tree = buildSemanticTree({ stepId: name, displayLatex: latex, enabled: true });
    assert.equal(tree.displayLatex, latex, "valid corpus TeX reaches annotation unchanged");
    const result = serializeSemanticTreeToLatex(tree);
    assert.equal(result.error, "");
    assert.equal(result.rangeValidation.valid, true, JSON.stringify(result.rangeValidation.errors));
    const check = createTexAnnotationGrammar(latex, trust).validate(result.latex, result.annotatedNodeIds);
    assert.equal(check.valid, true, check.error);
    for (const displayMode of [false, true]) {
      const html = katex.renderToString(result.latex, { throwOnError: true, strict: "ignore", trust, displayMode, output: "html" });
      const ids = [...html.matchAll(/data-semantic-id="([^"]+)"/gu)].map((match) => match[1]);
      assert.deepEqual([...ids].sort(), [...result.annotatedNodeIds].sort());
    }
    if (name !== "duplicate-expansion") assert.ok(result.annotatedNodeCount > 0, name);
    assert.ok(result.annotationPlan.validationAttempts <= 161);
    const again = serializeSemanticTreeToLatex(buildSemanticTree({ stepId: name, displayLatex: latex, enabled: true }));
    assert.equal(again.latex, result.latex);
    if (name === "repeated") {
      const xs = tree.flatNodes.filter((node) => node.latex === "x" && !node.childIds.length);
      assert.ok(xs.length >= 7);
      assert.equal(new Set(xs.map((node) => node.id)).size, xs.length);
      assert.ok(xs.every((node) => result.annotatedNodeIds.includes(node.id)));
    }
    if (name === "array-options") {
      for (const symbol of ["x", "y", "z", "w"]) {
        assert.ok(tree.flatNodes.some((node) => node.latex === symbol && result.annotatedNodeIds.includes(node.id)), symbol);
      }
    }
  });
}

test("KaTeX acceptance alone is insufficient for scopes, infix grammar and dimensions", () => {
  const fixtures = [
    [String.raw`\color{red}x+y`, String.raw`\htmlData{semantic-id=bad}{\color{red}}x+y`],
    [String.raw`a\over b`, String.raw`a\htmlData{semantic-id=bad}{\over}b`],
    [String.raw`\rule[2pt]{1em}{3pt}`, String.raw`\rule[\htmlData{semantic-id=bad}{2pt}]{1em}{3pt}`],
  ];
  for (const [source, annotated] of fixtures) {
    assert.doesNotThrow(() => katex.renderToString(annotated, { trust, strict: "ignore", throwOnError: true }));
    assert.equal(createTexAnnotationGrammar(source, trust).validate(annotated, ["bad"]).valid, false);
  }
});

test("font commands retain italic correction when semantic owners split a glyph run", () => {
  const latex = String.raw`\pi/2+2\Gamma(x)+\mathrm{office}+\mathit{ffi}`;
  const tree = buildSemanticTree({ stepId: "glyph-correction", displayLatex: latex, enabled: true });
  const rendered = serializeSemanticTreeToLatex(tree);
  const unsafeRomanFs = tree.flatNodes.filter((node) => node.latex === "f"
    && node.sourceRange.start >= latex.indexOf("office")
    && node.sourceRange.end <= latex.indexOf("office") + "office".length);
  const ordinaryMathLeaves = tree.flatNodes.filter((node) => [String.raw`\pi`, "2", String.raw`\Gamma`, "x"]
    .includes(node.latex) && !node.childIds.length && node.sourceRange.end <= latex.indexOf(String.raw`\mathrm`));

  assert.equal(unsafeRomanFs.length, 2);
  assert.ok(unsafeRomanFs.every((node) => !rendered.annotatedNodeIds.includes(node.id)));
  assert.ok(unsafeRomanFs.every((node) => rendered.nodeDiagnostics
    .find((diagnostic) => diagnostic.semanticId === node.id)?.reason === "tex-layout-changed"));
  assert.ok(ordinaryMathLeaves.length >= 4);
  assert.ok(ordinaryMathLeaves.every((node) => rendered.annotatedNodeIds.includes(node.id)));
  assert.equal(createTexAnnotationGrammar(latex, trust)
    .validate(rendered.latex, rendered.annotatedNodeIds).valid, true);
});

const rect = { left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 };
test("invalid geometry cannot be selected or resurrected as the current target", () => {
  const stale = { id: "stale", role: "variable", type: "symbol", latex: "x", rects: [rect], paintedRects: [rect], geometryValid: false };
  assert.equal(resolveSemanticTarget({ pointer: { x: 10, y: 10 }, candidates: [stale] }).target, null);
  assert.equal(resolveSemanticTarget({ pointer: { x: 10, y: 10 }, currentTarget: stale }).target, null);
});

test("a page ancestor in the hit stack cannot retain an occluded source", () => {
  const source = { isConnected: true, contains: () => false };
  const pageAncestor = { contains: (node) => node === source };
  const result = reconcileLogicalHoverOwnership({
    pointer: { x: 10, y: 10 }, activeTokenId: "x", sourceElement: source,
    measuredTargets: [{ id: "x", rects: [rect] }],
    documentRef: { elementsFromPoint: () => [pageAncestor] },
  });
  assert.equal(result.retained, false);
});

test("deterministic nested grammar stress preserves rendering and owner identity", () => {
  const wraps = [
    (inner) => String.raw`\frac{${inner}}{1+\frac14}`,
    (inner) => String.raw`\sqrt[n+1]{${inner}}`,
    (inner) => String.raw`\left(${inner}\right)^{x_i}`,
    (inner) => String.raw`\begin{pmatrix}${inner}&x\\x&x\end{pmatrix}`,
    (inner) => String.raw`\sum_{i=1}^n\left(${inner}\right)`,
    (inner) => String.raw`\begin{cases}${inner}&x>0\\-x&\text{otherwise}\end{cases}`,
    (inner) => String.raw`\widehat{${inner}}+\sin^2 x`,
    (inner) => String.raw`\begin{aligned}y&=${inner}\\&=x\end{aligned}`,
  ];
  for (let seed = 0; seed < 48; seed += 1) {
    let source = "x+x";
    for (let level = 0; level < 3 + seed % 4; level += 1) source = wraps[(seed + level * 3) % wraps.length](source);
    const tree = buildSemanticTree({ stepId: `stress-${seed}`, displayLatex: source, enabled: true });
    const rendering = serializeSemanticTreeToLatex(tree);
    assert.equal(rendering.error, "", source);
    const check = createTexAnnotationGrammar(source, trust).validate(rendering.latex, rendering.annotatedNodeIds);
    assert.equal(check.valid, true, `${seed}: ${check.error}`);
    assert.ok(rendering.annotatedNodeCount > 0, `stress-${seed} lost all ownership`);
    assert.ok(rendering.annotationPlan.validationAttempts <= 161);
  }
});

test("the diagnostic inspector joins source, annotation, owner, geometry and pointer stages", () => {
  const tree = buildSemanticTree({ stepId: "inspect", displayLatex: "x+1", enabled: true });
  const rendering = serializeSemanticTreeToLatex(tree);
  const node = tree.flatNodes.find((item) => item.latex === "x");
  const owner = { isConnected: true, getAttribute: () => node.id, getClientRects: () => [rect] };
  const target = { ...node, rects: [rect], paintedRects: [rect], geometryValid: true, elements: [owner] };
  const result = inspectSemanticRenderTarget({ tree, rendering, id: node.id, pointer: { x: 10, y: 10 },
    snapshot: { valid: true, revision: 2, targets: [target], childTargets: [target] } });
  assert.equal(result.sourceSlice, "x");
  assert.equal(result.annotation.serialized, true);
  assert.equal(result.ownerElements[0], owner);
  assert.deepEqual(result.owners[0].liveRects, [rect]);
  assert.equal(result.geometry.accepted, true);
  assert.equal(result.pointerSelection.selectedId, node.id);
});
