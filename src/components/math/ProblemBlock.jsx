import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Columns2, Eye, LayoutPanelTop } from "lucide-react";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal";
import { InteractiveMathLine } from "./MathStep";
import MathRenderer from "./MathRenderer";
import { normalizeMathRendererInput } from "./MathRenderer";
import SolutionFlow from "./SolutionFlow";
import WorkspaceCompareView from "./WorkspaceCompareView";
import { useHover } from "@/lib/HoverContext";
import { annotateMathExplanation } from "@/lib/mathAnnotator";
import { cleanLatexSnippet, getProblemLabel, hasLatexSyntax } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

function StepSkeleton() {
  return (
    <div className="step-card rounded-2xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <div className="h-8 w-8 animate-pulse rounded-xl bg-teal-300/[0.09]" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-20 animate-pulse rounded-full bg-teal-300/[0.09]" />
          <div className="mt-2 h-4 w-48 max-w-full animate-pulse rounded-full bg-white/[0.06]" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="h-7 w-20 animate-pulse rounded-lg bg-white/[0.055]" />
        <div className="h-7 w-28 animate-pulse rounded-lg bg-white/[0.055]" />
        <div className="h-7 w-16 animate-pulse rounded-lg bg-white/[0.055]" />
      </div>
    </div>
  );
}

function statementLineLatex(line) {
  if (line === null || line === undefined) return "";
  if (typeof line === "string" || typeof line === "number" || typeof line === "boolean") {
    return normalizeMathRendererInput(String(line));
  }
  if (typeof line === "object") {
    return normalizeMathRendererInput(line.latex || line.math || line.expression || line.display || line.text || "");
  }
  return "";
}

function problemStatementLines(problem) {
  const lines = [];
  const expression = statementLineLatex(problem.originalProblem || problem.problem || problem.problemLatex || problem.expression);
  if (expression) {
    lines.push({
      id: "problem-expression",
      kind: "block",
      latex: expression,
      displayMode: true,
      role: "problem",
    });
  }

  if (!expression && Array.isArray(problem.statement)) {
    problem.statement.forEach((line, index) => {
      const latex = statementLineLatex(line);
      if (!latex) return;
      lines.push({
        id: `problem-statement-${index + 1}`,
        kind: "block",
        latex,
        displayMode: true,
        role: "problem",
      });
    });
  }

  return lines;
}

function ExtractionReview({ problem }) {
  const extractedText = problem.extractedProblemText || "";
  const extractedLatex = problem.extractedProblemLatex || "";
  const displaySegments = Array.isArray(problem.displaySegments)
    ? problem.displaySegments
    : Array.isArray(problem.imageSource?.displaySegments)
      ? problem.imageSource.displaySegments
      : [];
  if (!extractedText && !extractedLatex) return null;

  const validation = problem.extractionValidation || {};
  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  const status = validation.status || "ok";
  const mathIntegrityScore = Number.isFinite(validation.mathIntegrityScore)
    ? validation.mathIntegrityScore
    : Number.isFinite(validation.confidence) ? validation.confidence : null;
  const ocrConfidence = Number.isFinite(validation.ocrConfidence)
    ? validation.ocrConfidence
    : Number.isFinite(validation.metrics?.ocrConfidence) ? validation.metrics.ocrConfidence : null;
  const isDanger = status === "danger";
  const isWarning = status === "warning";
  const StatusIcon = isDanger || isWarning ? AlertTriangle : CheckCircle2;
  const statusLabel = isDanger ? "Review required" : isWarning ? "Review suggested" : "Extraction checked";
  const shouldShowRenderedFallback = !extractedText && displaySegments.length > 0;
  const latexLine = !extractedText && extractedLatex && displaySegments.length === 0
    ? {
        id: "extracted-problem-latex",
        kind: "block",
        latex: extractedLatex,
        displayMode: false,
        role: "problem",
      }
    : null;

  return (
    <div className={cn(
      "mt-4 rounded-2xl border px-4 py-3",
      isDanger
        ? "border-amber-300/25 bg-amber-300/[0.06]"
        : isWarning
          ? "border-teal-200/20 bg-teal-300/[0.045]"
          : "border-white/[0.08] bg-white/[0.035]"
    )}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-300/72">
        <Eye className="h-3.5 w-3.5 text-teal-200/75" />
        Extracted from image
        <span className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 normal-case tracking-normal",
          isDanger
            ? "border-amber-200/25 text-amber-100/90"
            : isWarning
              ? "border-teal-200/20 text-teal-100/85"
              : "border-emerald-200/20 text-emerald-100/85"
        )}>
          <StatusIcon className="h-3 w-3" />
          {statusLabel}
        </span>
        {ocrConfidence !== null && (
          <span className="font-mono text-[11px] normal-case tracking-normal text-slate-300/60">
            OCR {ocrConfidence}%
          </span>
        )}
        {mathIntegrityScore !== null && (
          <span className="font-mono text-[11px] normal-case tracking-normal text-slate-300/60">
            math integrity {mathIntegrityScore}%
          </span>
        )}
      </div>

      {extractedText && (
        <p className="mt-3 whitespace-pre-wrap break-normal text-sm leading-6 text-slate-200/82 [overflow-wrap:anywhere]">
          {extractedText}
        </p>
      )}

      {shouldShowRenderedFallback && (
        <div className="omni-problem-preview mt-3 rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2 omni-scrollbar">
          <div className="flex min-w-max flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-7 text-slate-200/86">
            {displaySegments.map((segment, index) => (
              segment.type === "math" ? (
                <span key={`math-${index}`} className="font-serif italic text-cyan-50/92">
                  <MathRenderer
                    math={segment.latex}
                    fallbackText={segment.fallbackText}
                    componentName="ExtractedProblem.segment"
                  />
                </span>
              ) : (
                <span key={`text-${index}`}>{segment.text}</span>
              )
            ))}
          </div>
        </div>
      )}

      {latexLine && (
        <div className="omni-problem-preview mt-2 rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2 font-serif italic text-cyan-50/92 omni-scrollbar">
          <InteractiveMathLine line={latexLine} stepId="extracted-problem" />
        </div>
      )}

      {issues.length > 0 && (
        <ul className="mt-3 grid gap-1.5 text-xs leading-5 text-amber-50/80">
          {issues.slice(0, 4).map((issue, index) => (
            <li key={`${issue.type || "issue"}-${index}`} className="flex gap-2">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-amber-200/70" />
              <span>{issue.message || "Review this extraction before trusting the solution."}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProblemBlock({ problem: rawProblem, loading = false }) {
  const problem = useMemo(() => {
    try {
      return annotateMathExplanation(rawProblem || {});
    } catch (error) {
      console.error("Failed to annotate math explanation:", error, rawProblem);
      return rawProblem || {};
    }
  }, [rawProblem]);
  const [selectedStepId, setSelectedStepId] = useState(problem.steps?.[0]?.id ?? null);
  const [expandedStepIds, setExpandedStepIds] = useState(() => (
    problem.steps?.[0]?.id ? { [problem.steps[0].id]: true } : {}
  ));
  const [workspaceMode, setWorkspaceMode] = useState("board");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const { settings, updateSetting } = useSettings();
  const {
    clearHoverLens,
  } = useHover();
  const steps = problem.steps ?? [];
  const selectedIndex = Math.max(0, steps.findIndex((step) => step.id === selectedStepId));
  const selectedStep = steps[selectedIndex] || steps[0] || null;
  const problemLines = useMemo(() => problemStatementLines(problem), [problem]);
  const hasExpression = problemLines.length > 0;
  const solutionTitle = getProblemLabel(problem, "Solution");
  const description = problem.description && hasLatexSyntax(problem.description)
    ? cleanLatexSnippet(problem.description, "", 90)
    : problem.description;

  useEffect(() => {
    const firstStepId = problem.steps?.[0]?.id ?? null;
    setSelectedStepId(firstStepId);
    setExpandedStepIds(firstStepId ? { [firstStepId]: true } : {});
    setWorkspaceMode("board");
  }, [problem]);

  const selectStep = (stepId) => {
    setSelectedStepId(stepId);
  };

  const selectStepByOffset = (offset) => {
    if (steps.length === 0) return;
    const currentIndex = Math.max(0, steps.findIndex((step) => step.id === selectedStepId));
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), steps.length - 1);
    setSelectedStepId(steps[nextIndex].id);
  };

  const toggleStepExpanded = (stepId = selectedStepId) => {
    if (!stepId) return;
    setExpandedStepIds((current) => ({
      ...current,
      [stepId]: !current[stepId],
    }));
  };

  useEffect(() => {
    if (!settings.productivity.keyboardShortcuts) return undefined;

    const handleKeyDown = (event) => {
      const target = event.target;
      const isTyping = target?.isContentEditable
        || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
      if (isTyping) return;

      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "Escape") {
        if (shortcutsOpen) setShortcutsOpen(false);
        clearHoverLens();
        return;
      }
      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        updateSetting("interaction", "hoverLens", (value) => !value);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        selectStepByOffset(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        toggleStepExpanded();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    clearHoverLens,
    selectedStepId,
    settings.productivity.keyboardShortcuts,
    shortcutsOpen,
    steps,
    updateSetting,
  ]);

  return (
    <section className="solution-board min-w-0 max-w-full overflow-x-hidden">
      <div className="mb-5 grid gap-4">
        <div className="flex flex-col gap-4 border-b border-white/[0.07] pb-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 w-full max-w-full">
            <h2 className="text-2xl font-semibold tracking-normal text-cyan-50 md:text-3xl">
              {solutionTitle}
            </h2>
            {description && (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300/66">
                {description}
              </p>
            )}
            {hasExpression ? (
              <div className="omni-problem-preview mt-4 grid gap-2 border-l border-teal-300/25 py-2 pl-4">
                {problemLines.map((line) => (
                  <div
                    key={line.id}
                    className="omni-math-block font-serif italic text-cyan-50/92 omni-scrollbar"
                  >
                    <InteractiveMathLine line={line} stepId="problem-statement" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-teal-300/[0.12] bg-teal-300/[0.045] px-4 py-3 text-sm leading-6 text-slate-300/62">
                Enter a problem or upload an image to begin.
              </div>
            )}
            <ExtractionReview problem={problem} />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3" aria-label="Generating solution steps">
          <StepSkeleton />
          <StepSkeleton />
          <StepSkeleton />
        </div>
      ) : steps.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-8 text-center text-sm text-slate-300/60">
          No solution steps are available yet.
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1.5 border-b border-white/[0.04] pb-2">
            {[
              { key: "board", label: "Main board", icon: LayoutPanelTop },
              { key: "compare", label: "Compare Methods", icon: Columns2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setWorkspaceMode(key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45",
                  workspaceMode === key
                    ? "bg-teal-300/[0.055] text-teal-50"
                    : "text-slate-400/72 hover:text-teal-100"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {workspaceMode === "compare" ? (
            <WorkspaceCompareView problem={problem} selectedStep={selectedStep} />
          ) : (
            <SolutionFlow
              steps={steps}
              selectedStepId={selectedStepId}
              expandedStepIds={expandedStepIds}
              onSelect={selectStep}
              onToggleExpanded={toggleStepExpanded}
            />
          )}
        </>
      )}
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </section>
  );
}
