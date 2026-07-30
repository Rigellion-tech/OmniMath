import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { explainProblem } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { cn } from "@/lib/utils";

const DEBUG_SOLUTION_STATE = import.meta.env.DEV
  && import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true";

function logSolutionState(event, details = {}) {
  if (!DEBUG_SOLUTION_STATE) return;
  console.info("[omnimath:solution-state]", {
    event,
    ...details,
  });
}

export default function ProblemInput({
  activeSessionId = "",
  history: controlledHistory,
  onHistoryChange,
  onReset,
  onProblemGenerated,
  onGenerationStart,
  onGenerationError,
}) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [localHistory, setLocalHistory] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);
  const historyEndRef = useRef(null);
  const { getToken } = useAuthToken();
  const history = controlledHistory ?? localHistory;
  const setHistory = (updater) => {
    const nextHistory = typeof updater === "function" ? updater(history) : updater;
    if (onHistoryChange) {
      onHistoryChange(nextHistory);
    } else {
      setLocalHistory(nextHistory);
    }
  };

  useEffect(() => {
    if (expanded && historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [history, expanded]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const rawInputValue = input;
    if (!rawInputValue.trim()) return;

    const userMessage = rawInputValue.trim();
    const requestSessionId = activeSessionId;
    logSolutionState("typed submit", {
      rawInputValue,
      trimmedSubmittedValue: userMessage,
      activeSessionIdBeforeRequest: requestSessionId,
      selectedTokenContext: null,
      hoveredTokenContext: null,
    });
    setInput("");
    setLoading(true);

    const newHistory = [...history, { role: "user", text: userMessage }];
    setHistory(newHistory);
    if (!expanded && newHistory.length > 1) setExpanded(true);
    const operationContext = onGenerationStart?.({ source: "text", problem: userMessage, requestSessionId });

    try {
      const result = await explainProblem({
        problem: userMessage,
        history,
        getToken,
      });

      setHistory([...newHistory, { role: "tutor", text: result.title || "Updated explanation" }]);
      onProblemGenerated({
        ...result,
        _requestSessionId: requestSessionId,
        _operationContext: operationContext,
      }, operationContext);
    } catch (error) {
      console.error("Problem generation failed:", error);
      onGenerationError?.({
        source: "text",
        message: error.message,
        status: error.status,
        code: error.body?.code,
        usage: error.body?.usage,
        operationContext,
      });
      setInput(userMessage);
      setHistory(history);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleReset = () => {
    setHistory([]);
    setExpanded(false);
    setInput("");
    onReset?.();
    inputRef.current?.focus();
  };

  const userMessageCount = history.filter((message) => message.role === "user").length;
  const hasHistory = history.length > 0;

  return (
    <div className="flex w-full flex-col gap-2">
      {hasHistory && (
        <div className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.035] shadow-[0_14px_36px_rgba(0,0,0,0.18)]">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left font-sans text-xs text-slate-300/70 transition-colors hover:text-slate-100"
            >
              <span className="truncate">
                {userMessageCount} message{userMessageCount !== 1 ? "s" : ""} in tutor context
              </span>
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-rose-200/70 transition-colors hover:bg-rose-400/10 hover:text-rose-100"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          </div>

          {expanded && (
            <div className="omni-scrollbar flex max-h-36 flex-col gap-1.5 overflow-y-auto px-3 pb-3">
              {history.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <span
                    className={cn(
                      "max-w-[82%] rounded-xl px-3 py-1.5 text-xs leading-5",
                      message.role === "user"
                        ? "border border-teal-300/[0.18] bg-teal-300/[0.08] text-teal-50/80"
                        : "border border-white/[0.07] bg-white/[0.04] text-slate-300/70"
                    )}
                  >
                    {message.text}
                  </span>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 px-2 py-1 text-xs text-teal-200/70">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking...
                </div>
              )}
              <div ref={historyEndRef} />
            </div>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="omni-control flex min-h-12 flex-1 items-center gap-3 rounded-2xl px-4 transition-all duration-200">
          {hasHistory && (
            <span className="hidden shrink-0 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/60 sm:inline">
              Follow-up
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={hasHistory ? "Ask a follow-up or refine the solution..." : "Type a calculus problem, e.g. \\int_0^2 \\int_{x^2}^{4} (3x+2y) dy dx"}
            className="min-w-0 flex-1 bg-transparent font-serif text-[15px] italic text-cyan-50 outline-none placeholder:text-slate-500"
            style={{ caretColor: "rgb(94, 234, 212)" }}
            disabled={loading}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="omni-button flex min-h-12 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200 sm:min-w-[118px]"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {loading ? "Thinking..." : hasHistory ? "Send" : "Explain"}
        </button>
      </form>
    </div>
  );
}
