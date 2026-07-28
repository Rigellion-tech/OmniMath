import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Columns2, Eye, FileText, LayoutPanelTop } from "lucide-react";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal";
import { InteractiveMathLine } from "./MathStep";
import MathRenderer from "./MathRenderer";
import { normalizeMathRendererInput } from "./MathRenderer";
import SolutionFlow from "./SolutionFlow";
import WorkspaceCompareView from "./WorkspaceCompareView";
import { useHover } from "@/lib/HoverContext";
import { annotateMathExplanation } from "@/lib/mathAnnotator";
import { classifyProblem, cleanLatexSnippet, getProblemLabel, hasLatexSyntax } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import { getSolutionSteps, withNormalizedSolutionSteps } from "@/lib/solutionSteps";
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
  const canonicalText = problem.canonicalProblem?.canonicalText || "";
  const canonicalLatex = problem.canonicalProblem?.canonicalLatex || problem.imageSource?.canonicalProblem?.canonicalLatex || "";
  const shouldPreviewCanonicalText = canonicalText
    && !canonicalLatex
    && !problem.imageSource
    && !problem.extractedProblemText;
  const expression = statementLineLatex(
    canonicalLatex
    || problem.extractedProblemLatex
    || problem.problemLatex
    || (shouldPreviewCanonicalText ? canonicalText : "")
    || (!problem.imageSource && !problem.extractedProblemText ? problem.originalProblem : "")
    || (!problem.imageSource && !problem.extractedProblemText ? problem.problem : "")
    || problem.expression
  );
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

function getProblemSourceText(problem) {
  return String(
    problem?.canonicalProblem?.canonicalText
    || problem?.imageSource?.canonicalProblem?.canonicalText
    || problem?.imageSource?.finalProblemText
    || problem?.extractedProblemText
    || problem?.imageSource?.cleanedExtractedText
    || problem?.imageSource?.rawExtractedText
    || problem?.originalProblem
    || problem?.problem
    || problem?.problemLatex
    || problem?.expression
    || ""
  ).trim();
}

function getProblemSubtitle(problem, text = "") {
  const source = `${text} ${problem?.expression || ""} ${problem?.problemLatex || ""}`.toLowerCase();
  if (/ellipsoid|x\^2\/?4|y\^2\/?9|upper/.test(source)) return "Surface integral over upper ellipsoid cap";
  if (/paraboloid|z\s*=|9-x\^2-y\^2|9\s*-\s*x/.test(source)) return "Surface integral over upward-oriented paraboloid cap";
  if (/stokes|curl|\\nabla\s*\\times|\\oint/.test(source)) return "Boundary integral setup from a vector field";
  if (/green/.test(source)) return "Planar circulation or flux integral";
  if (/surface\s+integral|vector\s+field/.test(source)) return "Dense vector-calculus expression";
  return cleanLatexSnippet(text || problem?.title || "", "Reviewed math problem", 78);
}

function getProblemMetadata(problem) {
  const parts = [];
  if (problem?.imageSource || problem?.extractedProblemText || problem?.extractedProblemLatex) {
    parts.push("From image OCR");
  }
  if (problem?.imageSource?.solveDecision === "edited" || problem?.imageSource?.editedBeforeSolving) {
    parts.push("edited extraction");
  } else if (problem?.imageSource || problem?.extractedProblemText || problem?.extractedProblemLatex) {
    parts.push("reviewed extraction");
  }
  const confidence = problem?.confidence ?? problem?.extractionValidation?.confidence;
  if (Number.isFinite(confidence)) parts.push(`${Math.round(confidence)}% confidence`);
  return parts.join(" · ") || "Solved problem";
}

function ProblemSummaryCard({ problem, lines }) {
  const [expanded, setExpanded] = useState(false);
  const sourceText = getProblemSourceText(problem);
  const title = classifyProblem(problem, getProblemLabel(problem, "Math Problem"));
  const subtitle = getProblemSubtitle(problem, sourceText);
  const metadata = getProblemMetadata(problem);
  const hasFullProblem = Boolean(sourceText || lines.length > 0);

  return (
    <div className="omni-problem-summary-card mt-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-100/70">
            Problem summary
          </p>
          <h3 className="mt-1 text-xl font-semibold leading-7 text-cyan-50 md:text-2xl">
            {title}
          </h3>
          <p className="mt-1 text-base leading-7 text-slate-200/78">
            {subtitle}
          </p>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-slate-400/72">
            {metadata}
          </p>
        </div>
        {hasFullProblem && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-teal-300/[0.18] bg-teal-300/[0.055] px-3 text-sm font-semibold text-teal-50/88 transition-colors hover:bg-teal-300/[0.09] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45"
            aria-expanded={expanded}
          >
            <FileText className="h-4 w-4" />
            {expanded ? "Hide full problem" : "View full problem"}
            <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-4 grid gap-3 border-t border-white/[0.07] pt-4">
          {sourceText && (
            <div className="rounded-xl border border-white/[0.07] bg-black/15 px-4 py-3">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
                Full problem text
              </p>
              <p className="omni-text-wrap-safe mt-2 whitespace-pre-wrap text-base leading-8 text-slate-100/84">
                {sourceText}
              </p>
            </div>
          )}

          {lines.length > 0 && (
            <div className="rounded-xl border border-teal-300/[0.12] bg-teal-300/[0.035] px-4 py-3">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-100/62">
                Math preview
              </p>
              <div className="mt-2 grid gap-3">
                {lines.map((line) => (
                  <div
                    key={line.id}
                    className="min-w-0 max-w-full font-serif text-[20px] italic leading-[2.2rem] text-cyan-50/90 md:text-[22px] md:leading-[2.45rem]"
                  >
                    <InteractiveMathLine line={line} stepId="full-problem-preview" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExtractionReview({ problem }) {
  const [expanded, setExpanded] = useState(false);
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

      <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="omni-text-wrap-safe text-sm leading-6 text-slate-200/78">
          {classifyProblem(extractedText || extractedLatex, "Reviewed extracted problem")}
          {extractedText ? " · Full OCR text is available for review." : ""}
        </p>
        {(extractedText || shouldShowRenderedFallback || latexLine) && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 text-xs font-semibold text-slate-200/78 transition-colors hover:bg-white/[0.06] hover:text-teal-100"
            aria-expanded={expanded}
          >
            {expanded ? "Hide OCR details" : "View OCR details"}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {expanded && extractedText && (
        <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/15 px-3 py-2.5">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/55">
            Full OCR text
          </p>
          <p className="omni-text-wrap-safe mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200/82">
            {extractedText}
          </p>
        </div>
      )}

      {expanded && shouldShowRenderedFallback && (
        <div className="omni-problem-preview mt-3 rounded-xl border border-white/[0.06] bg-black/10 px-3 py-2 omni-scrollbar">
          <div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-7 text-slate-200/86">
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
                <span key={`text-${index}`} className="omni-text-wrap-safe">{segment.text}</span>
              )
            ))}
          </div>
        </div>
      )}

      {expanded && latexLine && (
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
      return annotateMathExplanation(withNormalizedSolutionSteps(rawProblem || {}));
    } catch (error) {
      console.error("Failed to annotate math explanation:", error, rawProblem);
      return withNormalizedSolutionSteps(rawProblem || {});
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
  const steps = useMemo(() => getSolutionSteps(problem), [problem]);
  useEffect(() => {
    logSolutionState("ProblemBlock props", {
      problemId: problem.id,
      sessionId: problem.sessionId,
      propStepCount: getSolutionSteps(rawProblem || {}).length,
      renderedStepCount: steps.length,
      loading,
    });
  }, [loading, problem.id, problem.sessionId, rawProblem, steps.length]);
  const selectedIndex = Math.max(0, steps.findIndex((step) => step.id === selectedStepId));
  const selectedStep = steps[selectedIndex] || steps[0] || null;
  const problemLines = useMemo(() => problemStatementLines(problem), [problem]);
  const hasExpression = problemLines.length > 0;
  const solutionTitle = getProblemLabel(problem, "Solution");
  const description = problem.description && hasLatexSyntax(problem.description)
    ? cleanLatexSnippet(problem.description, "", 90)
    : problem.description;

  useEffect(() => {
    const firstStepId = steps[0]?.id ?? null;
    setSelectedStepId(firstStepId);
    setExpandedStepIds(firstStepId ? { [firstStepId]: true } : {});
    setWorkspaceMode("board");
  }, [steps]);

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
      <div className="mb-6 grid gap-4">
        <div className="flex max-w-[96rem] flex-col gap-4 border-b border-white/[0.07] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 w-full max-w-full">
            <h2 className="text-2xl font-semibold tracking-normal text-cyan-50 md:text-3xl">
              {solutionTitle}
            </h2>
            {description && (
              <p className="omni-text-wrap-safe mt-2 max-w-5xl text-[15px] leading-7 text-slate-300/68">
                {description}
              </p>
            )}
            {hasExpression ? (
              <ProblemSummaryCard problem={problem} lines={problemLines} />
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
          <div className="mb-3 flex max-w-[96rem] flex-wrap gap-1.5 border-b border-white/[0.04] pb-3">
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
