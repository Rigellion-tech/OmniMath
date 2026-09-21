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

  it("preserves complete TeX environments through equation-chain preparation", () => {
    const expressions = [
      String.raw`\begin{aligned}A&=B \quad C+D&=E\\F&=G\end{aligned}`,
      String.raw`\begin{gathered}A=B\\C+D=E\end{gathered}`,
      String.raw`\begin{cases}x+y=1\\x-y=0\end{cases}`,
      String.raw`\begin{array}{cc}a=b&c+d=e\\f=g&h=i\end{array}`,
      String.raw`M=\begin{bmatrix}a=b&c+d\\e&f=g\end{bmatrix}`,
      String.raw`\begin{aligned}-\operatorname{div}((1+\alpha|\nabla u|^2)\nabla u)+\beta u-\lambda|u|^{p-2}u&=0\\u|_{\partial\Omega}&=0\end{aligned}`,
    ];

    for (const source of expressions) {
      assert.deepEqual(splitEquationChainLatex(source), [source]);
      assert.doesNotThrow(() => katex.renderToString(source, {
        throwOnError: true,
        strict: "ignore",
        displayMode: true,
      }));
    }
  });

  it("still splits a top-level equation chain around an embedded matrix", () => {
    const first = String.raw`x=\begin{bmatrix}a=b&c+d\\e&f=g\end{bmatrix}`;
    const second = "y+1=2";
    assert.deepEqual(splitEquationChainLatex(`${first} ${second}`), [first, second]);
  });
});
