const defaultScheduleFrame = (callback) => (
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : setTimeout(() => callback(Date.now()), 0)
);

const defaultCancelFrame = (handle) => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
};

function uniqueTargets(targets = []) {
  return [...new Set(targets.filter((target) => (
    target && typeof target.addEventListener === "function"
  )))];
}

export function createMathScrollCoordinator({
  scheduleFrame = defaultScheduleFrame,
  cancelFrame = defaultCancelFrame,
} = {}) {
  const targetRecords = new Map();
  const pendingSubscribers = new Set();
  let scheduledFrame = 0;
  let subscriberSequence = 0;
  const stats = {
    physicalListeners: 0,
    listenerAdds: 0,
    listenerRemovals: 0,
    physicalScrollCallbacks: 0,
    subscriberNotifications: 0,
    frames: 0,
  };

  const publishDiagnostics = () => {
    if (!import.meta.env?.DEV || typeof window === "undefined") return;
    const diagnosticWindow = /** @type {any} */ (window);
    const subscriberCounts = [...targetRecords.values()].map((record) => record.subscribers.size);
    diagnosticWindow.__OMNIMATH_SCROLL_COORDINATOR__ = {
      ...stats,
      registeredTargets: targetRecords.size,
      pendingSubscribers: pendingSubscribers.size,
      sharedTargets: subscriberCounts.filter((count) => count > 1).length,
      maxSubscribersPerTarget: Math.max(0, ...subscriberCounts),
      reset: resetStats,
      flush,
    };
  };

  const flush = (timestamp = Date.now()) => {
    if (scheduledFrame) {
      cancelFrame(scheduledFrame);
      scheduledFrame = 0;
    }
    if (pendingSubscribers.size === 0) return;
    stats.frames += 1;
    const subscribers = [...pendingSubscribers];
    pendingSubscribers.clear();
    for (const subscriber of subscribers) {
      if (!subscriber.active) continue;
      const changedTargets = [...subscriber.changedTargets];
      subscriber.changedTargets.clear();
      stats.subscriberNotifications += 1;
      subscriber.callback({ changedTargets, timestamp });
    }
    publishDiagnostics();
  };

  const scheduleFlush = () => {
    if (scheduledFrame) return;
    scheduledFrame = scheduleFrame((timestamp) => {
      scheduledFrame = 0;
      flush(timestamp);
    });
  };

  const addTargetRecord = (target) => {
    const record = {
      target,
      subscribers: new Set(),
      listener: null,
    };
    record.listener = () => {
      stats.physicalScrollCallbacks += 1;
      for (const subscriber of record.subscribers) {
        if (!subscriber.active) continue;
        subscriber.changedTargets.add(target);
        pendingSubscribers.add(subscriber);
      }
      scheduleFlush();
      publishDiagnostics();
    };
    target.addEventListener("scroll", record.listener, { passive: true });
    targetRecords.set(target, record);
    stats.physicalListeners += 1;
    stats.listenerAdds += 1;
    publishDiagnostics();
    return record;
  };

  const removeTargetRecord = (record) => {
    record.target.removeEventListener("scroll", record.listener, false);
    targetRecords.delete(record.target);
    stats.physicalListeners -= 1;
    stats.listenerRemovals += 1;
    publishDiagnostics();
  };

  /**
   * @param {{ targets?: any[], callback?: (event: { changedTargets: any[], timestamp: number }) => void, id?: string }} options
   */
  const subscribe = ({ targets = [], callback, id = "" } = {}) => {
    if (typeof callback !== "function") return () => {};
    subscriberSequence += 1;
    const subscriber = {
      id: id || `math-scroll-subscriber-${subscriberSequence}`,
      active: true,
      callback,
      changedTargets: new Set(),
      records: [],
    };
    for (const target of uniqueTargets(targets)) {
      const record = targetRecords.get(target) || addTargetRecord(target);
      record.subscribers.add(subscriber);
      subscriber.records.push(record);
    }

    return () => {
      if (!subscriber.active) return;
      subscriber.active = false;
      pendingSubscribers.delete(subscriber);
      subscriber.changedTargets.clear();
      for (const record of subscriber.records) {
        record.subscribers.delete(subscriber);
        if (record.subscribers.size === 0) removeTargetRecord(record);
      }
      subscriber.records = [];
    };
  };

  const resetStats = () => {
    stats.listenerAdds = 0;
    stats.listenerRemovals = 0;
    stats.physicalScrollCallbacks = 0;
    stats.subscriberNotifications = 0;
    stats.frames = 0;
    publishDiagnostics();
  };

  const destroy = () => {
    if (scheduledFrame) cancelFrame(scheduledFrame);
    scheduledFrame = 0;
    pendingSubscribers.clear();
    for (const record of [...targetRecords.values()]) removeTargetRecord(record);
  };

  return {
    subscribe,
    flush,
    resetStats,
    destroy,
    getStats: () => ({
      ...stats,
      registeredTargets: targetRecords.size,
      pendingSubscribers: pendingSubscribers.size,
    }),
  };
}

let sharedCoordinator = null;

export function getMathScrollCoordinator() {
  if (!sharedCoordinator) sharedCoordinator = createMathScrollCoordinator();
  return sharedCoordinator;
}

export function subscribeToMathScroll(targets, callback, id = "") {
  return getMathScrollCoordinator().subscribe({ targets, callback, id });
}

export function flushMathScrollTranslations() {
  getMathScrollCoordinator().flush();
}
