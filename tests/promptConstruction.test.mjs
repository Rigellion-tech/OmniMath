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

    assert.match(prompt, /Each step must correspond to a mathematical idea/);
    assert.match(prompt, /Avoid separate steps for substituting z=0/);
    assert.match(prompt, /Do not use the first step to restate problemLatex/);
    assert.doesNotMatch(prompt, /first step's latex must exactly match problemLatex/i);
    assert.match(prompt, /Simplify displayed equations before returning them/);
  });
});
