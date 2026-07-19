import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSolutionQualityRules, validateSolutionQuality } from "../server/solutionValidation.js";
import {
  analyzeFinalAnswerConsistency,
  analyzeNumericExpression,
  analyzeSubstitutionConsistency,
  numericalFinalAnswerCheck,
} from "../server/mathValidationAnalysis.js";

function expectValidationIssue(result, problem, issue) {
  assert.throws(() => validateSolutionQuality(result, { problem }), (error) => (
    error.code === "AI_SOLUTION_QUALITY_INVALID"
      && error.compactRetryable === false
      && error.solutionIssues.includes(issue)
  ));
}

const regressionIntegralProblem = "Evaluate the integral from 0 to infinity of (ln(1 + x^2) times arctan x) divided by (x times (1 + x^2)) with respect to x.";
const regressionIntegralLatex = "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx";

test("detached relation-leading display fragments are rejected outside aligned derivations", () => {
  expectValidationIssue({
    title: "Detached fragment",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "2",
    steps: [
      { id: "s1", label: "Setup", math: "\\int_0^1 x\\,dx", summary: "Set up the integral." },
      { id: "s2", label: "Detached result", math: "=2", summary: "A detached equality fragment." },
    ],
  }, "\\int_0^1 x\\,dx", "detached_relation_leading_fragment");

  assert.equal(validateSolutionQuality({
    title: "Aligned derivation",
    expression: "1+1",
    finalAnswerLatex: "I=2",
    steps: [
      {
        id: "s1",
        label: "Use an aligned derivation",
        math: "\\begin{aligned}I&=1+1\\\\&=2\\end{aligned}",
        summary: "The aligned block deliberately continues the equality.",
      },
    ],
  }, { problem: "1+1" }), true);
});

test("named sign inconsistency is rejected when a final answer drops the sign", () => {
  expectValidationIssue({
    title: "Sign inconsistency",
    expression: "I",
    finalAnswerLatex: "I=J",
    steps: [
      { id: "s1", label: "Relate quantities", math: "I=-2J", summary: "Derive the signed relation." },
      { id: "s2", label: "Evaluate J", math: "J=1", summary: "Evaluate the helper integral." },
      { id: "s3", label: "Final answer", math: "I=J", summary: "State the final answer." },
    ],
  }, "Evaluate I", "sign_inconsistent_named_quantity");
});

test("integration by parts declarations require v or a recognized identity", () => {
  expectValidationIssue({
    title: "Unsupported integration by parts",
    expression: "\\int x e^x\\,dx",
    finalAnswerLatex: "xe^x-e^x+C",
    steps: [
      {
        id: "s1",
        label: "Choose parts",
        math: "u=x,\\quad dv=e^x\\,dx",
        summary: "Use integration by parts with u=x and dv=e^x dx.",
      },
      {
        id: "s2",
        label: "Jump to result",
        math: "\\int xe^x\\,dx=xe^x-e^x+C",
        summary: "Apply the formula.",
      },
    ],
  }, "\\int x e^x\\,dx", "unsupported_integration_by_parts_setup");

  assert.equal(validateSolutionQuality({
    title: "Supported integration by parts",
    expression: "\\int x e^x\\,dx",
    finalAnswerLatex: "xe^x-e^x+C",
    steps: [
      {
        id: "s1",
        label: "Choose parts",
        math: "u=x,\\quad dv=e^x\\,dx,\\quad du=dx,\\quad v=e^x",
        summary: "Compute v by integrating dv.",
      },
      {
        id: "s2",
        label: "Apply parts",
        math: "\\int xe^x\\,dx=xe^x-\\int e^x\\,dx=xe^x-e^x+C",
        summary: "Substitute into integration by parts.",
      },
    ],
  }, { problem: "\\int x e^x\\,dx" }), true);
});

test("integration by parts rejects unevaluated v and vague setup claims", () => {
  expectValidationIssue({
    title: "Unevaluated v",
    expression: "\\int xe^x\\,dx",
    finalAnswerLatex: "xe^x-e^x+C",
    steps: [
      {
        id: "s1",
        label: "Choose parts",
        math: "u=x,\\quad dv=e^x\\,dx,\\quad du=dx,\\quad v=\\int e^x\\,dx",
        summary: "Leave v as an unevaluated integral.",
      },
      {
        id: "s2",
        label: "Final answer",
        math: "\\int xe^x\\,dx=xe^x-e^x+C",
        summary: "Jump to the result.",
      },
    ],
  }, "\\int xe^x\\,dx", "unsupported_integration_by_parts_setup");

  expectValidationIssue({
    title: "Vague parts",
    expression: "\\int xe^x\\,dx",
    finalAnswerLatex: "xe^x-e^x+C",
    steps: [
      {
        id: "s1",
        label: "Use integration by parts",
        math: "\\int xe^x\\,dx=xe^x-e^x+C",
        summary: "Using integration by parts gives the answer.",
      },
    ],
  }, "\\int xe^x\\,dx", "unsupported_integration_by_parts_setup");
});

test("integration by parts accepts explicit valid identities but rejects the known false cot-log antiderivative", () => {
  assert.equal(validateSolutionQuality({
    title: "Supported identity",
    expression: "\\int xe^x\\,dx",
    finalAnswerLatex: "xe^x-e^x+C",
    steps: [
      {
        id: "s1",
        label: "Use an identity",
        math: "\\int xe^x\\,dx=xe^x-e^x+C",
        summary: "Using the identity derived by differentiating xe^x-e^x gives the antiderivative.",
      },
    ],
  }, { problem: "\\int xe^x\\,dx" }), true);

  expectValidationIssue({
    title: "False identity",
    expression: "\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [
      {
        id: "s1",
        label: "Use integration by parts",
        math: "u=\\theta,\\quad dv=\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
        summary: "Using the identity \\int\\cot\\theta\\ln(\\cos\\theta)d\\theta=-\\frac{1}{2}\\ln^2(\\sin\\theta)+C.",
      },
      {
        id: "s2",
        label: "Final answer",
        math: "\\frac{\\pi}{2}\\ln^2 2",
        summary: "Apply the identity.",
      },
    ],
  }, "\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta", "unsupported_integration_by_parts_setup");
});

test("final answer jumps are rejected when unsupported by prior expressions", () => {
  expectValidationIssue({
    title: "Unsupported final jump",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "I=2",
    steps: [
      { id: "s1", label: "Set up", math: "\\int_0^1 x\\,dx", summary: "Set up the integral." },
      { id: "s2", label: "Final answer", math: "I=2", summary: "This is the answer." },
    ],
  }, "\\int_0^1 x\\,dx", "unsupported_final_answer_jump");
});

test("unsupported symmetry claims are rejected without a transformation or symmetric domain", () => {
  expectValidationIssue({
    title: "Unsupported symmetry",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "0",
    steps: [
      {
        id: "s1",
        label: "Cancel term",
        math: "\\int_0^1 x\\,dx=0",
        summary: "The term cancels by symmetry.",
      },
    ],
  }, "\\int_0^1 x\\,dx", "unsupported_theorem_or_symmetry_claim");

  const supported = {
    title: "Supported odd symmetry",
    expression: "\\int_{-1}^{1} x\\,dx",
    finalAnswerLatex: "\\boxed{0}",
    steps: [
      {
        id: "s1",
        label: "Use odd symmetry",
        math: "\\int_{-1}^{1}x\\,dx=0",
        summary: "The integrand is odd on the symmetric interval [-1,1], so the integral is zero.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(supported, { problem: supported.expression });

  assert.equal(report.issues.includes("unsupported_theorem_or_symmetry_claim"), false);
  assert.equal(validateSolutionQuality(supported, { problem: supported.expression }), true);
});

test("positive definite integrals reject visibly negative final answers", () => {
  const result = {
    title: "Negative answer",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\pi\\ln 2-\\pi",
    steps: [
      {
        id: "s1",
        label: "Final answer",
        math: "I=\\pi\\ln 2-\\pi",
        summary: "State a negative value.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(result, { problem: regressionIntegralProblem });

  assert.equal(report.context.signAnalysisResult.issue, "sign_contradiction_positive_integrand_negative_answer");
  expectValidationIssue(result, regressionIntegralProblem, "sign_contradiction_positive_integrand_negative_answer");
});

test("positive final answers are not rejected solely by sign validation", () => {
  const result = {
    title: "Positive answer",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "\\frac{1}{2}",
    steps: [
      { id: "s1", label: "Evaluate", math: "I=\\frac{1}{2}", summary: "Evaluate directly." },
    ],
  };
  const report = evaluateSolutionQualityRules(result, { problem: result.expression });

  assert.equal(report.context.signAnalysisResult.issue, null);
  assert.equal(validateSolutionQuality(result, { problem: result.expression }), true);
});

test("ambiguous sign, principal-value, and unstable numerical cases stay inconclusive", () => {
  const ambiguous = {
    title: "Ambiguous sign",
    expression: "\\int_0^1 \\left(x-\\frac{1}{2}\\right)\\,dx",
    finalAnswerLatex: "0",
    steps: [{ id: "s1", label: "Evaluate", math: "I=0", summary: "The integral is zero." }],
  };
  const ambiguousReport = evaluateSolutionQualityRules(ambiguous, { problem: ambiguous.expression });
  assert.equal(ambiguousReport.context.signAnalysisResult.issue, null);
  assert.match(ambiguousReport.context.signAnalysisResult.inconclusiveReason, /ambiguous|unknown/i);

  const principalValue = {
    title: "Principal value",
    expression: "\\operatorname{PV}\\int_{-1}^{1}\\frac{1}{x}\\,dx",
    finalAnswerLatex: "0",
    steps: [{ id: "s1", label: "Use symmetry", math: "I=0", summary: "Use principal-value symmetry." }],
  };
  const principalReport = evaluateSolutionQualityRules(principalValue, { problem: principalValue.expression });
  assert.equal(principalReport.context.signAnalysisResult.issue, null);
  assert.match(principalReport.context.signAnalysisResult.inconclusiveReason, /principal-value|complex|branch/i);

  const unstable = {
    title: "Endpoint singularity",
    expression: "\\int_0^1 \\frac{1}{x}\\,dx",
    finalAnswerLatex: "1",
    steps: [{ id: "s1", label: "Evaluate", math: "I=1", summary: "State a value." }],
  };
  const unstableReport = evaluateSolutionQualityRules(unstable, { problem: unstable.expression });
  assert.equal(unstableReport.context.numericalCrossCheckResult.issue, null);
  assert.match(unstableReport.context.numericalCrossCheckResult.inconclusiveReason, /non-finite|inconclusive|evalu/i);
});

test("reversed positive-integrand bounds reject a positive final answer", () => {
  const result = {
    title: "Reversed bounds",
    expression: "\\int_1^0 x\\,dx",
    finalAnswerLatex: "\\frac{1}{2}",
    steps: [{ id: "s1", label: "Evaluate", math: "I=\\frac{1}{2}", summary: "Incorrect sign." }],
  };
  expectValidationIssue(result, result.expression, "sign_contradiction_reversed_positive_integrand_positive_answer");
});

test("critical antiderivative verification rejects false identities and accepts correct elementary ones", () => {
  expectValidationIssue({
    title: "False antiderivative",
    expression: "\\int \\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
    finalAnswerLatex: "-\\frac{1}{2}\\ln^2(\\sin\\theta)+C",
    steps: [
      {
        id: "s1",
        label: "Claim an identity",
        math: "\\int\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta=-\\frac{1}{2}\\ln^2(\\sin\\theta)+C",
        summary: "Use the antiderivative identity.",
      },
    ],
  }, "\\int \\cot\\theta\\ln(\\cos\\theta)\\,d\\theta", "invalid_antiderivative");

  const correct = {
    title: "Correct antiderivative",
    expression: "\\int e^x\\,dx",
    finalAnswerLatex: "e^x+C",
    steps: [
      {
        id: "s1",
        label: "Differentiate to verify",
        math: "\\int e^x\\,dx=e^x+C",
        summary: "The derivative of e^x is e^x.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(correct, { problem: correct.expression });
  assert.equal(report.issues.includes("invalid_antiderivative"), false);
  assert.equal(validateSolutionQuality(correct, { problem: correct.expression }), true);
});

test("parameter differentiation checks reject mismatched families and allow supported setups", () => {
  expectValidationIssue({
    title: "Wrong parameter",
    expression: "\\int_0^1 x\\ln x\\,dx",
    finalAnswerLatex: "-1",
    steps: [
      {
        id: "s1",
        label: "Introduce family",
        math: "F(a)=\\int_0^1 x^a\\,dx",
        summary: "Let F(a) be the parameter family.",
      },
      {
        id: "s2",
        label: "Differentiate at the wrong point",
        math: "F'(0)=\\int_0^1 x\\ln x\\,dx=-1",
        summary: "This uses the wrong parameter value.",
      },
    ],
  }, "\\int_0^1 x\\ln x\\,dx", "parameter_derivative_mismatch");

  const supported = {
    title: "Supported parameter",
    expression: "\\int_0^1 x\\ln x\\,dx",
    finalAnswerLatex: "-\\frac{1}{4}",
    steps: [
      {
        id: "s1",
        label: "Introduce family",
        math: "F(a)=\\int_0^1 x^a\\,dx=\\frac{1}{a+1}",
        summary: "This family differentiates to x^a ln x.",
      },
      {
        id: "s2",
        label: "Differentiate at a=1",
        math: "I=F'(1)=-\\frac{1}{(1+1)^2}=-\\frac{1}{4}",
        summary: "At a=1 this gives the original x ln x integrand.",
      },
    ],
  };
  const report = evaluateSolutionQualityRules(supported, { problem: supported.expression });
  assert.equal(report.issues.includes("parameter_derivative_mismatch"), false);
  assert.equal(validateSolutionQuality(supported, { problem: supported.expression }), true);
});

test("parseable substitution algebra rejects a missing tangent factor", () => {
  expectValidationIssue({
    title: "Wrong substitution",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [
      {
        id: "s1",
        label: "Substitute",
        math: "x=\\tan\\theta,\\quad I=2\\int_0^{\\pi/2}\\theta\\ln(\\sec\\theta)\\,d\\theta",
        summary: "This drops the factor from x in the denominator.",
      },
      {
        id: "s2",
        label: "Final answer",
        math: "I=\\frac{\\pi}{2}\\ln^2 2",
        summary: "State the value.",
      },
    ],
  }, regressionIntegralProblem, "incorrect_substitution_jacobian");
});

test("final answers must be supported by the last substantive derivation value", () => {
  expectValidationIssue({
    title: "Unsupported final value",
    expression: "I",
    finalAnswerLatex: "\\frac{\\pi^3}{12}",
    steps: [
      { id: "s1", label: "Evaluate", math: "I=1", summary: "Evaluate the quantity." },
      { id: "s2", label: "Final answer", math: "I=1", summary: "This is the supported value." },
    ],
  }, "Evaluate I", "final_answer_not_supported_by_steps");
});

test("incorrect special-function simplifications are rejected when numerically comparable", () => {
  expectValidationIssue({
    title: "Wrong digamma simplification",
    expression: "I",
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln 2",
    steps: [
      {
        id: "s1",
        label: "Special function form",
        math: "I=\\frac{\\pi}{2}\\left(\\psi(1)-\\psi\\left(\\frac{3}{2}\\right)\\right)",
        summary: "Express the answer using digamma values.",
      },
    ],
  }, "Evaluate I", "unsupported_special_function_simplification");
});

test("numerical cross-check rejects clear mismatches but does not bypass invalid reasoning", () => {
  expectValidationIssue({
    title: "Wrong numeric value",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "2",
    steps: [{ id: "s1", label: "Evaluate", math: "I=2", summary: "Incorrect value." }],
  }, "\\int_0^1 x\\,dx", "numerical_final_answer_mismatch");

  expectValidationIssue({
    title: "Numerically right but invalid identity",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [
      {
        id: "s1",
        label: "False identity",
        math: "\\int\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta=-\\frac{1}{2}\\ln^2(\\sin\\theta)+C",
        summary: "This antiderivative identity is false.",
      },
      {
        id: "s2",
        label: "Final answer",
        math: "I=\\frac{\\pi}{2}\\ln^2 2",
        summary: "State the known value.",
      },
    ],
  }, regressionIntegralProblem, "invalid_antiderivative");
});

test("stable infinite-bound numerical integration accepts agreement", () => {
  const result = {
    title: "Exponential tail",
    expression: "\\int_0^\\infty e^{-x}\\,dx",
    finalAnswerLatex: "I=1",
    steps: [{ id: "s1", label: "Evaluate", math: "I=1", summary: "Evaluate the exponential tail." }],
  };
  const report = evaluateSolutionQualityRules(result, { problem: result.expression });

  assert.equal(report.context.numericalCrossCheckResult.issue, null);
  assert.equal(report.context.numericalCrossCheckResult.applicable, true);
  assert.equal(validateSolutionQuality(result, { problem: result.expression }), true);
});

test("regression integral rejects wrong constants and invalid generated derivations", () => {
  expectValidationIssue({
    title: "Wrong pi cubed answer",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi^3}{12}",
    steps: [{ id: "s1", label: "Final answer", math: "I=\\frac{\\pi^3}{12}", summary: "State an unsupported value." }],
  }, regressionIntegralProblem, "numerical_final_answer_mismatch");

  expectValidationIssue({
    title: "Invalid beta digamma derivation",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\left(\\psi(1)-\\psi\\left(\\frac{3}{2}\\right)\\right)",
    steps: [
      {
        id: "s1",
        label: "Tangent substitution",
        math: "x=\\tan\\theta,\\quad I=2\\int_0^{\\pi/2}\\theta\\ln(\\sec\\theta)\\,d\\theta",
        summary: "This transformed integral omits the tangent denominator.",
      },
      {
        id: "s2",
        label: "Parameter claim",
        math: "I'(1)=\\frac{\\pi}{2}\\left(\\psi\\left(\\frac{3}{2}\\right)-\\psi(1)\\right)",
        summary: "The parameter family does not reproduce the theta factor.",
      },
    ],
  }, regressionIntegralProblem, "sign_contradiction_positive_integrand_negative_answer");

  expectValidationIssue({
    title: "Unsupported integration by parts",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [
      {
        id: "s1",
        label: "Use integration by parts",
        math: "u=\\theta,\\quad dv=\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
        summary: "Declare the setup without a valid v.",
      },
      {
        id: "s2",
        label: "False identity",
        math: "\\int\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta=-\\frac{1}{2}\\ln^2(\\sin\\theta)+C",
        summary: "Use a false antiderivative identity.",
      },
      {
        id: "s3",
        label: "Final answer",
        math: "I=\\frac{\\pi}{2}\\ln^2 2",
        summary: "State the known value.",
      },
    ],
  }, regressionIntegralProblem, "unsupported_integration_by_parts_setup");
});

test("numeric expression analysis normalizes fraction wrappers and scientific notation safely", () => {
  const piCubed = Math.PI ** 3 / 12;

  assert.equal(analyzeNumericExpression("\\frac{\\pi^3}{12}").value, piCubed);
  assert.equal(analyzeNumericExpression("\\dfrac{\\pi^3}{12}").value, piCubed);
  assert.equal(analyzeNumericExpression("\\tfrac{\\pi^3}{12}").value, piCubed);
  assert.equal(analyzeNumericExpression("-\\dfrac{1}{2}").value, -0.5);
  assert.equal(analyzeNumericExpression("1e-3").value, 0.001);
  assert.equal(analyzeNumericExpression("1E-3").value, 0.001);
  assert.equal(analyzeNumericExpression("2.5e4").value, 25000);
  assert.equal(analyzeNumericExpression("-3.2E+5").value, -320000);
  assert.equal(analyzeNumericExpression("\\left(\\frac12\\right)").value, 0.5);
  assert.equal(analyzeNumericExpression("1e-3").value === Math.E - 3, false);

  const malformed = analyzeNumericExpression("\\dfrac{1}{}");
  assert.equal(malformed.status, "malformed");
  assert.equal(malformed.numericIntent, true);

  const symbolic = analyzeNumericExpression("x+1");
  assert.equal(symbolic.status, "symbolic");
  assert.equal(symbolic.numericIntent, false);
});

test("unsupported numeric final-answer syntax is explicit without affecting symbolic answers", () => {
  expectValidationIssue({
    title: "Malformed numeric final",
    expression: "\\int_0^1 x\\,dx",
    finalAnswerLatex: "\\dfrac{1}{}",
    steps: [{ id: "s1", label: "Final answer", math: "I=\\dfrac{1}{}", summary: "Malformed numeric syntax." }],
  }, "\\int_0^1 x\\,dx", "unsupported_numeric_final_answer_syntax");

  const symbolic = {
    title: "Symbolic answer",
    expression: "x+1",
    finalAnswerLatex: "x+1",
    steps: [{ id: "s1", label: "Final answer", math: "x+1", summary: "A symbolic expression." }],
  };
  const report = evaluateSolutionQualityRules(symbolic, { problem: "Simplify x+1." });
  assert.equal(report.issues.includes("unsupported_numeric_final_answer_syntax"), false);
});

test("numerical cross-check only rejects after stable convergence", () => {
  const convergentCases = [
    ["\\int_0^1 x^2\\,dx", "\\frac{1}{3}"],
    ["\\int_0^\\pi \\sin x\\,dx", "2"],
    ["\\int_0^\\infty e^{-x}\\,dx", "1"],
    ["\\int_0^\\infty \\frac{1}{1+x^2}\\,dx", "\\frac{\\pi}{2}"],
  ];
  for (const [problem, finalAnswerLatex] of convergentCases) {
    const check = numericalFinalAnswerCheck(problem, {
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", math: `I=${finalAnswerLatex}` }],
    });
    assert.equal(check.issue, null, problem);
    assert.equal(check.applicable, true, problem);
    assert.equal(check.converged, true, problem);
    assert.equal(check.refinementStable, true, problem);
    assert.equal(check.transformAgreement, true, problem);
  }

  const inconclusiveCases = [
    ["\\int_0^\\infty \\frac{\\sin x}{x}\\,dx", "\\frac{\\pi}{2}", /oscillatory_integrand/],
    ["\\int_0^{1000}\\sin(x^2)\\,dx", "0.626657", /oscillatory_integrand/],
    ["\\int_0^\\infty \\frac{1}{1+x}\\,dx", "0", /divergent_tail_suspected/],
    ["\\int_1^\\infty \\frac{1}{x}\\,dx", "0", /divergent_tail_suspected/],
    ["\\int_0^1 \\frac{1}{(x-0.5)^2+1e-12}\\,dx", "0", /max_depth_reached/],
    ["\\int_0^1 \\sin(1000x)\\,dx", "0.000437", /unstable_refinement|independent_estimates_disagree|oscillatory_integrand/],
  ];
  for (const [problem, finalAnswerLatex, reason] of inconclusiveCases) {
    const check = numericalFinalAnswerCheck(problem, {
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", math: `I=${finalAnswerLatex}` }],
    });
    assert.equal(check.issue, null, problem);
    assert.equal(check.diagnosticIssue, "numerical_check_inconclusive", problem);
    assert.match(check.inconclusiveReason, reason, problem);
    assert.notEqual(check.confidence, "high", problem);
  }
});

test("tan-substitution diagnostics reject only certain errors and do not reject valid equivalent forms", () => {
  const validForms = [
    "x=\\tan\\theta,\\quad I=-2\\int_0^{\\pi/2}\\frac{\\theta\\ln(\\cos\\theta)}{\\tan\\theta}\\,d\\theta",
    "x=\\tan\\theta,\\quad I=-2\\int_0^{\\pi/2}\\theta\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
    "x=\\tan\\theta,\\quad I=-2\\int_0^{\\pi/2}\\theta\\frac{\\cos\\theta}{\\sin\\theta}\\ln(\\cos\\theta)\\,d\\theta",
  ];
  for (const math of validForms) {
    const diagnostic = analyzeSubstitutionConsistency({
      expression: regressionIntegralLatex,
      steps: [{ id: "s1", label: "Substitute", math, summary: "Equivalent transformed form." }],
    }, regressionIntegralLatex);
    assert.equal(diagnostic.issue, null, math);
  }

  expectValidationIssue({
    title: "Wrong differential",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [{ id: "s1", label: "Substitute", math: "x=\\tan\\theta,\\quad dx=d\\theta,\\quad I=-2\\int_0^{\\pi/2}\\frac{\\theta\\ln(\\cos\\theta)}{\\tan\\theta}\\,d\\theta", summary: "Wrong differential." }],
  }, regressionIntegralLatex, "incorrect_substitution_jacobian");

  expectValidationIssue({
    title: "Wrong bound",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [{ id: "s1", label: "Substitute", math: "x=\\tan\\theta,\\quad \\infty\\mapsto \\theta=\\pi", summary: "Wrong upper bound." }],
  }, regressionIntegralLatex, "incorrect_substitution_jacobian");

  const split = analyzeSubstitutionConsistency({
    expression: regressionIntegralLatex,
    steps: [
      { id: "s1", label: "Substitute", math: "x=\\tan\\theta", summary: "Introduce the substitution." },
      { id: "s2", label: "Transform", math: "I=-2\\int_0^{\\pi/2}\\frac{\\theta\\ln(\\cos\\theta)}{\\tan\\theta}\\,d\\theta", summary: "Transform later." },
    ],
  }, regressionIntegralLatex);
  assert.equal(split.issue, null);
  assert.equal(split.verificationStatus, "inconclusive");
});

test("final-answer consistency ignores unrelated later side calculations", () => {
  const supportedThenSideCalculation = analyzeFinalAnswerConsistency({
    finalAnswerLatex: "2",
    steps: [
      { id: "s1", label: "Evaluate target", math: "I=2", summary: "This supports the final answer." },
      { id: "s2", label: "Side check", math: "J=1", summary: "A side calculation." },
    ],
  });
  assert.equal(supportedThenSideCalculation.issue, null);
  assert.equal(supportedThenSideCalculation.supportStatus, "supported");
  assert.equal(supportedThenSideCalculation.supportingStepId, "s1");

  assert.equal(analyzeFinalAnswerConsistency({
    finalAnswerLatex: "\\frac{1}{2}",
    steps: [{ id: "s1", label: "Explain", math: "", summary: "The value is one half." }],
  }).supportStatus, "unavailable");

  expectValidationIssue({
    title: "Sign flip",
    expression: "I",
    finalAnswerLatex: "-1",
    steps: [{ id: "s1", label: "Evaluate", math: "I=1", summary: "This supports positive one." }],
  }, "Evaluate I", "final_answer_sign_inconsistent_with_steps");

  expectValidationIssue({
    title: "Dropped factor",
    expression: "I",
    finalAnswerLatex: "1",
    steps: [{ id: "s1", label: "Evaluate", math: "I=2", summary: "This supports two." }],
  }, "Evaluate I", "final_answer_not_supported_by_steps");
});

test("confirmed integral hardening covers dfrac/tfrac and numerical tolerance", () => {
  for (const wrong of ["\\dfrac{\\pi^3}{12}", "\\tfrac{\\pi^3}{12}"]) {
    expectValidationIssue({
      title: "Wrong wrapped pi-cubed answer",
      expression: regressionIntegralLatex,
      finalAnswerLatex: wrong,
      steps: [{ id: "s1", label: "Final answer", math: `I=${wrong}`, summary: "Wrong constant." }],
    }, regressionIntegralProblem, "numerical_final_answer_mismatch");
  }

  expectValidationIssue({
    title: "Negative wrapped answer",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "-\\dfrac{1}{2}",
    steps: [{ id: "s1", label: "Final answer", math: "I=-\\dfrac{1}{2}", summary: "Negative value." }],
  }, regressionIntegralProblem, "sign_contradiction_positive_integrand_negative_answer");

  const correct = {
    title: "Correct exact value",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
    steps: [{ id: "s1", label: "Final answer", math: "I=\\frac{\\pi}{2}\\ln^2 2", summary: "State the checked value." }],
  };
  const report = evaluateSolutionQualityRules(correct, { problem: regressionIntegralProblem });
  assert.equal(report.issues.includes("numerical_final_answer_mismatch"), false);
  assert.equal(report.context.numericalCrossCheckResult.issue, null);
  assert.ok(Math.abs(report.context.numericalCrossCheckResult.numericalEstimate - 0.754693829460248) < 0.00031);
  assert.ok(report.context.numericalCrossCheckResult.tolerance < 0.001);
});

test("short mathematical final answers are present even when very short", () => {
  const cases = [
    ["0", "I=0", "Evaluate I."],
    ["1", "I=1", "Evaluate I."],
    ["-1", "I=-1", "Evaluate I."],
    ["-2", "I=-2", "Evaluate I."],
    ["\\pi", "I=\\pi", "Evaluate I."],
    ["e", "I=e", "Evaluate I."],
    ["\\frac12", "I=\\frac12", "Evaluate I."],
    ["x=1", "x=1", "Solve x=1."],
    ["x=-2", "x=-2", "Solve x=-2."],
    ["f'(x)=0", "f'(x)=0", "Find critical points of f(x)."],
    ["\\det(A)=-2", "\\det(A)=-2", "Compute \\det(A)."],
    ["\\lim_{x\\to0}f(x)=1", "\\lim_{x\\to0}f(x)=1", "Compute \\lim_{x\\to0}f(x)."],
  ];
  for (const [finalAnswerLatex, stepMath, problem] of cases) {
    const report = evaluateSolutionQualityRules({
      title: "Short final",
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: stepMath, summary: "State the result." }],
    }, { problem });
    assert.equal(report.issues.includes("missing_final_answer"), false, finalAnswerLatex);
    assert.equal(report.context.finalAnswerPresenceResult.present, true, finalAnswerLatex);
    assert.deepEqual(report.issues, [], finalAnswerLatex);
  }
});

test("compact TeX fractions pass complete validation only when both operands are present", () => {
  const validCases = [
    ["\\frac12", "I=\\frac12", "Evaluate I."],
    ["\\frac1x", "I=\\frac1x", "Simplify an expression in x."],
    ["\\frac\\pi2", "I=\\frac\\pi2", "Evaluate I."],
    ["\\frac xy", "I=\\frac xy", "Simplify an expression in x and y."],
    ["\\frac{1}{2}", "I=\\frac{1}{2}", "Evaluate I."],
  ];
  for (const [finalAnswerLatex, stepMath, problem] of validCases) {
    const report = evaluateSolutionQualityRules({
      title: "Compact fraction",
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: stepMath, summary: "State the result." }],
    }, { problem });
    assert.deepEqual(report.issues, [], finalAnswerLatex);
  }

  for (const finalAnswerLatex of ["\\frac", "\\frac1", "\\frac{}{}", "\\frac{}{2}", "\\frac{1}{}"]) {
    const report = evaluateSolutionQualityRules({
      title: "Malformed compact fraction",
      expression: "Evaluate I.",
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: `I=${finalAnswerLatex}`, summary: "Malformed final answer." }],
    }, { problem: "Evaluate I." });
    assert.notDeepEqual(report.issues, [], finalAnswerLatex);
    assert.equal(report.issues.includes("strict_generated_latex") || report.issues.includes("missing_final_answer"), true, finalAnswerLatex);
  }
});

test("invalid final answers still trigger missing_final_answer with structured evidence", () => {
  for (const finalAnswerLatex of ["", "   ", "=", "-", "\\frac", "\\dfrac{1}{}", "done"]) {
    const report = evaluateSolutionQualityRules({
      title: "Missing final",
      expression: "Evaluate I.",
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: finalAnswerLatex, summary: "Invalid final answer." }],
    }, { problem: "Evaluate I." });
    assert.equal(report.issues.includes("missing_final_answer"), true, finalAnswerLatex);
    const missingRule = report.evaluations.find((rule) => rule.name === "missing_final_answer");
    assert.match(String(missingRule.failureEvidence), /rawFinalAnswer|detectionReason/);
  }
});

test("set-valued answers are symbolic answer sets, not malformed scalar numerics", () => {
  const cases = [
    ["x=2,3", "Solve for x."],
    ["x\\in\\{2,3\\}", "Solve for x."],
    ["x=2\\text{ or }x=3", "Solve for x.", false],
    ["\\{2,3\\}", "Solve for x."],
    ["x=\\pm2", "Solve for x."],
    ["(x,y)=(1,2)", "Solve for x and y."],
    ["eigenvalues: 2,3", "Find the eigenvalues."],
    ["[1,2]", "Give the interval answer."],
    ["(-\\infty,1]\\cup[2,\\infty)", "Give the interval answer.", false],
  ];
  for (const [finalAnswerLatex, problem, expectNoIssues = true] of cases) {
    const report = evaluateSolutionQualityRules({
      title: "Set valued answer",
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: finalAnswerLatex, summary: "State all values." }],
    }, { problem });
    if (expectNoIssues) assert.deepEqual(report.issues, [], finalAnswerLatex);
    assert.equal(report.issues.includes("unsupported_numeric_final_answer_syntax"), false, finalAnswerLatex);
    assert.equal(report.context.numericFinalAnswerAnalysis.status, "symbolic", finalAnswerLatex);
    assert.equal(report.context.numericFinalAnswerAnalysis.setValued, true, finalAnswerLatex);
    assert.equal(report.context.numericalCrossCheckResult.proposedValue, null, finalAnswerLatex);
  }
});

test("malformed set-valued final answers are rejected structurally", () => {
  const cases = [
    ["x=2,,3", "repeated_separator", "Solve for x."],
    ["x=,2", "repeated_separator", "Solve for x."],
    ["x=2,", "repeated_separator", "Solve for x."],
    ["x=\\pm", "missing_plus_minus_operand", "Solve for x."],
    ["\\{,\\}", "repeated_separator", "Solve for x."],
    ["\\{1,,2\\}", "repeated_separator", "Solve for x."],
    ["\\{1,2", "unbalanced_delimiter", "Solve for x."],
    ["1,2\\}", "unbalanced_delimiter", "Solve for x."],
    ["(x,y)=()", "empty_tuple", "Solve for x and y."],
    ["(x,y)=(1,)", "repeated_separator", "Solve for x and y."],
    ["(x,y)=(,2)", "repeated_separator", "Solve for x and y."],
    ["(x,y)=(1,2,3)", "arity_mismatch", "Solve for x and y."],
  ];
  for (const [finalAnswerLatex, reason, problem] of cases) {
    const report = evaluateSolutionQualityRules({
      title: "Malformed set answer",
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: finalAnswerLatex, summary: "Malformed set-valued answer." }],
    }, { problem });
    assert.equal(report.issues.includes("malformed_set_valued_answer"), true, finalAnswerLatex);
    const rule = report.evaluations.find((item) => item.name === "malformed_set_valued_answer");
    assert.match(String(rule.failureEvidence), new RegExp(reason), finalAnswerLatex);
  }
});

test("unambiguous solve targets reject unrelated generated assignment targets", () => {
  const passCases = [
    ["x=2", "Solve for x."],
    ["2", "Solve for x."],
    ["x=2,3", "Solve for x."],
    ["(x,y)=(1,2)", "Solve for x and y."],
    ["f'(x)=0", "Find critical points of f."],
    ["\\det(A)=-2", "Compute \\det(A)."],
    ["\\lim_{x\\to0}f(x)=1", "Compute \\lim_{x\\to0}f(x)."],
  ];
  for (const [finalAnswerLatex, problem] of passCases) {
    const report = evaluateSolutionQualityRules({
      title: "Target match",
      expression: problem,
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: finalAnswerLatex, summary: "State the result." }],
    }, { problem });
    assert.equal(report.issues.includes("answer_target_mismatch"), false, finalAnswerLatex);
  }

  for (const finalAnswerLatex of ["d=2", "y=2"]) {
    const report = evaluateSolutionQualityRules({
      title: "Target mismatch",
      expression: "Solve for x.",
      finalAnswerLatex,
      steps: [{ id: "s1", label: "Final Answer", math: finalAnswerLatex, summary: "State the wrong target." }],
    }, { problem: "Solve for x." });
    assert.equal(report.issues.includes("answer_target_mismatch"), true, finalAnswerLatex);
    const rule = report.evaluations.find((item) => item.name === "answer_target_mismatch");
    assert.match(String(rule.failureEvidence), /expectedTargets/);
    assert.match(String(rule.failureEvidence), /generatedTargets/);
  }
});

test("mathematical validation resource limits are explicit and bounded", () => {
  const normal = evaluateSolutionQualityRules({
    title: "Normal 12 step",
    expression: "Evaluate I.",
    finalAnswerLatex: "12",
    steps: Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      label: `Step ${index}`,
      math: index === 11 ? "I=12" : `A_{${index}}=${index}`,
      summary: "Small step.",
    })),
  }, { problem: "Evaluate I." });
  assert.equal(normal.issues.includes("validation_resource_limit_reached"), false);

  const manySteps = evaluateSolutionQualityRules({
    title: "Too many steps",
    expression: "Evaluate I.",
    finalAnswerLatex: "1",
    steps: Array.from({ length: 200 }, (_, index) => ({
      id: `s${index}`,
      label: `Step ${index}`,
      math: index === 199 ? "I=1" : `A_${index}=${index}`,
      summary: "Synthetic.",
    })),
  }, { problem: "Evaluate I." });
  assert.equal(manySteps.issues.includes("validation_resource_limit_reached"), true);
  assert.equal(manySteps.context.resourceLimitResults.some((item) => item.limitType === "solution_steps"), true);

  const longStep = evaluateSolutionQualityRules({
    title: "Long step",
    expression: "Evaluate I.",
    finalAnswerLatex: "1",
    steps: [{ id: "s1", label: "Huge", math: `I=1+${"x".repeat(5000)}`, summary: "Huge step." }],
  }, { problem: "Evaluate I." });
  assert.equal(longStep.context.resourceLimitResults.some((item) => item.limitType === "step_characters"), true);

  let nested = "1";
  for (let index = 0; index < 700; index += 1) nested += "+1";
  const deep = evaluateSolutionQualityRules({
    title: "Parser limit",
    expression: "Evaluate I.",
    finalAnswerLatex: nested,
    steps: [{ id: "s1", label: "Final", math: `I=${nested}`, summary: "Deep expression." }],
  }, { problem: "Evaluate I." });
  assert.equal(deep.issues.includes("validation_resource_limit_reached"), true);
  assert.equal(deep.issues.includes("numerical_final_answer_mismatch"), false);

  const excessiveIdentities = Array.from({ length: 20 }, (_, index) => ({
    id: `a${index}`,
    label: "Antiderivative",
    math: `\\int x\\,dx=\\frac{x^2}{2}+C`,
    summary: "Claim an antiderivative.",
  }));
  const identityReport = evaluateSolutionQualityRules({
    title: "Many identities",
    expression: "\\int x\\,dx",
    finalAnswerLatex: "\\frac{x^2}{2}+C",
    steps: excessiveIdentities,
  }, { problem: "\\int x\\,dx" });
  assert.equal(identityReport.context.resourceLimitResults.some((item) => item.limitType === "identity_checks"), true);

  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => (calls++ === 0 ? 0 : 10000);
  try {
    const timeoutReport = evaluateSolutionQualityRules({
      title: "Clock guard",
      expression: "Evaluate I.",
      finalAnswerLatex: "1",
      steps: [{ id: "s1", label: "Final", math: "I=1", summary: "Small step." }],
    }, { problem: "Evaluate I." });
    assert.equal(timeoutReport.context.resourceLimitResults.some((item) => item.limitType === "validation_wall_clock_ms"), true);
  } finally {
    Date.now = originalNow;
  }

  const wrongAndLarge = evaluateSolutionQualityRules({
    title: "Wrong and large",
    expression: regressionIntegralLatex,
    finalAnswerLatex: "\\frac{\\pi^3}{12}",
    steps: Array.from({ length: 200 }, (_, index) => ({
      id: `s${index}`,
      label: "Work",
      math: index === 199 ? "I=\\frac{\\pi^3}{12}" : `A_${index}=${index}`,
      summary: "Synthetic.",
    })),
  }, { problem: regressionIntegralProblem });
  assert.equal(wrongAndLarge.issues.includes("validation_resource_limit_reached"), true);
  assert.equal(wrongAndLarge.issues.includes("numerical_final_answer_mismatch"), true);
});
