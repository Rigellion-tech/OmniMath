const MAX_MESSAGES = 80;
const MAX_TEXT_LENGTH = 12_000;

function cleanMessage(message) {
  if (!message || typeof message !== "object") return null;
  const role = message.role === "assistant" || message.role === "tutor" ? "assistant" : "user";
  const text = String(message.text || "").slice(0, MAX_TEXT_LENGTH);
  if (!text) return null;
  return {
    role,
    text,
    ...(message.requestId ? { requestId: String(message.requestId) } : {}),
    ...(message.partial ? { partial: true } : {}),
  };
}

export function normalizeWorkspaceConversation(value = {}) {
  return {
    messages: (Array.isArray(value.messages) ? value.messages : [])
      .map(cleanMessage)
      .filter(Boolean)
      .slice(-MAX_MESSAGES),
    draft: String(value.draft || "").slice(0, MAX_TEXT_LENGTH),
    status: ["idle", "generating", "streaming", "complete", "failed", "timed_out", "aborted"].includes(value.status)
      ? value.status
      : "idle",
    revision: String(value.revision || ""),
  };
}
