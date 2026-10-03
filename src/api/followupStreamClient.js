import { responseOwnsFollowupRequest } from "../lib/followupLifecycle.js";

/** Consume actual server deltas; never synthesize a stream from a completed answer. */
export async function consumeFollowupStream(response, request, onEvent, signal) {
  if (!response.body?.getReader) throw new Error("The explanation connection is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let terminal = null;
  let receivedChars = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const frame = async (value) => {
    const data = value.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return; // SSE heartbeat
    const event = JSON.parse(data);
    if (terminal || !responseOwnsFollowupRequest(event, request)
      || !["generating", "delta", "complete", "error"].includes(event.type)) {
      throw new Error("The explanation no longer matched this conversation.");
    }
    if (event.type === "delta") {
      if (typeof event.delta !== "string") throw new Error("The explanation delta was invalid.");
      receivedChars += event.delta.length;
      if (receivedChars > 128_000) throw new Error("The explanation exceeded its size limit.");
    }
    await onEvent?.(event);
    if (event.type === "error") {
      terminal = event;
      throw Object.assign(new Error(event.message || "Could not finish that explanation."), { code: event.code, body: event, status: event.status });
    }
    if (event.type === "complete") terminal = event;
  };
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    while (true) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (pending.length > 256_000) throw new Error("The explanation event exceeded its size limit.");
      let boundary;
      while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)[0];
        const value = pending.slice(0, boundary);
        pending = pending.slice(boundary + separator.length);
        await frame(value);
      }
      if (done) break;
    }
    if (pending.trim()) await frame(pending);
    if (!terminal) throw new Error("The explanation connection ended before completion. Partial text has been kept.");
    return terminal;
  } finally {
    signal?.removeEventListener("abort", abort);
    try { await reader.cancel(); } catch { /* disconnected */ }
    reader.releaseLock();
  }
}
