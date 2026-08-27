import assert from "node:assert/strict";
import test from "node:test";
import { createLocalRuleExplanation } from "../server/localRules.js";
import { evaluateSolutionQualityRules, findSolutionIntegrityIssues, validateSolutionQuality } from "../server/solutionValidation.js";

const problem = "Let S be the portion of the paraboloid z = 9 - x^2 - y^2 lying above z = 0, oriented upward. Its boundary curve is C. Evaluate ∬_S (∇ × F) · n dS where F(x,y,z)=<yz^2 + e^(x^2) sin(y), x^3 z + ln(1+z^2), xy^2 + z cos(xy)>.";

test("Stokes paraboloid curl problem does not fall back to generic power rule", () => {
  const result = createLocalRuleExplanation(problem, { source: "image" });
  const text = JSON.stringify(result);

  assert.ok(result);
  assert.doesNotMatch(text, /Recognized rule|Power rule|f g x/i);
  assert.match(text, /Stokes/);
  assert.match(text, /x\^2\+y\^2=9|x\^2\+y\^2\\le 9/);
  assert.match(text, /z=0/);
  assert.match(result.steps[3].math, /e\^\{x\^2\}\\sin\(y\).*dx/);
  assert.match(text, /Green/);
  assert.match(result.finalAnswerLatex, /^-\\iint/);
  assert.match(text, /no expected elementary closed form|does not simplify to an elementary closed form/);
  assert.equal(validateSolutionQuality(result, { problem }), true);
});

test("generic junk solution is rejected for Stokes curl problem", () => {
  assert.throws(() => validateSolutionQuality({
    title: "Power rule",
    expression: "x^n",
    finalAnswer: "f g x",
    steps: [{
      id: "local-step",
      label: "Recognized rule",
      math: "f g x",
      summary: "Recognized rule.",
    }],
  }, { problem }), /Solution failed quality validation/);
});

test("typed exponent equations do not trigger the derivative power-rule fallback", () => {
  assert.equal(createLocalRuleExplanation("3x^2 + 5x - 7 = 0", { source: "text" }), null);
  assert.equal(createLocalRuleExplanation("x^2 + y^2 = z^2", { source: "text" }), null);

  const derivativeRule = createLocalRuleExplanation("Differentiate x^2 using the power rule.", { source: "text" });
  assert.ok(derivativeRule);
  assert.equal(derivativeRule.expression, "x^n");
  assert.match(derivativeRule.finalAnswer, /d\/dx x\^n/);
});

test("plain equations reject derivative-only rule responses as wrong-problem output", () => {
  assert.throws(() => validateSolutionQuality({
    title: "Power rule",
    expression: "x^n",
    finalAnswer: "The power rule says d/dx x^n = n x^(n-1).",
    steps: [{
      id: "local-step",
      label: "Local rule",
      math: "x^n",
      summary: "The power rule says d/dx x^n = n x^(n-1).",
    }],
  }, { problem: "3x^2 + 5x - 7 = 0" }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.publicMessage === "The generated solution did not match the submitted problem. Please retry."
      && error.solutionIssues.includes("derivative_rule_for_plain_equation")
  ));
});

test("simple additive power equations require evaluated power final answer", () => {
  assert.throws(() => validateSolutionQuality({
    title: "Solve equation",
    finalAnswerLatex: "x=-35",
    steps: [
      { id: "s1", label: "Solve the square equation", math: "x+35^2=0", summary: "Start." },
      { id: "s2", label: "Final answer", math: "x=-35", summary: "Solve." },
    ],
  }, { problem: "x + 35^2 = 0" }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.solutionIssues.includes("incorrect_simple_power_equation_final")
  ));

  assert.equal(validateSolutionQuality({
    title: "Solve equation",
    finalAnswerLatex: "x=-1225",
    steps: [
      { id: "s1", label: "Evaluate the square", math: "x+35^2=0", summary: "Start." },
      { id: "s2", label: "Substitute the value", math: "x+1225=0", summary: "35^2=1225." },
      { id: "s3", label: "Final answer", math: "x=-1225", summary: "Subtract 1225." },
    ],
  }, { problem: "x + 35^2 = 0" }), true);
});

test("perfect-square trinomial steps preserve grouped binomial square", () => {
  const problemText = "x^2 + 70x + 1225 = 0";

  assert.throws(() => validateSolutionQuality({
    title: "Solve perfect square trinomial",
    finalAnswerLatex: "x=-35",
    steps: [
      { id: "s1", label: "Recognize the square", math: "x+35^2=0", summary: "Factor the trinomial." },
      { id: "s2", label: "Final answer", math: "x=-35", summary: "Solve." },
    ],
  }, { problem: problemText }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.solutionIssues.includes("flattened_grouped_binomial_square")
      && error.solutionIssues.includes("missing_grouped_perfect_square_step")
  ));

  assert.equal(validateSolutionQuality({
    title: "Solve perfect square trinomial",
    finalAnswerLatex: "x=-35",
    steps: [
      { id: "s1", label: "Recognize the square", math: "(x+35)^2=0", summary: "Factor the trinomial as a grouped square." },
      { id: "s2", label: "Solve the linear equation", math: "x+35=0", summary: "The repeated root equation is linear." },
      { id: "s3", label: "Final answer", math: "x=-35", summary: "Subtract 35." },
    ],
  }, { problem: problemText }), true);
});

test("perfect-square trinomial validation rejects invalid equality chains and blank solve steps", () => {
  assert.throws(() => validateSolutionQuality({
    title: "Solve perfect square trinomial",
    finalAnswerLatex: "x=-44",
    steps: [
      {
        id: "s1",
        label: "Recognize the square",
        math: "x^2+88x+1936=(x+44)^2=0",
        summary: "Recognize the perfect square.",
      },
      {
        id: "s2",
        label: "Set the equation and solve",
        math: "",
        summary: "",
      },
      {
        id: "s3",
        label: "Final answer",
        math: "x=-44",
        summary: "The solution is x=-44.",
      },
    ],
  }, { problem: "x^2 + 88x + 1936 = 0" }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.solutionIssues.includes("invalid_perfect_square_equality_chain")
      && error.solutionIssues.includes("empty_solve_for_x_step")
      && error.solutionIssues.includes("missing_linear_perfect_square_step")
  ));

  assert.throws(() => validateSolutionQuality({
    title: "Solve perfect square trinomial",
    finalAnswerLatex: "x=\\pm44",
    steps: [
      { id: "s1", label: "Recognize the square", math: "(x+44)^2=0", summary: "Factor the trinomial." },
      { id: "s2", label: "Set the equation and solve", math: "x+44=0", summary: "Solve the repeated-root equation." },
      { id: "s3", label: "Final answer", math: "x=\\pm44", summary: "Use plus-minus." },
    ],
  }, { problem: "x^2 + 88x + 1936 = 0" }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.solutionIssues.includes("plus_minus_for_zero_perfect_square")
  ));

  assert.equal(validateSolutionQuality({
    title: "Solve perfect square trinomial",
    finalAnswerLatex: "x=5",
    steps: [
      { id: "s1", label: "Recognize the square", math: "(x-5)^2=0", summary: "Factor the trinomial as a grouped square." },
      { id: "s2", label: "Solve for x", math: "x-5=0", summary: "Solve the repeated-root equation." },
      { id: "s3", label: "Final answer", math: "x=5", summary: "Add 5." },
    ],
  }, { problem: "x^2 - 10x + 25 = 0" }), true);
});

test("undefined placeholder final answers are rejected for Stokes curl problem", () => {
  assert.throws(() => validateSolutionQuality({
    title: "Placeholder final",
    expression: "\\iint_S (\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS",
    finalAnswerLatex: "\\int_0^{2\\pi}\\int_0^3 G(r,\\theta)\\,dr\\,d\\theta",
    steps: [
      {
        id: "stokes",
        label: "Use Stokes",
        math: "\\iint_S (\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r",
      },
      {
        id: "green",
        label: "Use Green",
        math: "\\iint_D G(r,\\theta)\\,dA",
      },
    ],
  }, { problem }), /Solution failed quality validation/);
});

test("Stokes ellipse cap solution rejects dropped cosine-fraction derivative terms", () => {
  const ellipseProblem = [
    "Use Stokes' theorem for the upper cap oriented upward with boundary",
    "x^2/4 + y^2/9 = 1.",
    "F(x,y,z)=<y^2z+e^{x^2}sin(yz), x^3+ln(1+z^2)+cos(xy)/(1+x^2+y^2), xye^{-z^2}+arctan(x-y)>.",
  ].join(" ");

  assert.throws(() => validateSolutionQuality({
    title: "Invalid Stokes ellipse solution",
    expression: "\\iint_S (\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS",
    finalAnswerLatex: "\\int_0^{2\\pi} 24\\cos^3\\theta\\,d\\theta",
    steps: [
      {
        id: "s1",
        label: "Use Stokes",
        math: "\\iint_S(\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r",
        summary: "Use Stokes' theorem.",
      },
      {
        id: "s2",
        label: "Use ellipse",
        math: "x=2r\\cos\\theta,\\quad y=3r\\sin\\theta,\\quad J=6r",
        summary: "Use Green's theorem on the ellipse.",
      },
      {
        id: "s3",
        label: "Discard oscillatory terms",
        math: "\\frac{\\cos(xy)}{1+x^2+y^2}\\text{ vanishes by odd oscillatory cancellation}",
        summary: "The fraction terms are odd and oscillatory, so they vanish.",
      },
    ],
  }, { problem: ellipseProblem }), /Solution failed quality validation/);
});

test("Stokes and ellipse validators are not applicable to ordinary logarithmic improper integrals", () => {
  const logarithmicProblem = "\\int_0^1 \\frac{\\ln x}{1+x}\\,dx";
  const result = {
    title: "Evaluate logarithmic integral",
    expression: logarithmicProblem,
    finalAnswerLatex: "-\\frac{\\pi^2}{12}",
    steps: [
      {
        id: "s1",
        label: "Expand the denominator",
        math: "\\frac{1}{1+x}=\\sum_{n=0}^{\\infty}(-1)^nx^n",
        summary: "Use the geometric series on 0<x<1.",
      },
      {
        id: "s2",
        label: "Integrate termwise",
        math: "\\int_0^1 \\frac{\\ln x}{1+x}\\,dx=-\\sum_{n=1}^{\\infty}\\frac{(-1)^{n-1}}{n^2}",
        summary: "Integrate each x^n\\ln x term.",
      },
      {
        id: "s3",
        label: "Evaluate the series",
        math: "I=-\\frac{\\pi^2}{12}",
        summary: "The alternating reciprocal-square series gives the final value.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(result, { problem: logarithmicProblem });
  const ruleByName = new Map(report.evaluations.map((rule) => [rule.name, rule]));

  assert.equal(validateSolutionQuality(result, { problem: logarithmicProblem }), true);
  assert.equal(report.issues.includes("missing_green_disk_reduction"), false);
  assert.equal(report.issues.includes("missing_ellipse_jacobian"), false);
  assert.equal(report.issues.includes("unsupported_symmetry_cancellation"), false);
  assert.equal(report.issues.includes("dropped_nonpolynomial_fraction_derivative"), false);
  assert.equal(ruleByName.get("missing_green_disk_reduction").applicable, false);
  assert.equal(ruleByName.get("missing_ellipse_jacobian").applicable, false);
  assert.equal(ruleByName.get("unsupported_symmetry_cancellation").applicable, false);
  assert.equal(ruleByName.get("dropped_nonpolynomial_fraction_derivative").applicable, false);
});

test("plain-equation derivative validator is not applicable to unrelated vector-calculus prompts", () => {
  const vectorProblem = "Find the curl of F(x,y,z)=<x^2,y^2,z^2>.";
  const result = {
    title: "Compute curl",
    expression: "\\nabla\\times F",
    finalAnswerLatex: "\\nabla\\times F=\\mathbf 0",
    steps: [
      {
        id: "s1",
        label: "Differentiate components",
        math: "\\nabla\\times F=\\langle R_y-Q_z, P_z-R_x, Q_x-P_y\\rangle",
        summary: "Use the curl component formula.",
      },
      {
        id: "s2",
        label: "Substitute derivatives",
        math: "\\nabla\\times F=\\langle 0-0,0-0,0-0\\rangle=\\mathbf 0",
        summary: "Each cross partial in the curl is zero.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(result, { problem: vectorProblem });
  const derivativeRule = report.evaluations.find((rule) => rule.name === "derivative_rule_for_plain_equation");
  const stokesRule = report.evaluations.find((rule) => rule.name === "missing_green_disk_reduction");

  assert.equal(validateSolutionQuality(result, { problem: vectorProblem }), true);
  assert.equal(derivativeRule.applicable, false);
  assert.equal(stokesRule.applicable, false);
  assert.equal(report.issues.includes("derivative_rule_for_plain_equation"), false);
  assert.equal(report.issues.includes("missing_green_disk_reduction"), false);
});

test("Stokes solution integrity detects a jump from theorem setup to final answer", () => {
  const issues = findSolutionIntegrityIssues({
    title: "Incomplete Stokes solution",
    expression: "\\iint_S(\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS",
    finalAnswerLatex: "18\\pi",
    steps: [
      {
        id: "s1",
        label: "Use Stokes",
        math: "\\iint_S(\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r",
        summary: "Use Stokes' theorem.",
      },
      {
        id: "s2",
        label: "Final answer",
        math: "18\\pi",
        summary: "This is the answer.",
      },
    ],
  }, { problem });

  assert.ok(issues.includes("missing_green_disk_reduction"));
  assert.ok(issues.includes("missing_intermediate_simplification"));
});

test("coordinate changes must include a Jacobian", () => {
  const issues = findSolutionIntegrityIssues({
    title: "Incomplete coordinate change",
    finalAnswerLatex: "\\int_0^1\\int_0^{2\\pi} f(r,\\theta)\\,d\\theta\\,dr",
    steps: [
      {
        id: "s1",
        label: "Use Stokes",
        math: "\\iint_S(\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r",
        summary: "Use Stokes.",
      },
      {
        id: "s2",
        label: "Change variables",
        math: "x=2r\\cos\\theta,\\quad y=3r\\sin\\theta",
        summary: "Change variables to polar coordinates.",
      },
    ],
  }, { problem: [
    "Use Stokes' theorem for the upper cap oriented upward with boundary",
    "x^2/4 + y^2/9 = 1.",
    "F(x,y,z)=<y^2z+e^{x^2}sin(yz), x^3+ln(1+z^2)+cos(xy)/(1+x^2+y^2), xye^{-z^2}+arctan(x-y)>.",
  ].join(" ") });

  assert.ok(issues.includes("coordinate_change_without_jacobian"));
  assert.ok(issues.includes("missing_ellipse_jacobian"));
});

test("non-elementary Stokes integrals must not be claimed as simplified", () => {
  const issues = findSolutionIntegrityIssues({
    title: "Over-simplified ellipse solution",
    finalAnswerLatex: "24\\pi",
    steps: [
      {
        id: "s1",
        label: "Use Stokes",
        math: "\\iint_S(\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r",
        summary: "Use Stokes and Green.",
      },
      {
        id: "s2",
        label: "Change variables",
        math: "x=2r\\cos\\theta,\\quad y=3r\\sin\\theta,\\quad J=6r",
        summary: "Change variables and simplify to the answer.",
      },
    ],
  }, { problem: [
    "Use Stokes' theorem for the upper cap oriented upward with boundary",
    "x^2/4 + y^2/9 = 1.",
    "F(x,y,z)=<y^2z+e^{x^2}sin(yz), x^3+ln(1+z^2)+cos(xy)/(1+x^2+y^2), xye^{-z^2}+arctan(x-y)>.",
  ].join(" ") });

  assert.ok(issues.includes("non_elementary_integral_claimed_simplified"));
});

test("solution validation flags abrupt special function introductions", () => {
  const bad = {
    title: "Known integral shortcut",
    expression: "\\int_0^1 \\frac{\\ln x}{1-x}\\,dx",
    finalAnswerLatex: "\\zeta(3)",
    steps: [
      {
        id: "s1",
        label: "Set up the integral",
        math: "\\int_0^1 \\frac{\\ln x}{1-x}\\,dx",
        summary: "Set up the integral.",
      },
      {
        id: "s2",
        label: "Use known integral result",
        math: "\\int_0^1 \\frac{\\ln x}{1-x}\\,dx=\\zeta(3)",
        summary: "Use known integral result.",
      },
    ],
  };

  assert.throws(() => validateSolutionQuality(bad, { problem: bad.expression }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.solutionIssues.includes("abrupt_special_function_introduction:zeta")
  ));

  const justified = {
    title: "Derived zeta identity",
    expression: "\\int_0^1 \\frac{\\ln^2 x}{1-x}\\,dx",
    finalAnswerLatex: "2\\zeta(3)",
    steps: [
      {
        id: "s1",
        label: "Derive the identity",
        math: "n\\in\\mathbb N_0,\\quad \\frac{1}{1-x}=\\sum_{n=0}^{\\infty}x^n,\\quad \\int_0^1 x^n\\ln^2x\\,dx=\\frac{2}{(n+1)^3}",
        summary: "For nonnegative integers n, derive the identity from the geometric series.",
      },
      {
        id: "s2",
        label: "Sum the derived series",
        math: "\\int_0^1 \\frac{\\ln^2x}{1-x}\\,dx=2\\sum_{n=1}^{\\infty}\\frac{1}{n^3}=2\\zeta(3)",
        summary: "Using the identity: \\zeta(3)=\\sum_{n=1}^{\\infty}n^{-3}.",
      },
    ],
  };

  assert.equal(validateSolutionQuality(justified, { problem: justified.expression }), true);
});
