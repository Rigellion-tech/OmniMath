import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { Loader2, MoreHorizontal, Plus, Send, Square } from "lucide-react";
import ConversationText from "./ConversationText";
import { explainFollowup } from "@/api/mathClient";
import { buildFollowupPayload, buildProvenanceSnapshot, getConversationId, getTargetRevision } from "@/lib/explanationProvenance";
import { INITIAL_FOLLOWUP_STATE, isSameFollowupRequest, recordFollowupLifecycle, reduceFollowupLifecycle, responseOwnsFollowupRequest } from "@/lib/followupLifecycle";

let requestSequence = 0;
const TIMEOUT_MS = 35_000;
const RENDER_INTERVAL_MS = 80;
export const LENS_ACTIONS = [
  { label: "Simplify", question: "Explain this exact object more simply." },
  { label: "Intuition", question: "Give intuition for this exact object." },
  { label: "Derive", question: "Derive this exact expression using the available evidence." },
  { label: "Verify", question: "Check this exact expression and state what can and cannot be verified." },
  { label: "Example", question: "Show an example illustrating this exact object." },
];

/** The thread owns UI/request state, while the parent remains the source of mathematics. */
export default function ScopedConversation({
  item, problem, getToken, displayedExplanation = "", scope = "lens",
  initialMessages = null, initialDraft = "", onConversationChange = null,
  presentationDepth = "standard", quickActions = LENS_ACTIONS, disabled = false,
  tools = [],
}) {
  // A pin's target snapshot never changes merely because its position/content changes.
  const snapshot = useMemo(() => item.provenanceSnapshot || buildProvenanceSnapshot({ item, problem }), [item.id]);
  const revision = item.targetRevision || getTargetRevision(snapshot);
  const conversationId = item.conversationId || getConversationId(snapshot);
  const [state, dispatch] = useReducer(/** @type {React.Reducer<any, any>} */ (reduceFollowupLifecycle), {
    ...INITIAL_FOLLOWUP_STATE,
    messages: initialMessages || item.chatHistory || [],
    draft: initialDraft || item.conversationDraft || "",
    status: ["generating", "streaming"].includes(item.conversationStatus) ? "aborted" : item.conversationStatus || "idle",
  });
  const activeRef = useRef(null);
  const mountedRef = useRef(true);
  const scrollRef = useRef(null);
  const nearBottomRef = useRef(true);
  const pendingRef = useRef("");
  const renderTimerRef = useRef(null);
  const persistTimerRef = useRef(null);
  const callbackRef = useRef(onConversationChange);
  const stateRef = useRef(state);
  const acceptedRef = useRef(null);
  const actionsRef = useRef(null);
  callbackRef.current = onConversationChange;
  stateRef.current = state;
  const persist = () => {
    if (!callbackRef.current) return;
    const current = stateRef.current;
    const last = current.messages.at(-1);
    if (last?.requestId) recordFollowupLifecycle("local_window_update_requested", {
      requestId: last.requestId, conversationId, targetRevision: revision, messageCount: current.messages.length,
    });
    callbackRef.current({ messages: current.messages, draft: current.draft, status: current.status });
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current?.controller.abort();
      clearTimeout(renderTimerRef.current);
      clearTimeout(persistTimerRef.current);
      persist();
    };
  }, []);

  useEffect(() => {
    if (!state.loading) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
      persist();
    } else if (!persistTimerRef.current) {
      persistTimerRef.current = setTimeout(() => { persistTimerRef.current = null; persist(); }, 500);
    }
  }, [state.messages, state.draft, state.status, state.loading]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && nearBottomRef.current) element.scrollTop = element.scrollHeight;
    const accepted = acceptedRef.current;
    if (!accepted || state.loading) return;
    recordFollowupLifecycle("committed_to_ui", { ...accepted, messageCount: state.messages.length });
    recordFollowupLifecycle("rendered", { ...accepted, renderedTextLength: state.messages.at(-1)?.text?.length || 0 });
    acceptedRef.current = null;
  }, [state.messages, state.loading]);

  const flush = (request) => {
    // An aborted predecessor must not consume a newer request's buffered text.
    if (!isSameFollowupRequest(activeRef.current, request)) return;
    clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    if (!pendingRef.current) return;
    const delta = pendingRef.current;
    pendingRef.current = "";
    if (mountedRef.current && isSameFollowupRequest(activeRef.current, request)) {
      dispatch({ type: "response_delta", request, delta });
      if (import.meta.env.DEV) {
        const metrics = window["__OMNIMATH_LENS_STREAM_METRICS__"] ||= { flushes: 0, chars: 0 };
        metrics.flushes += 1;
        metrics.chars += delta.length;
      }
    }
  };

  const submit = async (question) => {
    const trimmed = String(question || "").trim();
    if (!trimmed || activeRef.current || disabled) return;
    const request = { requestId: `followup-${Date.now().toString(36)}-${++requestSequence}`, conversationId, targetRevision: revision };
    const controller = new AbortController();
    activeRef.current = { ...request, controller };
    pendingRef.current = "";
    nearBottomRef.current = true;
    dispatch({ type: "request_started", request, question: trimmed, preservePartial: true });
    recordFollowupLifecycle("request_started", request);
    let timedOut = false;
    let sawDelta = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    try {
      const data = await explainFollowup({
        getToken, signal: controller.signal,
        payload: { ...buildFollowupPayload({ request, provenanceSnapshot: snapshot, item, problem, displayedExplanation, question: trimmed, history: state.messages }), scope, presentationDepth },
        onEvent: (event) => {
          if (!isSameFollowupRequest(activeRef.current, request) || !mountedRef.current) return;
          if (event.type !== "delta") return;
          if (!responseOwnsFollowupRequest(event, request)) return;
          if (!sawDelta) { sawDelta = true; recordFollowupLifecycle("streaming", request); }
          pendingRef.current += event.delta;
          if (!renderTimerRef.current) renderTimerRef.current = setTimeout(() => flush(request), RENDER_INTERVAL_MS);
        },
      });
      flush(request);
      if (!mountedRef.current || !isSameFollowupRequest(activeRef.current, request)) return;
      if (!responseOwnsFollowupRequest(data, request)) throw new Error("The answer no longer matched this selected object. Please retry.");
      const answer = String(data.answer || "").trim();
      if (!answer) throw new Error("The follow-up returned an empty answer. Please retry.");
      recordFollowupLifecycle("api_parsed", { ...request, answerLength: answer.length });
      acceptedRef.current = request;
      dispatch({ type: "request_succeeded", request, answer });
    } catch (error) {
      flush(request);
      if (!mountedRef.current || !isSameFollowupRequest(activeRef.current, request)) return;
      const aborted = error?.name === "AbortError" && !timedOut;
      const timeout = timedOut || error?.code === "AI_REQUEST_TIMEOUT";
      recordFollowupLifecycle(aborted ? "aborted" : timeout ? "timed_out" : "api_failed", { ...request, reason: error.message });
      dispatch({ type: aborted ? "request_aborted" : "request_failed", request, timedOut: timeout,
        error: timeout ? "The follow-up timed out. Partial text has been kept; you can retry." : error.message || "Could not finish that explanation." });
    } finally {
      clearTimeout(timer);
      if (isSameFollowupRequest(activeRef.current, request)) activeRef.current = null;
    }
  };

  const stop = () => {
    const active = activeRef.current;
    if (!active) return;
    active.controller.abort();
    flush(active);
    recordFollowupLifecycle("aborted", active);
    dispatch({ type: "request_aborted", request: active });
    activeRef.current = null;
  };

  return (
    <div className={`omni-scoped-conversation omni-${scope}-conversation`} data-conversation-id={conversationId} data-conversation-status={state.status}>
      <div ref={scrollRef} className="omni-conversation-messages omni-scrollbar" onScroll={(event) => {
        const node = event.currentTarget;
        nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      }}>
        {state.messages.map((message, index) => (
          <div key={message.requestId ? `${message.requestId}-${message.role}` : `restored-${index}`} data-followup-request-id={message.requestId || undefined} data-message-role={message.role} className={`omni-conversation-turn is-${message.role}`}>
            {message.partial ? <div className="omni-stream-text"><ConversationText>{message.text}</ConversationText></div> : <ConversationText>{message.text}</ConversationText>}
            {message.partial && !state.loading && <small>Partial response</small>}
          </div>
        ))}
      </div>
      {state.loading && <div className="omni-conversation-status" role="status"><Loader2 className="h-3 w-3 animate-spin" />{state.status === "streaming" ? "Responding…" : "Generating…"}</div>}
      {state.status === "aborted" && <p className="omni-conversation-status" role="status">Stopped. Conversation retained.</p>}
      {state.error && <p className="omni-conversation-error" role="alert">{state.error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void submit(state.draft); }}>
        <details ref={actionsRef} className="omni-conversation-more">
          <summary aria-label={scope === "lens" ? "More actions for this object" : "More actions for this solution"} title={scope === "workspace" ? "Tools and suggested questions" : "Suggested questions"}>{scope === "workspace" ? <Plus className="h-4 w-4" /> : <MoreHorizontal className="h-4 w-4" />}</summary>
          <div className="omni-conversation-actions" aria-label={scope === "lens" ? "Actions for this object" : "Actions for this solution"}>
            {tools.map((tool) => <button key={tool.label} type="button" onClick={() => { actionsRef.current.open = false; tool.onClick(); }}>{tool.label}</button>)}
            {quickActions.map((action) => <button key={action.label} type="button" disabled={state.loading || disabled} onClick={() => { actionsRef.current.open = false; void submit(action.question); }}>{action.label}</button>)}
          </div>
        </details>
        <input value={state.draft} onChange={(event) => dispatch({ type: "draft_changed", draft: event.target.value })}
          onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}
          aria-label={scope === "lens" ? "Ask about this object" : "Ask about this solution"}
          placeholder={scope === "lens" ? "Ask about this" : "Ask about this solution…"} disabled={disabled} />
        {state.loading ? <button key="stop" type="button" aria-label="Stop response" onClick={(event) => { event.preventDefault(); stop(); }}><Square className="h-3.5 w-3.5" /></button>
          : <button key="send" type="submit" disabled={disabled || !state.draft.trim()} aria-label="Send follow-up"><Send className="h-3.5 w-3.5" /></button>}
      </form>
    </div>
  );
}
