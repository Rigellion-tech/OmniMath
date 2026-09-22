import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getMathTextRenderParts,
  normalizeDisplayTextSegment,
} from "../src/lib/mathTextSegments.js";

function readable(parts) {
  return parts.map((part) => (part.type === "math" ? part.value : part.value)).join("");
}

describe("math text render segments", () => {
  it("keeps dense variational prompt prose readable while isolating its math", () => {
    const source = "For J[u]=∫_Ω(1/2|∇u|²+α/6|∇u|⁶+β/2 u²−λ/q|u|^q)dx, α,β,λ>0, 2<q<4, u|∂Ω=0: derive the Euler-Lagrange PDE, linearize it at a critical point u*, compute J''[u*](v,v), and give the lowest-eigenvalue/Rayleigh-quotient condition for u* to be a strict local minimum. Show the nonlinear gradient-term linearization explicitly.";
    const parts = getMathTextRenderParts(source);
    const math = parts.filter((part) => part.type === "math").map((part) => part.value);

    assert.equal(math.some((value) => /Euler|Lagrange|lowest|eigenvalue|Rayleigh|quotient|gradient|term/u.test(value)), false);
    assert.equal(math.some((value) => value.includes("J''[u*](v,v)")), true);
    assert.equal(math.some((value) => value === "u*"), true);
    assert.equal(math[0].includes("\\nabla u"), true);
    assert.equal(math[0].includes("\\nablau"), false);
    assert.match(readable(parts), /derive the Euler-Lagrange PDE, linearize it at a critical point u\*, compute J''\[u\*\]\(v,v\), and give the lowest-eigenvalue\/Rayleigh-quotient condition/u);
    assert.match(readable(parts), /Show the nonlinear gradient-term linearization explicitly\.$/u);
  });

  it("preserves spaces around word + inline math + word", () => {
    const parts = getMathTextRenderParts("The term $c$ is the constant.");

    assert.equal(readable(parts), "The term c is the constant.");
    assert.deepEqual(parts.map((part) => part.type), ["text", "math", "text"]);
    assert.equal(parts[0].value.endsWith(" "), true);
    assert.equal(parts[2].value.startsWith(" "), true);
  });

  it("keeps punctuation tight after inline math", () => {
    assert.equal(
      readable(getMathTextRenderParts("The value $-29$.")),
      "The value -29."
    );
  });

  it("inserts one safety space when explicit math touches prose", () => {
    assert.equal(
      readable(getMathTextRenderParts("quadratic equation$ax^2 + bx + c = 0$")),
      "quadratic equation ax^2 + bx + c = 0"
    );
    assert.equal(
      readable(getMathTextRenderParts("The term$-29$is used.")),
      "The term -29 is used."
    );
  });

  it("preserves emphasized prose adjacent to inline math", () => {
    assert.equal(
      readable(getMathTextRenderParts("The **term** $c$ in the expression")),
      "The **term** c in the expression"
    );
  });

  it("keeps normal paragraphs without math readable", () => {
    assert.equal(
      readable(getMathTextRenderParts("No inline math appears in this paragraph.")),
      "No inline math appears in this paragraph."
    );
    assert.equal(normalizeDisplayTextSegment(" leading and trailing "), " leading and trailing ");
  });

  it("does not glue auto-detected unicode math to surrounding words", () => {
    assert.equal(
      readable(getMathTextRenderParts("used in the discriminant calculation b\u00b2 \u2212 4ac")),
      "used in the discriminant calculation b^2 - 4ac"
    );
  });

  it("does not convert the prose word delta into a Greek math symbol", () => {
    const parts = getMathTextRenderParts("The delta between both values is small.");

    assert.deepEqual(parts.map((part) => part.type), ["text"]);
    assert.equal(readable(parts), "The delta between both values is small.");
  });

  it("preserves explicit math contents instead of treating them as OCR text", () => {
    const parts = getMathTextRenderParts("Use $delta$ as the perturbation.");

    assert.deepEqual(parts.map((part) => part.type), ["text", "math", "text"]);
    assert.equal(parts[1].value, "delta");
    assert.equal(readable(parts), "Use delta as the perturbation.");
  });

  it("keeps OCR normalization on unescaped auto-detected math runs", () => {
    const parts = getMathTextRenderParts("Use delta=1 and pi/2.");
    const math = parts.filter((part) => part.type === "math").map((part) => part.value);

    assert.deepEqual(math, ["\\delta=1", "\\pi/2"]);
  });
});
