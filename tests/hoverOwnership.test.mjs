import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reconcileLogicalHoverOwnership,
  shouldExecuteHoverClear,
} from "../src/lib/hoverOwnership.js";

function element({ classes = [], attributes = {}, connected = true } = {}) {
  const classSet = new Set(classes);
  return {
    isConnected: connected,
    children: new Set(),
    getAttribute(name) { return attributes[name] || null; },
    matches(selector) { return selector.startsWith(".") && classSet.has(selector.slice(1)); },
    closest(selector) { return this.matches(selector) ? this : null; },
    contains(candidate) { return candidate === this || this.children.has(candidate); },
    getBoundingClientRect() { return attributes.rect || { left: 10, top: 10, right: 30, bottom: 30 }; },
  };
}

function documentAt(hitStack = [], owners = []) {
  return {
    elementsFromPoint() { return hitStack; },
    querySelectorAll() { return owners; },
  };
}

const measured = {
  id: "token-a",
  ownerId: "chunk-a",
  rects: [{ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }],
};

describe("logical hover ownership reconciliation", () => {
  it("A: retains a stationary hover when response content mounts or resizes the matching tooltip", () => {
    const tooltip = element({
      classes: ["omni-quick-tooltip"],
      attributes: { "data-tooltip-semantic-id": "token-a" },
    });
    const result = reconcileLogicalHoverOwnership({
      pointer: { clientX: 20, clientY: 20 },
      activeTokenId: "token-a",
      activeSemanticId: "token-a",
      measuredTargets: [measured],
      documentRef: documentAt([tooltip]),
    });

    assert.equal(result.retained, true);
    assert.equal(result.owner, "tooltip");
    assert.equal(shouldExecuteHoverClear({ scheduledRevision: 4, currentRevision: 4, reconciliation: result }).execute, false);
  });

  it("B: recovers the same stable token after its source DOM node is replaced", () => {
    const oldSource = element({ connected: false, attributes: { "data-math-chunk-owner": "chunk-a" } });
    const newSource = element({ attributes: { "data-math-chunk-owner": "chunk-a" } });
    const result = reconcileLogicalHoverOwnership({
      pointer: { clientX: 20, clientY: 20 },
      activeTokenId: "token-a",
      sourceElement: oldSource,
      measuredTargets: [measured],
      documentRef: documentAt([newSource], [newSource]),
    });

    assert.equal(result.retained, true);
    assert.equal(result.owner, "source");
    assert.equal(result.sourceElement, newSource);
  });

  it("C: allows the existing delayed clear after a genuine pointer departure", () => {
    const source = element({ attributes: { "data-math-chunk-owner": "chunk-a" } });
    const outside = element();
    const result = reconcileLogicalHoverOwnership({
      pointer: { clientX: 90, clientY: 90 },
      activeTokenId: "token-a",
      sourceElement: source,
      measuredTargets: [measured],
      documentRef: documentAt([outside], [source]),
    });

    assert.equal(result.retained, false);
    assert.equal(shouldExecuteHoverClear({ scheduledRevision: 7, currentRevision: 7, reconciliation: result }).execute, true);
  });

  it("D: treats source to tooltip and tooltip to source as one logical region", () => {
    const source = element({ attributes: { "data-math-chunk-owner": "chunk-a" } });
    const tooltip = element({
      classes: ["omni-quick-tooltip"],
      attributes: { "data-tooltip-semantic-id": "token-a" },
    });
    const common = {
      pointer: { clientX: 20, clientY: 20 },
      activeTokenId: "token-a",
      activeSemanticId: "token-a",
      sourceElement: source,
      measuredTargets: [measured],
    };

    assert.equal(reconcileLogicalHoverOwnership({ ...common, documentRef: documentAt([source]) }).owner, "source");
    assert.equal(reconcileLogicalHoverOwnership({ ...common, documentRef: documentAt([tooltip, source]) }).owner, "tooltip");
    assert.equal(reconcileLogicalHoverOwnership({ ...common, documentRef: documentAt([source]) }).owner, "source");
  });

  it("E: rejects an old clear even when the old pointer no longer owns a region", () => {
    const decision = shouldExecuteHoverClear({
      scheduledRevision: 2,
      currentRevision: 3,
      reconciliation: { retained: false, reason: "pointer-outside-logical-region" },
    });

    assert.deepEqual(decision, { execute: false, reason: "stale-hover-revision" });
  });
});

