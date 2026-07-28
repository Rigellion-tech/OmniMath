import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { createSemanticKatexTrust, serializeSemanticTreeToLatex, validateSemanticTreeRanges } from "../src/lib/semanticMathRenderer.js";

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderSemanticLatex(latex, stepId = "semantic-render-test") {
  const tree = buildSemanticTree({ stepId, displayLatex: latex });
  const rendered = serializeSemanticTreeToLatex(tree);
  assert.ok(rendered.annotatedNodeCount > 0, `expected annotations for ${latex}`);
  const html = katex.renderToString(rendered.latex, {
    throwOnError: true,
    strict: "ignore",
    trust: createSemanticKatexTrust(),
  });
  return { tree, rendered, html };
}

function flatNodes(tree) {
  return tree.flatNodes || Object.values(tree.nodes || {});
}

function findNode(tree, predicate) {
  return flatNodes(tree).find(predicate);
}

function findNodes(tree, predicate) {
  return flatNodes(tree).filter(predicate);
}

function assertNodeInHtml(html, node) {
  assert.ok(node?.id, "expected semantic node");
  assert.match(html, new RegExp(`data-semantic-id="${escapeRegExp(node.id)}"`));
}

function assertSafeSemanticRendering(latex, stepId = "safe-semantic-case") {
  const tree = buildSemanticTree({ stepId, displayLatex: latex });
  const validation = validateSemanticTreeRanges(tree);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));

  for (const node of tree.flatNodes) {
    assert.ok(node.sourceRange, `missing range for ${node.id}`);
    const slice = tree.displayLatex.slice(node.sourceRange.start, node.sourceRange.end);
    assert.equal(slice, node.source || node.latex, `${node.id} should own exact source slice`);
    assert.doesNotMatch(slice, /^\\(?:the|th)$/);
    assert.doesNotMatch(slice, /^(?:heta|ta)$/);
  }

  const rendered = serializeSemanticTreeToLatex(tree);
  assert.ok(rendered.annotatedNodeCount > 0, `expected annotations for ${latex}`);
  assert.equal(rendered.error, "");
  assert.doesNotMatch(rendered.latex, /\\htmlData\{[^{}]*\}\{\\\}/, "must not wrap a lone backslash");
  assert.doesNotMatch(rendered.latex, /\\htmlData\{[^{}]*\}\{\\(?:the|th)\}/, "must not wrap partial theta command");
  assert.doesNotMatch(rendered.latex, /\\htmlData\{[^{}]*\}\{(?:heta|ta)\}/, "must not wrap trailing theta fragments");
  assert.doesNotMatch(rendered.latex, /\\htmlData\{[^{}]*\}\{\\sec\}[A-Za-z]/, "must not split letters after sec command");
  katex.renderToString(rendered.latex, {
    throwOnError: true,
    strict: "ignore",
    trust: createSemanticKatexTrust(),
  });
  return { tree, rendered };
}

describe("semanticMathRenderer", () => {
  it("serializes x^2 with distinct base and exponent DOM IDs", () => {
    const { tree, html } = renderSemanticLatex("x^2", "power");
    const base = findNode(tree, (node) => node.role === "base" && node.latex === "x");
    const exponent = findNode(tree, (node) => node.role === "exponent" && node.latex === "2");

    assert.notEqual(base.id, exponent.id);
    assertNodeInHtml(html, base);
    assertNodeInHtml(html, exponent);
  });

  it("preserves fraction numerator, radicand, operator, and denominator IDs", () => {
    const { tree, html } = renderSemanticLatex("\\frac{-5 + \\sqrt{241}}{6}", "fraction");
    const signedFive = findNode(tree, (node) => node.role === "constant" && node.latex === "-5");
    const plus = findNode(tree, (node) => node.role === "operator" && node.latex === "+");
    const root = findNode(tree, (node) => node.role === "root" && node.latex === "\\sqrt{241}");
    const radicand = findNode(tree, (node) => node.role === "radicand" && node.latex === "241");
    const denominator = findNode(tree, (node) => node.role === "denominator" && node.latex === "6");

    for (const node of [signedFive, plus, root, radicand, denominator]) {
      assertNodeInHtml(html, node);
    }
  });

  it("gives repeated fractions distinct stable semantic IDs in rendered DOM", () => {
    const latex = "\\frac{-5 + \\sqrt{241}}{6}\\quad\\text{or}\\quad\\frac{-5 - \\sqrt{241}}{6}";
    const { tree, html } = renderSemanticLatex(latex, "repeated");
    const denominators = findNodes(tree, (node) => node.role === "denominator" && node.latex === "6");
    const fives = findNodes(tree, (node) => node.role === "constant" && node.latex === "-5");
    const radicands = findNodes(tree, (node) => node.role === "radicand" && node.latex === "241");

    assert.equal(denominators.length, 2);
    assert.equal(new Set(denominators.map((node) => node.id)).size, 2);
    assert.equal(fives.length, 2);
    assert.equal(new Set(fives.map((node) => node.id)).size, 2);
    assert.equal(radicands.length, 2);
    assert.equal(new Set(radicands.map((node) => node.id)).size, 2);
    for (const node of [...denominators, ...fives, ...radicands]) {
      assertNodeInHtml(html, node);
    }
  });

  it("keeps arctan as one function-name semantic token", () => {
    const { tree, html } = renderSemanticLatex("\\arctan(x)", "arctan");
    const arctan = findNode(tree, (node) => node.role === "functionName" && node.latex === "\\arctan");
    const x = findNode(tree, (node) => node.role === "argument" && node.latex === "x");
    const letterFragments = findNodes(tree, (node) => ["a", "r", "c", "t", "n"].includes(node.latex));

    assertNodeInHtml(html, arctan);
    assertNodeInHtml(html, x);
    assert.equal(letterFragments.length, 0);
  });

  it("preserves integral operator, bounds, power leaves, and differential identities", () => {
    const { tree, html } = renderSemanticLatex("\\int_0^1 x^2\\,dx", "integral");
    const expected = [
      findNode(tree, (node) => node.role === "integralSymbol" && node.latex === "\\int"),
      findNode(tree, (node) => node.role === "lowerBound" && node.latex === "0"),
      findNode(tree, (node) => node.role === "upperBound" && node.latex === "1"),
      findNode(tree, (node) => node.role === "base" && node.latex === "x"),
      findNode(tree, (node) => node.role === "exponent" && node.latex === "2"),
      findNode(tree, (node) => node.role === "differential" && node.latex === "dx"),
      findNode(tree, (node) => node.role === "differentialOperator" && node.latex === "d"),
    ];

    for (const node of expected) {
      assertNodeInHtml(html, node);
    }
  });

  it("preserves selectable descendants in numerator and denominator sums", () => {
    const { tree, html } = renderSemanticLatex("\\frac{a+b}{c+d}", "fraction-sums");
    const leaves = ["a", "+", "b", "c", "d"].map((latex) => (
      findNodes(tree, (node) => node.latex === latex && node.childIds.length === 0)
    )).flat();

    assert.ok(leaves.length >= 5);
    for (const node of leaves) assertNodeInHtml(html, node);
  });

  it("preserves canonical nested integral leaf annotations through parenthesized denominator groups", () => {
    const { tree, html } = renderSemanticLatex("\\int_0^\\infty\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx", "canonical-integral-render");
    const denominator = findNode(tree, (node) => node.latex === "x(1+x^2)" && node.role === "denominator");
    const denominatorGroup = findNode(tree, (node) => node.type === "parenthesized" && node.latex === "(1+x^2)" && node.parentId === denominator?.id);
    const denominatorInner = findNode(tree, (node) => node.latex === "1+x^2" && node.parentId === denominatorGroup?.id);
    const denominatorExponent = findNode(tree, (node) => node.latex === "2" && node.role === "exponent" && node.sourceRange?.start > denominator.sourceRange.start);
    const expectedLeaves = [
      findNode(tree, (node) => node.role === "integralSymbol" && node.latex === "\\int"),
      findNode(tree, (node) => node.role === "lowerBound" && node.latex === "0"),
      findNode(tree, (node) => node.role === "upperBound" && node.latex === "\\infty"),
      findNode(tree, (node) => node.role === "functionName" && node.latex === "\\ln"),
      findNode(tree, (node) => node.role === "functionName" && node.latex === "\\arctan"),
      findNode(tree, (node) => node.role === "argument" && node.latex === "x" && node.parentId && tree.nodeMap[node.parentId]?.type === "functionCall" && tree.nodeMap[node.parentId]?.latex.includes("\\arctan")),
      denominatorExponent,
      findNode(tree, (node) => node.role === "differentialOperator" && node.latex === "d"),
      findNode(tree, (node) => node.role === "variable" && node.latex === "x" && tree.nodeMap[node.parentId]?.role === "differential"),
    ];

    assert.ok(denominatorGroup?.id, "expected denominator parenthesized group");
    assert.ok(denominatorInner?.id, "expected denominator inner sum");
    for (const node of expectedLeaves) assertNodeInHtml(html, node);
  });

  it("keeps command tokens atomic and source ranges exact through implicit products", () => {
    const cases = [
      "\\theta\\sec^2\\theta",
      "\\theta\\,d\\theta",
      "\\theta\\cot\\theta",
      "\\ln(\\cos\\theta)",
      "\\cos(2n\\theta)",
      "x=\\tan\\theta",
      "\\int_0^{\\pi/2}",
      "\\int_0^{\\infty}",
      "\\frac{\\ln(\\sec^2\\theta)\\theta\\sec^2\\theta}{\\tan\\theta\\sec^2\\theta}",
    ];

    for (const [index, latex] of cases.entries()) {
      assertSafeSemanticRendering(latex, `atomic-command-${index}`);
    }
  });

  it("preserves useful nodes in the complex transformed fraction", () => {
    const latex = "\\frac{\\ln(\\sec^2\\theta)\\theta\\sec^2\\theta}{\\tan\\theta\\sec^2\\theta}";
    const { tree } = assertSafeSemanticRendering(latex, "transformed-fraction");
    const numerator = findNode(tree, (node) => node.role === "numerator");
    const denominator = findNode(tree, (node) => node.role === "denominator");
    const secFunctions = findNodes(tree, (node) => node.role === "functionName" && node.latex === "\\sec");
    const thetaLeaves = findNodes(tree, (node) => node.latex === "\\theta" && node.childIds.length === 0);

    assert.equal(numerator?.latex, "\\ln(\\sec^2\\theta)\\theta\\sec^2\\theta");
    assert.equal(denominator?.latex, "\\tan\\theta\\sec^2\\theta");
    assert.ok(secFunctions.length >= 2);
    assert.ok(thetaLeaves.length >= 4);
  });

  it("falls back before serialization when a range would bisect a command", () => {
    const source = "\\theta\\sec^2\\theta";
    const tree = {
      displayLatex: source,
      rootId: "root",
      semanticTree: { id: "root", type: "expression", role: "expression", latex: source, sourceRange: { start: 0, end: source.length }, childIds: ["bad"] },
      flatNodes: [
        { id: "root", type: "expression", role: "expression", latex: source, sourceRange: { start: 0, end: source.length }, childIds: ["bad"] },
        { id: "bad", parentId: "root", type: "symbol", role: "variable", latex: "\\thet", sourceRange: { start: 0, end: 5 }, childIds: [] },
      ],
    };
    const rendered = serializeSemanticTreeToLatex(tree);

    assert.equal(rendered.annotatedNodeCount, 0);
    assert.equal(rendered.latex, "");
    assert.equal(rendered.error, "invalid-semantic-ranges");
    assert.match(rendered.diagnostics[0].reason, /source-slice-mismatch|range-end-inside-command/);
  });
});
