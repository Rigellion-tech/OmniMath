import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Code2, Loader2, Pencil, RotateCcw, Sparkles } from "lucide-react";
import katex from "katex";
import { explainProblem } from "@/api/mathClient";
import { useAuthToken } from "@/lib/auth";
import { createCanonicalProblemPayload } from "@/lib/canonicalProblem";
import { MATH_SYMBOL_REGISTRY } from "@/lib/mathSymbolRegistry";
import { restorePrimaryComposerSource, serializePrimaryComposer } from "@/lib/primaryComposerSerialization";
import MathInputPalette from "@/components/math/MathInputPalette";
import VisualMathField from "@/components/math/VisualMathField";

const STRUCTURE_IDS = [
  "fraction", "power", "subscript", "subsup", "sqrt", "nthRoot", "derivative", "partialDerivative",
  "definiteIntegral", "indefiniteIntegral", "sumStructure", "productStructure", "limit", "matrixStructure",
  "cases", "system",
];

const DEBUG_SOLUTION_STATE = import.meta.env.DEV && import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true";

function logSolutionState(event, details = {}) {
  if (DEBUG_SOLUTION_STATE) console.info("[omnimath:solution-state]", { event, ...details });
}

function renderLatex(latex, displayMode = false) {
  if (!latex) return "";
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: true, strict: "ignore", trust: false, output: "html" });
  } catch {
    return "";
  }
}

function StructureButton({ item, onInsert, disabled }) {
  const markup = renderLatex(item.displayLatex || item.display || item.insertion);
  return (
    <button type="button" disabled={disabled} title={disabled ? "Switch to the visual editor to insert structures" : item.name} aria-label={`Insert ${item.name} structure`} onPointerDown={(event) => event.preventDefault()} onClick={() => onInsert(item)} className="omni-structure-button group flex min-h-11 min-w-[4.25rem] flex-col items-center justify-center rounded-xl border border-white/[0.07] bg-white/[0.025] px-2 py-1 text-cyan-50 transition hover:border-teal-300/35 hover:bg-teal-300/[0.08] focus:outline-none focus:ring-2 focus:ring-teal-300/20 disabled:cursor-not-allowed disabled:opacity-35">
      {markup ? <span className="omni-structure-symbol" aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="text-xs" aria-hidden="true">{item.name}</span>}
      <span className="mt-0.5 max-w-20 truncate text-[9px] text-slate-500 group-hover:text-slate-300">{item.name}</span>
    </button>
  );
}

function CompactProblem({ snapshot, onEdit, onActivate }) {
  const markup = renderLatex(snapshot?.canonicalLatex, false);
  if (!snapshot) {
    return (
      <button type="button" onClick={onActivate} className="flex min-h-12 w-full items-center justify-between gap-3 px-4 text-left" data-testid="primary-composer-activate">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-cyan-50">Compose a math problem</span>
          <span className="block truncate text-xs text-slate-400">Visual fractions, matrices, calculus, tensors, and more</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-teal-200/70" />
      </button>
    );
  }

  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="primary-composer-compact-problem">
      <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label="Edit submitted problem">
        {snapshot.displayText && <span className="max-w-[45%] truncate text-xs text-slate-300/70">{snapshot.displayText}</span>}
        {markup ? <span className="min-w-0 flex-1 truncate text-cyan-50" dangerouslySetInnerHTML={{ __html: markup }} /> : <span className="min-w-0 flex-1 truncate text-sm text-cyan-50">{snapshot.displayText || "Custom mathematical expression"}</span>}
      </button>
      <button type="button" onClick={onEdit} className="omni-button flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold"><Pencil className="h-3.5 w-3.5" />Edit</button>
    </div>
  );
}

function PrimaryComposerSession({
  activeSessionId = "",
  problem = null,
  history: controlledHistory,
  expanded,
  setExpanded,
  onHistoryChange,
  onReset,
  onProblemGenerated,
  onGenerationStart,
  onGenerationError,
  canApplyOperation,
}) {
  const restored = useMemo(() => restorePrimaryComposerSource(problem), []);
  const [prose, setProse] = useState(restored.prose);
  const [visualLatex, setVisualLatex] = useState(restored.visualLatex);
  const [rawLatex, setRawLatex] = useState(restored.rawLatex);
  const [sourceMode, setSourceMode] = useState(restored.sourceMode);
  const [modeError, setModeError] = useState("");
  const [inputError, setInputError] = useState("");
  const [submitted, setSubmitted] = useState(restored.submitted);
  const [loading, setLoading] = useState(false);
  const [localHistory, setLocalHistory] = useState([]);
  const [recentSymbols, setRecentSymbols] = useState([]);
  const mathfieldRef = useRef(null);
  const rawInputRef = useRef(null);
  const activeRequestRef = useRef(null);
  const mountedRef = useRef(true);
  const lastProblemHashRef = useRef(problem?.canonicalProblem?.hash || "");
  const { getToken } = useAuthToken();
  const history = controlledHistory ?? localHistory;
  const structures = useMemo(() => STRUCTURE_IDS.map((id) => MATH_SYMBOL_REGISTRY.find((item) => item.id === id)).filter(Boolean), []);
  const serialized = serializePrimaryComposer({ prose, visualLatex, rawLatex, sourceMode });

  const setHistory = (updater, ownership = {}) => {
    const nextHistory = typeof updater === "function" ? updater(history) : updater;
    if (onHistoryChange) onHistoryChange(nextHistory, ownership);
    else setLocalHistory(nextHistory);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const hash = problem?.canonicalProblem?.hash || "";
    if (!hash || hash === lastProblemHashRef.current) return;
    lastProblemHashRef.current = hash;
    const next = restorePrimaryComposerSource(problem);
    if (next.submitted) setSubmitted(next.submitted);
  }, [problem]);

  const activate = () => {
    if (!prose && !visualLatex && !rawLatex && submitted?.sourceMode === "external") setProse(submitted.canonicalText || submitted.displayText || "");
    setExpanded(true);
    requestAnimationFrame(() => mathfieldRef.current?.focus());
  };

  const insertItem = (item) => {
    if (sourceMode === "raw") {
      if (item.type === "structure") return;
      const field = rawInputRef.current;
      const insertion = item.editorInsertion || item.insertion;
      const start = field?.selectionStart ?? rawLatex.length;
      const end = field?.selectionEnd ?? rawLatex.length;
      setRawLatex(`${rawLatex.slice(0, start)}${insertion}${rawLatex.slice(end)}`);
      requestAnimationFrame(() => {
        field?.focus();
        field?.setSelectionRange(start + insertion.length, start + insertion.length);
      });
      return;
    }
    mathfieldRef.current?.insert(item.editorInsertion || item.insertion, item.insertOptions || {
      insertionMode: "replaceSelection",
      selectionMode: item.type === "structure" ? "placeholder" : "after",
    });
  };

  const handleModeChange = (mode) => {
    if (loading || mode === sourceMode) return;
    setModeError("");
    if (mode === "raw") {
      setRawLatex(visualLatex);
      setSourceMode("raw");
      requestAnimationFrame(() => rawInputRef.current?.focus());
      return;
    }
    if (!mathfieldRef.current?.trySetValue(rawLatex)) {
      setModeError("This custom source cannot be represented exactly by the visual editor. It remains preserved in Advanced LaTeX.");
      return;
    }
    setVisualLatex(rawLatex);
    setSourceMode("visual");
    requestAnimationFrame(() => mathfieldRef.current?.focus());
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    const currentLatex = mathfieldRef.current?.getValue() ?? visualLatex;
    const source = serializePrimaryComposer({ prose, visualLatex: currentLatex, rawLatex, sourceMode });
    if (source.isEmpty || activeRequestRef.current) return;
    // MathLive serializes unfilled structure slots as \placeholder{...}.
    // Check the live field before any canonical request, including after the
    // Solve button blurs the editor; React's last input event may lag behind.
    if (sourceMode === "visual" && (/\\placeholder(?:\[[^\]]*\])?\{[^}]*\}/.test(currentLatex) || mathfieldRef.current?.getErrors().length)) {
      setInputError("Fill the empty math slots and correct incomplete notation before solving.");
      mathfieldRef.current?.focus();
      return;
    }
    setInputError("");

    const requestSessionId = activeSessionId;
    const operationContext = onGenerationStart?.({ source: "text", problem: source.canonicalText, canonicalLatex: source.canonicalLatex, requestSessionId });
    const controller = new AbortController();
    const request = { controller, operationContext, requestSessionId, source };
    activeRequestRef.current = request;
    setLoading(true);
    const newHistory = [...history, { role: "user", text: source.canonicalText }];
    setHistory(newHistory, { operationContext, targetSessionId: requestSessionId });
    logSolutionState("visual submit", { canonicalText: source.canonicalText, canonicalLatex: source.canonicalLatex, requestSessionId });

    try {
      const result = await explainProblem({ problem: source.canonicalText, canonicalLatex: source.canonicalLatex, history, getToken, signal: controller.signal });
      if (activeRequestRef.current !== request || canApplyOperation?.(operationContext) === false) return;
      setHistory([...newHistory, { role: "tutor", text: result.title || "Updated explanation" }], { operationContext, targetSessionId: requestSessionId });
      onProblemGenerated({
        ...result,
        canonicalProblem: {
          ...(result.canonicalProblem || createCanonicalProblemPayload({ ...source, source: "typed" })),
          composerSourceMode: source.sourceMode,
        },
        _requestSessionId: requestSessionId,
        _operationContext: operationContext,
      }, operationContext);
      if (mountedRef.current) {
        setSubmitted(source);
        setExpanded(false);
      }
    } catch (error) {
      if (activeRequestRef.current !== request || canApplyOperation?.(operationContext) === false || error?.name === "AbortError") return;
      console.error("Problem generation failed:", error);
      onGenerationError?.({ source: "text", message: error.message, status: error.status, code: error.body?.code, usage: error.body?.usage, operationContext });
      setHistory(history, { operationContext, targetSessionId: requestSessionId });
    } finally {
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    }
  };

  const handleReset = () => {
    const activeRequest = activeRequestRef.current;
    activeRequestRef.current = null;
    activeRequest?.controller.abort();
    setLoading(false); setHistory([]); setProse(""); setVisualLatex(""); setRawLatex("");
    setSourceMode("visual"); setSubmitted(null); setExpanded(false); onReset?.();
  };

  const compactSnapshot = submitted || (!serialized.isEmpty ? serialized : null);

  return (
    <>
      {!expanded ? <CompactProblem snapshot={compactSnapshot} onActivate={activate} onEdit={activate} /> : (
        <form onSubmit={handleSubmit} className="omni-composer-workspace" data-testid="primary-composer-workspace">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
            <div>
              <p className="text-sm font-semibold text-cyan-50">Problem composer</p>
              <p className="text-[11px] text-slate-400">Write the prompt in words, then build its mathematics visually.</p>
            </div>
            <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-black/15 p-0.5" role="tablist" aria-label="Math source mode">
              <button type="button" disabled={loading} role="tab" aria-selected={sourceMode === "visual"} onClick={() => handleModeChange("visual")} className={`rounded-md px-2.5 py-1 text-[11px] disabled:opacity-40 ${sourceMode === "visual" ? "bg-teal-300/15 text-teal-100" : "text-slate-400"}`}>Visual</button>
              <button type="button" disabled={loading} role="tab" aria-selected={sourceMode === "raw"} onClick={() => handleModeChange("raw")} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] disabled:opacity-40 ${sourceMode === "raw" ? "bg-teal-300/15 text-teal-100" : "text-slate-400"}`}><Code2 className="h-3 w-3" />Advanced LaTeX</button>
            </div>
          </div>

          <div className="omni-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <label className="block">
              <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.14em] text-slate-400">Problem context (optional)</span>
              <textarea value={prose} onChange={(event) => setProse(event.target.value)} disabled={loading} rows={1} placeholder="Describe assumptions, boundary conditions, or what should be found…" className="omni-composer-prose w-full resize-y rounded-xl border border-white/[0.08] bg-black/15 px-3 py-2 text-sm leading-5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-teal-300/30" />
            </label>

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-slate-400">Mathematics</span>
                {sourceMode === "visual" && <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <span className="mr-1 hidden sm:inline">Space adds math spacing</span>
                  <button type="button" disabled={loading} onPointerDown={(event) => event.preventDefault()} onClick={() => mathfieldRef.current?.executeCommand(["switchMode", "text"])} className="rounded-md border border-white/[0.07] px-2 py-1 hover:bg-white/5 disabled:opacity-35" title="Type words and spaces in the math expression">Text mode</button>
                  <button type="button" disabled={loading} onPointerDown={(event) => event.preventDefault()} onClick={() => mathfieldRef.current?.executeCommand(["switchMode", "math"])} className="rounded-md border border-white/[0.07] px-2 py-1 hover:bg-white/5 disabled:opacity-35" title="Continue typing mathematics">Math mode</button>
                </div>}
              </div>
              <div className={sourceMode === "visual" ? "block" : "hidden"} aria-hidden={sourceMode !== "visual"}>
                <VisualMathField ref={mathfieldRef} value={visualLatex} onChange={(value) => { setVisualLatex(value); setInputError(""); }} onPasteError={setInputError} disabled={loading} onSubmit={handleSubmit} />
              </div>
              {sourceMode === "raw" && (
                <div>
                  <textarea ref={rawInputRef} aria-label="Advanced raw LaTeX source" data-testid="primary-raw-latex" value={rawLatex} onChange={(event) => setRawLatex(event.target.value)} disabled={loading} rows={5} spellCheck={false} placeholder="Enter specialist or custom LaTeX source" className="omni-scrollbar min-h-28 w-full resize-y rounded-xl border border-amber-200/[0.16] bg-black/25 px-3 py-2 font-mono text-sm leading-6 text-amber-50 outline-none focus:border-amber-200/35" />
                  <p className="mt-1 text-[10px] text-slate-500">Advanced source is preserved as entered. Its preview may be unavailable for custom commands.</p>
                  {modeError && <p role="alert" className="mt-1 text-[10px] text-amber-200/85">{modeError}</p>}
                </div>
              )}
              {inputError && <p role="alert" className="mt-2 text-xs text-amber-200">{inputError}</p>}
            </div>

            <div className="mt-3">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-400">Common structures</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {sourceMode === "visual" && <>
                    <button type="button" disabled={loading} onPointerDown={(event) => event.preventDefault()} onClick={() => mathfieldRef.current?.executeCommand("addRowAfter")} className="rounded-lg border border-white/[0.07] px-2 py-1.5 text-[10px] text-slate-300 hover:bg-white/5 disabled:opacity-35">Add row</button>
                    <button type="button" disabled={loading} onPointerDown={(event) => event.preventDefault()} onClick={() => mathfieldRef.current?.executeCommand("addColumnAfter")} className="rounded-lg border border-white/[0.07] px-2 py-1.5 text-[10px] text-slate-300 hover:bg-white/5 disabled:opacity-35">Add column</button>
                  </>}
                  <MathInputPalette disabled={loading} structuresEnabled={sourceMode === "visual"} recent={recentSymbols} onRecent={(id) => setRecentSymbols((items) => [id, ...items.filter((item) => item !== id)].slice(0, 16))} onInsert={insertItem} />
                </div>
              </div>
              <div className="omni-structure-strip omni-scrollbar flex gap-1.5 overflow-x-auto pb-1" aria-label="Common mathematical structures">
                {structures.map((item) => <StructureButton key={item.id} item={item} onInsert={insertItem} disabled={loading || sourceMode === "raw"} />)}
              </div>
            </div>
          </div>
        </form>
      )}

      <div className="omni-composer-actions flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2">
        <div className="ml-auto flex items-center gap-2">
          {(submitted || prose || visualLatex || rawLatex) && <button type="button" disabled={loading} onClick={handleReset} className="flex min-h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs text-slate-400 hover:bg-rose-400/10 hover:text-rose-100"><RotateCcw className="h-3.5 w-3.5" />Reset</button>}
          {expanded && <>
            <button type="button" disabled={loading} onClick={() => setExpanded(false)} className="min-h-9 rounded-xl px-3 text-xs font-semibold text-slate-400 hover:bg-white/5 hover:text-slate-100 disabled:opacity-40">Collapse</button>
            <button type="button" disabled={loading || serialized.isEmpty} onClick={handleSubmit} className="omni-button flex min-h-10 min-w-[108px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold" data-testid="primary-composer-solve">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{loading ? "Solving…" : "Solve"}</button>
          </>}
        </div>
      </div>
    </>
  );
}

// The session-keyed editing state and the image workflow have separate lifetimes.
// ImageUpload must remain mounted across session changes so in-flight OCR retains
// its origin session, cancellation controller, and review state.
export default function PrimaryMathComposer(props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [props.activeSessionId]);
  return (
    <section className={`omni-primary-composer ${expanded ? "is-expanded" : "is-collapsed"}`} data-testid="primary-math-composer" data-composer-state={expanded ? "expanded" : "collapsed"}>
      <PrimaryComposerSession key={props.activeSessionId} {...props} expanded={expanded} setExpanded={setExpanded} />
      <div className="omni-primary-upload" data-testid="primary-image-upload-slot">{props.imageUpload}</div>
    </section>
  );
}
