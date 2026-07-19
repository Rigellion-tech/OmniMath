import assert from "node:assert/strict";
import test from "node:test";
import { buildRepairSolvePrompt } from "../server/app.js";

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
