const MAX_PENDING_FRAME_CHARS = 1024 * 1024;

/** Read server-owned solve events. Provider text is never part of this wire format. */
export async function consumeProgressiveSolveStream(response, onEvent) {
  if (!response?.body?.getReader) throw new Error("The progressive solve connection is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  /** @type {{ type: string } | null} */
  let terminal = null;
  let received = 0;
  let completed = false;

  const processFrame = async (frame) => {
    const lines = frame.split(/\r?\n/u);
    const kind = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (kind !== "solve") return;
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) throw new Error("The progressive solve event was empty.");
    const event = JSON.parse(data);
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new Error("The progressive solve event was invalid.");
    }
    received += 1;
    await onEvent?.(event);
    if (["solve_completed", "solve_failed", "solve_cancelled"].includes(event.type)) terminal = event;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      if (pending.length > MAX_PENDING_FRAME_CHARS) throw new Error("The progressive solve event exceeded its size limit.");
      let boundary;
      while ((boundary = pending.search(/\r?\n\r?\n/u)) >= 0) {
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/u)[0];
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + separator.length);
        await processFrame(frame);
      }
      if (done) break;
    }
    if (pending.trim()) await processFrame(pending);
    if (!terminal) throw new Error("The progressive solve connection ended before a terminal event.");
    completed = true;
    return { progressiveStream: true, status: /** @type {{ type: string }} */ (terminal).type, eventCount: received };
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* already disconnected */ }
    }
    reader.releaseLock();
  }
}
