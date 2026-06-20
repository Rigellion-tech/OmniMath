import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseSemanticHit } from "../src/lib/semanticHitboxes.js";

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("semanticHitboxes", () => {
  it("prefers the deepest semantic node containing the point", () => {
    const parent = { id: "parent", depth: 1, rects: [rect(0, 0, 100, 40)] };
    const child = { id: "child", depth: 3, rects: [rect(10, 5, 80, 25)] };

    assert.equal(chooseSemanticHit([parent, child], 20, 10, parent).id, "child");
  });

  it("uses smallest visual area as a tie-break at the same depth", () => {
    const wide = { id: "wide", depth: 2, rects: [rect(0, 0, 100, 40)] };
    const tight = { id: "tight", depth: 2, rects: [rect(10, 5, 20, 10)] };

    assert.equal(chooseSemanticHit([wide, tight], 15, 8).id, "tight");
  });

  it("falls back to the parent when no semantic child contains the point", () => {
    const parent = { id: "parent", depth: 0, rects: [rect(0, 0, 100, 40)] };
    const child = { id: "child", depth: 1, rects: [rect(10, 5, 20, 10)] };

    assert.equal(chooseSemanticHit([child], 80, 30, parent).id, "parent");
  });

  it("supports multiple rects per semantic node", () => {
    const split = {
      id: "split",
      depth: 2,
      rects: [rect(0, 0, 10, 10), rect(50, 0, 10, 10)],
    };

    assert.equal(chooseSemanticHit([split], 55, 5).id, "split");
  });

  it("handles unsupported or unsafe measurement with parent fallback", () => {
    const parent = { id: "flat-parent", depth: 0, rects: [rect(0, 0, 100, 40)] };

    assert.equal(chooseSemanticHit([], 12, 12, parent).id, "flat-parent");
  });
});
