import assert from "node:assert/strict";
import test from "node:test";
import { createLocalRuleExplanation } from "../server/localRules.js";
import { validateSolutionQuality } from "../server/solutionValidation.js";

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
