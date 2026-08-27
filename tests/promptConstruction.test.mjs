import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMathExplanationPrompt } from "../server/mathPrompt.js";

const CONFIRMED_OCR_PROBLEM = "\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS,\\quad \\mathbf{F}(x,y,z)=\\langle y^2z+e^{x^2}\\sin(yz),x^3+\\ln(1+z^2),xye^{-z^2}\\rangle";

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

describe("math prompt construction", () => {
  it("keeps a confirmed OCR solve problem in the solver prompt once", () => {
    const prompt = buildMathExplanationPrompt({ problem: CONFIRMED_OCR_PROBLEM });

    assert.equal(prompt.includes("Previous conversation:"), false);
    assert.equal(prompt.includes("Confirmed image extraction text"), false);
    assert.equal(countOccurrences(prompt, CONFIRMED_OCR_PROBLEM), 1);
    assert.match(prompt, /Student problem:/);
  });

  it("asks for conceptual solution steps instead of mechanical problem restatements", () => {
    const prompt = buildMathExplanationPrompt({ problem: CONFIRMED_OCR_PROBLEM });

    assert.match(prompt, /Each step must correspond to a mathematical transformation or theorem application/);
    assert.match(prompt, /Avoid separate steps for substituting a boundary value/);
    assert.match(prompt, /Do not use the first step to restate problemLatex/);
    assert.doesNotMatch(prompt, /first step's latex must exactly match problemLatex/i);
    assert.match(prompt, /Simplify displayed equations before returning them/);
  });

  it("moves mathematical quality responsibility into generation", () => {
    const prompt = buildMathExplanationPrompt({ problem: "x^2 + 88x + 1936 = 0" });

    assert.match(prompt, /each displayed steps\[\]\.latex must be a direct algebraic transformation/i);
    assert.match(prompt, /Explanatory facts and identity checks belong in steps\[\]\.reasoning/i);
    assert.match(prompt, /Solve the mathematics carefully before writing the response/);
    assert.match(prompt, /Introduce every new symbol before or at first use/);
    assert.match(prompt, /Use special functions only when genuinely useful/);
    assert.match(prompt, /every displayed equation must follow from the preceding step/);
    assert.match(prompt, /check the final answer against the derivation/i);
    assert.match(prompt, /Do not display identity-conversion steps/);
  });

  it("keeps typed exponent equations as the exact solver problem", () => {
    const problem = "3x^2 + 5x - 7 = 0";
    const prompt = buildMathExplanationPrompt({ problem });

    assert.equal(countOccurrences(prompt, problem), 1);
    assert.match(prompt, /Student problem: "3x\^2 \+ 5x - 7 = 0"\./);
    assert.doesNotMatch(prompt, /x\^n|power rule says|d\/dx x\^n/i);
  });

  it("defines a strict standalone contract for finalAnswerLatex", () => {
    const prompt = buildMathExplanationPrompt({ problem: "\\int_0^\\infty f(x)\\,dx" });

    assert.match(prompt, /Standalone-final-expression contract for finalAnswerLatex/);
    assert.match(prompt, /exactly one standalone mathematical expression/);
    assert.match(prompt, /one equation assigning the original expression to that value/);
    assert.match(prompt, /no prose, explanation, intermediate derivation, \\Rightarrow, multiline content/);
    assert.match(prompt, /Valid shape: A/);
    assert.match(prompt, /Valid shape: E=A/);
    assert.match(prompt, /Invalid shape: E_1=\\cdots \\\\ \\Rightarrow E=A/);
    assert.match(prompt, /Invalid shape: Therefore the answer is A/);
    assert.match(prompt, /Invalid: A=B,\\quad C=D/);
    assert.match(prompt, /compact responses, the last step's latex is treated as finalAnswerLatex/i);
  });
});
