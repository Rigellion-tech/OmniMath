import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTooltipPositionFromRect } from "../src/lib/tooltipPosition.js";

const viewport = { width: 1000, height: 700 };
const size = { width: 260, height: 120 };

function toTooltipRect(position) {
  return {
    left: position.x,
    right: position.x + size.width,
    top: position.y,
    bottom: position.y + size.height,
  };
}

function intersects(left, right) {
  return !(
    left.right <= right.left
    || left.left >= right.right
    || left.bottom <= right.top
    || left.top >= right.bottom
  );
}

function assertContained(position) {
  const tooltip = toTooltipRect(position);

  assert.ok(tooltip.left >= 12);
  assert.ok(tooltip.top >= 12);
  assert.ok(tooltip.right <= viewport.width - 12);
  assert.ok(tooltip.bottom <= viewport.height - 12);
}

describe("tooltipPosition", () => {
  it("places the tooltip beside the hovered token bounding box", () => {
    const rect = { left: 100, right: 140, top: 200, bottom: 224, width: 40, height: 24 };
    const position = getTooltipPositionFromRect(rect, { size, viewport });

    assert.equal(position.x, rect.right + 10);
    assert.equal(position.y, rect.top);
    assert.equal(intersects(toTooltipRect(position), rect), false);
    assertContained(position);
  });

  it("uses the current token rect after scrolling instead of stale coordinates", () => {
    const staleRect = { left: 100, right: 140, top: 500, bottom: 524, width: 40, height: 24 };
    const scrolledRect = { left: 100, right: 140, top: 120, bottom: 144, width: 40, height: 24 };
    const stalePosition = getTooltipPositionFromRect(staleRect, { size, viewport });
    const scrolledPosition = getTooltipPositionFromRect(scrolledRect, { size, viewport });

    assert.equal(scrolledPosition.x, scrolledRect.right + 10);
    assert.equal(scrolledPosition.y, scrolledRect.top);
    assert.notEqual(scrolledPosition.y, stalePosition.y);
    assert.equal(intersects(toTooltipRect(scrolledPosition), scrolledRect), false);
    assertContained(scrolledPosition);
  });

  it("flips and clamps when the token is near a viewport edge", () => {
    const rect = { left: 940, right: 980, top: 640, bottom: 664, width: 40, height: 24 };
    const position = getTooltipPositionFromRect(rect, { size, viewport });

    assert.equal(position.x, rect.left - 10 - size.width);
    assert.ok(position.y <= viewport.height - size.height - 12);
    assert.ok(position.y >= 12);
    assert.equal(intersects(toTooltipRect(position), rect), false);
    assertContained(position);
  });

  it("keeps quick tooltips off wide math fragments", () => {
    const rect = { left: 414, right: 672, top: 468, bottom: 500, width: 258, height: 32 };
    const position = getTooltipPositionFromRect(rect, { size, viewport });

    assert.equal(position.x, rect.right + 10);
    assert.equal(position.y, rect.top);
    assert.equal(intersects(toTooltipRect(position), rect), false);
    assertContained(position);
  });

  it("clamps using actual measured tooltip dimensions near the right edge", () => {
    const actualSize = { width: 360, height: 220 };
    const edgeRect = { left: 970, right: 995, top: 24, bottom: 48, width: 25, height: 24 };
    const position = getTooltipPositionFromRect(edgeRect, { size: actualSize, viewport });
    const tooltip = {
      left: position.x,
      right: position.x + actualSize.width,
      top: position.y,
      bottom: position.y + actualSize.height,
    };

    assert.ok(tooltip.left >= 12);
    assert.ok(tooltip.right <= viewport.width - 12);
    assert.ok(tooltip.top >= 12);
    assert.ok(tooltip.bottom <= viewport.height - 12);
  });

  it("clamps tall measured tooltip frames inside the viewport", () => {
    const actualSize = { width: 340, height: 660 };
    const edgeRect = { left: 420, right: 460, top: 660, bottom: 690, width: 40, height: 30 };
    const position = getTooltipPositionFromRect(edgeRect, { size: actualSize, viewport });

    assert.equal(position.y, 28);
    assert.ok(position.x >= 12);
    assert.ok(position.x + actualSize.width <= viewport.width - 12);
  });
});
