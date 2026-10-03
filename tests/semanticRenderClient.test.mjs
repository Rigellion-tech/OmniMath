import { test } from "node:test";
import assert from "node:assert/strict";

test("worker results keep request identity and cancelled sessions cannot publish stale math", async () => {
  const originalWorker = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    requests = [];
    constructor() { worker = this; }
    postMessage(message) { this.requests.push(message); }
  };
  try {
    const { prepareSemanticRender } = await import("../src/lib/semanticRenderClient.js?identity-test");
    const received = [];
    const tree = { displayLatex: "x=1", flatNodes: [] };
    const cancel = prepareSemanticRender(tree, (value) => received.push(["old", value]));
    prepareSemanticRender(tree, (value) => received.push(["new", value]));
    assert.equal(worker.requests[0].tree, tree);
    assert.notEqual(worker.requests[0].id, worker.requests[1].id);
    cancel();
    worker.onmessage({ data: { id: worker.requests[0].id, value: { latex: "stale" } } });
    worker.onmessage({ data: { id: worker.requests[1].id, value: { latex: "current" } } });
    assert.deepEqual(received, [["new", { latex: "current" }]]);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test("a worker blocked by the browser falls back to the same serializer", async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class { constructor() { throw new Error("worker blocked"); } };
  try {
    const { prepareSemanticRender } = await import("../src/lib/semanticRenderClient.js?fallback-test");
    const { buildSemanticTree } = await import("../src/lib/mathSemanticTree.js");
    const { serializeSemanticTreeToLatex } = await import("../src/lib/semanticMathRenderer.js");
    const tree = buildSemanticTree({ stepId: "fallback", displayLatex: "x+1=2" });
    const expected = serializeSemanticTreeToLatex(tree);
    const result = await new Promise((resolve) => prepareSemanticRender(tree, resolve));
    assert.deepEqual(result, expected);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
