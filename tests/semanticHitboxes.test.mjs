import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseSemanticHit,
  filterLeafRects,
  getTargetsIntersectingRect,
  reconstructTextFromTargets,
  isHoverEligibleTarget,
  isAggregateHoverTarget,
  isBoundaryCompatibleTextMatch,
  medianRectHeight,
  refineDifferentialHighlightGeometry,
  resolveSemanticTarget,
  sortTargetsByRenderedOrder,
  unionSemanticRects,
} from "../src/lib/semanticHitboxes.js";

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("semanticHitboxes", () => {
  it("prefers the deepest semantic node containing the point", () => {
    const parent = { id: "parent", depth: 1, rects: [rect(0, 0, 100, 40)] };
    const child = { id: "child", depth: 3, rects: [rect(10, 5, 80, 25)] };

    assert.equal(chooseSemanticHit([parent, child], 20, 10, parent).id, "child");
  });

  it("keeps a child number above an overlapping radical parent", () => {
    const radical = {
      id: "radical-expression",
      role: "root",
      type: "root",
      latex: "\\sqrt{5^2-4ac}",
      childIds: ["base-five"],
      depth: 3,
      rects: [rect(20, 0, 120, 40)],
    };
    const five = {
      id: "base-five",
      role: "base",
      type: "number",
      latex: "5",
      parentId: "power-five",
      depth: 7,
      rectSource: "dom-leaf",
      rects: [rect(42, 16, 10, 16)],
    };

    assert.equal(chooseSemanticHit([radical, five], 47, 22).id, "base-five");
  });

  it("does not match positive numeric tokens inside negative numbers", () => {
    const text = "x=-5+√5^2";

    assert.equal(isBoundaryCompatibleTextMatch(text, text.indexOf("5"), "5"), false);
    assert.equal(isBoundaryCompatibleTextMatch(text, text.lastIndexOf("5"), "5"), true);
    assert.equal(isBoundaryCompatibleTextMatch(text, text.indexOf("-5"), "-5"), true);
  });

  it("ignores large parent nodes during hover when eligible leaf candidates exist", () => {
    const parent = { id: "integrand", role: "integrand", type: "fraction", depth: 2, rects: [rect(0, 0, 220, 80)] };
    const child = { id: "x", role: "variable", type: "symbol", depth: 5, rects: [rect(20, 20, 14, 18)] };

    assert.equal(chooseSemanticHit([parent, child], 24, 25).id, "x");
  });

  it("does not hover-select a fraction parent over a child token", () => {
    const fraction = { id: "fraction", role: "fraction", type: "fraction", depth: 1, rects: [rect(0, 0, 120, 70)] };
    const numerator = { id: "three", role: "coefficient", type: "number", parentId: "fraction", depth: 3, rects: [rect(42, 8, 12, 16)] };

    assert.equal(chooseSemanticHit([fraction, numerator], 46, 12).id, "three");
  });

  it("resolves nested quadratic fraction hover to inner leaves before fraction chunks", () => {
    const fraction = { id: "formula", role: "fraction", type: "fraction", depth: 1, childIds: ["numerator", "denominator"], rects: [rect(0, 0, 180, 90)] };
    const numerator = { id: "numerator", role: "numerator", type: "sum", parentId: "formula", depth: 2, childIds: ["neg-five", "pm", "sqrt"], rects: [rect(12, 8, 156, 36)] };
    const negFive = { id: "neg-five", role: "constant", type: "number", parentId: "numerator", depth: 5, latex: "-5", rects: [rect(18, 17, 18, 16)] };
    const plusMinus = { id: "pm", role: "operator", type: "operator", parentId: "numerator", depth: 5, latex: "\\pm", rects: [rect(44, 17, 14, 16)] };
    const sqrtBody = { id: "sqrt-body", role: "radicand", type: "sum", parentId: "sqrt", depth: 5, latex: "25-72", rects: [rect(82, 15, 42, 18)] };
    const sqrt = { id: "sqrt", role: "root", type: "root", parentId: "numerator", depth: 4, childIds: ["sqrt-body"], rects: [rect(65, 8, 72, 31)] };
    const denominator = { id: "denominator", role: "denominator", type: "product", parentId: "formula", depth: 2, childIds: ["two", "times", "three"], rects: [rect(55, 58, 70, 20)] };
    const six = { id: "six", role: "constant", type: "number", parentId: "denominator", depth: 6, latex: "6", rects: [rect(84, 60, 10, 16)] };
    const targets = [fraction, numerator, negFive, plusMinus, sqrt, sqrtBody, denominator, six];

    assert.equal(chooseSemanticHit(targets, 24, 22).id, "neg-five");
    assert.equal(chooseSemanticHit(targets, 50, 22).id, "pm");
    assert.equal(chooseSemanticHit(targets, 98, 22).id, "sqrt-body");
    assert.equal(chooseSemanticHit(targets, 88, 66).id, "six");
  });

  it("hovering quadratic formula pieces selects sub-tokens instead of the whole step", () => {
    const step = { id: "step-card", role: "step", type: "step", depth: 0, childIds: ["formula"], rects: [rect(0, 0, 260, 120)] };
    const formula = { id: "formula", role: "fraction", type: "fraction", depth: 1, childIds: ["numerator", "denominator"], rects: [rect(20, 10, 200, 86)] };
    const numerator = { id: "numerator", role: "numerator", type: "sum", parentId: "formula", depth: 2, childIds: ["neg-five", "pm", "sqrt-493"], rects: [rect(36, 18, 168, 34)] };
    const negFive = { id: "neg-five", role: "constant", type: "number", parentId: "numerator", depth: 6, latex: "-5", rectSource: "dom-leaf", rects: [rect(42, 26, 18, 16)] };
    const plusMinus = { id: "plus-minus", role: "operator", type: "operator", parentId: "numerator", depth: 6, latex: "\\pm", rectSource: "dom-leaf", rects: [rect(68, 26, 14, 16)] };
    const sqrt493 = { id: "sqrt-493", role: "root", type: "root", parentId: "numerator", depth: 5, childIds: ["n493"], latex: "\\sqrt{493}", rects: [rect(92, 17, 70, 32)] };
    const n493 = { id: "n493", role: "radicand", type: "number", parentId: "sqrt-493", depth: 7, latex: "493", rectSource: "dom-leaf", rects: [rect(116, 25, 30, 16)] };
    const denominator = { id: "denominator", role: "denominator", type: "product", parentId: "formula", depth: 2, childIds: ["six"], rects: [rect(96, 66, 48, 20)] };
    const six = { id: "six", role: "constant", type: "number", parentId: "denominator", depth: 7, latex: "6", rectSource: "dom-leaf", rects: [rect(116, 68, 10, 16)] };
    const targets = [step, formula, numerator, negFive, plusMinus, sqrt493, n493, denominator, six];

    assert.equal(chooseSemanticHit(targets, 48, 32, step, { includeStructural: true }).id, "neg-five");
    assert.equal(chooseSemanticHit(targets, 74, 32, step, { includeStructural: true }).id, "plus-minus");
    assert.equal(chooseSemanticHit(targets, 128, 32, step, { includeStructural: true }).id, "n493");
    assert.equal(chooseSemanticHit(targets, 120, 74, step, { includeStructural: true }).id, "six");
  });

  it("hovering whitespace inside a step does not invent a math token", () => {
    const token = { id: "x", role: "variable", type: "symbol", depth: 4, rects: [rect(20, 20, 12, 16)] };

    assert.equal(chooseSemanticHit([token], 90, 24), null);
  });

  it("does not rank an empty semantic wrapper as an exact hover hit", () => {
    const emptyWrapper = {
      id: "empty-katex-wrapper",
      role: "operator",
      type: "operator",
      latex: "+",
      depth: 8,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "structural_only",
      paintedArea: 0,
      rects: [rect(40, 10, 24, 18)],
      paintedRects: [],
    };

    const resolution = resolveSemanticTarget({
      pointer: { x: 44, y: 14 },
      candidates: [emptyWrapper],
    });

    assert.equal(resolution.target, null);
    assert.equal(resolution.reason, "no-hit");
  });

  it("keeps a visible child reachable when its aggregate parent covers the same point", () => {
    const parent = {
      id: "sum-parent",
      role: "sum",
      type: "sum",
      childIds: ["visible-x"],
      depth: 2,
      deterministic: true,
      rectSource: "semantic-dom:painted-child-clusters",
      geometryQuality: "precise_group",
      rects: [rect(10, 10, 130, 30)],
      paintedRects: [rect(22, 16, 12, 16), rect(80, 16, 12, 16)],
    };
    const child = {
      id: "visible-x",
      role: "variable",
      type: "symbol",
      parentId: "sum-parent",
      depth: 8,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "precise_leaf",
      rects: [rect(22, 16, 12, 16)],
      paintedRects: [rect(22, 16, 12, 16)],
    };

    assert.equal(chooseSemanticHit([parent, child], 26, 20).id, "visible-x");
  });

  it("lets a valid painted group win only when no painted child is under the pointer", () => {
    const group = {
      id: "function-argument",
      role: "argument",
      type: "product",
      childIds: ["left-x", "right-y"],
      depth: 3,
      deterministic: true,
      rectSource: "semantic-dom:painted-child-clusters",
      geometryQuality: "precise_group",
      rects: [rect(10, 10, 90, 20)],
      paintedRects: [rect(10, 10, 12, 16), rect(88, 10, 12, 16)],
    };
    const left = {
      id: "left-x",
      role: "variable",
      type: "symbol",
      parentId: "function-argument",
      depth: 7,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "precise_leaf",
      rects: [rect(10, 10, 12, 16)],
      paintedRects: [rect(10, 10, 12, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 16, y: 16 },
      candidates: [group, left],
      options: { includeStructural: true },
    }).target.id, "left-x");
    assert.equal(resolveSemanticTarget({
      pointer: { x: 94, y: 16 },
      candidates: [group, left],
      options: { includeStructural: true },
    }).target.id, "function-argument");
  });

  it("does not let a broad structural candidate win over a painted leaf", () => {
    const broad = {
      id: "broad-sum",
      role: "sum",
      type: "sum",
      childIds: ["painted-x"],
      depth: 2,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "broad_aggregate",
      rects: [rect(0, 0, 180, 44)],
      paintedRects: [rect(40, 12, 12, 16)],
    };
    const leaf = {
      id: "painted-x",
      role: "variable",
      type: "symbol",
      parentId: "broad-sum",
      depth: 8,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "precise_leaf",
      rects: [rect(40, 12, 12, 16)],
      paintedRects: [rect(40, 12, 12, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 46, y: 18 },
      candidates: [broad, leaf],
      options: { includeStructural: true },
    }).target.id, "painted-x");
  });

  it("rejects collapsed duplicate semantic rectangles that have no painted glyph geometry", () => {
    const collapsed = {
      id: "collapsed-duplicate",
      role: "constant",
      type: "number",
      latex: "5",
      depth: 7,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "collapsed",
      rects: [rect(10, 10, 40, 20), rect(10, 10, 40, 20)],
      paintedRects: [],
    };

    const resolution = resolveSemanticTarget({
      pointer: { x: 20, y: 15 },
      candidates: [collapsed],
    });

    assert.equal(resolution.target, null);
    assert.equal(resolution.reason, "no-hit");
  });

  it("does not let a malformed broad exact rectangle hide a missing visible leaf", () => {
    const malformedParent = {
      id: "argument-parent",
      role: "argument",
      type: "product",
      childIds: ["missing-visible-y"],
      depth: 3,
      deterministic: true,
      rectSource: "semantic-dom-targeted-fallback",
      geometryQuality: "broad_aggregate",
      rects: [rect(0, 0, 180, 40)],
      paintedRects: [rect(6, 12, 12, 16)],
    };
    const missingVisibleLeaf = {
      id: "missing-visible-y",
      role: "variable",
      type: "symbol",
      parentId: "argument-parent",
      depth: 9,
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "zero_size",
      rects: [],
      paintedRects: [],
    };

    const resolution = resolveSemanticTarget({
      pointer: { x: 120, y: 18 },
      candidates: [malformedParent, missingVisibleLeaf],
    });

    assert.equal(resolution.target, null);
    assert.equal(resolution.reason, "no-hit");
  });

  it("does not hover-select denominator parent when denominator leaves exist", () => {
    const denominator = { id: "denominator", role: "denominator", type: "sum", depth: 2, rects: [rect(0, 40, 160, 24)] };
    const x = { id: "x", role: "base", type: "symbol", parentId: "denominator", depth: 5, rects: [rect(44, 43, 12, 15)] };

    assert.equal(chooseSemanticHit([denominator, x], 48, 47).id, "x");
  });

  it("does not hover-select integrand parent when a leaf candidate exists", () => {
    const integrand = { id: "integrand", role: "integrand", type: "product", depth: 2, rects: [rect(0, 0, 180, 36)] };
    const coefficient = { id: "four", role: "coefficient", type: "number", parentId: "integrand", depth: 4, rects: [rect(4, 8, 11, 16)] };

    assert.equal(chooseSemanticHit([integrand, coefficient], 8, 12).id, "four");
  });

  it("selects coefficient 4 in 4r^2 as the coefficient, not the power base", () => {
    const product = { id: "product", role: "product", type: "product", depth: 1, rects: [rect(0, 0, 70, 30)] };
    const four = { id: "four", role: "coefficient", type: "number", parentId: "product", depth: 2, rects: [rect(0, 8, 11, 16)] };
    const base = { id: "r", role: "base", type: "symbol", parentId: "power", depth: 3, rects: [rect(18, 8, 11, 16)] };

    assert.equal(chooseSemanticHit([product, four, base], 5, 12).id, "four");
  });

  it("targets sin, exponent 2, and theta separately in sin^2 theta geometry", () => {
    const fn = { id: "sin", role: "functionName", type: "function", depth: 2, rects: [rect(0, 10, 24, 14)] };
    const exponent = { id: "two", role: "exponent", type: "number", depth: 2, rects: [rect(25, 2, 8, 10)] };
    const theta = { id: "theta", role: "variable", type: "symbol", depth: 2, rects: [rect(36, 10, 14, 16)] };

    assert.equal(chooseSemanticHit([fn, exponent, theta], 6, 14).id, "sin");
    assert.equal(chooseSemanticHit([fn, exponent, theta], 28, 6).id, "two");
    assert.equal(chooseSemanticHit([fn, exponent, theta], 40, 15).id, "theta");
  });

  it("keeps aggregate math constructs hover-eligible while excluding generic containers", () => {
    assert.equal(isHoverEligibleTarget({ role: "fraction", type: "fraction", childIds: ["num", "den"] }), true);
    assert.equal(isHoverEligibleTarget({ role: "integrand", type: "product", childIds: ["x"] }), true);
    assert.equal(isHoverEligibleTarget({ role: "step", type: "step", childIds: ["expr"] }), false);
    assert.equal(isHoverEligibleTarget({ role: "functionName", type: "function" }), true);
    assert.equal(isHoverEligibleTarget({ role: "radicand", type: "sum", childIds: ["x3", "minus"] }), true);
  });

  it("keeps long numeric factor leaves hover-eligible", () => {
    assert.equal(isHoverEligibleTarget({ role: "factor", type: "number", latex: "-4455969793" }), true);
  });

  it("uses smallest visual area as a tie-break at the same depth", () => {
    const wide = { id: "wide", depth: 2, rects: [rect(0, 0, 100, 40)] };
    const tight = { id: "tight", depth: 2, rects: [rect(10, 5, 20, 10)] };

    assert.equal(chooseSemanticHit([wide, tight], 15, 8).id, "tight");
  });

  it("falls back to the parent when no semantic child contains the point", () => {
    const parent = { id: "parent", depth: 0, rects: [rect(0, 0, 100, 40)] };
    const child = { id: "child", depth: 1, rects: [rect(10, 5, 20, 10)] };

    assert.equal(chooseSemanticHit([child], 80, 30, parent).id, "parent");
  });

  it("supports multiple rects per semantic node", () => {
    const split = {
      id: "split",
      depth: 2,
      rects: [rect(0, 0, 10, 10), rect(50, 0, 10, 10)],
    };

    assert.equal(chooseSemanticHit([split], 55, 5).id, "split");
  });

  it("keeps ambiguous tiny operators leaf-sized instead of climbing to structural parents", () => {
    const parent = { id: "sum", role: "term", depth: 2, rects: [rect(0, 0, 80, 30)] };
    const operator = { id: "plus", role: "operator", parentId: "sum", depth: 4, rects: [rect(38, 12, 2, 6)] };

    assert.equal(chooseSemanticHit([parent, operator], 39, 14).id, "plus");
  });

  it("hovers requested sub-tokens instead of whole expressions", () => {
    const expression = { id: "expr", role: "expression", type: "sum", depth: 1, childIds: ["n18", "frac", "cos", "xy", "dtheta", "pow"], rects: [rect(0, 0, 240, 50)] };
    const n18 = { id: "n18", role: "constant", type: "number", parentId: "expr", depth: 4, rects: [rect(4, 16, 18, 16)] };
    const frac = { id: "frac", role: "fraction", type: "fraction", parentId: "expr", depth: 3, childIds: ["three-pi", "four"], rects: [rect(32, 4, 44, 38)] };
    const threePi = { id: "three-pi", role: "numerator", type: "product", parentId: "frac", depth: 4, rects: [rect(36, 5, 28, 14)] };
    const cos = { id: "cos", role: "functionName", type: "function", parentId: "expr", depth: 4, rects: [rect(86, 16, 22, 15)] };
    const xy = { id: "xy", role: "argument", type: "product", parentId: "expr", depth: 4, rects: [rect(112, 16, 20, 15)] };
    const dtheta = { id: "dtheta", role: "differential", type: "differential", parentId: "expr", depth: 4, rects: [rect(146, 16, 24, 16)] };
    const exponent = { id: "exp2", role: "exponent", type: "number", parentId: "pow", depth: 5, rects: [rect(190, 4, 8, 10)] };
    const power = { id: "pow", role: "power", type: "power", parentId: "expr", depth: 3, childIds: ["base", "exp2"], rects: [rect(176, 8, 30, 30)] };

    const targets = [expression, frac, threePi, cos, xy, dtheta, power, n18, exponent];
    assert.equal(chooseSemanticHit(targets, 10, 20).id, "n18");
    assert.equal(chooseSemanticHit(targets, 42, 10).id, "three-pi");
    assert.equal(chooseSemanticHit(targets, 92, 20).id, "cos");
    assert.equal(chooseSemanticHit(targets, 120, 20).id, "xy");
    assert.equal(chooseSemanticHit(targets, 154, 20).id, "dtheta");
    assert.equal(chooseSemanticHit(targets, 193, 7).id, "exp2");
  });

  it("uses parent semantic groups only when no leaf geometry contains the point", () => {
    const group = { id: "fraction", role: "fraction", type: "fraction", depth: 2, childIds: ["num", "den"], rects: [rect(0, 0, 80, 40)] };
    const leaf = { id: "num", role: "constant", type: "number", parentId: "fraction", depth: 4, rects: [rect(10, 6, 12, 12)] };

    assert.equal(chooseSemanticHit([group, leaf], 14, 10).id, "num");
    assert.equal(chooseSemanticHit([group, leaf], 60, 28, null, { includeStructural: true }).id, "fraction");
  });

  it("preserves complete integral aggregate selection without collapsing to the upper bound", () => {
    const integral = {
      id: "integral",
      role: "integral",
      type: "integral",
      childIds: ["upper", "integrand", "dx"],
      latex: "\\int_0^{\\pi/2}\\sin x\\,dx",
      depth: 1,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(0, 0, 220, 82)],
    };
    const upper = {
      id: "upper",
      role: "upperBound",
      type: "symbol",
      parentId: "integral",
      latex: "\\pi/2",
      depth: 4,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(22, 0, 34, 18)],
    };
    const integrand = {
      id: "integrand",
      role: "integrand",
      type: "functionCall",
      parentId: "integral",
      childIds: ["sin"],
      latex: "\\sin x",
      depth: 3,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(70, 35, 64, 22)],
    };
    const sin = {
      id: "sin",
      role: "functionName",
      type: "function",
      parentId: "integrand",
      latex: "\\sin",
      depth: 5,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(72, 38, 24, 16)],
    };
    const targets = [integral, upper, integrand, sin];

    assert.equal(isAggregateHoverTarget(integral), true);
    assert.equal(chooseSemanticHit(targets, 180, 54, upper).id, "integral");
    assert.equal(chooseSemanticHit(targets, 34, 8, integral).id, "upper");
    assert.equal(chooseSemanticHit(targets, 78, 44, integral).id, "sin");
  });

  it("keeps a bound expression selectable over internal fraction leaves", () => {
    const upper = {
      id: "upper-bound",
      role: "upperBound",
      type: "fraction",
      latex: "\\pi/2",
      depth: 4,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(20, 0, 42, 22)],
    };
    const numerator = {
      id: "upper-numerator",
      role: "numerator",
      type: "symbol",
      parentId: "upper-bound",
      latex: "\\pi",
      depth: 7,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(30, 1, 16, 10)],
    };
    const denominator = {
      id: "upper-denominator",
      role: "denominator",
      type: "number",
      parentId: "upper-bound",
      latex: "2",
      depth: 7,
      rectSource: "annotated-semantic-dom",
      deterministic: true,
      rects: [rect(35, 12, 8, 9)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 38, y: 7 },
      candidates: [upper, numerator, denominator],
    }).target.id, "upper-bound");
  });

  it("builds aggregate rectangles from descendant rectangles", () => {
    const aggregate = unionSemanticRects([
      rect(20, 10, 30, 16),
      rect(80, 24, 40, 18),
    ]);

    assert.deepEqual(aggregate, {
      left: 20,
      right: 120,
      top: 10,
      bottom: 42,
      width: 100,
      height: 32,
    });
  });

  it("returns null instead of silently expanding to a large expression fallback without highlight geometry", () => {
    const expression = { id: "expression", role: "expression", type: "equation", depth: 0, rects: [] };

    assert.equal(chooseSemanticHit([], 40, 20, expression), null);
  });

  it("does not use child-union as a casual hover target when no concrete leaf exists", () => {
    const radicandUnion = {
      id: "radicand",
      role: "radicand",
      type: "sum",
      childIds: ["x3", "minus-339"],
      depth: 3,
      rectSource: "child-union",
      rects: [rect(20, 8, 180, 34)],
    };
    const expression = {
      id: "full-expression",
      role: "expression",
      type: "equation",
      childIds: ["radicand"],
      depth: 1,
      rectSource: "child-union",
      rects: [rect(0, 0, 280, 70)],
    };

    assert.equal(chooseSemanticHit([expression, radicandUnion], 100, 24), null);
  });

  it("child-union cannot win over a concrete DOM leaf", () => {
    const radicandUnion = {
      id: "radicand",
      role: "radicand",
      type: "sum",
      childIds: ["x3"],
      depth: 5,
      rectSource: "child-union",
      rects: [rect(20, 8, 180, 34)],
    };
    const x3 = {
      id: "x3",
      role: "component",
      type: "atom",
      latex: "x3",
      depth: 4,
      rectSource: "dom-leaf",
      rects: [rect(46, 16, 18, 16)],
    };

    assert.equal(chooseSemanticHit([radicandUnion, x3], 52, 22).id, "x3");
  });

  it("resolves radical pieces instead of radicand child-union or full formula", () => {
    const fullFormula = {
      id: "formula",
      role: "expression",
      type: "equation",
      childIds: ["radicand"],
      depth: 0,
      rectSource: "child-union",
      rects: [rect(0, 0, 360, 80)],
    };
    const radicandUnion = {
      id: "radicand",
      role: "radicand",
      type: "sum",
      childIds: ["x3", "minus-339"],
      depth: 2,
      rectSource: "child-union",
      rects: [rect(80, 10, 170, 34)],
    };
    const x3 = {
      id: "x3",
      role: "component",
      type: "atom",
      latex: "x3",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(96, 18, 20, 16)],
    };
    const minus339 = {
      id: "minus-339",
      role: "constant",
      type: "number",
      latex: "-339",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(142, 18, 34, 16)],
    };

    assert.equal(chooseSemanticHit([fullFormula, radicandUnion, x3, minus339], 104, 24).id, "x3");
    assert.equal(chooseSemanticHit([fullFormula, radicandUnion, x3, minus339], 158, 24).id, "minus-339");
  });

  it("prefers imaginary radical leaves over the implicit product parent", () => {
    const product = {
      id: "i-root-product",
      role: "term",
      type: "product",
      childIds: ["imaginary-i", "sqrt-278471"],
      depth: 2,
      rectSource: "child-union",
      latex: "i\\sqrt{278471}",
      rects: [rect(10, 6, 112, 30)],
    };
    const radicalExpression = {
      id: "sqrt-278471",
      role: "root",
      type: "root",
      childIds: ["sqrt-sign", "radicand-278471"],
      depth: 4,
      rectSource: "child-union",
      latex: "\\sqrt{278471}",
      rects: [rect(30, 6, 92, 30)],
    };
    const imaginary = {
      id: "imaginary-i",
      role: "imaginaryUnit",
      type: "symbol",
      latex: "i",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(12, 14, 10, 16)],
    };
    const radicalSign = {
      id: "sqrt-sign",
      role: "radical",
      type: "operator",
      latex: "\\sqrt",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(32, 8, 18, 28)],
    };
    const radicand = {
      id: "radicand-278471",
      role: "radicand",
      type: "number",
      latex: "278471",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(58, 14, 58, 16)],
    };
    const targets = [product, radicalExpression, imaginary, radicalSign, radicand];

    assert.equal(chooseSemanticHit(targets, 17, 20).id, "imaginary-i");
    assert.equal(chooseSemanticHit(targets, 40, 20).id, "sqrt-sign");
    assert.equal(chooseSemanticHit(targets, 80, 20).id, "radicand-278471");
    assert.equal(chooseSemanticHit(targets, 88, 9).id, "sqrt-278471");
  });

  it("keeps the radical operator from inheriting radicand geometry", () => {
    const radicalExpression = {
      id: "sqrt-expression",
      role: "root",
      type: "root",
      childIds: ["sqrt-operator", "radicand"],
      depth: 3,
      rectSource: "aggregate-descendant-clusters",
      latex: "\\sqrt{278471}",
      rects: [rect(30, 6, 88, 30)],
      paintedRects: [rect(30, 6, 20, 28), rect(58, 14, 58, 16)],
      geometryQuality: "precise_group",
    };
    const radicalOperator = {
      id: "sqrt-operator",
      role: "radical",
      type: "operator",
      latex: "\\sqrt",
      depth: 4,
      rectSource: "semantic-dom-targeted-fallback",
      rects: [rect(30, 6, 20, 28)],
      paintedRects: [rect(30, 6, 20, 28)],
      geometryQuality: "precise_leaf",
    };
    const radicand = {
      id: "radicand",
      role: "radicand",
      type: "number",
      latex: "278471",
      depth: 4,
      rectSource: "semantic-dom",
      rects: [rect(58, 14, 58, 16)],
      paintedRects: [rect(58, 14, 58, 16)],
      geometryQuality: "precise_leaf",
    };
    const targets = [radicalExpression, radicalOperator, radicand];

    assert.equal(chooseSemanticHit(targets, 40, 20).id, "sqrt-operator");
    assert.equal(chooseSemanticHit(targets, 112, 22).id, "radicand");
    assert.equal(chooseSemanticHit(targets, 88, 9).id, "sqrt-expression");
  });

  it("does not resolve one approximation fraction hover to the full approximation line", () => {
    const approximationLine = {
      id: "approx-line",
      role: "expression",
      type: "equation",
      childIds: ["solution-a", "solution-b"],
      depth: 1,
      rectSource: "child-union",
      rects: [rect(0, 0, 420, 42)],
      latex: "x\\approx 9.83, -11.5",
    };
    const solutionFraction = {
      id: "solution-a",
      role: "component",
      type: "atom",
      depth: 5,
      rectSource: "dom-leaf",
      latex: "\\frac{-5+\\sqrt{...}}{6}",
      rects: [rect(52, 8, 82, 24)],
    };

    assert.equal(chooseSemanticHit([approximationLine, solutionFraction], 80, 18).id, "solution-a");
  });

  it("right-click can reuse the exact same resolver output as hover", () => {
    const radicandUnion = {
      id: "radicand",
      role: "radicand",
      type: "sum",
      childIds: ["x3"],
      depth: 2,
      rectSource: "child-union",
      rects: [rect(10, 10, 120, 30)],
    };
    const x3 = {
      id: "x3",
      role: "component",
      type: "atom",
      latex: "x3",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(28, 16, 18, 14)],
    };

    const hoverTarget = chooseSemanticHit([radicandUnion, x3], 34, 20);
    const rightClickTarget = chooseSemanticHit([radicandUnion, x3], 34, 20);
    assert.equal(rightClickTarget.id, hoverTarget.id);
    assert.equal(rightClickTarget.id, "x3");
  });

  it("handles unsupported or unsafe measurement with parent fallback", () => {
    const parent = { id: "flat-parent", depth: 0, rects: [rect(0, 0, 100, 40)] };

    assert.equal(chooseSemanticHit([], 12, 12, parent).id, "flat-parent");
  });

  it("keeps the 445 leaf separate from the preceding minus operator", () => {
    const minus = {
      id: "minus",
      role: "operator",
      type: "operator",
      depth: 4,
      rectSource: "dom-leaf",
      rects: [rect(80, 10, 7, 14)],
    };
    const n445 = {
      id: "445",
      role: "constant",
      type: "number",
      depth: 4,
      rectSource: "dom-leaf",
      rects: [rect(92, 10, 30, 16)],
    };
    const term = {
      id: "negative-term",
      role: "term",
      type: "product",
      depth: 2,
      childIds: ["minus", "445"],
      rectSource: "child-union",
      rects: [rect(80, 10, 42, 16)],
    };

    assert.equal(chooseSemanticHit([term, minus, n445], 83, 17).id, "minus");
    assert.equal(chooseSemanticHit([term, minus, n445], 107, 17).id, "445");
  });

  it("prefers a negative-number leaf over an overlapping stray minus hitbox", () => {
    const negativeFive = {
      id: "negative-five",
      role: "constant",
      type: "number",
      latex: "-5",
      depth: 3,
      rectSource: "dom-leaf",
      rects: [rect(10, 10, 20, 16)],
    };
    const strayMinus = {
      id: "stray-minus",
      role: "operator",
      type: "operator",
      latex: "-",
      depth: 6,
      rectSource: "dom-leaf",
      rects: [rect(10, 10, 8, 16)],
    };

    assert.equal(chooseSemanticHit([negativeFive, strayMinus], 14, 16).id, "negative-five");
  });

  it("does not keep a previous negative token when the pointer moves into a powered 5 leaf", () => {
    const negativeFive = {
      id: "negative-five",
      role: "constant",
      type: "number",
      latex: "-5",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(10, 10, 20, 16)],
    };
    const baseFive = {
      id: "base-five",
      role: "base",
      type: "number",
      latex: "5",
      depth: 7,
      rectSource: "dom-leaf",
      rects: [rect(52, 10, 10, 16)],
    };
    const exponentTwo = {
      id: "exponent-two",
      role: "exponent",
      type: "number",
      latex: "2",
      depth: 7,
      rectSource: "dom-leaf",
      rects: [rect(63, 2, 8, 10)],
    };

    assert.equal(chooseSemanticHit([negativeFive, baseFive, exponentTwo], 15, 16).id, "negative-five");
    assert.equal(chooseSemanticHit([negativeFive, baseFive, exponentTwo], 56, 16, negativeFive).id, "base-five");
    assert.equal(chooseSemanticHit([negativeFive, baseFive, exponentTwo], 66, 6, negativeFive).id, "exponent-two");
  });

  it("does not keep a previous x token when the pointer moves into coefficient 3", () => {
    const coefficient = {
      id: "coefficient-three",
      role: "coefficient",
      type: "number",
      latex: "3",
      depth: 6,
      rectSource: "dom-leaf",
      rects: [rect(10, 10, 10, 16)],
    };
    const variable = {
      id: "variable-x",
      role: "variable",
      type: "symbol",
      latex: "x",
      depth: 6,
      rectSource: "dom-leaf",
      rects: [rect(23, 10, 10, 16)],
    };

    assert.equal(chooseSemanticHit([coefficient, variable], 27, 16).id, "variable-x");
    assert.equal(chooseSemanticHit([coefficient, variable], 14, 16, variable).id, "coefficient-three");
  });

  it("only retains a fallback target while the pointer remains inside its own rect", () => {
    const previous = {
      id: "previous",
      role: "constant",
      type: "number",
      latex: "5",
      depth: 4,
      rects: [rect(10, 10, 10, 16)],
    };

    assert.equal(chooseSemanticHit([], 14, 16, previous).id, "previous");
    assert.equal(chooseSemanticHit([], 40, 16, previous), null);
  });

  it("filters denominator leaf rects that look like full fraction or line wrappers", () => {
    const leaf = { id: "den-two", role: "constant", type: "number", latex: "2" };
    const filtered = filterLeafRects([
      rect(10, 0, 120, 72),
      rect(64, 50, 10, 14),
    ], leaf, {
      medianLeafHeight: 16,
      containerRect: rect(0, 0, 140, 78),
    });

    assert.deepEqual(filtered, [rect(64, 50, 10, 14)]);
  });

  it("filters row-wide rectangles for long numeric leaves", () => {
    const leaf = { id: "large-negative", role: "factor", type: "number", latex: "-4455969793" };
    const filtered = filterLeafRects([
      rect(0, 0, 560, 28),
      rect(220, 0, 122, 24),
    ], leaf, {
      medianLeafHeight: 18,
      containerRect: rect(0, 0, 580, 42),
    });

    assert.deepEqual(filtered, [rect(220, 0, 122, 24)]);
  });

  it("rejects absurdly tall simple leaf hitboxes but allows tall math constructs", () => {
    const simple = { id: "x", role: "variable", type: "symbol", latex: "x" };
    const sqrt = { id: "sqrt", role: "root", type: "root", latex: "\\sqrt{x}" };

    assert.equal(filterLeafRects([rect(0, 0, 12, 80)], simple, { medianLeafHeight: 16 }).length, 0);
    assert.equal(filterLeafRects([rect(0, 0, 24, 80)], sqrt, { medianLeafHeight: 16 }).length, 1);
  });

  it("computes group geometry as a union of child leaf rects", () => {
    const left = rect(20, 10, 12, 16);
    const right = rect(44, 12, 18, 14);
    const union = unionSemanticRects([left, right]);

    assert.deepEqual(union, rect(20, 10, 42, 16));
  });

  it("selects only leaf hitboxes intersecting the drag rectangle on the first rendered equation line", () => {
    const leaves = [
      { id: "a", role: "coefficient", type: "number", latex: "3", display: "3", depth: 4, rects: [rect(10, 10, 10, 14)] },
      { id: "x2", role: "base", type: "symbol", latex: "x^2", display: "x²", depth: 4, rects: [rect(24, 10, 18, 14)] },
      { id: "plus1", role: "operator", type: "operator", latex: "+", display: "+", depth: 4, rects: [rect(46, 10, 8, 14)] },
      { id: "five-x", role: "factor", type: "atom", latex: "5x", display: "5x", depth: 4, rects: [rect(58, 10, 18, 14)] },
      { id: "plus2", role: "operator", type: "operator", latex: "+", display: "+", depth: 4, rects: [rect(80, 10, 8, 14)] },
      { id: "six", role: "constant", type: "number", latex: "6", display: "6", depth: 4, rects: [rect(92, 10, 10, 14)] },
      { id: "later-a", role: "coefficient", type: "number", latex: "3", display: "3", depth: 4, rects: [rect(10, 48, 10, 14)] },
      { id: "later-x2", role: "base", type: "symbol", latex: "x^2", display: "x²", depth: 4, rects: [rect(24, 48, 18, 14)] },
      { id: "later-minus", role: "operator", type: "operator", latex: "-", display: "-", depth: 4, rects: [rect(80, 48, 8, 14)] },
      { id: "later-37", role: "constant", type: "number", latex: "37", display: "37", depth: 4, rects: [rect(92, 48, 18, 14)] },
      { id: "later-eq", role: "equality", type: "operator", latex: "=", display: "=", depth: 4, rects: [rect(114, 48, 8, 14)] },
      { id: "later-zero", role: "constant", type: "number", latex: "0", display: "0", depth: 4, rects: [rect(126, 48, 10, 14)] },
    ];

    const selected = sortTargetsByRenderedOrder(getTargetsIntersectingRect(leaves, rect(8, 6, 98, 24)));
    assert.deepEqual(selected.map((target) => target.id), ["a", "x2", "plus1", "five-x", "plus2", "six"]);
    assert.equal(reconstructTextFromTargets(selected), "3 x² + 5x + 6");
  });

  it("does not reconstruct later equation text from a first-line drag regression", () => {
    const leaves = [
      { id: "first-3x2", role: "component", type: "atom", display: "3x²", latex: "3x^2", depth: 4, rects: [rect(0, 0, 30, 16)] },
      { id: "first-plus", role: "operator", type: "operator", display: "+", latex: "+", depth: 4, rects: [rect(34, 0, 8, 16)] },
      { id: "first-5x", role: "component", type: "atom", display: "5x", latex: "5x", depth: 4, rects: [rect(46, 0, 20, 16)] },
      { id: "first-plus2", role: "operator", type: "operator", display: "+", latex: "+", depth: 4, rects: [rect(70, 0, 8, 16)] },
      { id: "first-6", role: "constant", type: "number", display: "6", latex: "6", depth: 4, rects: [rect(82, 0, 10, 16)] },
      { id: "second-equation", role: "component", type: "atom", display: "3x² + 5x - 37 = 0", latex: "3x^2+5x-37=0", depth: 4, rects: [rect(0, 34, 150, 16)] },
    ];

    const text = reconstructTextFromTargets(getTargetsIntersectingRect(leaves, rect(0, -4, 100, 24)));
    assert.equal(text.includes("37"), false);
    assert.equal(text.includes("="), false);
    assert.equal(text, "3x² + 5x + 6");
  });

  it("uses median leaf height as the sane simple-token height baseline", () => {
    assert.equal(medianRectHeight([rect(0, 0, 10, 14), rect(0, 0, 10, 16), rect(0, 0, 10, 60)]), 16);
  });

  it("resolveSemanticTarget selects exponent, base, and power gap deterministically", () => {
    const power = { id: "x2", role: "power", type: "power", depth: 4, childIds: ["x", "two"], rects: [rect(10, 4, 30, 30)] };
    const base = { id: "x", role: "base", type: "symbol", depth: 6, parentId: "x2", rectSource: "dom-leaf", rects: [rect(12, 18, 12, 14)] };
    const exponent = { id: "two", role: "exponent", type: "number", depth: 6, parentId: "x2", rectSource: "dom-leaf", rects: [rect(28, 6, 8, 10)] };
    const targets = [power, base, exponent];

    assert.equal(resolveSemanticTarget({ pointer: { x: 31, y: 9 }, candidates: targets }).target.id, "two");
    assert.equal(resolveSemanticTarget({ pointer: { x: 17, y: 24 }, candidates: targets }).target.id, "x");
    assert.equal(resolveSemanticTarget({ pointer: { x: 26, y: 17 }, candidates: targets, options: { includeStructural: true } }).target.id, "x2");
  });

  it("resolveSemanticTarget rejects imprecise operator overlays instead of rescuing a parent", () => {
    const power = {
      id: "power",
      role: "power",
      type: "power",
      depth: 1,
      childIds: ["operator-plus", "exponent-two"],
      sourceRange: { start: 0, end: 7 },
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "broad_aggregate",
      paintedRects: [rect(120, 330, 8, 9)],
      rects: [rect(100, 330, 17, 26)],
    };
    const plus = {
      id: "operator-plus",
      role: "operator",
      type: "operator",
      latex: "+",
      depth: 4,
      parentId: "power",
      sourceRange: { start: 2, end: 3 },
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "collapsed",
      paintedRects: [],
      paintedArea: 0,
      rects: [rect(100, 330, 17, 26)],
    };
    const exponent = {
      id: "exponent-two",
      role: "exponent",
      type: "number",
      latex: "2",
      depth: 4,
      parentId: "power",
      sourceRange: { start: 6, end: 7 },
      deterministic: true,
      rectSource: "semantic-dom",
      geometryQuality: "precise_leaf",
      paintedRects: [rect(113, 330, 6, 9)],
      rects: [rect(113, 330, 6, 9)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 106, y: 344 },
      candidates: [power, plus, exponent],
    }).target, null);
    assert.equal(resolveSemanticTarget({
      pointer: { x: 116, y: 334 },
      candidates: [power, plus, exponent],
    }).target.id, "exponent-two");
  });

  it("resolveSemanticTarget keeps legitimate variable leaves even when their rectangle matches an aggregate", () => {
    const power = {
      id: "power",
      role: "power",
      type: "power",
      depth: 1,
      childIds: ["x"],
      sourceRange: { start: 0, end: 3 },
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(100, 330, 17, 26)],
    };
    const x = {
      id: "x",
      role: "variable",
      type: "symbol",
      latex: "x",
      depth: 4,
      parentId: "power",
      sourceRange: { start: 0, end: 1 },
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(100, 330, 17, 26)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 106, y: 344 },
      candidates: [power, x],
    }).target.id, "x");
  });

  it("resolveSemanticTarget keeps radical signs even when their type is operator", () => {
    const radical = {
      id: "sqrt-sign",
      role: "radical",
      type: "operator",
      latex: "\\sqrt",
      depth: 3,
      sourceRange: { start: 18, end: 23 },
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(420, 675, 36, 20)],
    };
    const root = {
      id: "sqrt-root",
      role: "root",
      type: "root",
      childIds: ["sqrt-sign", "radicand"],
      sourceRange: { start: 18, end: 36 },
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(420, 675, 36, 20)],
    };
    const fraction = {
      id: "outer-fraction",
      role: "fraction",
      type: "fraction",
      childIds: ["sqrt-root"],
      sourceRange: { start: 0, end: 59 },
      deterministic: true,
      rectSource: "aggregate-descendant-union",
      rects: [rect(390, 660, 90, 70)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 438, y: 685 },
      candidates: [fraction, root, radical],
    }).target.id, "sqrt-sign");
  });

  it("resolveSemanticTarget ignores zero-sized nodes and returns candidate scores", () => {
    const zero = { id: "zero", role: "variable", type: "symbol", depth: 10, rects: [{ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }] };
    const x = { id: "x", role: "variable", type: "symbol", depth: 4, rectSource: "dom-leaf", rects: [rect(10, 10, 12, 16)] };
    const result = resolveSemanticTarget({ pointer: { x: 14, y: 15 }, candidates: [zero, x] });

    assert.equal(result.target.id, "x");
    assert.equal(result.candidateScores[0].target.id, "x");
    assert.equal(result.candidateScores.some((candidate) => candidate.target.id === "zero"), false);
  });

  it("resolveSemanticTarget handles fragmented rects without selecting a stretched ancestor", () => {
    const ancestor = { id: "ancestor", role: "expression", type: "sum", depth: 1, rectSource: "child-union", childIds: ["frag"], rects: [rect(0, 0, 160, 80)] };
    const fragment = {
      id: "frag",
      role: "argument",
      type: "sum",
      depth: 5,
      rectSource: "dom-leaf",
      rects: [rect(10, 12, 28, 16), rect(80, 12, 30, 16)],
    };

    assert.equal(resolveSemanticTarget({ pointer: { x: 90, y: 18 }, candidates: [ancestor, fragment] }).target.id, "frag");
    assert.equal(resolveSemanticTarget({ pointer: { x: 70, y: 60 }, candidates: [ancestor, fragment] }).target, null);
  });

  it("resolveSemanticTarget is stable across approach direction but does not trap stale targets", () => {
    const left = { id: "left", role: "variable", type: "symbol", depth: 4, rectSource: "dom-leaf", rects: [rect(10, 10, 12, 16)] };
    const right = { id: "right", role: "variable", type: "symbol", depth: 4, rectSource: "dom-leaf", rects: [rect(24, 10, 12, 16)] };
    const first = resolveSemanticTarget({ pointer: { x: 16, y: 16 }, candidates: [left, right], currentTarget: right });
    const second = resolveSemanticTarget({ pointer: { x: 16, y: 16 }, candidates: [right, left], currentTarget: null });
    const moved = resolveSemanticTarget({ pointer: { x: 30, y: 16 }, candidates: [left, right], currentTarget: left });

    assert.equal(first.target.id, "left");
    assert.equal(second.target.id, "left");
    assert.equal(moved.target.id, "right");
  });

  it("resolveSemanticTarget lets the explicit minus operator win inside a negative number", () => {
    const negative = {
      id: "negative-451",
      role: "constant",
      type: "number",
      latex: "-451",
      depth: 4,
      sourceRange: { start: 8, end: 12 },
      rectSource: "dom-leaf",
      rects: [rect(40, 10, 36, 16)],
    };
    const minus = {
      id: "minus",
      role: "operator",
      type: "operator",
      latex: "-",
      depth: 5,
      sourceRange: { start: 8, end: 9 },
      rectSource: "dom-leaf",
      rects: [rect(40, 10, 8, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 43, y: 16 },
      candidates: [negative, minus],
      currentTarget: negative,
    }).target.id, "minus");
  });

  it("resolveSemanticTarget prefers a differential aggregate over its child d by default", () => {
    const differential = {
      id: "dtheta",
      role: "differential",
      type: "differential",
      latex: "d\\theta",
      depth: 3,
      childIds: ["d", "theta"],
      rectSource: "child-union",
      rects: [rect(10, 10, 32, 16)],
    };
    const d = {
      id: "d",
      role: "differentialOperator",
      type: "operator",
      latex: "d",
      depth: 4,
      parentId: "dtheta",
      rectSource: "dom-leaf",
      rects: [rect(10, 10, 10, 16)],
    };
    differential.geometryQuality = "precise_group";
    differential.paintedRects = [rect(10, 10, 32, 16)];
    d.geometryQuality = "precise_leaf";
    d.paintedRects = [rect(10, 10, 10, 16)];

    assert.equal(resolveSemanticTarget({
      pointer: { x: 15, y: 16 },
      candidates: [differential, d],
    }).target.id, "dtheta");
  });

  it("selects differential targets only inside glyph-tight bounds", () => {
    const dt = {
      id: "dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["dt-d", "dt-t"],
      rectSource: "semantic-dom:differential-child-leaf-union",
      geometryQuality: "precise_group",
      paintedRects: [rect(180, 20, 17, 16)],
      rects: [rect(180, 20, 17, 16)],
    };
    const dx = {
      id: "dx",
      role: "differential",
      type: "differential",
      latex: "dx",
      childIds: ["dx-d", "dx-x"],
      rectSource: "semantic-dom:differential-child-leaf-union",
      geometryQuality: "precise_group",
      paintedRects: [rect(220, 20, 18, 16)],
      rects: [rect(220, 20, 18, 16)],
    };

    assert.equal(chooseSemanticHit([dt], 186, 28).id, "dt");
    assert.equal(chooseSemanticHit([dx], 228, 28).id, "dx");
    assert.equal(chooseSemanticHit([dt], 174, 28), null);
    assert.equal(chooseSemanticHit([dt], 202, 28), null);
  });

  it("omits oversized differential aggregate geometry when no glyph-tight rect is available", () => {
    const oversized = {
      id: "oversized-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["missing-d", "missing-t"],
      rectSource: "semantic-dom",
      rects: [rect(10, 10, 220, 24)],
    };
    const refined = refineDifferentialHighlightGeometry(oversized, {
      childRects: [],
      textRects: [],
      containerRect: rect(0, 0, 260, 60),
      medianLeafHeight: 16,
    });

    assert.equal(refined.id, "oversized-dt");
    assert.deepEqual(refined.rects, []);
    assert.match(refined.visualRectSource, /differential-omitted-oversized/);
    assert.equal(chooseSemanticHit([refined], 90, 20), null);
  });

  it("visible deterministic leaves beat overlapping passive differential aggregates", () => {
    const coefficient = {
      id: "two-a",
      role: "coefficient",
      type: "atom",
      latex: "2a",
      depth: 5,
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(44, 18, 20, 16)],
    };
    const passiveDifferential = {
      id: "passive-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["passive-d", "passive-t"],
      depth: 3,
      deterministic: true,
      rectSource: "semantic-dom:differential-child-leaf-union",
      rects: [rect(40, 16, 28, 18)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 53, y: 25 },
      candidates: [passiveDifferential, coefficient],
    }).target.id, "two-a");
  });

  it("complex fraction gaps and right-side leaves do not resolve to distant differentials", () => {
    const fraction = {
      id: "right-fraction",
      role: "fraction",
      type: "fraction",
      depth: 2,
      childIds: ["numerator", "denominator"],
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(20, 10, 140, 58)],
    };
    const numerator = {
      id: "numerator",
      role: "numerator",
      type: "number",
      latex: "7",
      depth: 4,
      parentId: "right-fraction",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(72, 14, 10, 16)],
    };
    const rightLeaf = {
      id: "right-side-2a",
      role: "coefficient",
      type: "atom",
      latex: "2a",
      depth: 4,
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(116, 42, 22, 16)],
    };
    const dt = {
      id: "distant-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["distant-d", "distant-t"],
      depth: 3,
      deterministic: true,
      rectSource: "semantic-dom:differential-child-leaf-union",
      rects: [rect(186, 42, 16, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 104, y: 36 },
      candidates: [fraction, numerator, rightLeaf, dt],
    }).target, null);
    assert.equal(resolveSemanticTarget({
      pointer: { x: 124, y: 49 },
      candidates: [fraction, dt, rightLeaf],
    }).target.id, "right-side-2a");
  });

  it("drag selection over a larger region keeps the selected range instead of collapsing to dt", () => {
    const leaves = [
      { id: "right-2a", role: "coefficient", type: "atom", display: "2a", latex: "2a", depth: 4, rects: [rect(80, 20, 20, 16)] },
      { id: "right-plus", role: "operator", type: "operator", display: "+", latex: "+", depth: 4, rects: [rect(104, 20, 8, 16)] },
      { id: "right-b", role: "variable", type: "symbol", display: "b", latex: "b", depth: 4, rects: [rect(116, 20, 10, 16)] },
      { id: "right-d", role: "differentialOperator", type: "operator", display: "d", latex: "d", depth: 5, parentId: "right-dt", rects: [rect(138, 20, 8, 16)] },
      { id: "right-t", role: "variable", type: "symbol", display: "t", latex: "t", depth: 5, parentId: "right-dt", rects: [rect(147, 20, 7, 16)] },
      { id: "right-dt", role: "differential", type: "differential", display: "dt", latex: "dt", childIds: ["right-d", "right-t"], depth: 4, rects: [rect(138, 20, 16, 16)] },
    ];

    const selected = sortTargetsByRenderedOrder(getTargetsIntersectingRect(leaves, rect(78, 18, 80, 20)));
    assert.deepEqual(selected.map((target) => target.id), ["right-2a", "right-plus", "right-b", "right-d", "right-t"]);
    assert.equal(reconstructTextFromTargets(selected), "2a + b d t");
  });

  it("refines dt at the end of an integral to visible differential leaves", () => {
    const differential = {
      id: "integral-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["dt-d", "dt-t"],
      rectSource: "semantic-dom",
      rects: [rect(10, 10, 220, 24)],
    };

    const refined = refineDifferentialHighlightGeometry(differential, {
      childRects: [rect(194, 13, 8, 15), rect(203, 13, 7, 15)],
      containerRect: rect(0, 0, 260, 60),
    });

    assert.equal(refined.id, "integral-dt");
    assert.equal(refined.rects.length, 1);
    assert.deepEqual(refined.rects[0], rect(194, 13, 16, 15));
    assert.match(refined.visualRectSource, /differential-child-leaf-union/);
  });

  it("refines a multi-character differential variable without collapsing to only d", () => {
    const differential = {
      id: "dtheta",
      role: "differential",
      type: "differential",
      latex: "d\\theta",
      childIds: ["d", "theta"],
      rectSource: "semantic-dom",
      rects: [rect(80, 20, 96, 22)],
    };

    const refined = refineDifferentialHighlightGeometry(differential, {
      childRects: [rect(142, 23, 8, 16), rect(151, 23, 24, 16)],
      containerRect: rect(0, 0, 220, 70),
    });

    assert.equal(refined.id, "dtheta");
    assert.deepEqual(refined.rects[0], rect(142, 23, 33, 16));
  });

  it("keeps nested fraction/integral differential geometry out of the integrand", () => {
    const differential = {
      id: "nested-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["nested-d", "nested-t"],
      rectSource: "semantic-dom",
      rects: [rect(30, 8, 250, 64)],
    };
    const integrand = rect(48, 12, 165, 52);

    const refined = refineDifferentialHighlightGeometry(differential, {
      childRects: [rect(232, 42, 8, 16), rect(241, 42, 7, 16)],
      containerRect: rect(0, 0, 300, 90),
    });

    assert.equal(refined.id, "nested-dt");
    assert.deepEqual(refined.rects[0], rect(232, 42, 16, 16));
    assert.equal(refined.rects[0].left > integrand.right, true);
  });

  it("keeps multiple dt tokens in one step visually independent", () => {
    const first = {
      id: "first-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["first-d", "first-t"],
      rectSource: "semantic-dom",
      rects: [rect(0, 10, 100, 20)],
    };
    const second = {
      id: "second-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["second-d", "second-t"],
      rectSource: "semantic-dom",
      rects: [rect(120, 10, 110, 20)],
    };

    const firstRefined = refineDifferentialHighlightGeometry(first, {
      childRects: [rect(84, 12, 8, 15), rect(93, 12, 7, 15)],
    });
    const secondRefined = refineDifferentialHighlightGeometry(second, {
      childRects: [rect(211, 12, 8, 15), rect(220, 12, 7, 15)],
    });

    assert.equal(firstRefined.id, "first-dt");
    assert.equal(secondRefined.id, "second-dt");
    assert.deepEqual(firstRefined.rects[0], rect(84, 12, 16, 15));
    assert.deepEqual(secondRefined.rects[0], rect(211, 12, 16, 15));
  });

  it("falls back to filtered text-range geometry before using an oversized differential aggregate", () => {
    const differential = {
      id: "text-range-dt",
      role: "differential",
      type: "differential",
      latex: "dt",
      childIds: ["missing-d", "missing-t"],
      rectSource: "semantic-dom",
      rects: [rect(0, 10, 180, 22)],
    };

    const refined = refineDifferentialHighlightGeometry(differential, {
      childRects: [],
      textRects: [rect(162, 12, 15, 16)],
      containerRect: rect(0, 0, 220, 60),
    });

    assert.equal(refined.id, "text-range-dt");
    assert.deepEqual(refined.rects[0], rect(162, 12, 15, 16));
    assert.match(refined.visualRectSource, /differential-text-range/);
  });

  it("deterministic semantic DOM targets choose the exponent leaf over its power parent", () => {
    const power = {
      id: "x2",
      role: "power",
      type: "power",
      depth: 2,
      childIds: ["x", "two"],
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(10, 4, 34, 34)],
    };
    const base = {
      id: "x",
      role: "base",
      type: "symbol",
      depth: 3,
      parentId: "x2",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(12, 20, 12, 16)],
    };
    const exponent = {
      id: "two",
      role: "exponent",
      type: "number",
      depth: 3,
      parentId: "x2",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(30, 6, 8, 10)],
    };

    const result = resolveSemanticTarget({
      pointer: { x: 33, y: 9 },
      candidates: [power, base, exponent],
      currentTarget: power,
    });

    assert.equal(result.target.id, "two");
    assert.equal(result.reason, "deterministic-leaf-hit");
  });

  it("deterministic semantic DOM targets keep signed-number body distinct from the explicit minus", () => {
    const negative = {
      id: "negative-one",
      role: "constant",
      type: "number",
      latex: "-1",
      depth: 4,
      sourceRange: { start: 17, end: 19 },
      deterministic: true,
      rectSource: "semantic-dom-targeted-fallback",
      rects: [rect(40, 10, 14, 16)],
    };
    const minus = {
      id: "minus",
      role: "operator",
      type: "operator",
      latex: "-",
      depth: 4,
      sourceRange: { start: 17, end: 18 },
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(40, 10, 5, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 43, y: 16 },
      candidates: [negative, minus],
    }).target.id, "minus");
    assert.equal(resolveSemanticTarget({
      pointer: { x: 48, y: 16 },
      candidates: [minus, negative],
    }).target.id, "negative-one");
  });

  it("deterministic semantic DOM resolution is independent of approach direction and candidate order", () => {
    const parent = {
      id: "parent",
      role: "fraction",
      type: "fraction",
      depth: 1,
      childIds: ["six"],
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(0, 0, 90, 70)],
    };
    const denominator = {
      id: "six",
      role: "denominator",
      type: "number",
      depth: 4,
      parentId: "parent",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(38, 48, 10, 16)],
    };
    const pointer = { x: 42, y: 54 };
    const directions = [
      { currentTarget: parent, candidates: [parent, denominator] },
      { currentTarget: null, candidates: [denominator, parent] },
      { currentTarget: { ...parent, id: "above" }, candidates: [parent, denominator] },
      { currentTarget: { ...parent, id: "below" }, candidates: [denominator, parent] },
    ];

    for (const options of directions) {
      assert.equal(resolveSemanticTarget({ pointer, ...options }).target.id, "six");
    }
  });

  it("deterministic semantic DOM targets do not select an ineligible parent in empty space", () => {
    const parent = {
      id: "fraction",
      role: "fraction",
      type: "fraction",
      depth: 1,
      childIds: ["num", "den"],
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(0, 0, 120, 70)],
    };
    const numerator = {
      id: "num",
      role: "constant",
      type: "number",
      depth: 3,
      parentId: "fraction",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(40, 8, 12, 16)],
    };

    assert.equal(resolveSemanticTarget({
      pointer: { x: 100, y: 50 },
      candidates: [parent, numerator],
    }).target, null);
    assert.equal(resolveSemanticTarget({
      pointer: { x: 100, y: 50 },
      candidates: [parent, numerator],
      options: { includeStructural: true },
    }).target.id, "fraction");
  });

  it("deterministic repeated denominator targets resolve by semantic ID, not text occurrence", () => {
    const first = {
      id: "first-denominator-6",
      role: "denominator",
      type: "number",
      latex: "6",
      depth: 4,
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(20, 48, 10, 16)],
    };
    const second = {
      id: "second-denominator-6",
      role: "denominator",
      type: "number",
      latex: "6",
      depth: 4,
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(110, 48, 10, 16)],
    };

    assert.equal(resolveSemanticTarget({ pointer: { x: 24, y: 54 }, candidates: [second, first] }).target.id, first.id);
    assert.equal(resolveSemanticTarget({ pointer: { x: 114, y: 54 }, candidates: [first, second] }).target.id, second.id);
  });

  it("deterministic fragmented leaf rects do not create a giant gap hitbox", () => {
    const parent = {
      id: "expression",
      role: "expression",
      type: "sum",
      depth: 1,
      childIds: ["fragment"],
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(0, 0, 140, 60)],
    };
    const fragment = {
      id: "fragment",
      role: "argument",
      type: "symbol",
      depth: 4,
      parentId: "expression",
      deterministic: true,
      rectSource: "semantic-dom",
      rects: [rect(10, 10, 20, 14), rect(90, 10, 20, 14)],
    };

    assert.equal(resolveSemanticTarget({ pointer: { x: 95, y: 16 }, candidates: [parent, fragment] }).target.id, "fragment");
    assert.equal(resolveSemanticTarget({ pointer: { x: 60, y: 16 }, candidates: [parent, fragment] }).target, null);
  });
});
