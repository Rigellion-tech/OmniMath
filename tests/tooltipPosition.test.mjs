import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTooltipPositionFromRect } from "../src/lib/tooltipPosition.js";

const viewport = { width: 1000, height: 700 };
const size = { width: 260, height: 120 };

describe("tooltipPosition", () => {
  it("places the tooltip beside the hovered token bounding box", () => {
    const rect = { left: 100, right: 140, top: 200, bottom: 224, width: 40, height: 24 };
    const position = getTooltipPositionFromRect(rect, { size, viewport });

    assert.equal(position.x, rect.right + 10);
    assert.equal(position.y, rect.top);
  });

  it("uses the current token rect after scrolling instead of stale coordinates", () => {
    const staleRect = { left: 100, right: 140, top: 500, bottom: 524, width: 40, height: 24 };
    const scrolledRect = { left: 100, right: 140, top: 120, bottom: 144, width: 40, height: 24 };
    const stalePosition = getTooltipPositionFromRect(staleRect, { size, viewport });
    const scrolledPosition = getTooltipPositionFromRect(scrolledRect, { size, viewport });

    assert.equal(scrolledPosition.x, scrolledRect.right + 10);
    assert.equal(scrolledPosition.y, scrolledRect.top);
    assert.notEqual(scrolledPosition.y, stalePosition.y);
  });

  it("flips and clamps when the token is near a viewport edge", () => {
    const rect = { left: 940, right: 980, top: 640, bottom: 664, width: 40, height: 24 };
    const position = getTooltipPositionFromRect(rect, { size, viewport });

    assert.equal(position.x, rect.left - 10 - size.width);
    assert.ok(position.y <= viewport.height - size.height - 12);
    assert.ok(position.y >= 12);
  });
});
