import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyMathClaim, parseStatement } from "../server/verification/mathVerifier.js";
import { format, parseExpression } from "../server/verification/expression.js";

const check = (kind, fields, options) => verifyMathClaim({ kind, ...fields }, options);
const eq = (left, right, options) => check("equivalence", { left, right }, options);
const calculus = (kind, fields, options) => check(kind, { variable: "x", ...fields }, options);

describe("exact and conservative algebra evidence", () => {
  for (const [name, left, right, state] of [
    ["identical polynomial", "x^2+2*x+1", "x^2+2*x+1", "verified"],
    ["different syntax", String.raw`\frac{2*x+2}{2}`, "x+1", "verified"],
    ["distribution", "(x+1)^2", "x^2+2*x+1", "verified"],
    ["multiple variables", "(x+y)^2", "x^2+2*x*y+y^2", "verified"],
    ["subtle coefficient", "(x+1)^2", "x^2+2.001*x+1", "contradicted"],
    ["exact error below numerical tolerance", "x+0.000000000000001", "x", "contradicted"],
    ["decimal rationals", "0.1+0.2", "0.3", "verified"],
    ["large integers remain exact", "9007199254740993", "9007199254740992", "contradicted"],
    ["numerical trigonometric identity", "sin(x)^2+cos(x)^2", "1", "numerically_supported"],
    ["cancellation requires domain", "x/x", "1", "inconclusive"],
    ["nonzero denominator inferred", "(x^2+1)/(x^2+1)", "1", "verified"],
    ["square root branch", "sqrt(x^2)", "x", "contradicted"],
    ["log branch unknown", "ln(x^2)", "2*ln(x)", "inconclusive"],
    ["inverse branch", "asin(sin(x))", "x", "contradicted"],
    ["fractional powers no unsafe rewrite", "(x^2)^0.5", "x", "contradicted"],
    ["power needs domain", "x^0", "1", "inconclusive"],
    ["zero times undefined", "0*(1/x)", "0", "inconclusive"],
    ["unknown functions not erased", String.raw`\Gamma(x)`, String.raw`\Gamma(x)`, "inconclusive"],
    ["no legacy hyperbolic rewrite", String.raw`\operatorname{sech}(x)`, "1/cos(x)", "inconclusive"],
    ["ambiguous logarithm base", "log(x)", "ln(x)", "inconclusive"],
    ["case sensitive variables", "C", "c", "contradicted"],
    ["no approximate constant proof", "pi", "3.141592653589793", "numerically_supported"],
    ["zero denominator never proved", "1/0", "1/0", "inconclusive"],
    ["full expression required", "x+1; x=2", "x+1", "inconclusive"],
    ["unbound functions not multiplication", "f(x)", "f*x", "inconclusive"],
  ]) it(name, () => assert.equal(eq(left, right).state, state));

  it("discharges cancellation only under a known nonzero assumption", () => {
    const r = eq("x/x", "1", { assumptions: [{ variable: "x", relation: "!=", value: "0" }] });
    assert.equal(r.state, "verified"); assert.equal(r.domain.obligations[0].resolved, true);
    assert.deepEqual(r.assumptions, [{ variable: "x", relation: "!=", value: "0" }]);
  });
  it("unknown assumptions do not silently disappear", () => assert.equal(eq("x", "x", { assumptions: ["x is complex"] }).state, "inconclusive"));
  it("assumption budgets cannot discard restrictions", () => assert.equal(eq("x", "x", { assumptions: Array.from({ length: 33 }, () => ({ variable: "x", relation: ">", value: "0" })) }).state, "inconclusive"));
  it("inconsistent assumptions cannot produce a vacuous proof", () => assert.equal(eq("x", "x", { assumptions: [{ variable: "x", relation: ">", value: "1" }, { variable: "x", relation: "<", value: "0" }] }).state, "inconclusive"));
  it("positive log assumptions permit numerical support, not symbolic proof", () => assert.equal(eq("ln(x^2)", "2*ln(x)", { assumptions: [{ variable: "x", relation: ">", value: "0" }] }).state, "numerically_supported"));
  it("identical fractional powers are proved only for a positive base", () => assert.equal(eq("x^0.5", "x^0.5", { assumptions: [{ variable: "x", relation: ">", value: "0" }] }).state, "verified"));
});

describe("numerical evidence boundaries", () => {
  it("requires multiple distinct samples, never one accidental agreement", () => {
    const r = eq("x", "x^2", { samples: [{ x: 0 }] }); assert.equal(r.state, "inconclusive");
  });
  it("duplicate points are not multiple evidence", () => assert.equal(eq("x", "x^2", { samples: Array.from({ length: 8 }, () => ({ x: 1 })) }).state, "inconclusive"));
  it("other samples expose one-point agreement", () => assert.equal(eq("x", "x^2").state, "contradicted"));
  it("records singularity exclusions", () => {
    const r = eq("1/x", "2/x"); assert.equal(r.state, "contradicted"); assert.ok(r.numerical.excluded.some((s) => s.bindings.x === 0));
  });
  it("near-singular samples cannot prove or refute", () => {
    const r = eq("1/x", "2/x", { samples: [{ x: 1e-15 }, { x: -1e-14 }, { x: 0 }] }); assert.equal(r.state, "inconclusive");
  });
  it("catastrophic cancellation cannot count as stable evidence", () => assert.equal(eq("(10000000000000000+x)-10000000000000000", "0").state, "inconclusive"));
  it("square root cannot hide cancellation uncertainty at its boundary", () => assert.equal(eq("sqrt((10000000000000000+x)-10000000000000000)", "0").state, "inconclusive"));
  it("sampling is reproducible including excluded points", () => assert.deepEqual(eq("sin(x)^2+cos(x)^2", "1"), eq("sin(x)^2+cos(x)^2", "1")));
  it("retains tolerance, precision, residual and sample bindings", () => {
    const r = eq("sin(x)^2+cos(x)^2", "1"); assert.equal(r.state, "numerically_supported");
    assert.ok(r.numerical.samples.length >= 5); assert.ok(r.numerical.absTolerance > 0); assert.equal(r.numerical.precision, "IEEE-754 binary64");
    assert.equal(typeof r.numerical.samples[0].bindings.x, "number");
  });
  it("does not compare huge trigonometric arguments", () => assert.equal(eq("sin(100000000*x)", "0", { samples: [{ x: 1 }, { x: 2 }] }).state, "inconclusive"));
});

describe("symbolic differentiation", () => {
  for (const [name, expression, right, state] of [
    ["correct derivative", "x^3", "3*x^2", "verified"],
    ["correct cosine sign", "cos(x)", "-sin(x)", "verified"],
    ["wrong sign", "cos(x)", "sin(x)", "contradicted"],
    ["missing factor", "x^3", "x^2", "contradicted"],
    ["chain rule", "sin(3*x^2)", "6*x*cos(3*x^2)", "verified"],
    ["chain rule error", "sin(3*x^2)", "cos(3*x^2)", "contradicted"],
    ["product rule", "x*sin(x)", "sin(x)+x*cos(x)", "verified"],
    ["quotient rule known domain", "x/(1+x^2)", "(1-x^2)/(1+x^2)^2", "verified"],
    ["absolute value unsupported", "abs(x)", "1", "inconclusive"],
    ["square-root differentiability boundary", "sqrt(x)", "1/(2*sqrt(x))", "inconclusive"],
  ]) it(name, () => assert.equal(calculus("derivative", { expression, right }).state, state));
  it("log derivative retains positive-domain requirement", () => assert.equal(calculus("derivative", { expression: "ln(x)", right: "1/x" }, { assumptions: [{ variable: "x", relation: ">", value: "0" }] }).state, "verified"));
});

describe("antiderivative verification differentiates the proposed primitive", () => {
  for (const [name, integrand, right, state] of [
    ["correct antiderivative", "x^2", "x^3/3+C", "verified"],
    ["missing coefficient", "x^2", "x^3+C", "contradicted"],
    ["wrong sign", "sin(x)", "cos(x)+C", "contradicted"],
    ["additive numeric constant", "cos(x)", "sin(x)+17", "verified"],
    ["additive parameter constant", "2*x", "x^2+a", "verified"],
    ["correct chain coefficient", "cos(2*x)", "sin(2*x)/2+C", "verified"],
    ["not finite differences", "cos(x)", "sin(x)+C", "verified"],
  ]) it(name, () => assert.equal(calculus("antiderivative", { integrand, right }).state, state));
});

describe("definite integral evidence", () => {
  for (const [name, integrand, lower, upper, right, state] of [
    ["exact result", "x^2", "0", "1", "1/3", "verified"],
    ["subtle error", "x^2", "0", "1", "0.3334", "contradicted"],
    ["reversed limits", "x", "1", "0", "-1/2", "verified"],
    ["zero interval polynomial", "x", "1", "1", "0", "verified"],
    ["numerical Gaussian", "exp(-x^2)", "0", "1", "0.7468241328124271", "numerically_supported"],
    ["numerical disagreement is not certified quadrature", "exp(-x^2)", "0", "1", "0.7469", "inconclusive"],
    ["interior pole rejected", "1/(x-0.317)", "0", "1", "0", "inconclusive"],
    ["singular integral rejected", "1/x", "-1", "1", "0", "inconclusive"],
    ["improper limits unsupported", "exp(-x)", "0", String.raw`\infty`, "1", "inconclusive"],
  ]) it(name, () => assert.equal(calculus("definite_integral", { integrand, lower, upper, right }).state, state));
  it("reports evaluations and uncertified convergence", () => {
    const r = calculus("definite_integral", { integrand: "exp(-x^2)", lower: "0", upper: "1", right: "0.7468241328124271" });
    assert.ok(r.numerical.evaluations > 1); assert.equal(r.numerical.certifiedErrorBound, false);
  });
});

describe("original-equation solution substitution", () => {
  for (const [name, left, right, value, state] of [
    ["valid root", "x^2", "4", "2", "verified"],
    ["invalid root", "x^2", "4", "3", "contradicted"],
    ["extraneous squared root", "sqrt(x+1)", "x-1", "0", "contradicted"],
    ["pole introduced by multiplying", "1/(x-1)", "2", "1", "contradicted"],
    ["root outside sqrt domain", "sqrt(x)", "1", "-1", "contradicted"],
    ["root outside log domain", "ln(x)", "0", "-1", "contradicted"],
  ]) it(name, () => assert.equal(calculus("solution", { left, right, value }).state, state));
  it("does not claim all roots found", () => assert.equal(calculus("solution", { left: "x^2", right: "4", value: "2" }).completenessChecked, false));
  it("respects exact root assumptions", () => assert.equal(calculus("solution", { left: "x^2", right: "4", value: "-2" }, { assumptions: [{ variable: "x", relation: ">", value: "0" }] }).state, "contradicted"));
});

describe("bounded expression interpretation", () => {
  it("preserves exponent/unary precedence", () => { assert.equal(eq("-x^2", "-(x^2)").state, "verified"); assert.equal(eq("-x^2", "(-x)^2").state, "contradicted"); });
  it("parses complete integral and derivative notation", () => {
    assert.equal(parseStatement(String.raw`\int_0^1 x\,dx`).kind, "definite_integral");
    assert.equal(parseStatement(String.raw`\int x^2\,dx=x^3/3+C`).kind, "antiderivative");
    assert.equal(parseStatement(String.raw`\frac{d}{dx}sin(2*x)=2*cos(2*x)`).kind, "derivative");
  });
  it("preserves complete grouping", () => assert.equal(format(parseExpression(String.raw`\frac{x+1}{x-1}`)), "((x+1)/(x-1))"));
  it("limits huge input", () => assert.equal(eq("x+".repeat(2000) + "1", "0").state, "inconclusive"));
  it("limits deep input", () => assert.equal(eq("(".repeat(80) + "x" + ")".repeat(80), "0").state, "inconclusive"));
  it("limits combinatorial expansion", () => assert.equal(eq("(x+y+z+a+b+c+d)^12", "0").state, "inconclusive"));
  it("normalizes deeply nested function arguments within bounded resources", () => {
    const nested = (argument) => "sin(".repeat(24) + argument + ")".repeat(24);
    assert.equal(eq(nested("x+1"), nested("1+x")).state, "verified");
  });
  it("keeps distinct nested function atoms separate", () => {
    const nested = (argument) => "sin(".repeat(23) + argument + ")".repeat(23);
    assert.equal(eq(nested("sin(x+1)"), nested("cos(x+1)")).state, "contradicted");
  });
});
