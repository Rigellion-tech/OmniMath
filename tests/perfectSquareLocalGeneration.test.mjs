import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalRuleExplanation } from "../server/localRules.js";

function stepMath(result) {
  return result.steps.map((step) => step.math);
}

describe("perfect-square quadratic generation", () => {
  it("generates a natural transformation chain for x^2 + 88x + 1936 = 0", () => {
    const result = createLocalRuleExplanation("x^2 + 88x + 1936 = 0");

    assert.deepEqual(stepMath(result), [
      "x^2+88x+1936=0",
      "(x+44)^2=0",
      "x+44=0",
      "x=-44",
    ]);
    assert.equal(result.finalAnswerLatex, "x=-44");
    assert.doesNotMatch(stepMath(result).join("\n"), /1936=44\^2|44\^2=1936|2\\cdot44=88|x\^2\+88x\+44\^2=\(x\+44\)\^2/);
    assert.match(result.steps[1].summary, /1936=44\^2/);
  });

  it("generates a natural transformation chain for x^2 + 70x + 1225 = 0", () => {
    const result = createLocalRuleExplanation("x^2 + 70x + 1225 = 0");

    assert.deepEqual(stepMath(result), [
      "x^2+70x+1225=0",
      "(x+35)^2=0",
      "x+35=0",
      "x=-35",
    ]);
    assert.equal(result.finalAnswerLatex, "x=-35");
    assert.doesNotMatch(stepMath(result).join("\n"), /1225=35\^2|35\^2=1225|2\\cdot35=70/);
  });

  it("generates the repeated positive root for x^2 - 10x + 25 = 0", () => {
    const result = createLocalRuleExplanation("x^2 - 10x + 25 = 0");

    assert.deepEqual(stepMath(result), [
      "x^2-10x+25=0",
      "(x-5)^2=0",
      "x-5=0",
      "x=5",
    ]);
    assert.equal(result.finalAnswerLatex, "x=5");
    assert.doesNotMatch(stepMath(result).join("\n"), /\\pm|±/);
  });
});
