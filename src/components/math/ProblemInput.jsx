import React, { useState, useRef, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Loader2, Sparkles, RotateCcw, ChevronDown, ChevronUp } from "lucide-react";

const JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    expression: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          chunks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                display: { type: "string" },
                short: { type: "string" },
                medium: { type: "string" },
                deep: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

function buildPrompt(history, newMessage) {
  const conversationBlock = history.length > 0
    ? `Previous conversation:\n${history.map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${m.text}`).join("\n")}\n\n`
    : "";

  return `You are an expert calculus tutor in an ongoing conversation with a student.

${conversationBlock}Student: "${newMessage}"

The student may be:
- Submitting a new math problem to solve
- Asking a follow-up question about the previous problem
- Providing clarification or additional context
- Asking you to go deeper on a specific step or concept

Based on the full conversation context above, generate or update the step-by-step breakdown accordingly.

For each step, split the math into small "chunks". For every chunk provide:
- short: a 3-6 word label
- medium: 1-2 sentences for an intermediate student
- deep: 2-4 sentences with full mathematical detail and intuition

Return a JSON object:
{
  "title": "short label (e.g. Differentiate, Double Integral, Limit)",
  "expression": "the core expression in LaTeX",
  "steps": [
    {
      "id": "step-0",
      "label": "step name",
      "chunks": [
        { "id": "s0-c0", "display": "LaTeX string", "short": "...", "medium": "...", "deep": "..." }
      ]
    }
  ]
}

Rules:
- id values must be unique (format "s{stepIndex}-c{chunkIndex}")
- Each step: 2-10 chunks, provide 4-7 steps total
- CRITICAL: "display" fields MUST be valid LaTeX (e.g. "\\frac{d}{dx}", "\\int_0^2", "2x", "+")
- "expression" must also be valid LaTeX
- Be thorough and mathematically rigorous`;
}

export default function ProblemInput({ onProblemGenerated }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);
  const historyEndRef = useRef(null);

  useEffect(() => {
    if (expanded && historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [history, expanded]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput("");
    setLoading(true);

    const newHistory = [...history, { role: "user", text: userMessage }];
    setHistory(newHistory);
    if (!expanded && newHistory.length > 1) setExpanded(true);

    const result = await base44.integrations.Core.InvokeLLM({
      prompt: buildPrompt(history, userMessage),
      response_json_schema: JSON_SCHEMA,
    });

    setHistory((prev) => [...prev, { role: "tutor", text: result.title || "Updated explanation" }]);
    setLoading(false);
    onProblemGenerated(result);
    inputRef.current?.focus();
  };

  const handleReset = () => {
    setHistory([]);
    setExpanded(false);
    setInput("");
    inputRef.current?.focus();
  };

  const hasHistory = history.length > 0;

  return (
    <div className="flex flex-col gap-1 w-full">
      {/* History thread (collapsible) */}
      {hasHistory && (
        <div
          className="rounded-lg overflow-hidden transition-all duration-300"
          style={{ background: "rgba(10,24,30,0.6)", border: "1px solid rgba(34,211,238,0.12)" }}
        >
          {/* Toggle header */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5 font-sans"
            style={{ fontSize: 10, color: "rgba(150,210,220,0.5)" }}
          >
            <span>{history.filter((m) => m.role === "user").length} message{history.filter((m) => m.role === "user").length !== 1 ? "s" : ""} in context</span>
            <div className="flex items-center gap-2">
              <span
                onClick={(e) => { e.stopPropagation(); handleReset(); }}
                className="flex items-center gap-1 hover:opacity-80 transition-opacity"
                style={{ color: "rgba(255,100,100,0.5)", cursor: "pointer" }}
              >
                <RotateCcw className="w-2.5 h-2.5" /> Reset
              </span>
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </div>
          </button>

          {/* Message list */}
          {expanded && (
            <div className="px-3 pb-2 flex flex-col gap-1 max-h-32 overflow-y-auto">
              {history.map((m, i) => (
                <div key={i} className={`flex gap-2 items-start ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <span
                    className="px-2 py-1 rounded-md font-sans"
                    style={{
                      fontSize: 11,
                      maxWidth: "80%",
                      background: m.role === "user" ? "rgba(34,211,238,0.1)" : "rgba(255,255,255,0.04)",
                      color: m.role === "user" ? "rgba(34,211,238,0.85)" : "rgba(150,210,220,0.55)",
                      border: m.role === "user" ? "1px solid rgba(34,211,238,0.2)" : "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    {m.text}
                  </span>
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-1.5 px-2 py-1" style={{ color: "rgba(34,211,238,0.4)", fontSize: 11 }}>
                  <Loader2 className="w-3 h-3 animate-spin" /> Thinking…
                </div>
              )}
              <div ref={historyEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Input row */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div
          className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg"
          style={{
            background: "rgba(10, 24, 30, 0.7)",
            border: hasHistory ? "1px solid rgba(34,211,238,0.3)" : "1px solid rgba(34,211,238,0.2)",
          }}
        >
          {hasHistory && (
            <span className="font-sans shrink-0" style={{ fontSize: 10, color: "rgba(34,211,238,0.4)" }}>
              Follow-up:
            </span>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={hasHistory ? "Ask a follow-up or refine the problem…" : "Type any calculus problem, e.g. ∫₀² ∫_{x²}^{4} (3x+2y) dy dx"}
            className="flex-1 bg-transparent outline-none font-serif italic"
            style={{ fontSize: 13, color: "hsl(185,60%,85%)", caretColor: "rgba(34,211,238,0.8)" }}
            disabled={loading}
          />
        </div>
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-sans font-semibold transition-all duration-200 shrink-0"
          style={{
            fontSize: 11,
            background: loading || !input.trim() ? "rgba(34,211,238,0.06)" : "rgba(34,211,238,0.15)",
            color: loading || !input.trim() ? "rgba(34,211,238,0.3)" : "rgba(34,211,238,0.9)",
            border: "1px solid rgba(34,211,238,0.25)",
          }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? "Thinking…" : hasHistory ? "Send" : "Explain"}
        </button>
      </form>
    </div>
  );
}