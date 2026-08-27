import assert from "node:assert/strict";
import test from "node:test";
import { buildFreshEscalationSolvePrompt, buildRepairSolvePrompt, categorizeRepairIssues } from "../server/app.js";

function qualityError({ rule = "unsupported_integration_by_parts_setup", evidence = "" } = {}) {
  return {
    solutionIssues: [rule],
    solutionRuleEvaluations: [{
      validatorName: rule,
      name: rule,
      issue: rule,
      result: "fail",
      failureEvidence: evidence,
    }],
  };
}

test("unsupported integration-by-parts repair prompt includes targeted guidance and evidence", () => {
  const originalPrompt = "Original solve prompt with Stokes theorem, Green theorem, paraboloid, ellipse, and perfect-square examples.";
  const prompt = buildRepairSolvePrompt(originalPrompt, ["unsupported_integration_by_parts_setup"], {
    problem: "Evaluate the integral.",
    previousResult: {
      finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
      steps: [{
        label: "Use integration by parts",
        math: "u=\\theta,\\quad dv=\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
        summary: "Invalid setup.",
      }],
    },
    error: qualityError({
      evidence: "u=\\theta and dv=\\cot\\theta\\ln(\\cos\\theta)\\,d\\theta",
    }),
  });

  assert.match(prompt, /Repair task/);
  assert.match(prompt, /Canonical problem:/);
  assert.match(prompt, /Previous invalid solution:/);
  assert.match(prompt, /Failed validation rules:/);
  assert.match(prompt, /Exact failure evidence:/);
  assert.match(prompt, /unsupported_integration_by_parts_setup/);
  assert.match(prompt, /u=\\theta and dv=\\cot\\theta\\ln\(\\cos\\theta\)\\,d\\theta/);
  assert.match(prompt, /explicitly provide u, dv, du, a correct explicit v, and the substituted integration-by-parts equation/);
  assert.match(prompt, /Verify v by differentiating it/);
  assert.match(prompt, /Do not leave v as an unevaluated integral/);
  assert.match(prompt, /If dv has no usable closed form, abandon that integration-by-parts choice/);
  assert.match(prompt, /Do NOT preserve the previous derivation/);
  assert.match(prompt, /Assume the previous derivation is mathematically unreliable/);
  assert.match(prompt, /Reconstruct the solution from scratch/);
  assert.match(prompt, /avoid integration by parts unless every part is fully justified/);
  assert.match(prompt, /Do not repeat the previous method/);
  assert.doesNotMatch(prompt, /Original solve prompt/);
  assert.doesNotMatch(prompt, /Stokes theorem|Green theorem|paraboloid|ellipse|perfect-square/i);
});

test("fresh escalation prompt avoids full contaminated derivation", () => {
  const prompt = buildFreshEscalationSolvePrompt({
    problem: "\\int_0^\\infty f(x)\\,dx",
    canonicalLatex: "\\int_0^\\infty f(x)\\,dx",
    canonicalText: "Evaluate the improper integral.",
    issues: ["numerical_final_answer_mismatch"],
    previousResult: {
      finalAnswerLatex: "\\frac{\\pi}{2}G",
      steps: Array.from({ length: 6 }, (_, index) => ({
        latex: `bad_step_${index}=G`,
        reasoning: "Contaminated derivation text that should not be copied wholesale.",
      })),
    },
    error: {
      solutionIssues: ["numerical_final_answer_mismatch"],
      solutionValidationContext: {
        firstFailingStepId: "s7",
        relevantStepLatex: "I\\approx 0",
        numericalCrossCheckResult: {
          numericalEstimate: 0.7546930417050932,
          proposedValue: 0,
          absoluteDifference: 0.7546930417050932,
          tolerance: 0.0003018772166820373,
        },
      },
      solutionRuleEvaluations: [{
        issue: "numerical_final_answer_mismatch",
        result: "fail",
        failureEvidence: "estimate=0.7546930417050932 proposed=0",
      }],
    },
    priorFailures: [{
      stage: "initial",
      result: {
        finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
        steps: [{ latex: "earlier_bad_series", reasoning: "Do not copy this derivation." }],
      },
      error: qualityError({
        rule: "unverified_critical_identity",
        evidence: "parameter family did not reproduce the target integrand",
      }),
    }],
  });

  assert.match(prompt, /Fresh escalation task/);
  assert.match(prompt, /Solve the canonical original problem from scratch/);
  assert.match(prompt, /validation constraint, not as a derivation/);
  assert.match(prompt, /Independently verify the final result numerically against the canonical original problem/);
  assert.match(prompt, /numerical_final_answer_mismatch/);
  assert.match(prompt, /0\.7546930417050932/);
  assert.match(prompt, /Previous final answer to avoid repeating without proof: \\frac\{\\pi\}\{2\}G/);
  assert.match(prompt, /Earlier rejected candidate findings:/);
  assert.match(prompt, /initial:/);
  assert.match(prompt, /unverified_critical_identity/);
  assert.match(prompt, /Previous final answer to avoid repeating without proof: \\frac\{\\pi\}\{2\}\\ln\^2 2/);
  assert.doesNotMatch(prompt, /bad_step_0/);
  assert.doesNotMatch(prompt, /bad_step_5/);
  assert.doesNotMatch(prompt, /earlier_bad_series/);
  assert.doesNotMatch(prompt, /Previous invalid solution:/);
});

test("missing numerical evidence is never coerced into a trusted zero estimate", () => {
  const error = {
    solutionIssues: ["unsupported_final_answer_jump"],
    solutionValidationContext: {
      numericalCrossCheckResult: {
        numericalEstimate: null,
        proposedValue: null,
        absoluteDifference: null,
        tolerance: null,
      },
    },
    solutionRuleEvaluations: [{
      issue: "unsupported_final_answer_jump",
      result: "fail",
      failureEvidence: "final equality has no supported bridge",
    }],
  };
  const prompt = buildFreshEscalationSolvePrompt({
    problem: "\\int_0^\\infty f(x)\\,dx",
    canonicalLatex: "\\int_0^\\infty f(x)\\,dx",
    issues: error.solutionIssues,
    previousResult: { finalAnswerLatex: "I=G" },
    error,
  });

  assert.doesNotMatch(prompt, /independent numerical estimate:/u);
  assert.doesNotMatch(prompt, /proposed model value:/u);
  assert.doesNotMatch(prompt, /absolute difference:/u);
  assert.doesNotMatch(prompt, /allowed tolerance:/u);
  assert.match(prompt, /No detailed validator findings|Validator evidence:/u);
});

test("repair prompt caps and sanitizes failure evidence", () => {
  const longEvidence = `u=x\u0000 ${"dv=e^x dx ".repeat(200)}`;
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["unsupported_integration_by_parts_setup"], {
    problem: "Problem",
    previousResult: {},
    error: qualityError({ evidence: longEvidence }),
  });

  assert.doesNotMatch(prompt, /\u0000/);
  assert.match(prompt, /Exact failure evidence:/);
  assert.ok(prompt.length < 10000);
});

test("repair prompts remove raw and JSON-escaped ANSI sequences", () => {
  const latex = "\\int_0^\\infty f(x)\\,dx";
  const prompt = buildRepairSolvePrompt("unused", ["numerical_final_answer_mismatch"], {
    problem: `\u001b[1m${latex}\u001b[0m`,
    previousResult: {
      problemLatex: `\u001b[1m${latex}\u001b[0m`,
      finalAnswerLatex: "1",
      steps: [],
    },
    error: qualityError({ rule: "numerical_final_answer_mismatch" }),
  });

  assert.match(prompt, new RegExp(latex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(prompt, /\u001b|\\u001b|\x1b|\\x1b|\[[01]m/iu);
  assert.doesNotMatch(prompt, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
});

test("unrelated repair rules do not include integration-by-parts-specific guidance", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["incorrect_simple_power_equation_final"], {
    problem: "x+35^2=0",
    previousResult: {},
    error: qualityError({
      rule: "incorrect_simple_power_equation_final",
      evidence: "expected x=-1225",
    }),
  });

  assert.match(prompt, /incorrect_simple_power_equation_final/);
  assert.doesNotMatch(prompt, /integration-by-parts equation/);
  assert.doesNotMatch(prompt, /Verify v by differentiating/);
});

test("mathematical validation failures receive exact restart-and-verify repair guidance", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["numerical_final_answer_mismatch", "invalid_antiderivative"], {
    problem: "\\int_0^1 x\\,dx",
    previousResult: {
      finalAnswerLatex: "2",
      steps: [{ label: "Evaluate", math: "I=2", summary: "Incorrect value." }],
    },
    error: {
      solutionIssues: ["numerical_final_answer_mismatch", "invalid_antiderivative"],
      solutionRuleEvaluations: [
        {
          validatorName: "numerical_final_answer_cross_check",
          name: "numerical_final_answer_cross_check",
          issue: "numerical_final_answer_mismatch",
          result: "fail",
          failureEvidence: "estimate=0.5; proposed=2; absDiff=1.5; tolerance=0.0001",
        },
        {
          validatorName: "critical_identity_verification",
          name: "critical_identity_verification",
          issue: "invalid_antiderivative",
          result: "fail",
          failureEvidence: "s1: derivative does not match integrand",
        },
      ],
    },
  });

  assert.match(prompt, /numerical_final_answer_mismatch/);
  assert.match(prompt, /invalid_antiderivative/);
  assert.match(prompt, /estimate=0\.5; proposed=2; absDiff=1\.5; tolerance=0\.0001/);
  assert.match(prompt, /The previous final answer is numerically inconsistent/);
  assert.match(prompt, /independent numerical estimate: 0\.5/);
  assert.match(prompt, /proposed model value: 2/);
  assert.match(prompt, /absolute difference: 1\.5/);
  assert.match(prompt, /allowed tolerance: 0\.0001/);
  assert.match(prompt, /derivative does not match integrand/);
  assert.match(prompt, /Rebuild the derivation from the earliest suspect step/);
  assert.match(prompt, /do not change only finalAnswerLatex/);
  assert.match(prompt, /Do not preserve the invalid antiderivative or identity/);
  assert.match(prompt, /Reconstruct the solution from scratch/);
  assert.match(prompt, /Verify substitutions, derivatives, signs, and special-function simplifications/);
  assert.match(prompt, /Keep finalAnswerLatex structurally valid/);
});

test("repair issue categorization routes structural-only failures narrowly", () => {
  assert.equal(categorizeRepairIssues([
    "unexplained_generated_symbol:\\theta",
    "strict_generated_latex",
    "invalid_latex:finalAnswerLatex:final_answer_contains_prose",
    "undefined_final_placeholder",
  ]).category, "structural");

  assert.equal(categorizeRepairIssues([
    "unexplained_generated_symbol:\\theta",
    "numerical_final_answer_mismatch",
  ]).category, "mathematical");

  assert.equal(categorizeRepairIssues(["unknown_validator_issue"]).category, "mathematical");
});

test("undefined symbols used by the final answer trigger mathematical repair", () => {
  const issue = "unexplained_generated_symbol:G";
  const error = {
    solutionIssues: [issue],
    solutionRuleEvaluations: [{
      validatorName: "unexplained_generated_symbol",
      name: "unexplained_generated_symbol",
      issue,
      result: "fail",
      inputFields: ["result.finalAnswerLatex"],
      failureEvidence: JSON.stringify({
        symbol: "G",
        fieldPath: "finalAnswerLatex",
        sourceType: "finalAnswer",
        classification: "undefined_free_symbol",
      }),
    }],
  };

  assert.equal(categorizeRepairIssues([issue], { error }).category, "mathematical");
  const prompt = buildRepairSolvePrompt("Original solve prompt", [issue], {
    problem: "\\int_0^\\infty f(x)\\,dx",
    previousResult: {
      finalAnswerLatex: "I=\\frac{\\pi}{2}G",
      steps: [{ label: "Known form", math: "I=\\frac{\\pi}{2}G", summary: "State an unsupported constant." }],
    },
    error,
  });

  assert.match(prompt, /Assume the previous derivation is mathematically unreliable/);
  assert.match(prompt, /Reconstruct the solution from scratch/);
  assert.doesNotMatch(prompt, /Preserve final answer/);
  assert.doesNotMatch(prompt, /Do not recompute/);
});

test("structural repair prompt preserves the previous derivation and final answer", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["unexplained_generated_symbol:\\theta"], {
    problem: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    previousResult: {
      finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
      numericCheck: "0.7546938294602481",
      steps: [{
        label: "Series identity",
        math: "-\\ln(\\cos\\theta)=\\sum_{n=1}^{\\infty}\\frac{(\\sin\\theta)^{2n}}{2n}",
        summary: "Theta needs an introduction.",
      }],
    },
    error: {
      solutionIssues: ["unexplained_generated_symbol:\\theta"],
      solutionRuleEvaluations: [{
        validatorName: "unexplained_generated_symbol",
        name: "unexplained_generated_symbol",
        issue: "unexplained_generated_symbol:\\theta",
        result: "fail",
        failureEvidence: "\\theta in steps[0].latex",
      }],
    },
  });

  assert.match(prompt, /Structural repair task:/);
  assert.match(prompt, /Preserve derivation/);
  assert.match(prompt, /Preserve mathematics/);
  assert.match(prompt, /Preserve final answer/);
  assert.match(prompt, /Only repair symbol introduction/);
  assert.match(prompt, /Only repair formatting/);
  assert.match(prompt, /Do not recompute/);
  assert.match(prompt, /Do not regenerate the proof from scratch/);
  assert.match(prompt, /\\frac\{\\pi\}\{2\}\\ln\^2 2/);
  assert.match(prompt, /0\.7546938294602481/);
  assert.match(prompt, /Undefined generated symbols detected:\n- \\theta/);
  assert.doesNotMatch(prompt, /Reconstruct the solution from scratch/);
  assert.doesNotMatch(prompt, /Assume the previous derivation is mathematically unreliable/);
});

test("unexplained generated symbols receive binding-specific repair guidance", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", [
    "unexplained_generated_symbol:\\theta",
    "unexplained_generated_symbol:B",
    "unexplained_generated_symbol:n",
    "unexplained_generated_symbol:m",
    "unexplained_generated_symbol:B",
  ], {
    problem: "\\int_0^\\infty \\frac{\\ln(1+x^2)\\arctan x}{x(1+x^2)}\\,dx",
    previousResult: {
      finalAnswerLatex: "\\frac{\\pi}{2}\\ln^2 2",
      steps: [{
        label: "Series setup",
        math: "I=B+\\theta+\\sum_n \\frac{1}{n}+\\sum_m \\frac{1}{m}",
        summary: "Uses symbols without binding them in rendered math.",
      }],
    },
    error: {
      solutionIssues: [
        "unexplained_generated_symbol:\\theta",
        "unexplained_generated_symbol:B",
        "unexplained_generated_symbol:n",
        "unexplained_generated_symbol:m",
      ],
      solutionRuleEvaluations: [
        {
          validatorName: "unexplained_generated_symbol",
          name: "unexplained_generated_symbol",
          issue: "unexplained_generated_symbol:\\theta",
          result: "fail",
          failureEvidence: "\\theta in steps[0].latex",
        },
      ],
    },
  });

  assert.match(prompt, /For unexplained_generated_symbol:/);
  assert.match(prompt, /Structural repair task:/);
  assert.match(prompt, /Preserve final answer/);
  assert.match(prompt, /Undefined generated symbols detected:/);
  assert.match(prompt, /- \\theta/);
  assert.match(prompt, /- B/);
  assert.match(prompt, /- n/);
  assert.match(prompt, /- m/);
  assert.equal((prompt.match(/- B/g) || []).length, 1);
  assert.match(prompt, /Every substitution variable must be explicitly defined in rendered LaTeX before first use/);
  assert.match(prompt, /Every named quantity or constant must be explicitly defined in rendered LaTeX before first use/);
  assert.match(prompt, /Every summation or product index must be bound in the summation\/product notation/);
  assert.match(prompt, /Every integration variable must be bound by a differential or explicitly defined/);
  assert.match(prompt, /A symbol mentioned only in prose is not considered defined/);
  assert.match(prompt, /remove it instead of inventing a definition/);
  assert.match(prompt, /Do not rename the same quantity inconsistently across steps/);
  assert.match(prompt, /Do not introduce additional symbols while repairing the listed ones/);
  assert.match(prompt, /v = g\(u\)/);
  assert.match(prompt, /K = Q/);
  assert.match(prompt, /\\sum_\{j\\in J\} a_j/);
  assert.match(prompt, /\\int_D f\(u\)\\,du/);
  assert.match(prompt, /using v before defining it/);
  assert.match(prompt, /"let K be the constant" only in prose/);
  assert.match(prompt, /using \\sum_j without a clear bound/);
  assert.match(prompt, /switching between u and v/);
  assert.match(prompt, /Return only valid JSON matching the requested schema/);
  assert.doesNotMatch(prompt, /Stokes|Green|curl|vector calculus|paraboloid|ellipse|Jacobian|perfect-square|quadratics/i);
  assert.doesNotMatch(prompt, /Reconstruct the solution from scratch/);
});

test("symbol-specific repair guidance is absent without unexplained symbol issues", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["numerical_final_answer_mismatch"], {
    problem: "\\int_0^1 x\\,dx",
    previousResult: { finalAnswerLatex: "2", steps: [] },
    error: qualityError({
      rule: "numerical_final_answer_mismatch",
      evidence: "estimate=0.5; proposed=2; absDiff=1.5; tolerance=0.0001",
    }),
  });

  assert.match(prompt, /The previous final answer is numerically inconsistent/);
  assert.doesNotMatch(prompt, /Undefined generated symbols detected/);
  assert.doesNotMatch(prompt, /A symbol mentioned only in prose is not considered defined/);
});

test("symbol repair guidance coexists with numerical mismatch guidance", () => {
  const prompt = buildRepairSolvePrompt("Original solve prompt", [
    "numerical_final_answer_mismatch",
    "unexplained_generated_symbol:B",
  ], {
    problem: "\\int_0^1 x\\,dx",
    previousResult: {
      finalAnswerLatex: "B",
      steps: [{ label: "Final", math: "I=B", summary: "B is not defined." }],
    },
    error: {
      solutionIssues: ["numerical_final_answer_mismatch", "unexplained_generated_symbol:B"],
      solutionRuleEvaluations: [
        {
          validatorName: "numerical_final_answer_cross_check",
          name: "numerical_final_answer_cross_check",
          issue: "numerical_final_answer_mismatch",
          result: "fail",
          failureEvidence: "estimate=0.5; proposed=2; absDiff=1.5; tolerance=0.0001",
        },
        {
          validatorName: "unexplained_generated_symbol",
          name: "unexplained_generated_symbol",
          issue: "unexplained_generated_symbol:B",
          result: "fail",
          failureEvidence: "B in finalAnswerLatex",
        },
      ],
    },
  });

  assert.match(prompt, /The previous final answer is numerically inconsistent/);
  assert.match(prompt, /independent numerical estimate: 0\.5/);
  assert.match(prompt, /Undefined generated symbols detected:\n- B/);
  assert.match(prompt, /Every named quantity or constant must be explicitly defined in rendered LaTeX before first use/);
  assert.match(prompt, /Return only valid JSON matching the requested schema/);
});

test("repair prompt keeps JSON contract while omitting unrelated geometry instructions", () => {
  const prompt = buildRepairSolvePrompt([
    "You are OmniMath.",
    "For Stokes/Green/curl problems, use vector calculus rules.",
    "For the paraboloid z=9-x^2-y^2 above z=0, identify the boundary.",
    "For Green's theorem on the ellipse x^2/4+y^2/9=1, use the ellipse Jacobian.",
    "For perfect-square quadratics, use the grouped square example.",
  ].join("\n"), ["abrupt_special_function_introduction:polylogarithm"], {
    problem: "\\int_0^\\infty f(x)\\,dx",
    previousResult: {
      finalAnswerLatex: "\\operatorname{Li}_3(1)",
      steps: [{ label: "Shortcut", math: "I=\\operatorname{Li}_3(1)", summary: "Unsupported shortcut." }],
    },
    error: qualityError({
      rule: "abrupt_special_function_introduction:polylogarithm",
      evidence: "abrupt_special_function_introduction:polylogarithm",
    }),
  });

  assert.match(prompt, /Return only valid JSON matching the requested schema/);
  assert.match(prompt, /Required fields: title, problemLatex, steps, finalAnswerLatex, numericCheck/);
  assert.match(prompt, /Each step must include id, heading, latex, reasoning, and anchors/);
  assert.match(prompt, /If a special function was introduced previously, do not introduce it again unless the identity is derived explicitly/);
  assert.doesNotMatch(prompt, /Stokes|Green|curl|vector calculus|paraboloid|ellipse|Jacobian|perfect-square|quadratics/i);
});
