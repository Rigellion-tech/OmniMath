const LONG_TASK_THRESHOLD_MS = 50;
const LOG_PREFIX = ["[omnimath", ":perf]"].join("");
let sequence = 0;
let observerInstalled = false;

function isDevPerformanceEnabled() {
  return Boolean(import.meta.env?.DEV) && typeof performance !== "undefined";
}

function getPerfStore() {
  if (!isDevPerformanceEnabled() || typeof window === "undefined") return null;
  const diagnosticWindow = /** @type {any} */ (window);
  const store = diagnosticWindow.__OMNIMATH_PERF__ || {
    createdAt: Date.now(),
    thresholdMs: LONG_TASK_THRESHOLD_MS,
    measurements: [],
    slow: [],
    longTasks: [],
    counters: {},
    reset() {
      this.createdAt = Date.now();
      this.measurements = [];
      this.slow = [];
      this.longTasks = [];
      this.counters = {};
    },
  };
  if (typeof store.reset !== "function") {
    store.reset = function resetOmniPerformanceDiagnostics() {
      this.createdAt = Date.now();
      this.measurements = [];
      this.slow = [];
      this.longTasks = [];
      this.counters = {};
    };
  }
  diagnosticWindow.__OMNIMATH_PERF__ = store;
  return store;
}

function pushLimited(list = [], item, limit = 1000) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function recordMeasurement(name, durationMs, details = {}, kind = "measure") {
  const store = getPerfStore();
  if (!store) return;
  const entry = {
    at: Date.now(),
    kind,
    name,
    durationMs: Math.round(durationMs * 100) / 100,
    details,
  };
  pushLimited(store.measurements, entry);
  store.counters[name] = (store.counters[name] || 0) + 1;
  if (durationMs >= LONG_TASK_THRESHOLD_MS || kind === "longtask") {
    pushLimited(kind === "longtask" ? store.longTasks : store.slow, entry);
    console.warn(LOG_PREFIX, entry);
  }
}

export function initOmniPerformanceObserver() {
  if (!isDevPerformanceEnabled() || observerInstalled || typeof window === "undefined") return;
  observerInstalled = true;
  getPerfStore();
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const longTaskAttribution = /** @type {any} */ (entry).attribution || [];
        recordMeasurement("browser.longtask", entry.duration || 0, {
          startTime: Math.round((entry.startTime || 0) * 100) / 100,
          attribution: longTaskAttribution,
        }, "longtask");
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    const store = getPerfStore();
    if (store) store.longTaskObserverUnsupported = true;
  }
}

export function startOmniMeasure(name, details = {}) {
  if (!isDevPerformanceEnabled()) return null;
  initOmniPerformanceObserver();
  sequence += 1;
  const id = `${name}:${sequence}`;
  const token = {
    name,
    details,
    start: performance.now(),
    startMark: `${id}:start`,
    endMark: `${id}:end`,
  };
  try {
    performance.mark(token.startMark);
  } catch {
    // Some runtimes expose performance.now without user timing marks.
  }
  return token;
}

export function endOmniMeasure(token, details = {}) {
  if (!token || !isDevPerformanceEnabled()) return 0;
  const durationMs = performance.now() - token.start;
  try {
    performance.mark(token.endMark);
    performance.measure(token.name, token.startMark, token.endMark);
    performance.clearMarks(token.startMark);
    performance.clearMarks(token.endMark);
  } catch {
    // Keep the explicit duration even if User Timing is unavailable.
  }
  recordMeasurement(token.name, durationMs, { ...token.details, ...details });
  return durationMs;
}

export function measureOmniSync(name, callback, details = {}) {
  const token = startOmniMeasure(name, details);
  try {
    return callback();
  } finally {
    endOmniMeasure(token);
  }
}

export function recordOmniDiagnostic(name, details = {}) {
  const store = getPerfStore();
  if (!store) return;
  const entry = {
    at: Date.now(),
    kind: "diagnostic",
    name,
    details,
  };
  pushLimited(store.measurements, entry);
  store.counters[name] = (store.counters[name] || 0) + 1;
}
