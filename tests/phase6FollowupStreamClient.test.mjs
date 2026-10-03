import assert from "node:assert/strict";
import test from "node:test";
import { consumeFollowupStream } from "../src/api/followupStreamClient.js";

const owner = { requestId: "request-a", conversationId: "lens-a", targetRevision: "revision-a" };
const encoder = new TextEncoder();
const frame = (type, fields = {}) => `event: followup\ndata: ${JSON.stringify({ type, ...owner, ...fields })}\n\n`;

function connection() {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    write(value) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
  };
}

test("follow-up deltas are delivered before completion rather than replayed from a full answer", async () => {
  const wire = connection();
  const events = [];
  let observed;
  const incremental = new Promise((resolve) => { observed = resolve; });
  const consuming = consumeFollowupStream(wire.response, owner, (event) => {
    events.push(event);
    if (event.type === "delta") observed();
  });
  wire.write(frame("generating"));
  const value = frame("delta", { delta: "First part α" });
  wire.write(value.slice(0, 17));
  wire.write(value.slice(17));
  await incremental;
  assert.deepEqual(events.map((value) => value.type), ["generating", "delta"]);
  wire.write(frame("complete", { answer: "First part α finished" }));
  wire.close();
  assert.equal((await consuming).answer, "First part α finished");
});

test("stream failure retains already delivered deltas and exposes a correlated terminal error", async () => {
  const wire = connection();
  const events = [];
  const consuming = consumeFollowupStream(wire.response, owner, (event) => events.push(event));
  wire.write(frame("delta", { delta: "Meaningful partial reasoning" }));
  wire.write(frame("error", { code: "AI_REQUEST_TIMEOUT", message: "Timed out", partial: true }));
  wire.close();
  await assert.rejects(consuming, (error) => error.code === "AI_REQUEST_TIMEOUT" && error.body.partial);
  assert.equal(events[0].delta, "Meaningful partial reasoning");
});

test("an ownership mismatch never reaches the thread", async () => {
  const wire = connection();
  const events = [];
  const consuming = consumeFollowupStream(wire.response, owner, (event) => events.push(event));
  wire.write(frame("delta", { conversationId: "another-lens", delta: "Wrong target" }));
  wire.close();
  await assert.rejects(consuming, /no longer matched/);
  assert.equal(events.length, 0);
});

test("connection close without completion preserves delivered text and fails explicitly", async () => {
  const wire = connection();
  const events = [];
  const consuming = consumeFollowupStream(wire.response, owner, (event) => events.push(event));
  wire.write(frame("delta", { delta: "Partial" }));
  wire.close();
  await assert.rejects(consuming, /before completion/);
  assert.equal(events[0].delta, "Partial");
});

test("abort settles a pending read cleanly", async () => {
  const wire = connection();
  const abort = new AbortController();
  const consuming = consumeFollowupStream(wire.response, owner, () => {}, abort.signal);
  abort.abort();
  await assert.rejects(consuming, (error) => error.name === "AbortError");
});

test("invalid delta and frames following completion fail closed", async () => {
  for (const output of [frame("delta", { delta: 12 }), frame("complete", { answer: "Done" }) + frame("delta", { delta: "extra" })]) {
    const wire = connection();
    const consuming = consumeFollowupStream(wire.response, owner, () => {});
    wire.write(output); wire.close();
    await assert.rejects(consuming);
  }
});
