// Development-only timing for completed steps. This runs on step arrival, never on pointer movement.
function getStore() {
  if (!import.meta.env?.DEV || typeof window === "undefined") return null;
  const browser = /** @type {any} */ (window);
  if (!browser.__OMNIMATH_PROGRESSIVE_PRESENTATION__) {
    browser.__OMNIMATH_PROGRESSIVE_PRESENTATION__ = {
      steps: [],
      reset() { this.steps = []; },
    };
  }
  return browser.__OMNIMATH_PROGRESSIVE_PRESENTATION__;
}

function findStep(store, requestId, stepId) {
  let entry = store.steps.find((step) => step.requestId === requestId && step.stepId === stepId);
  if (!entry) {
    entry = { requestId, stepId };
    store.steps.push(entry);
  }
  return entry;
}

export function markProgressiveEventReceived(event) {
  if (event?.type !== "step_completed") return;
  const store = getStore();
  if (!store) return;
  const entry = findStep(store, event.requestId, event.stepId);
  if (entry.receivedAt !== undefined) return;
  entry.serverAcceptedAt = event.acceptedAt || null;
  entry.receivedAt = performance.now();
  entry.receivedWallAt = Date.now();
}

export function markProgressiveStepInserted({ requestId, stepId, element }) {
  const store = getStore();
  if (!store || !element) return;
  const entry = findStep(store, requestId, stepId);
  if (entry.insertedAt !== undefined) return;
  entry.insertedAt = performance.now();
  entry.eventToInsertedMs = entry.receivedAt === undefined ? null : entry.insertedAt - entry.receivedAt;

  let observer;
  let timeout;
  const markGeometry = () => {
    if (!element.isConnected) {
      observer?.disconnect();
      clearTimeout(timeout);
      return;
    }
    const hoverableHitbox = element.querySelector(
      ".math-semantic-hitbox[data-inspectable='math-subtoken'][data-geometry-valid='true']"
    );
    if (!hoverableHitbox) return;
    entry.geometryValidAt = performance.now();
    entry.hoverableAt = entry.geometryValidAt;
    entry.eventToHoverableMs = entry.receivedAt === undefined ? null : entry.hoverableAt - entry.receivedAt;
    observer?.disconnect();
    clearTimeout(timeout);
  };

  requestAnimationFrame(() => {
    if (!element.isConnected) return;
    if (element.getClientRects().length) {
      entry.visibleAt = performance.now();
      entry.eventToVisibleMs = entry.receivedAt === undefined ? null : entry.visibleAt - entry.receivedAt;
    }
    observer = new MutationObserver(markGeometry);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-geometry-valid"],
    });
    timeout = setTimeout(() => observer.disconnect(), 10_000);
    markGeometry();
  });
}
