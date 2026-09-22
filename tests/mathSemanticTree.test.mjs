import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachLocalSemanticExplanation, cleanSemanticTarget } from "../src/lib/mathHitboxes.js";
import { createMultiSelection, createRangeSelection } from "../src/lib/mathSelectionModel.js";
import { buildSemanticTree } from "../src/lib/mathSemanticTree.js";
import { latexToCompactDisplay, looksLikeBrokenMathLabel, userFacingTooltipTitle } from "../src/lib/presentationLabels.js";

function nodeByLatex(tree, latex, role = null) {
  return tree.flatNodes.find((node) => node.latex === latex && (!role || node.role === role));
}

function compactLatex(value = "") {
  return String(value || "").replace(/\s+/g, "");
}

function semanticTree(displayLatex, stepId = "s1") {
  return buildSemanticTree({ stepId, displayLatex, enabled: true });
}

function sourceText(tree, node) {
  return tree.displayLatex.slice(node.sourceRange.start, node.sourceRange.end);
}

function childrenOf(tree, node) {
  return (node?.childIds || []).map((id) => tree.nodeMap[id]).filter(Boolean);
}

function descendantsOf(tree, node) {
  const descendants = [];
  const visit = (current) => {
    for (const child of childrenOf(tree, current)) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(node);
  return descendants;
}

function findDescendant(tree, node, predicate, label) {
  const found = descendantsOf(tree, node).find(predicate);
  assert.ok(found, `missing ${label}`);
  return found;
}

function assertSourceText(tree, node, expected) {
  assert.ok(node?.sourceRange, `missing source range for ${expected}`);
  assert.equal(sourceText(tree, node), expected, `${node.id} should map to ${expected}`);
}

function assertImaginaryRootTree(displayLatex) {
  const tree = semanticTree(displayLatex);
  const repeated = semanticTree(displayLatex);
  const expectedLeaves = ["x", "=", "-35", "\\pm", "i", "\\sqrt", "278471", "/", "6"];
  const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

  assert.deepEqual(leafLatex, expectedLeaves);

  const importantNodes = [
    nodeByLatex(tree, "i", "imaginaryUnit"),
    nodeByLatex(tree, "\\sqrt{278471}", "root"),
    nodeByLatex(tree, "\\sqrt", "radical"),
    nodeByLatex(tree, "278471", "radicand"),
    tree.flatNodes.find((node) => node.role === "numerator" && compactLatex(node.latex) === "-35\\pmi\\sqrt{278471}"),
    nodeByLatex(tree, "6", "denominator"),
  ];

  for (const node of importantNodes) {
    assert.ok(node?.id, `missing expected node in ${displayLatex}`);
  }

  assert.equal(nodeByLatex(tree, "\\sqrt{278471}", "root").type, "root");
    assert.equal(nodeByLatex(tree, "278471", "radicand").type, "number");
    assert.equal(nodeByLatex(tree, "i", "imaginaryUnit").type, "symbol");
  assert.equal(tree.flatNodes.find((node) => node.role === "numerator" && compactLatex(node.latex) === "-35\\pmi\\sqrt{278471}")?.type, "sum");
  assert.equal(nodeByLatex(tree, "6", "denominator").type, "number");

  assert.deepEqual(
    importantNodes.map((node) => node.id),
    [
      nodeByLatex(repeated, "i", "imaginaryUnit"),
      nodeByLatex(repeated, "\\sqrt{278471}", "root"),
      nodeByLatex(repeated, "\\sqrt", "radical"),
      nodeByLatex(repeated, "278471", "radicand"),
      repeated.flatNodes.find((node) => node.role === "numerator" && compactLatex(node.latex) === "-35\\pmi\\sqrt{278471}"),
      nodeByLatex(repeated, "6", "denominator"),
    ].map((node) => node.id)
  );
}

describe("math semantic tree", () => {
  it("keeps dense variational operators, decorated symbols, scripts, and tensor products occurrence-specific", () => {
    const latex = String.raw`B_*=(1+\alpha|\nabla u_*|^4)I+4\alpha|\nabla u_*|^2\nabla u_*\otimes\nabla u_*`;
    const tree = semanticTree(latex, "variational-dense");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);

    assert.ok(leaves.some((node) => node.latex === "B_*"));
    assert.equal(leaves.filter((node) => node.latex === String.raw`\nabla`).length, 4);
    assert.equal(leaves.filter((node) => node.latex === "u_*").length, 4);
    assert.ok(leaves.some((node) => node.latex === String.raw`\otimes` && node.role === "operator"));
    assert.ok(leaves.some((node) => node.latex === "4" && node.role === "exponent"));
    assert.ok(leaves.some((node) => node.latex === "2" && node.role === "exponent"));
    assert.equal(tree.flatNodes.filter((node) => node.type === "absoluteValue").length, 2);
  });

  it("keeps prime decorations and grouped functional arguments as compact semantic units", () => {
    const tree = semanticTree(String.raw`J''[u_*](v,v)`, "variational-second-variation");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const primeSymbol = leaves.find((node) => node.latex === "J''");
    const argument = tree.flatNodes.find((node) => node.type === "parenthesized" && node.latex === "(v,v)");

    assertSourceText(tree, primeSymbol, "J''");
    assert.ok(argument?.id);
    assertSourceText(tree, argument, "(v,v)");
  });

  it("models infimum and integral heads separately from their full Rayleigh expressions", () => {
    const latex = String.raw`\inf_{0\ne v\in H_0^1(\Omega)}\frac{J''[u_*](v,v)}{\int_\Omega v^2\,dx}`;
    const tree = semanticTree(latex, "variational-rayleigh");
    const heads = tree.flatNodes.filter((node) => node.role === "operatorHead");

    assert.ok(heads.some((node) => node.latex.startsWith(String.raw`\inf_`)));
    assert.ok(heads.some((node) => node.latex.startsWith(String.raw`\int_`)));
    assert.ok(heads.every((node) => node.sourceRange.end - node.sourceRange.start < latex.length / 2));
    assert.ok(tree.flatNodes.some((node) => node.role === "bound" && node.latex.includes(String.raw`H_0^1`)));
  });

  it("keeps both variational integrals and the equation suffix in ranged semantic leaves", () => {
    const equations = [
      String.raw`J'[u](v)=\int_{\Omega}\left[-\nabla\cdot\left((1+\alpha|\nabla u|^2)\nabla u\right)+\beta u-\lambda|u|^{p-2}u\right]v\,dx+\int_{\partial\Omega}(1+\alpha|\nabla u|^2)\frac{\partial u}{\partial n}v\,dS`,
      String.raw`\int_{\Omega}(1+\alpha|\nabla u|^2)\nabla u\cdot\nabla v\,dx+\int_{\Omega}(\beta u-\lambda|u|^{p-2}u)v\,dx=0`,
    ];
    for (const [index, latex] of equations.entries()) {
      const tree = semanticTree(latex, `variational-${index}`);
      const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
      const boundary = latex.indexOf("dx+") + 2;
      const boundaryPlus = leaves.find((node) => node.latex === "+" && node.sourceRange.start === boundary);
      assert.ok(boundaryPlus, `missing top-level additive boundary in ${latex}`);
      assert.equal(leaves.filter((node) => node.latex === "\\int").length, 2);
      assert.ok(tree.flatNodes.some((node) => node.sourceRange.start > boundary && node.latex === (index === 0 ? "dS" : "0")));
      assert.ok(leaves.some((node) => node.sourceRange.start > boundary && node.latex === "\\lambda") || index === 0);
    }
  });

  it("splits additive expressions after a completed integral but keeps integrand additions inside it", () => {
    const latex = String.raw`\int_0^1 x+y\,dx+\int_{\partial\Omega} z+w\,dS+q`;
    const tree = semanticTree(latex);
    const root = tree.nodeMap[tree.rootId];
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    assert.equal(root.type, "sum");
    assert.equal(childrenOf(tree, root).filter((node) => node.type === "integral").length, 2);
    assert.equal(leaves.filter((node) => node.latex === "+").length, 4);
    assert.ok(leaves.some((node) => node.latex === "q" && node.sourceRange.end === latex.length));
  });

  it("retains complex right operands and repeated symbols after addition", () => {
    const rightOperands = [
      String.raw`\int_0^1 x\,dx`,
      String.raw`\int_{\partial\Omega} f\,dS`,
      String.raw`\frac{a}{b}`,
      String.raw`\sqrt{a+b}`,
      String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
      String.raw`\frac{\partial f}{\partial x}`,
      String.raw`(a+b)(c+d)`,
      String.raw`\int_0^1 a\,dx+\int_0^1 a\,dx`,
    ];
    for (const rhs of rightOperands) {
      const latex = `a+${rhs}`;
      const tree = semanticTree(latex);
      const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
      assert.ok(leaves.some((node) => node.latex === "+" && node.sourceRange.start === 1), latex);
      assert.ok(leaves.some((node) => node.sourceRange.start > 2 && node.sourceRange.end >= latex.length - 1) ||
        tree.flatNodes.some((node) => node.sourceRange.start >= 2 && node.sourceRange.end === latex.length),
      `missing rightmost semantic range in ${latex}`);
      assert.ok(leaves.some((node) => node.sourceRange.start > 2 && node.latex !== "+"), `missing RHS semantics in ${latex}`);
    }
  });
  it("creates a semantic tree from a simple equation", () => {
    const tree = semanticTree("3x+45=67");
    assert.equal(tree.stepId, "s1");
    assert.equal(tree.displayLatex, "3x+45=67");
    assert.equal(tree.nodeMap[tree.rootId].type, "equation");
    assert.equal(nodeByLatex(tree, "3x").type, "product");
    assert.equal(nodeByLatex(tree, "3", "coefficient").type, "number");
    assert.equal(nodeByLatex(tree, "x", "factor").type, "symbol");
    assert.equal(nodeByLatex(tree, "=", "equality").type, "operator");
  });

  it("keeps deterministic linear leaf order", () => {
    const tree = semanticTree("3x+45=67");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);
    assert.deepEqual(leafLatex, ["3", "x", "+", "45", "=", "67"]);
  });

  it("keeps presentational symbol commands atomic instead of parsing them as functions", () => {
    for (const latex of ["\\mathbf{F}", "d\\mathbf{r}", "\\mathbf{F}\\cdot d\\mathbf{r}"]) {
      const tree = semanticTree(latex);
      const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);
      assert.ok(!leafLatex.includes("\\mathbf"), `bare \\mathbf leaf leaked from ${latex}: ${leafLatex.join(" ")}`);
    }

    assert.deepEqual(
      semanticTree("\\mathbf{F}").linearLeaves.map((id) => semanticTree("\\mathbf{F}").nodeMap[id]?.latex),
      ["\\mathbf{F}"]
    );
    assert.deepEqual(
      semanticTree("d\\mathbf{r}").linearLeaves.map((id) => semanticTree("d\\mathbf{r}").nodeMap[id]?.latex),
      ["d", "\\mathbf{r}"]
    );
  });

  it("tokenizes 3x + 45 = 67 into literal leaves", () => {
    const tree = semanticTree("3x+45=67");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);
    assert.deepEqual(leafLatex, ["3", "x", "+", "45", "=", "67"]);
  });

  it("keeps quadratic minus and constant leaves separate", () => {
    const tree = semanticTree("3x^2+5x-445=0");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);
    const minusIndex = leafLatex.indexOf("-");
    const constantIndex = leafLatex.indexOf("-445");

    assert.ok(minusIndex >= 0, `missing minus leaf in ${leafLatex.join(" ")}`);
    assert.ok(constantIndex >= 0, `missing signed 445 leaf in ${leafLatex.join(" ")}`);
    assert.equal(constantIndex, minusIndex + 1);
  });

  it("exposes quadratic-formula denominator 2 as a leaf target", () => {
    const tree = semanticTree("x=\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}");
    const denominator = nodeByLatex(tree, "2\\cdot3", "denominator");
    const denominatorLeaves = tree.linearLeaves
      .map((id) => tree.nodeMap[id])
      .filter((node) => node.sourceRange.start >= denominator.sourceRange.start && node.sourceRange.end <= denominator.sourceRange.end)
      .map((node) => node.latex);

    assert.equal(denominatorLeaves[0], "2");
    assert.ok(!denominatorLeaves.includes("2\\cdot3"), `denominator should not be one leaf: ${denominatorLeaves.join(" ")}`);
  });

  it("splits unicode imaginary radicals into independent semantic leaves", () => {
    assertImaginaryRootTree("x = (-35 ± i√278471) / 6");
  });

  it("splits LaTeX imaginary radicals into independent semantic leaves", () => {
    assertImaginaryRootTree("x = (-35 \\pm i\\sqrt{278471}) / 6");
  });

  it("normalizes a clean subtree range selection", () => {
    const tree = semanticTree("3x+45=67");
    const start = nodeByLatex(tree, "3", "coefficient");
    const end = nodeByLatex(tree, "x", "factor");
    const selection = createRangeSelection(tree, start.id, end.id);
    assert.equal(selection.kind, "semantic");
    assert.equal(tree.nodeMap[selection.normalizedToNodeId].latex, "3x");
  });

  it("keeps non-subtree ranges as leaf ranges", () => {
    const tree = semanticTree("3x+45=67");
    const start = nodeByLatex(tree, "45");
    const end = nodeByLatex(tree, "67");
    const selection = createRangeSelection(tree, start.id, end.id);
    assert.equal(selection.kind, "range");
    assert.deepEqual(selection.leafIds.map((id) => tree.nodeMap[id].latex), ["45", "=", "67"]);
    assert.equal(selection.normalizedToNodeId, null);
  });

  it("marks unsafe or opaque latex as fallback instead of throwing", () => {
    const tree = buildSemanticTree({ stepId: "bad", displayLatex: "\\left\\{", enabled: true });
    assert.ok(tree);
    assert.equal(tree.fallback, true);
    assert.equal(tree.linearLeaves.length, 1);
  });

  it("adds local explanations for obvious roles", () => {
    const tree = semanticTree("3x+45=67");
    const coefficient = attachLocalSemanticExplanation(nodeByLatex(tree, "3", "coefficient"));
    assert.equal(coefficient.short, "Coefficient");
    assert.match(coefficient.medium, /multiplies/i);
  });

  it("produces stable node ids for the same input", () => {
    const first = semanticTree("3x+45=67");
    const second = semanticTree("3x+45=67");
    assert.deepEqual(
      first.flatNodes.map((node) => node.id),
      second.flatNodes.map((node) => node.id)
    );
  });

  it("gives repeated final-answer leaves unique occurrence-aware ids", () => {
    const tree = semanticTree("x = \\frac{-5 + \\sqrt{241}}{6} \\quad \\text{or} \\quad x = \\frac{-5 - \\sqrt{241}}{6}");
    const repeatedLeaves = tree.linearLeaves
      .map((id) => tree.nodeMap[id])
      .filter((node) => ["x", "-5", "241", "6"].includes(node.latex));
    const ids = repeatedLeaves.map((node) => node.id);

    assert.equal(repeatedLeaves.filter((node) => node.latex === "x").length, 2);
    assert.equal(repeatedLeaves.filter((node) => node.latex === "-5").length, 2);
    assert.equal(repeatedLeaves.filter((node) => node.latex === "241").length, 2);
    assert.equal(repeatedLeaves.filter((node) => node.latex === "6").length, 2);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      repeatedLeaves.filter((node) => node.latex === "6").map((node) => node.sourceRange),
      [{ start: 27, end: 28 }, { start: 71, end: 72 }]
    );
  });

  it("keeps repeated simplified fraction denominators unique across an equality chain", () => {
    const tree = semanticTree("x=\\frac{-5\\pm\\sqrt{25+216}}{6}=\\frac{-5\\pm\\sqrt{241}}{6}");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const denominators = leaves.filter((node) => node.latex === "6" && node.role === "denominator");
    const negativeFives = leaves.filter((node) => node.latex === "-5");

    assert.equal(denominators.length, 2);
    assert.equal(negativeFives.length, 2);
    assert.equal(new Set(denominators.map((node) => node.id)).size, 2);
    assert.equal(new Set(negativeFives.map((node) => node.id)).size, 2);
  });

  it("is disabled unless the semantic AST flag is enabled", () => {
    assert.equal(buildSemanticTree({ stepId: "s1", displayLatex: "3x+45=67", enabled: false }), null);
  });

  it("parses a nested trigonometric fraction into fraction, numerator, denominator, function, and argument nodes", () => {
    const tree = semanticTree("\\frac{\\cos(xy)}{1+x^2+y^2}");
    assert.equal(nodeByLatex(tree, "\\frac{\\cos(xy)}{1+x^2+y^2}", "fraction").type, "fraction");
    assert.equal(nodeByLatex(tree, "\\cos(xy)", "numerator").type, "functionCall");
    assert.equal(nodeByLatex(tree, "1+x^2+y^2", "denominator").type, "sum");
    assert.equal(nodeByLatex(tree, "xy", "argument").type, "product");
    assert.equal(nodeByLatex(tree, "x", "factor").type, "symbol");
    assert.equal(nodeByLatex(tree, "y", "factor").type, "symbol");
  });

  it("tokenizes cos(xy)/(1+x^2+y^2) into literal leaves", () => {
    const tree = semanticTree("\\frac{\\cos(xy)}{1+x^2+y^2}");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

    for (const expected of ["\\cos", "(", "x", "y", ")", "/", "1", "+", "^", "2"]) {
      assert.ok(leafLatex.includes(expected), `missing leaf ${expected} in ${leafLatex.join(" ")}`);
    }
    assert.equal(leafLatex.filter((leaf) => leaf === "x").length >= 2, true);
    assert.equal(leafLatex.filter((leaf) => leaf === "y").length >= 2, true);
    assert.equal(leafLatex.filter((leaf) => leaf === "^").length, 2);
    assert.equal(leafLatex.filter((leaf) => leaf === "2").length, 2);
  });

  it("parses slash fractions such as 3pi over 4", () => {
    const tree = semanticTree("3\\pi/4");
    assert.equal(nodeByLatex(tree, "3\\pi/4", "fraction").type, "fraction");
    assert.equal(nodeByLatex(tree, "3\\pi", "numerator").type, "product");
    assert.equal(nodeByLatex(tree, "4", "denominator").type, "number");
  });

  it("parses partial derivatives with a nested argument expression", () => {
    const tree = semanticTree("\\partial/\\partialx(\\frac{\\cos(xy)}{1+x^2+y^2})");
    assert.equal(nodeByLatex(tree, "\\partial/\\partialx(\\frac{\\cos(xy)}{1+x^2+y^2})", "partialDerivative").type, "partialDerivative");
    assert.equal(nodeByLatex(tree, "\\partial/\\partialx", "differentialOperator").type, "operator");
    assert.equal(nodeByLatex(tree, "\\frac{\\cos(xy)}{1+x^2+y^2}", "argument").type, "fraction");
  });

  it("parses ellipse equations with powered fraction terms", () => {
    const tree = semanticTree("x^2/4+y^2/9=1");
    assert.equal(tree.nodeMap[tree.rootId].type, "equation");
    assert.equal(nodeByLatex(tree, "x^2/4", "fraction").type, "fraction");
    assert.equal(nodeByLatex(tree, "y^2/9", "fraction").type, "fraction");
    assert.equal(nodeByLatex(tree, "x^2", "numerator").type, "power");
    assert.equal(nodeByLatex(tree, "9", "denominator").type, "number");
  });

  it("parses double integrals with multiple differential terms", () => {
    const tree = semanticTree("\\iint_D\\frac{\\cos(xy)}{1+x^2+y^2}\\,dx\\,dy");
    assert.equal(tree.nodeMap[tree.rootId].type, "integral");
    assert.equal(nodeByLatex(tree, "\\frac{\\cos(xy)}{1+x^2+y^2}", "integrand").type, "fraction");
    assert.deepEqual(
      tree.flatNodes.filter((node) => node.role === "differential").map((node) => node.latex),
      ["dx", "dy"]
    );
  });

  it("parses integral bounds and differentials as independent targets", () => {
    const tree = semanticTree("\\int_0^{2\\pi}\\cos^4\\theta\\,d\\theta=\\frac{3\\pi}{4}");

    assert.equal(nodeByLatex(tree, "0", "lowerBound").type, "number");
    assert.equal(nodeByLatex(tree, "2\\pi", "upperBound").type, "product");
    assert.equal(nodeByLatex(tree, "d\\theta", "differential").type, "differential");
    assert.equal(nodeByLatex(tree, "\\frac{3\\pi}{4}").type, "fraction");
    assert.equal(nodeByLatex(tree, "3\\pi", "numerator").type, "product");
    assert.equal(nodeByLatex(tree, "4", "denominator").type, "number");
  });

  it("tokenizes integral sign, lower bound, and upper bound in a bounded integral", () => {
    const tree = semanticTree("\\int_0^{2\\pi}");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

    assert.ok(leafLatex.includes("\\int"));
    assert.ok(leafLatex.includes("0"));
    assert.ok(leafLatex.includes("2"));
    assert.ok(leafLatex.includes("\\pi"));
  });

  it("parses base and exponent targets in powered fractions", () => {
    const tree = semanticTree("x^2/4+y^2/9=1");
    const xSquared = nodeByLatex(tree, "x^2", "numerator");
    assert.equal(xSquared.type, "power");
    assert.equal(tree.nodeMap[xSquared.childIds[0]].role, "base");
    assert.equal(tree.nodeMap[xSquared.childIds[0]].latex, "x");
    assert.ok(xSquared.childIds.map((id) => tree.nodeMap[id].latex).includes("^"));
    assert.equal(nodeByLatex(tree, "2", "exponent").type, "number");
  });

  it("parses multi-digit powered bases and exponent groups independently", () => {
    const tree = semanticTree("x+35^2=0");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);
    const power = nodeByLatex(tree, "35^2", "power");

    assert.deepEqual(leafLatex, ["x", "+", "35", "^", "2", "=", "0"]);
    assert.equal(power.type, "power");
    assert.equal(nodeByLatex(tree, "35", "base").type, "number");
    assert.equal(nodeByLatex(tree, "2", "exponent").type, "number");
  });

  it("parses quadratic formula fraction leaves separately", () => {
    const tree = semanticTree("\\frac{-5\\pm\\sqrt{5^2-4\\cdot3\\cdot(-445)}}{2\\cdot3}");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

    assert.ok(leafLatex.includes("-5"));
    assert.ok(leafLatex.includes("\\pm"));
    assert.ok(leafLatex.includes("\\sqrt"));
    assert.ok(leafLatex.includes("5"));
    assert.ok(leafLatex.includes("2"));
    assert.ok(leafLatex.includes("3"));
    assert.ok(leafLatex.includes("-445"));
  });

  it("parses approximation lines with decimals and subscripted branches", () => {
    const tree = semanticTree("x_1\\approx33.51, x_2\\approx-34.18");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

    for (const expected of ["x_1", "\\approx", "33.51", "x_2", "-34.18"]) {
      assert.ok(leafLatex.includes(expected), `missing ${expected} in ${leafLatex.join(" ")}`);
    }

    assert.equal(nodeByLatex(tree, "x_1").type, "subscript");
    assert.equal(nodeByLatex(tree, "x_2").type, "subscript");
    assert.equal(nodeByLatex(tree, "\\approx", "approximation").type, "operator");
  });

  it("creates equivalent number leaves for integer and decimal literals in one fraction numerator", () => {
    const tree = semanticTree("\\frac{5345-5902.71}{6}");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const numerator = nodeByLatex(tree, "5345-5902.71", "numerator");

    assert.deepEqual(leaves.map((node) => node.latex), ["5345", "-", "-5902.71", "/", "6"]);
    assert.equal(nodeByLatex(tree, "5345", "constant").type, "number");
    assert.equal(nodeByLatex(tree, "-5902.71", "constant").type, "number");
    assert.equal(leaves.filter((node) => node.latex === "5345").length, 1);
    assert.equal(leaves.filter((node) => node.latex === "-5902.71").length, 1);

    for (const literal of ["5345", "-5902.71"]) {
      const node = nodeByLatex(tree, literal, "constant");
      assert.ok(node.sourceRange.start >= numerator.sourceRange.start, `${literal} should be inside numerator range`);
      assert.ok(node.sourceRange.end <= numerator.sourceRange.end, `${literal} should be inside numerator range`);
    }
  });

  it("creates signed numeric leaves for final root arithmetic without dropping operators", () => {
    const tree = semanticTree("\\frac{-68068-200681.07}{4}=-66937.77");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const leafLatex = leaves.map((node) => node.latex);

    for (const expected of ["-68068", "-", "-200681.07", "4", "=", "-66937.77"]) {
      assert.ok(leafLatex.includes(expected), `missing ${expected} in ${leafLatex.join(" ")}`);
    }

    assert.equal(nodeByLatex(tree, "-200681.07", "constant").type, "number");
    assert.equal(nodeByLatex(tree, "-66937.77", "rightSide").type, "number");
    assert.equal(nodeByLatex(tree, "4", "denominator").type, "number");
  });

  it("exposes power bases, exponents, and large negative grouped constants", () => {
    const tree = semanticTree("\\Delta=68068²-4\\cdot2\\cdot(-4455969793)");
    const leafLatex = tree.linearLeaves.map((id) => tree.nodeMap[id].latex);

    for (const expected of ["68068", "^", "2", "4", "2", "-4455969793"]) {
      assert.ok(leafLatex.includes(expected), `missing ${expected} in ${leafLatex.join(" ")}`);
    }

    assert.equal(nodeByLatex(tree, "68068", "base").type, "number");
    assert.equal(nodeByLatex(tree, "2", "exponent").type, "number");
    assert.equal(nodeByLatex(tree, "-4455969793", "factor").type, "number");
  });

  it("creates one semantic leaf per decimal literal occurrence across nested fraction and radical contexts", () => {
    const tree = semanticTree("\\frac{\\frac{-92.12}{0.5}}{\\sqrt{\\frac{3.14159}{-0.001}}},x\\approx-0.001");
    const leaves = tree.linearLeaves.map((id) => tree.nodeMap[id]);
    const leafLatex = leaves.map((node) => node.latex);

    for (const expected of ["-92.12", "0.5", "3.14159", "-0.001"]) {
      assert.ok(leafLatex.includes(expected), `missing ${expected} in ${leafLatex.join(" ")}`);
      assert.equal(leaves.filter((node) => node.latex === expected).every((node) => node.type === "number"), true);
    }

    assert.equal(leaves.filter((node) => node.latex === "-92.12").length, 1);
    assert.equal(leaves.filter((node) => node.latex === "0.5").length, 1);
    assert.equal(leaves.filter((node) => node.latex === "3.14159").length, 1);
    assert.equal(leaves.filter((node) => node.latex === "-0.001").length, 2);
    assert.equal(nodeByLatex(tree, "0.5", "denominator").type, "number");
    assert.equal(nodeByLatex(tree, "3.14159", "numerator").type, "number");
    assert.equal(nodeByLatex(tree, "-0.001", "denominator").type, "number");
  });

  it("parses arctan function calls and arguments", () => {
    const tree = semanticTree("\\arctan(x-y)");
    assert.equal(nodeByLatex(tree, "\\arctan(x-y)", "function").type, "functionCall");
    assert.equal(nodeByLatex(tree, "\\arctan", "functionName").type, "function");
    assert.equal(nodeByLatex(tree, "x-y", "argument").type, "sum");
  });

  it("normalizes drag selection over exact leaves to a known subtree", () => {
    const tree = semanticTree("x^2/4+y^2/9=1");
    const base = nodeByLatex(tree, "x", "base");
    const exponent = nodeByLatex(tree, "2", "exponent");
    const selection = createRangeSelection(tree, base.id, exponent.id);

    assert.equal(selection.kind, "semantic");
    assert.equal(tree.nodeMap[selection.normalizedToNodeId].latex, "x^2");
  });

  it("keeps drag selection as multi-node when no single subtree matches", () => {
    const tree = semanticTree("3x+45=67");
    const three = nodeByLatex(tree, "3", "coefficient");
    const sixtySeven = nodeByLatex(tree, "67");
    const selection = createMultiSelection(tree, [three.id, sixtySeven.id]);

    assert.equal(selection.kind, "multi");
    assert.deepEqual(selection.leafIds.map((id) => tree.nodeMap[id].latex), ["3", "67"]);
  });

  it("preserves vector differential semantics for sub-token hover labels", () => {
    const tree = semanticTree("d\\mathbf r = \\langle -2\\sin\\theta, 3\\cos\\theta, 0\\rangle d\\theta");
    const latexNodes = tree.flatNodes.map((node) => node.latex);

    assert.ok(latexNodes.includes("d\\mathbf{r}"));
    assert.ok(latexNodes.includes("\\mathbf{r}"));
    assert.ok(latexNodes.includes("\\langle -2\\sin\\theta, 3\\cos\\theta, 0\\rangle\\,d\\theta"));
    assert.ok(latexNodes.includes("-2\\sin\\theta"));
    assert.ok(latexNodes.includes("3\\cos\\theta"));
    assert.ok(latexNodes.includes("0"));
    assert.ok(latexNodes.includes("d\\theta"));

    assert.deepEqual(
      tree.flatNodes.filter((node) => node.role === "component").map((node) => node.latex),
      ["-2\\sin\\theta", "3\\cos\\theta", "0"]
    );
    assert.equal(nodeByLatex(tree, "d\\theta", "differential").type, "differential");
  });

  it("formats vector and trig fragments without corrupting delimiter commands", () => {
    assert.equal(latexToCompactDisplay("\\mathbf{r}"), "r");
    assert.equal(latexToCompactDisplay("\\langle-2\\sin\\theta,3\\cos\\theta,0\\rangle\\,d\\theta"), "⟨-2sinθ,3cosθ,0⟩ dθ");
    assert.equal(latexToCompactDisplay("-2\\sin\\theta"), "-2sinθ");
    assert.equal(latexToCompactDisplay("3\\cos\\theta"), "3cosθ");
    assert.equal(latexToCompactDisplay("d\\theta"), "dθ");
    assert.equal(looksLikeBrokenMathLabel("()"), true);
    assert.equal(looksLikeBrokenMathLabel("\\langle-2\\sin\\theta,3\\cos\\theta,0\\rangle"), false);
  });

  it("falls back from invalid child labels to the nearest clean semantic parent", () => {
    const parent = { id: "parent", latex: "\\langle-2\\sin\\theta,3\\cos\\theta,0\\rangle", display: "\\langle-2\\sin\\theta,3\\cos\\theta,0\\rangle" };
    const child = { id: "child", parentId: "parent", latex: "()", display: "()" };
    const target = cleanSemanticTarget(child, new Map([[parent.id, parent], [child.id, child]]), null);

    assert.equal(target.id, "parent");
    assert.equal(userFacingTooltipTitle({
      selectedText: target.display,
      display: target.display,
      latex: target.latex,
    }), "⟨-2sinθ,3cosθ,0⟩");
  });

  it("uses the same clean fragment for hover title and explanation target", () => {
    const fragment = "-2\\sin\\theta";
    const title = userFacingTooltipTitle({
      selectedText: fragment,
      display: fragment,
      latex: fragment,
      role: "component",
    });
    const lazyPayloadSelectedLatex = fragment;

    assert.equal(title, "-2sinθ");
    assert.equal(latexToCompactDisplay(lazyPayloadSelectedLatex), title);
  });

  it("represents x^2 with distinct base, operator, exponent, and power ranges", () => {
    const tree = semanticTree("x^2");
    const power = nodeByLatex(tree, "x^2", "power");
    const base = nodeByLatex(tree, "x", "base");
    const exponent = nodeByLatex(tree, "2", "exponent");

    assert.equal(power.type, "power");
    assert.deepEqual(power.sourceRange, { start: 0, end: 3 });
    assert.deepEqual(base.sourceRange, { start: 0, end: 1 });
    assert.deepEqual(exponent.sourceRange, { start: 2, end: 3 });
    assert.deepEqual(power.childIds.map((id) => tree.nodeMap[id].latex), ["x", "^", "2"]);
  });

  it("keeps 1+x^2, x^2, x, and 2 as separate compositional nodes", () => {
    const tree = semanticTree("1+x^2");
    const sum = nodeByLatex(tree, "1+x^2", "expression");
    const power = nodeByLatex(tree, "x^2", "power");

    assert.equal(sum.type, "sum");
    assert.equal(power.parentId, sum.id);
    assert.deepEqual(tree.linearLeaves.map((id) => tree.nodeMap[id].latex), ["1", "+", "x", "^", "2"]);
  });

  it("parses generic function calls without enumerating function names", () => {
    const tree = semanticTree("customFunction(x^2,y+1)");
    const call = nodeByLatex(tree, "customFunction(x^2,y+1)", "function");
    const name = nodeByLatex(tree, "customFunction", "functionName");
    const argument = nodeByLatex(tree, "x^2,y+1", "argument");

    assert.equal(call.type, "functionCall");
    assert.equal(name.type, "function");
    assert.equal(argument.type, "sequence");
    assert.equal(nodeByLatex(tree, "x^2", "power").parentId, argument.id);
    assert.equal(nodeByLatex(tree, "y+1", "term").type, "sum");
  });

  it("parses control-word and operatorname functions with coherent function heads", () => {
    const fixtures = [
      { latex: String.raw`\Gamma(a)`, head: String.raw`\Gamma`, argument: "a" },
      { latex: String.raw`\zeta(s)`, head: String.raw`\zeta`, argument: "s" },
      { latex: String.raw`\operatorname{Li}(x)`, head: String.raw`\operatorname{Li}`, argument: "x" },
      { latex: String.raw`\operatorname{ArbitraryName}(t)`, head: String.raw`\operatorname{ArbitraryName}`, argument: "t" },
    ];

    for (const fixture of fixtures) {
      const tree = semanticTree(fixture.latex, "named-function");
      const call = tree.nodeMap[tree.rootId];
      const head = nodeByLatex(tree, fixture.head, "functionName");
      const argument = nodeByLatex(tree, fixture.argument, "argument");

      assert.equal(call.type, "functionCall", fixture.latex);
      assert.equal(head.type, "function", fixture.latex);
      assert.equal(head.parentId, call.id, fixture.latex);
      assert.equal(argument.parentId, call.id, fixture.latex);
      assert.deepEqual(head.sourceRange, { start: 0, end: fixture.head.length }, fixture.latex);
      assert.equal(sourceText(tree, head), fixture.head, fixture.latex);
      assert.equal(sourceText(tree, argument), fixture.argument, fixture.latex);
      assert.notEqual(head.id, argument.id, fixture.latex);
    }
  });

  it("parses adjacent generic functions as an implicit product, not one giant function argument", () => {
    const tree = semanticTree("ln(1+x^2) arctan(x)");
    const product = nodeByLatex(tree, "ln(1+x^2) arctan(x)", "term");
    const calls = tree.flatNodes.filter((node) => node.type === "functionCall");

    assert.equal(product.type, "product");
    assert.deepEqual(calls.map((node) => node.latex), ["ln(1+x^2)", "arctan(x)"]);
    assert.equal(nodeByLatex(tree, "1+x^2", "argument").type, "sum");
    assert.equal(nodeByLatex(tree, "arctan", "functionName").type, "function");
  });

  it("keeps repeated x^2 occurrences occurrence-specific in the full integral", () => {
    const tree = semanticTree("∫_0^∞ [ln(1+x^2) arctan(x)]/[x(1+x^2)] dx");
    const powers = tree.flatNodes.filter((node) => node.latex === "x^2" && node.type === "power");
    const infinity = nodeByLatex(tree, "\\infty", "upperBound");
    const differential = nodeByLatex(tree, "dx", "differential");

    assert.equal(tree.nodeMap[tree.rootId].type, "integral");
    assert.equal(powers.length, 2);
    assert.equal(new Set(powers.map((node) => node.id)).size, 2);
    assert.deepEqual(powers.map((node) => node.sourceRange), [{ start: 20, end: 23 }, { start: 41, end: 44 }]);
    assert.equal(infinity.type, "symbol");
    assert.equal(differential.type, "differential");
    assert.deepEqual(differential.childIds.map((id) => tree.nodeMap[id].latex), ["d", "x"]);
  });

  it("preserves canonical nested integral groups with exact source ranges", () => {
    const tree = semanticTree("\\int_0^\\infty\n\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\n\\,dx", "canonical-integral");
    const nodesById = new Set(tree.flatNodes.map((node) => node.id));
    assert.equal(nodesById.size, tree.flatNodes.length, "semantic ids should not collide");

    const root = tree.nodeMap[tree.rootId];
    const integralSymbol = nodeByLatex(tree, "\\int", "integralSymbol");
    const lower = nodeByLatex(tree, "0", "lowerBound");
    const upper = nodeByLatex(tree, "\\infty", "upperBound");
    const fraction = nodeByLatex(tree, "\\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}", "integrand");
    const numerator = nodeByLatex(tree, "\\ln(1+x^2)\\arctan x", "numerator");
    const denominator = nodeByLatex(tree, "x(1+x^2)", "denominator");
    const lnCall = nodeByLatex(tree, "\\ln(1+x^2)", "function");
    const lnName = nodeByLatex(tree, "\\ln", "functionName");
    const lnArgument = nodeByLatex(tree, "1+x^2", "argument");
    const arctanCall = nodeByLatex(tree, "\\arctan x", "function");
    const arctanName = nodeByLatex(tree, "\\arctan", "functionName");
    const arctanArgument = findDescendant(tree, arctanCall, (node) => node.latex === "x" && node.role === "argument", "arctan argument");
    const denominatorX = findDescendant(tree, denominator, (node) => node.latex === "x" && node.role === "factor", "standalone denominator x");
    const denominatorGroup = findDescendant(tree, denominator, (node) => node.type === "parenthesized" && node.latex === "(1+x^2)", "denominator parenthesized group");
    const denominatorInner = childrenOf(tree, denominatorGroup).find((node) => node.latex === "1+x^2");
    const differential = nodeByLatex(tree, "dx", "differential");
    const differentialVariable = findDescendant(tree, differential, (node) => node.latex === "x" && node.role === "variable", "differential variable x");

    assert.equal(root.type, "integral");
    for (const node of [
      integralSymbol,
      lower,
      upper,
      fraction,
      numerator,
      denominator,
      lnCall,
      lnName,
      lnArgument,
      arctanCall,
      arctanName,
      arctanArgument,
      denominatorX,
      denominatorGroup,
      denominatorInner,
      differential,
      differentialVariable,
    ]) {
      assert.ok(node?.id, "expected canonical integral node");
      assert.ok(Number.isInteger(node.depth) && node.depth >= 0, `${node.id} should have sensible depth`);
      assert.ok(node.sourceRange.start >= 0 && node.sourceRange.end <= tree.displayLatex.length, `${node.id} should stay inside source`);
    }

    assertSourceText(tree, integralSymbol, "\\int");
    assertSourceText(tree, lower, "0");
    assertSourceText(tree, upper, "\\infty");
    assertSourceText(tree, numerator, "\\ln(1+x^2)\\arctan x");
    assertSourceText(tree, denominator, "x(1+x^2)");
    assertSourceText(tree, lnCall, "\\ln(1+x^2)");
    assertSourceText(tree, lnName, "\\ln");
    assertSourceText(tree, lnArgument, "1+x^2");
    assertSourceText(tree, arctanCall, "\\arctan x");
    assertSourceText(tree, arctanName, "\\arctan");
    assertSourceText(tree, arctanArgument, "x");
    assertSourceText(tree, denominatorX, "x");
    assertSourceText(tree, denominatorGroup, "(1+x^2)");
    assertSourceText(tree, denominatorInner, "1+x^2");
    assertSourceText(tree, differential, "dx");
    assertSourceText(tree, differentialVariable, "x");

    const numeratorPower = findDescendant(tree, lnArgument, (node) => node.latex === "x^2" && node.type === "power", "numerator x^2");
    const denominatorPower = findDescendant(tree, denominatorInner, (node) => node.latex === "x^2" && node.type === "power", "denominator x^2");
    const numeratorExponent = findDescendant(tree, numeratorPower, (node) => node.latex === "2" && node.role === "exponent", "numerator exponent");
    const denominatorExponent = findDescendant(tree, denominatorPower, (node) => node.latex === "2" && node.role === "exponent", "denominator exponent");
    assertSourceText(tree, numeratorPower, "x^2");
    assertSourceText(tree, numeratorExponent, "2");
    assertSourceText(tree, denominatorPower, "x^2");
    assertSourceText(tree, denominatorExponent, "2");

    assert.equal(denominatorGroup.parentId, denominator.id);
    assert.equal(denominatorInner.parentId, denominatorGroup.id);
    assert.ok(denominatorInner.sourceRange.start > denominatorGroup.sourceRange.start, "inner group should start after opening parenthesis");

    const xLeaves = tree.linearLeaves.map((id) => tree.nodeMap[id]).filter((node) => node.latex === "x");
    assert.equal(xLeaves.length, 5);
    assert.equal(new Set(xLeaves.map((node) => `${node.sourceRange.start}:${node.sourceRange.end}`)).size, xLeaves.length);
    assert.deepEqual(tree.linearLeaves.map((id) => tree.nodeMap[id].latex).filter((latex) => ["\\int", "\\infty", "\\ln", "\\arctan", "dx"].includes(latex)), ["\\int", "\\infty", "\\ln", "\\arctan"]);
  });

  it("keeps nested integral upper-bound scripts inside the upperBound semantic group", () => {
    const latex = "\\int_{0}^{2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}} f(x)\\,dx";
    const tree = semanticTree(latex, "complex-upper-bound");
    const root = tree.nodeMap[tree.rootId];
    const upper = nodeByLatex(tree, "2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}", "upperBound");
    const upperDescendants = descendantsOf(tree, upper);
    const exponent = findDescendant(tree, upper, (node) => node.role === "exponent" && node.type === "fraction", "upper-bound exponent fraction");
    const numerator = findDescendant(tree, exponent, (node) => node.role === "numerator" && node.latex === "\\pi", "upper-bound numerator");
    const denominator = findDescendant(tree, exponent, (node) => node.role === "denominator" && node.latex.includes("\\ln"), "upper-bound denominator");
    const nestedNumerator = findDescendant(tree, denominator, (node) => node.role === "numerator" && node.latex === "\\ln(\\sec t)", "nested numerator");
    const nestedDenominator = findDescendant(tree, denominator, (node) => node.role === "denominator" && node.latex === "\\tan t", "nested denominator");
    const integrand = nodeByLatex(tree, "f(x)", "integrand");

    assert.equal(root.type, "integral");
    assertSourceText(tree, upper, "2^{\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}}");
    assertSourceText(tree, exponent, "\\frac{\\pi}{2+\\frac{\\ln(\\sec t)}{\\tan t}}");
    assertSourceText(tree, numerator, "\\pi");
    assertSourceText(tree, denominator, "2+\\frac{\\ln(\\sec t)}{\\tan t}");
    assertSourceText(tree, nestedNumerator, "\\ln(\\sec t)");
    assertSourceText(tree, nestedDenominator, "\\tan t");
    assertSourceText(tree, integrand, "f(x)");
    assert.equal(upperDescendants.some((node) => node.latex === "f(x)"), false);
    assert.ok(integrand.sourceRange.start > upper.sourceRange.end, "integrand must start after the full upper bound");
  });

  it("parses signed exponent subtrahends before adjacent fractions", () => {
    const tree = semanticTree("(\\sec^2\\theta)^{a-1}\\frac{\\sec^2\\theta}{\\sec^2\\theta}", "signed-exponent");
    const root = tree.nodeMap[tree.rootId];
    const power = tree.flatNodes.find((node) => node.latex === "(\\sec^2\\theta)^{a-1}" && node.type === "power");
    const fraction = tree.flatNodes.find((node) => node.latex === "\\frac{\\sec^2\\theta}{\\sec^2\\theta}" && node.type === "fraction");
    const exponent = nodeByLatex(tree, "a-1", "exponent");
    const signedOne = nodeByLatex(tree, "-1", "constant");
    const minus = findDescendant(tree, exponent, (node) => node.latex === "-" && node.role === "operator", "exponent minus operator");

    assert.equal(root.type, "product");
    assert.equal(power.type, "power");
    assert.equal(fraction.type, "fraction");
    assert.equal(exponent.parentId, power.id);
    assert.equal(signedOne.parentId, exponent.id);
    assert.equal(minus.parentId, exponent.id);
    assertSourceText(tree, power, "(\\sec^2\\theta)^{a-1}");
    assertSourceText(tree, exponent, "a-1");
    assertSourceText(tree, minus, "-");
    assertSourceText(tree, signedOne, "-1");
    assert.ok(signedOne.sourceRange.start === minus.sourceRange.start, "signed subtrahend should include the minus sign");
    assert.ok(fraction.sourceRange.start > signedOne.sourceRange.end, "neighboring fraction should start after the signed exponent");
  });

  it("parses ordinary and mixed partial derivatives with derivative variables", () => {
    const ordinary = semanticTree("d/dx [x^3]");
    const partial = semanticTree("∂²f/∂x∂y");

    assert.equal(ordinary.nodeMap[ordinary.rootId].type, "derivative");
    assert.equal(nodeByLatex(ordinary, "x", "derivativeVariable").type, "symbol");
    assert.equal(nodeByLatex(ordinary, "x^3", "argument").type, "power");
    assert.equal(partial.nodeMap[partial.rootId].type, "partialDerivative");
    assert.deepEqual(
      partial.flatNodes.filter((node) => node.role === "derivativeVariable").map((node) => node.latex),
      ["x", "y"]
    );
  });

  it("parses summation and limit operators structurally", () => {
    const summation = semanticTree("Σ_(k=1)^n k^2");
    const limit = semanticTree("lim_(x→0) sin(x)/x");

    assert.equal(summation.nodeMap[summation.rootId].type, "summation");
    assert.equal(nodeByLatex(summation, "k=1", "lowerBound").type, "equation");
    assert.equal(nodeByLatex(summation, "n", "upperBound").type, "symbol");
    assert.equal(nodeByLatex(summation, "k^2", "summand").type, "power");
    assert.equal(limit.nodeMap[limit.rootId].type, "limit");
    assert.equal(nodeByLatex(limit, "sin(x)/x", "argument").type, "fraction");
  });

  it("parses matrices and cases into rows and cells", () => {
    const matrix = semanticTree("\\begin{matrix}a&b\\\\c&d\\end{matrix}");
    const cases = semanticTree("\\begin{cases}x^2&x<0\\\\x&x\\ge0\\end{cases}");

    assert.equal(matrix.nodeMap[matrix.rootId].type, "matrix");
    assert.equal(matrix.flatNodes.filter((node) => node.type === "matrixRow").length, 2);
    assert.equal(matrix.flatNodes.filter((node) => node.type === "matrixCell").length, 4);
    assert.equal(cases.nodeMap[cases.rootId].type, "cases");
    assert.equal(cases.flatNodes.filter((node) => node.type === "caseExpression").length, 2);
    assert.equal(cases.flatNodes.filter((node) => node.type === "caseCondition").length, 2);
  });

  it("segments nested integral products by mathematical factors instead of function suffix text", () => {
    const latex = "\\int_{0}^{\\frac{\\pi}{2}}\\frac{t\\cot t\\ln(\\cos t)}{1+t_1^2}\\,dt";
    const tree = semanticTree(latex, "nested-product-ownership");
    const cot = nodeByLatex(tree, "\\cot t", "function");
    const logarithm = nodeByLatex(tree, "\\ln(\\cos t)", "function");
    const cosine = nodeByLatex(tree, "\\cos t", "argument");
    const poweredSubscript = nodeByLatex(tree, "t_1^2", "power");

    assert.equal(cot.type, "functionCall");
    assert.equal(logarithm.type, "functionCall");
    assert.equal(cosine.type, "functionCall");
    assert.equal(cot.latex.includes("\\ln"), false, "cotangent must not own the following logarithm");
    assert.equal(cot.parentId, logarithm.parentId, "adjacent function factors should be siblings in the product");
    assert.deepEqual(childrenOf(tree, poweredSubscript).map((node) => node.latex), ["t_1", "^", "2"]);
    for (const node of [cot, logarithm, cosine, poweredSubscript]) assertSourceText(tree, node, node.latex);
  });

  it("keeps spacing commands outside neighboring semantic source ranges", () => {
    const tree = semanticTree("a\\qquad=\\qquad\\left(\\frac{x_1^2}{1+x}\\right)", "spacing-ownership");
    const equality = nodeByLatex(tree, "=", "equality");
    const left = nodeByLatex(tree, "a", "leftSide");
    const fraction = tree.flatNodes.find((node) => node.type === "fraction");

    assertSourceText(tree, equality, "=");
    assertSourceText(tree, left, "a");
    assert.equal(left.sourceRange.end <= equality.sourceRange.start, true);
    assert.equal(fraction.latex.includes("\\qquad"), false);
  });

  it("parses evaluation wrappers without losing inner semantic ownership or source coordinates", () => {
    const latex = String.raw`A=\left.\frac{\partial^2}{\partial a\,\partial b}\frac{\Gamma(a/2)\Gamma(b/2)}{2\Gamma((a+b)/2)}\right|_{a=b=1}`;
    const tree = semanticTree(latex, "evaluation-gamma");
    const root = tree.nodeMap[tree.rootId];
    const evaluation = tree.flatNodes.find((node) => node.type === "evaluation");
    const evaluatedExpression = tree.nodeMap[evaluation?.childIds.find((id) => tree.nodeMap[id]?.role === "evaluatedExpression")];
    const evaluationBar = tree.nodeMap[evaluation?.childIds.find((id) => tree.nodeMap[id]?.role === "evaluationBar")];
    const condition = tree.nodeMap[evaluation?.childIds.find((id) => tree.nodeMap[id]?.role === "evaluationCondition")];
    const gammaCalls = tree.flatNodes.filter((node) => node.type === "functionCall" && node.latex.startsWith("\\Gamma"));
    const gammaNames = tree.flatNodes.filter((node) => node.role === "functionName" && node.latex === "\\Gamma");

    assert.equal(tree.displayLatex, latex);
    assert.equal(root.type, "equation");
    assert.ok(evaluation);
    assert.notEqual(evaluation.type, "atom");
    assert.equal(evaluatedExpression.type, "product");
    assert.equal(evaluationBar.latex, "|");
    assert.equal(condition.latex, "a=b=1");
    assert.equal(gammaCalls.length, 3);
    assert.equal(gammaNames.length, 3);
    assert.equal(new Set(gammaCalls.map((node) => node.id)).size, 3);
    assert.equal(new Set(gammaNames.map((node) => node.id)).size, 3);

    const derivative = tree.flatNodes.find((node) => node.type === "fraction" && node.latex.startsWith("\\frac{\\partial^2}"));
    const gammaFraction = tree.flatNodes.find((node) => node.type === "fraction" && node.latex.includes("\\Gamma(a/2)"));
    const groupedSum = tree.flatNodes.find((node) => node.type === "parenthesized" && node.latex === "(a+b)");
    assert.ok(derivative);
    assert.ok(gammaFraction);
    assert.ok(groupedSum);
    for (const expected of ["a", "b", "/", "2", "+"]) {
      assert.ok(tree.flatNodes.some((node) => node.latex === expected), `missing ${expected}`);
    }

    for (const node of tree.flatNodes) {
      assert.ok(node.sourceRange, `missing source range for ${node.id}`);
      assert.equal(sourceText(tree, node), node.source || node.latex, `${node.id} should use rendered-source coordinates`);
    }
  });

  it("parses evaluation notation and ordinary sized delimiters independently of function names", () => {
    const fixtures = [
      { latex: String.raw`\left.x^2\right|_{x=1}`, type: "evaluation", condition: "x=1" },
      { latex: String.raw`\left.\frac{d}{dx}f(x)\right|_{x=0}`, type: "evaluation", condition: "x=0" },
      { latex: String.raw`\left(x+\frac{1}{2}\right)`, type: "sizedDelimited", condition: null },
      { latex: String.raw`\left[x+1\right]`, type: "sizedDelimited", condition: null },
      { latex: String.raw`\left\{x+1\right\}`, type: "sizedDelimited", condition: null },
      { latex: String.raw`\left|x+1\right|`, type: "sizedDelimited", condition: null },
      { latex: String.raw`\bigl(x+1\bigr)`, type: "sizedDelimited", condition: null },
    ];

    for (const fixture of fixtures) {
      const tree = semanticTree(fixture.latex, "sized-delimiter");
      assert.equal(tree.displayLatex, fixture.latex);
      assert.equal(tree.nodeMap[tree.rootId].type, fixture.type);
      assert.equal(tree.fallback, false);
      assert.ok(tree.flatNodes.length > 1);
      if (fixture.condition) assert.ok(nodeByLatex(tree, fixture.condition, "evaluationCondition"));
      for (const node of tree.flatNodes) assert.equal(sourceText(tree, node), node.source || node.latex);
    }
  });

  it("parses leading unary signs as structural expressions with recursively parsed operands", () => {
    const fixtures = [
      { latex: "-B", operand: "B", operandType: "symbol" },
      { latex: "+B", operand: "B", operandType: "symbol" },
      { latex: String.raw`-\frac{B}{2}`, operand: String.raw`\frac{B}{2}`, operandType: "fraction" },
      { latex: String.raw`+\frac{x}{y}`, operand: String.raw`\frac{x}{y}`, operandType: "fraction" },
      { latex: String.raw`-\Gamma(x)`, operand: String.raw`\Gamma(x)`, operandType: "functionCall" },
      { latex: String.raw`-\sqrt{x}`, operand: String.raw`\sqrt{x}`, operandType: "root" },
      { latex: "-(a+b)", operand: "(a+b)", operandType: "parenthesized" },
      { latex: String.raw`-\sin x`, operand: String.raw`\sin x`, operandType: "functionCall" },
      { latex: "--B", operand: "-B", operandType: "unaryExpression" },
      { latex: "-(-B)", operand: "(-B)", operandType: "parenthesized" },
    ];

    for (const [index, fixture] of fixtures.entries()) {
      const tree = semanticTree(fixture.latex, `unary-${index}`);
      const unary = tree.nodeMap[tree.rootId];
      const [operator, operand] = childrenOf(tree, unary);
      assert.equal(unary.type, "unaryExpression");
      assert.equal(operator.type, "operator");
      assert.equal(operator.role, "unaryOperator");
      assert.equal(operator.latex, fixture.latex[0]);
      assert.deepEqual(operator.sourceRange, { start: 0, end: 1 });
      assert.equal(operand.type, fixture.operandType);
      assert.equal(operand.latex, fixture.operand);
      for (const node of tree.flatNodes) assert.equal(sourceText(tree, node), node.source || node.latex);
    }
  });

  it("represents a leading signed numeric factor as one coefficient inside a product", () => {
    for (const [index, latex] of [String.raw`-2\theta\ln(\cos\theta)`, String.raw`+3x^2`].entries()) {
      const tree = semanticTree(latex, `signed-coefficient-${index}`);
      const product = tree.nodeMap[tree.rootId];
      const coefficient = childrenOf(tree, product)[0];

      assert.equal(product.type, "product");
      assert.equal(coefficient.type, "number");
      assert.equal(coefficient.role, "coefficient");
      assert.equal(coefficient.latex, index === 0 ? "-2" : "+3");
      assert.equal(sourceText(tree, coefficient), coefficient.latex);
    }
  });

  it("keeps a signed coefficient reachable inside a fraction numerator", () => {
    const latex = String.raw`\frac{-2\theta\ln(\cos\theta)}{\sin\theta\cos\theta}`;
    const tree = semanticTree(latex, "signed-integrand-coefficient");
    const coefficient = nodeByLatex(tree, "-2", "coefficient");

    assert.ok(coefficient);
    assert.equal(coefficient.type, "number");
    assert.deepEqual(coefficient.sourceRange, { start: 6, end: 8 });
    assert.equal(sourceText(tree, coefficient), "-2");
  });

  it("preserves a unary first term and granular signed-fraction ownership in additive expressions", () => {
    const latex = String.raw`J=-\frac{B}{2}+\frac{\pi A}{4}`;
    const tree = semanticTree(latex, "unary-reported-equation");
    const unary = tree.flatNodes.find((node) => node.type === "unaryExpression");
    const unaryOperator = nodeByLatex(tree, "-", "unaryOperator");
    const firstFraction = tree.flatNodes.find((node) => node.type === "fraction" && node.sourceRange.start === 3);
    const b = nodeByLatex(tree, "B", "numerator");
    const firstTwo = tree.flatNodes.find((node) => node.latex === "2" && node.role === "denominator");
    const secondFraction = tree.flatNodes.find((node) => node.type === "fraction" && node.latex.includes("\\pi A"));

    assert.equal(tree.nodeMap[tree.rootId].type, "equation");
    assert.ok(tree.flatNodes.some((node) => node.type === "sum" && node.role === "rightSide"));
    assert.ok(unary);
    assert.ok(unaryOperator);
    assert.ok(firstFraction);
    assert.notEqual(firstFraction.type, "atom");
    assert.ok(secondFraction);
    assert.deepEqual(unaryOperator.sourceRange, { start: 2, end: 3 });
    assert.deepEqual(b.sourceRange, { start: 9, end: 10 });
    assert.equal(tree.displayLatex.slice(9, 10), "B");
    assert.deepEqual(firstTwo.sourceRange, { start: 12, end: 13 });
    assert.equal(new Set([unary.id, firstFraction.id, b.id, firstTwo.id]).size, 4);
    assert.equal(firstFraction.parentId, unary.id);
    assert.equal(b.parentId, firstFraction.id);
  });

  it("preserves already-working later signed terms while parsing nested unary operands", () => {
    const laterSigned = semanticTree(String.raw`\frac{\pi A}{4}-\frac{B}{2}`, "later-signed-fraction");
    const laterB = nodeByLatex(laterSigned, "B", "numerator");
    assert.ok(laterB);
    assert.ok(laterSigned.flatNodes.some((node) => node.type === "fraction" && node.latex === String.raw`\frac{B}{2}`));
    assert.equal(laterSigned.flatNodes.some((node) => node.type === "atom" && node.latex.includes("\\frac{B}{2}")), false);

    const nestedFixtures = [
      String.raw`a+-\Gamma(x)`,
      String.raw`f(-\sqrt{x})`,
      String.raw`\frac{-B}{+2}`,
    ];
    for (const [index, latex] of nestedFixtures.entries()) {
      const tree = semanticTree(latex, `nested-unary-${index}`);
      assert.ok(tree.flatNodes.some((node) => node.type === "unaryExpression"), `missing unary node for ${latex}`);
      assert.equal(tree.flatNodes.some((node) => node.type === "atom" && /^[+-]/u.test(node.latex)), false);
      for (const node of tree.flatNodes) assert.equal(sourceText(tree, node), node.source || node.latex);
    }
  });
});
