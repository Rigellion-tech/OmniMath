import assert from "node:assert/strict";
import test from "node:test";
import { buildRepairSolvePrompt, categorizeRepairIssues } from "../server/app.js";

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
  const prompt = buildRepairSolvePrompt("Original solve prompt", ["unsupported_integration_by_parts_setup"], {
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

  assert.match(prompt, /Quality repair context/);
  assert.match(prompt, /Original problem:/);
  assert.match(prompt, /Previous invalid solution:/);
  assert.match(prompt, /Failed validation rules:/);
  assert.match(prompt, /Exact failure evidence:/);
  assert.match(prompt, /unsupported_integration_by_parts_setup/);
  assert.match(prompt, /u=\\theta and dv=\\cot\\theta\\ln\(\\cos\\theta\)\\,d\\theta/);
  assert.match(prompt, /explicitly provide u, dv, du, a correct explicit v, and the substituted integration-by-parts equation/);
  assert.match(prompt, /Verify v by differentiating it/);
  assert.match(prompt, /Do not leave v as an unevaluated integral/);
  assert.match(prompt, /If dv has no usable closed form, abandon that integration-by-parts choice/);
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
          failureEvidence: "estimate=0.5; proposed=2",
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
  assert.match(prompt, /estimate=0\.5; proposed=2/);
  assert.match(prompt, /derivative does not match integrand/);
  assert.match(prompt, /Rebuild the derivation from the earliest suspect step/);
  assert.match(prompt, /do not change only finalAnswerLatex/);
  assert.match(prompt, /Do not preserve the invalid antiderivative or identity/);
  assert.match(prompt, /rebuild the derivation from the earliest failing step/i);
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
  assert.doesNotMatch(prompt, /Quality repair context/);
  assert.doesNotMatch(prompt, /Reconstruct the solution from scratch/);
  assert.doesNotMatch(prompt, /Assume the previous derivation is mathematically unreliable/);
});

test("unexplained generated symbols receive binding-specific structural repair guidance", () => {
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
  assert.doesNotMatch(prompt, /Reconstruct the solution from scratch/);
});
