import assert from "node:assert/strict";
import test from "node:test";
import { consumeProgressiveSolveStream } from "../src/api/progressiveStreamClient.js";

function streamResponse(chunks, onCancel = () => {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
    cancel: onCancel,
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

test("progressive SSE consumer reassembles fragmented authoritative events", async () => {
  const observed = [];
  const response = streamResponse([
    'event: solve\ndata: {"type":"solve_started","sequence":0}\n\n',
    'event: solve\ndata: {"type":"step_',
    'completed","sequence":1}\n\nevent: solve\ndata: {"type":"solve_completed","sequence":2}\n\n',
  ]);
  const result = await consumeProgressiveSolveStream(response, (event) => observed.push(event));
  assert.deepEqual(observed.map((event) => event.type), ["solve_started", "step_completed", "solve_completed"]);
  assert.equal(result.status, "solve_completed");
  assert.equal(result.eventCount, 3);
});

test("progressive SSE consumer rejects transport close without a terminal solve event", async () => {
  const response = streamResponse(['event: solve\ndata: {"type":"step_completed"}\n\n']);
  await assert.rejects(consumeProgressiveSolveStream(response, () => {}), /before a terminal event/u);
});

test("progressive SSE consumer does not accept invalid event envelopes", async () => {
  const response = streamResponse(['event: solve\ndata: {"delta":"raw provider token"}\n\n']);
  await assert.rejects(consumeProgressiveSolveStream(response, () => {}), /event was invalid/u);
});
