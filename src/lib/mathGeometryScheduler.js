const FRAME_BUDGET_MS = 8;
const pendingMeasurements = new Map();
const pendingBackgroundTasks = new Map();
let scheduledFrame = 0;
let backgroundTaskScheduled = false;

const now = () => (
  typeof performance !== "undefined" ? performance.now() : Date.now()
);

const scheduleFrame = (callback) => (
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(() => callback(now()), 0)
);

function publishDiagnostics() {
  if (!import.meta.env?.DEV || typeof window === "undefined") return;
  const diagnosticWindow = /** @type {any} */ (window);
  const current = diagnosticWindow.__OMNIMATH_GEOMETRY_SCHEDULER__ || {};
  diagnosticWindow.__OMNIMATH_GEOMETRY_SCHEDULER__ = {
    ...current,
    pending: pendingMeasurements.size,
    backgroundPending: pendingBackgroundTasks.size,
  };
}

function scheduleBackground(callback) {
  const browserScheduler = typeof window !== "undefined"
    ? /** @type {any} */ (window).scheduler
    : null;
  if (typeof browserScheduler?.postTask === "function") {
    browserScheduler.postTask(callback, { priority: "background" }).catch(() => {});
    return;
  }
  setTimeout(callback, 0);
}

function flushBackgroundTask() {
  backgroundTaskScheduled = false;
  const entry = pendingBackgroundTasks.entries().next().value;
  if (!entry) {
    publishDiagnostics();
    return;
  }
  const [key, callback] = entry;
  pendingBackgroundTasks.delete(key);
  callback();
  if (pendingBackgroundTasks.size > 0) {
    backgroundTaskScheduled = true;
    scheduleBackground(flushBackgroundTask);
  }
  publishDiagnostics();
}

function flushMeasurements() {
  scheduledFrame = 0;
  const frameStartedAt = now();
  let processed = 0;

  for (const [key, callback] of pendingMeasurements) {
    pendingMeasurements.delete(key);
    callback();
    processed += 1;
    if (processed > 0 && now() - frameStartedAt >= FRAME_BUDGET_MS) break;
  }

  if (import.meta.env?.DEV && typeof window !== "undefined") {
    const diagnosticWindow = /** @type {any} */ (window);
    const current = diagnosticWindow.__OMNIMATH_GEOMETRY_SCHEDULER__ || {};
    diagnosticWindow.__OMNIMATH_GEOMETRY_SCHEDULER__ = {
      ...current,
      frames: (current.frames || 0) + 1,
      measurements: (current.measurements || 0) + processed,
      lastFrameDurationMs: Math.round((now() - frameStartedAt) * 100) / 100,
      pending: pendingMeasurements.size,
    };
  }

  if (pendingMeasurements.size > 0) scheduledFrame = scheduleFrame(flushMeasurements);
  publishDiagnostics();
}

/**
 * Coalesce semantic geometry rebuilds by rendered chunk and distribute them
 * across animation frames. Pointer-boundary code may still measure its local
 * chunk synchronously when a snapshot is unavailable.
 */
export function scheduleMathGeometryMeasurement(key, callback) {
  if (!key || typeof callback !== "function") return () => {};
  pendingMeasurements.set(key, callback);
  if (!scheduledFrame) scheduledFrame = scheduleFrame(flushMeasurements);
  publishDiagnostics();
  return () => {
    pendingMeasurements.delete(key);
    publishDiagnostics();
  };
}

export function cancelMathGeometryMeasurement(key) {
  pendingMeasurements.delete(key);
  publishDiagnostics();
}

/** Run non-visible semantic preparation behind input and rendering work. */
export function scheduleMathBackgroundTask(key, callback) {
  if (!key || typeof callback !== "function") return () => {};
  pendingBackgroundTasks.set(key, callback);
  if (!backgroundTaskScheduled) {
    backgroundTaskScheduled = true;
    scheduleBackground(flushBackgroundTask);
  }
  publishDiagnostics();
  return () => {
    pendingBackgroundTasks.delete(key);
    publishDiagnostics();
  };
}
