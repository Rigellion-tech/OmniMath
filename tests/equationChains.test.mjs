import assert from "node:assert/strict";
import { describe, it } from "node:test";
import katex from "katex";
import { splitEquationChainLatex } from "../src/lib/equationChains.js";

describe("equation chain layout helpers", () => {
  it("splits glued transformation states into separate equation segments", () => {
    const segments = splitEquationChainLatex(
      "3x^2 + 5x + 6 = 45 3x^2 + 5x + 6 - 45 = 0 3x^2 + 5x - 39 = 0"
    );

    assert.deepEqual(segments, [
      "3x^2 + 5x + 6 = 45",
      "3x^2 + 5x + 6 - 45 = 0",
      "3x^2 + 5x - 39 = 0",
    ]);
  });

  it("splits accidentally concatenated adjacent equations without whitespace", () => {
    assert.deepEqual(splitEquationChainLatex("x+35=0x=-35"), [
      "x+35=0",
      "x=-35",
    ]);
  });

  it("does not split ordinary equality chains with a coefficient term", () => {
    assert.deepEqual(splitEquationChainLatex("y=0x+1=1"), [
      "y=0x+1=1",
    ]);
  });

  it("keeps spaced evaluation delimiters intact instead of producing arrow-only render fragments", () => {
    const bracketEvaluation = "I = \\left[ \\frac{t^2}{2} \\right]_0^1 = \\frac12";
    const barEvaluation = "I = \\left. \\frac{t^2}{2} \\right|_0^1 = \\frac12";

    for (const source of [bracketEvaluation, barEvaluation]) {
      const segments = splitEquationChainLatex(source);
      assert.deepEqual(segments, [source]);
      assert.doesNotThrow(() => katex.renderToString(segments[0], {
        throwOnError: true,
        strict: "ignore",
      }));
    }
  });

  it("leaves normal single equations untouched", () => {
    assert.deepEqual(splitEquationChainLatex("x=\\frac{-5\\pm\\sqrt{493}}{6}"), [
      "x=\\frac{-5\\pm\\sqrt{493}}{6}",
    ]);
  });
});
