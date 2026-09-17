import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMathScrollCoordinator, hasMathScrollStateDrift } from "../src/lib/mathScrollCoordinator.js";

function fakeScrollTarget() {
  const listeners = new Set();
  return {
    addCalls: 0,
    removeCalls: 0,
    addEventListener(type, listener) {
      if (type !== "scroll") return;
      this.addCalls += 1;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type !== "scroll") return;
      this.removeCalls += 1;
      listeners.delete(listener);
    },
    scroll() {
      for (const listener of listeners) listener({ target: this });
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function immediateFrameHarness() {
  let pending = null;
  return {
    schedule(callback) {
      pending = callback;
      return 1;
    },
    cancel() {
      pending = null;
    },
    run() {
      const callback = pending;
      pending = null;
      callback?.(16);
    },
  };
}

describe("math scroll coordinator", () => {
  it("detects scroll-offset drift before a queued scroll callback is delivered", () => {
    const cached = {
      windowX: 0,
      windowY: 120,
      rootLeft: 0,
      rootTop: 0,
      visualLeft: 0,
      visualTop: 0,
      scrollAncestors: [{ owner: "math-shell", left: 640, top: 0 }],
    };

    assert.equal(hasMathScrollStateDrift(cached, structuredClone(cached)), false);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      scrollAncestors: [{ owner: "math-shell", left: 0, top: 0 }],
    }), true);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      scrollAncestors: [],
    }), true);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      windowY: 121,
    }), true);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      rootLeft: 1,
    }), true);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      scrollAncestors: [{ owner: "renamed-shell", left: 640.5, top: 0 }],
    }), false);
    assert.equal(hasMathScrollStateDrift(cached, {
      ...structuredClone(cached),
      scrollAncestors: [{ owner: "math-shell", left: 640.51, top: 0 }],
    }), true);
  });

  it("shares one physical listener across chunks and batches notifications", () => {
    const frames = immediateFrameHarness();
    const coordinator = createMathScrollCoordinator({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
    });
    const container = fakeScrollTarget();
    let firstCalls = 0;
    let secondCalls = 0;
    const unsubscribeFirst = coordinator.subscribe({ targets: [container], callback: () => { firstCalls += 1; } });
    const unsubscribeSecond = coordinator.subscribe({ targets: [container], callback: () => { secondCalls += 1; } });

    assert.equal(container.listenerCount(), 1);
    assert.equal(container.addCalls, 1);
    container.scroll();
    container.scroll();
    frames.run();
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1);
    assert.equal(coordinator.getStats().physicalScrollCallbacks, 2);

    unsubscribeFirst();
    assert.equal(container.listenerCount(), 1);
    unsubscribeSecond();
    assert.equal(container.listenerCount(), 0);
    assert.equal(container.removeCalls, 1);
  });

  it("supports nested containers and removes pending unmounted subscribers", () => {
    const frames = immediateFrameHarness();
    const coordinator = createMathScrollCoordinator({
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
    });
    const outer = fakeScrollTarget();
    const inner = fakeScrollTarget();
    const notifications = [];
    const unsubscribe = coordinator.subscribe({
      targets: [outer, inner, inner],
      callback: ({ changedTargets }) => notifications.push(changedTargets),
    });

    assert.equal(outer.listenerCount(), 1);
    assert.equal(inner.listenerCount(), 1);
    outer.scroll();
    inner.scroll();
    frames.run();
    assert.equal(notifications.length, 1);
    assert.equal(new Set(notifications[0]).size, 2);

    inner.scroll();
    unsubscribe();
    frames.run();
    assert.equal(notifications.length, 1);
    assert.equal(coordinator.getStats().physicalListeners, 0);
  });
});
