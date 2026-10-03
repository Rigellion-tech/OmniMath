import { serializeSemanticTreeToLatex } from "./semanticMathRenderer.js";
import { scheduleMathBackgroundTask } from "./mathGeometryScheduler.js";
import { recordOmniDiagnostic } from "./performanceDiagnostics.js";

let worker;
let unavailable = false;
let sequence = 0;
const pending = new Map();

function failWorker() {
  unavailable = true;
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.fallback();
  pending.clear();
}

/** Keep the exact annotation validator off the input/rendering thread.
 * Cancellation discards obsolete results; no cross-session result cache exists.
 */
export function prepareSemanticRender(tree, onReady) {
  const id = ++sequence;
  let cancelled = false;
  let cancelFallback;
  const finish = (value) => { if (!cancelled) onReady(value); };
  const fallback = () => {
    if (cancelled) return;
    cancelFallback = scheduleMathBackgroundTask(`annotation-fallback:${id}`, () => {
      finish(serializeSemanticTreeToLatex(tree));
    });
  };
  if (!unavailable && typeof Worker !== "undefined") {
    try {
      if (!worker) {
        worker = new Worker(new URL("./semanticRender.worker.js", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => {
          const request = pending.get(data.id);
          if (!request) return;
          pending.delete(data.id);
          if (data.error) request.fallback();
          else {
            recordOmniDiagnostic("semantic-render.worker", { durationMs: data.durationMs });
            request.finish(data.value);
          }
        };
        worker.onerror = failWorker;
        worker.onmessageerror = failWorker;
      }
      pending.set(id, { finish, fallback });
      worker.postMessage({ id, tree });
    } catch {
      const wasPending = pending.has(id);
      failWorker();
      if (!wasPending) fallback();
    }
  } else fallback();
  return () => {
    cancelled = true;
    pending.delete(id);
    cancelFallback?.();
  };
}
