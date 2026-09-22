import test from "node:test";
import assert from "node:assert/strict";
import katex from "katex";
import { validateLatex } from "mathlive";
import {
  MATH_CATEGORIES,
  MATH_SUBCATEGORIES,
  MATH_SYMBOL_REGISTRY,
  searchMathSymbols,
  validateMathSymbolRegistry,
} from "../src/lib/mathSymbolRegistry.js";

const byId = new Map(MATH_SYMBOL_REGISTRY.map((item) => [item.id, item]));

test("math registry has stable editor metadata, unique ids, and meaningful breadth", () => {
  assert.ok(validateMathSymbolRegistry());
  assert.equal(MATH_SYMBOL_REGISTRY.length, 523);
  assert.equal(MATH_SYMBOL_REGISTRY.filter((item) => item.type === "symbol").length, 461);
  assert.equal(MATH_SYMBOL_REGISTRY.filter((item) => item.type === "structure").length, 62);
  assert.equal(MATH_CATEGORIES.length, 22);
  assert.equal(Object.values(MATH_SUBCATEGORIES).reduce((count, values) => count + values.length, 0), 100);
  assert.equal(new Set(MATH_SYMBOL_REGISTRY.map((item) => item.id)).size, MATH_SYMBOL_REGISTRY.length);
  assert.ok(MATH_SYMBOL_REGISTRY.every((item) => item.category && item.subcategory));
  assert.ok(MATH_SYMBOL_REGISTRY.every((item) => item.displayLatex && item.insertion && item.editorInsertion));
  assert.ok(MATH_SYMBOL_REGISTRY.every((item) => Array.isArray(item.aliases) && item.insertOptions?.insertionMode && item.insertOptions?.selectionMode));
});

test("independent graduate STEM inventory has representative notation in every audited discipline", () => {
  const inventory = {
    arithmetic: ["boxplus", "wreath"],
    relations: ["notLessEqual", "precedesEqual"],
    functions: ["sin", "arctan", "sinh", "naturalLog"],
    calculus: ["oiint", "oiiint", "dalembertian"],
    analysis: ["limitSuperior", "weakStarConvergence", "residue"],
    "linear algebra": ["kernel", "directSum", "frobeniusNorm", "spectralRadius"],
    "abstract algebra and sets": ["finiteField", "disjointUnion", "proves"],
    "discrete mathematics": ["fallingFactorial", "graphDegree", "congruentModulo"],
    "probability and statistics": ["conditionalExpectation", "normalDistribution", "convergenceAlmostSure"],
    "information theory": ["entropy", "mutualInformation", "klDivergence"],
    optimization: ["subgradient", "proximalOperator", "positiveSemidefinite"],
    "numerical analysis": ["machineEpsilon", "conditionNumber", "centralDifference"],
    "signal and control": ["fourierTransform", "zTransform", "stateSpace"],
    physics: ["outerProductQuantum", "vacuumPermittivity", "partitionFunction", "stressTensor"],
    "geometry and tensors": ["sphericalAngle", "christoffel", "wedgeProduct"],
    structures: ["mixedPartialDerivative", "surfaceIntegralStructure", "matrix3x3", "constrainedOptimization", "covariantDerivativeStructure"],
  };
  for (const [discipline, ids] of Object.entries(inventory)) {
    for (const id of ids) assert.ok(byId.has(id), `${discipline} is missing ${id}`);
  }
});

test("human search terms find visually renderable symbols and advanced structures", () => {
  const expected = {
    "surface integral": "oiint",
    theta: "theta",
    "partial derivative": "partialDerivative",
    gradient: "gradient",
    nabla: "nabla",
    "approximately equal": "approx",
    expectation: "expectation",
    variance: "variance",
    Hessian: "hessian",
    Kronecker: "kronecker",
    "Levi Civita": "leviCivita",
    tensor: "tensor",
    bra: "bra",
    ket: "ket",
    subset: "subset",
    perpendicular: "perp",
    conjugate: "complexConjugate",
    curl: "curl",
    divergence: "divergence",
  };
  for (const [query, id] of Object.entries(expected)) {
    assert.ok(searchMathSymbols(query).some((item) => item.id === id), `${query} did not find ${id}`);
  }
  assert.ok(searchMathSymbols("theta").some((item) => item.id === "vartheta"));
  assert.ok(searchMathSymbols("surface integral").some((item) => item.displayLatex === "\\oiint"));
});

test("MathLive 0.110 templates use explicit selection and navigable placeholders", () => {
  const structures = MATH_SYMBOL_REGISTRY.filter((item) => item.type === "structure");
  for (const item of structures) {
    assert.doesNotMatch(item.editorInsertion, /□/u, `${item.id} leaks a legacy square into MathLive`);
    assert.match(item.editorInsertion, /#@/u, `${item.id} has no selection-aware principal slot`);
    assert.equal(item.insertOptions.selectionMode, "placeholder");
  }
  for (const id of ["fraction", "matrixStructure", "matrix3x3", "cases", "system", "mixedPartialDerivative", "surfaceIntegralStructure", "constrainedOptimization", "braketStructure", "tensor"]) {
    assert.match(byId.get(id).editorInsertion, /#\?/u, `${id} has no secondary navigable placeholder`);
  }
  assert.equal(byId.get("fraction").editorInsertion, "\\frac{#@}{#?}");
});

test("every display and insertion template parses with the selected renderers", () => {
  for (const item of MATH_SYMBOL_REGISTRY) {
    assert.doesNotThrow(() => katex.renderToString(item.displayLatex, { throwOnError: true, strict: "error" }), `KaTeX display failed: ${item.id}`);
    const materialized = item.editorInsertion.replaceAll("#@", "{x}").replaceAll("#?", "{x}");
    assert.deepEqual(validateLatex(materialized), [], `MathLive insertion failed: ${item.id} (${materialized})`);
  }
});

test("legacy insertion remains available while editor insertion is separate", () => {
  const fraction = byId.get("fraction");
  assert.match(fraction.insertion, /□/u);
  assert.doesNotMatch(fraction.editorInsertion, /□/u);
});
