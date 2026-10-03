import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ChevronDown, Columns2, Eye, FileText, LayoutPanelTop } from "lucide-react";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal";
import { InteractiveMathLine } from "./MathStep";
import MathRenderer from "./MathRenderer";
import { normalizeMathRendererInput } from "./MathRenderer";
import MathText from "./MathText";
import SolutionFlow from "./SolutionFlow";
import WorkspaceCompareView from "./WorkspaceCompareView";
import { useHoverActions } from "@/lib/HoverContext";
import { annotateMathExplanation } from "@/lib/mathAnnotator";
import { classifyProblem, cleanLatexSnippet, getConciseProblemTitle, hasLatexSyntax } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import { getSolutionSteps, withNormalizedSolutionSteps } from "@/lib/solutionSteps";
import { cn } from "@/lib/utils";
import { recordOmniDiagnostic } from "@/lib/performanceDiagnostics";

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
        <div className="h-8 w-8 animate-pulse rounded-xl bg-neutral-200" />
        <div className="min-w-0 flex-1">
          <div className="h-3 w-20 animate-pulse rounded-full bg-neutral-200" />
          <div className="mt-2 h-4 w-48 max-w-full animate-pulse rounded-full bg-neutral-200/80" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="h-7 w-20 animate-pulse rounded-lg bg-neutral-200/80" />
        <div className="h-7 w-28 animate-pulse rounded-lg bg-neutral-200/80" />
        <div className="h-7 w-16 animate-pulse rounded-lg bg-neutral-200/80" />
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
  if (shouldPreviewCanonicalText) {
    lines.push({
      id: "problem-mixed-source",
      kind: "mixed",
      text: canonicalText,
      role: "problem",
    });
    return lines;
  }
  const expression = statementLineLatex(
    canonicalLatex
    || problem.extractedProblemLatex
    || problem.problemLatex
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
  const reviewAction = problem?.reviewAction || problem?.imageSource?.reviewAction || null;
  if (problem?.imageSource || problem?.extractedProblemText || problem?.extractedProblemLatex) {
    parts.push("From image OCR");
  }
  if (reviewAction?.kind === "edited") {
    parts.push("edited extraction");
  } else if (reviewAction?.kind === "confirmed_unchanged") {
    parts.push("reviewed extraction");
  } else if (problem?.imageSource || problem?.extractedProblemText || problem?.extractedProblemLatex) {
    parts.push("automated extraction");
  }
  const confidence = problem?.confidence ?? problem?.extractionValidation?.confidence;
  if (Number.isFinite(confidence)) parts.push(`${Math.round(confidence)}% confidence`);
  return parts.join(" · ");
}

function ProblemSummaryCard({ problem, lines, title }) {
  const [expanded, setExpanded] = useState(false);
  const sourceText = getProblemSourceText(problem);
  const subtitle = getProblemSubtitle(problem, sourceText);
  const metadata = getProblemMetadata(problem);
  const hasFullProblem = Boolean(sourceText || lines.length > 0);
  const showSubtitle = subtitle
    && subtitle.trim().toLowerCase() !== String(title || "").trim().toLowerCase();

  return (
    <div className="omni-problem-summary-card mt-2">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          {showSubtitle && (
            <p className="text-sm leading-6 text-neutral-600">
              {subtitle}
            </p>
          )}
          {metadata && (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-neutral-500">
              {metadata}
            </p>
          )}
        </div>
        {hasFullProblem && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
            aria-expanded={expanded}
          >
            <FileText className="h-4 w-4" />
            {expanded ? "Hide full problem" : "View full problem"}
            <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-4 grid gap-3 border-t border-neutral-200 pt-4">
          {sourceText && (
            <div className="rounded-xl bg-neutral-50 px-4 py-3">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
                Full problem text
              </p>
              <p className="omni-text-wrap-safe mt-2 whitespace-pre-wrap text-base leading-8 text-neutral-800">
                {sourceText}
              </p>
            </div>
          )}

          {lines.length > 0 && (
            <div className="rounded-xl bg-neutral-50 px-4 py-3">
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
                Math preview
              </p>
              <div className="mt-2 grid gap-3">
                {lines.map((line) => (
                  <div
                    key={line.id}
                    className={cn(
                      "min-w-0 max-w-full text-neutral-900",
                      line.kind === "mixed"
                        ? "omni-text-wrap-safe font-sans text-base not-italic leading-8"
                        : "font-serif text-[20px] italic leading-[2.2rem] md:text-[22px] md:leading-[2.45rem]"
                    )}
                  >
                    {line.kind === "mixed"
                      ? <MathText>{line.text}</MathText>
                      : <InteractiveMathLine line={line} stepId="full-problem-preview" />}
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

  const validation = problem.extractionValidation || problem.imageSource?.extractionValidation || null;
  const hasValidation = Boolean(validation && typeof validation === "object");
  const issues = Array.isArray(validation?.issues) ? validation.issues : [];
  const status = validation?.status || "unknown";
  const automatedDecision = problem.ocrSolveDecision || problem.imageSource?.ocrSolveDecision || null;
  const automatedReviewRequired = automatedDecision?.reviewRequired === true;
  const mathIntegrityScore = Number.isFinite(validation?.mathIntegrityScore)
    ? validation.mathIntegrityScore
    : Number.isFinite(validation?.confidence) ? validation.confidence : null;
  const ocrConfidence = Number.isFinite(validation?.ocrConfidence)
    ? validation.ocrConfidence
    : Number.isFinite(validation?.metrics?.ocrConfidence) ? validation.metrics.ocrConfidence : null;
  const isDanger = status === "danger";
  const isWarning = status === "warning";
  const StatusIcon = !hasValidation || automatedReviewRequired || isDanger || isWarning ? AlertTriangle : CheckCircle2;
  const statusLabel = !hasValidation
    ? "Extraction check unavailable"
    : automatedReviewRequired || isDanger
      ? "Automated check flagged review"
      : isWarning
        ? "Automated check: review suggested"
        : "Automated checks passed";
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
        ? "border-rose-200 bg-rose-50"
        : isWarning
          ? "border-amber-200 bg-amber-50"
          : "border-transparent bg-neutral-50"
    )}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
        <Eye className="h-3.5 w-3.5 text-neutral-500" />
        Extracted from image
        <span className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 normal-case tracking-normal",
          isDanger
            ? "border-rose-200 text-rose-700"
            : isWarning
              ? "border-amber-200 text-amber-700"
              : "border-emerald-200 text-emerald-700"
        )}>
          <StatusIcon className="h-3 w-3" />
          {statusLabel}
        </span>
        {ocrConfidence !== null && (
          <span className="font-mono text-[11px] normal-case tracking-normal text-neutral-500">
            OCR {ocrConfidence}%
          </span>
        )}
        {mathIntegrityScore !== null && (
          <span className="font-mono text-[11px] normal-case tracking-normal text-neutral-500">
            math integrity {mathIntegrityScore}%
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <p className="omni-text-wrap-safe text-sm leading-6 text-neutral-700">
          {classifyProblem(extractedText || extractedLatex, "Reviewed extracted problem")}
          {extractedText ? " · Full OCR text is available for review." : ""}
        </p>
        {(extractedText || shouldShowRenderedFallback || latexLine) && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-expanded={expanded}
          >
            {expanded ? "Hide OCR details" : "View OCR details"}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {expanded && extractedText && (
        <div className="mt-3 rounded-xl bg-white/70 px-3 py-2.5">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
            Full OCR text
          </p>
          <p className="omni-text-wrap-safe mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">
            {extractedText}
          </p>
        </div>
      )}

      {expanded && shouldShowRenderedFallback && (
        <div className="omni-problem-preview mt-3 rounded-xl bg-white/70 px-3 py-2 omni-scrollbar">
          <div className="flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-sm leading-7 text-neutral-800">
            {displaySegments.map((segment, index) => (
              segment.type === "math" ? (
                <span key={`math-${index}`} className="font-serif italic text-neutral-950">
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
        <div className="omni-problem-preview mt-2 rounded-xl bg-white/70 px-3 py-2 font-serif italic text-neutral-950 omni-scrollbar">
          <InteractiveMathLine line={latexLine} stepId="extracted-problem" />
        </div>
      )}

      {issues.length > 0 && (
        <ul className="mt-3 grid gap-1.5 text-xs leading-5 text-amber-800">
          {issues.slice(0, 4).map((issue, index) => (
            <li key={`${issue.type || "issue"}-${index}`} className="flex gap-2">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
              <span>{issue.message || "Review this extraction before trusting the solution."}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProblemBlock({ problem: rawProblem, loading = false }) {
  const progressiveAnnotationCache = useRef({ attemptId: "", steps: new Map() });
  const problem = useMemo(() => {
    try {
      const attemptId = rawProblem?.progressiveSolve?.attemptId;
      if (attemptId && rawProblem?.progressiveSolve?.mode === "progressive") {
        if (progressiveAnnotationCache.current.attemptId !== attemptId) {
          progressiveAnnotationCache.current = { attemptId, steps: new Map() };
        }
        const cache = progressiveAnnotationCache.current.steps;
        const base = annotateMathExplanation({ ...rawProblem, steps: [] });
        const steps = getSolutionSteps(rawProblem || {}).map((step, index) => {
          const cached = cache.get(step.id);
          if (cached?.source === step) return cached.annotated;
          const annotated = annotateMathExplanation({
            ...rawProblem,
            steps: [{ ...step, label: step.label || step.title || `Step ${index + 1}` }],
          }).steps[0];
          cache.set(step.id, { source: step, annotated });
          return annotated;
        });
        return { ...base, steps };
      }
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
  const solutionBoardRef = useRef(null);
  const scrollFollowRef = useRef(false);
  const programmaticScrollTargetRef = useRef(null);
  const lastScrollYRef = useRef(0);
  const lastPresentedStepRef = useRef(null);
  const lastPresentedAttemptRef = useRef(null);
  const [hasUnseenSteps, setHasUnseenSteps] = useState(false);
  const { settings, updateSetting } = useSettings();
  const {
    clearHoverLens,
  } = useHoverActions();
  const steps = useMemo(() => getSolutionSteps(problem), [problem]);
  const isProgressive = problem.progressiveSolve?.mode === "progressive";
  const progressiveStatus = problem.progressiveSolve?.status;
  const progressiveAttemptId = problem.progressiveSolve?.attemptId || null;
  const lastStepId = steps.at(-1)?.id || null;
  const scrollNearBottom = useCallback((threshold = 120) => (
    document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) <= threshold
  ), []);
  const latestStepIsBelowViewport = useCallback(() => {
    const board = solutionBoardRef.current;
    const latest = board?.querySelector(".omni-solution-flow [data-step-id]:last-child");
    return Boolean(latest && latest.getBoundingClientRect().bottom > window.innerHeight - 24);
  }, []);
  const scrollSolutionToLatest = useCallback(() => {
    const board = solutionBoardRef.current;
    const bottom = board
      ? window.scrollY + board.getBoundingClientRect().bottom
      : document.documentElement.scrollHeight;
    const top = Math.min(Math.max(0, document.documentElement.scrollHeight - window.innerHeight), Math.max(0, bottom - window.innerHeight + 24));
    // Dock clearance can make following the next step move slightly upward.
    // That alignment is still automatic following, not a reader scrolling back.
    programmaticScrollTargetRef.current = top;
    recordOmniDiagnostic("progressive.follow-scroll", { top, scrollY: window.scrollY });
    window.scrollTo({
      top,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, []);

  useEffect(() => {
    if (!isProgressive) return undefined;
    scrollFollowRef.current = scrollNearBottom();
    lastScrollYRef.current = window.scrollY;
    lastPresentedStepRef.current = lastStepId;
    programmaticScrollTargetRef.current = null;
    setHasUnseenSteps(false);

    const onScroll = () => {
      const nextY = window.scrollY;
      const movedUp = nextY < lastScrollYRef.current - 2;
      const programmatic = programmaticScrollTargetRef.current !== null;
      if (programmatic && Math.abs(nextY - programmaticScrollTargetRef.current) <= 2) programmaticScrollTargetRef.current = null;
      lastScrollYRef.current = nextY;
      if (movedUp && !programmatic) scrollFollowRef.current = false;
      else if (scrollNearBottom(24) && !document.querySelector("[data-pinned-lens]:hover, .omni-solution-flow [data-step-id]:hover")) {
        scrollFollowRef.current = true;
      }
      if (!latestStepIsBelowViewport()) setHasUnseenSteps(false);
      recordOmniDiagnostic("progressive.follow-scroll-event", { scrollY: nextY, movedUp, programmatic, following: scrollFollowRef.current });
    };
    const onReaderInteraction = (event) => {
      if (event.target instanceof Element && event.target.closest("[data-pinned-lens]")) {
        programmaticScrollTargetRef.current = null;
        scrollFollowRef.current = false;
      }
    };
    const onWheel = (event) => {
      programmaticScrollTargetRef.current = null;
      if (event.deltaY < 0) scrollFollowRef.current = false;
    };
    const onKeyDown = (event) => {
      programmaticScrollTargetRef.current = null;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) scrollFollowRef.current = false;
    };
    const onScrollEnd = () => { programmaticScrollTargetRef.current = null; };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", onScrollEnd, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onReaderInteraction, true);
    document.addEventListener("focusin", onReaderInteraction, true);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", onScrollEnd);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onReaderInteraction, true);
      document.removeEventListener("focusin", onReaderInteraction, true);
    };
  }, [isProgressive, latestStepIsBelowViewport, progressiveAttemptId, scrollNearBottom]);

  useLayoutEffect(() => {
    if (!isProgressive) return;
    if (lastPresentedAttemptRef.current !== progressiveAttemptId) {
      lastPresentedAttemptRef.current = progressiveAttemptId;
      lastPresentedStepRef.current = lastStepId;
      return;
    }
    if (!lastStepId) return;
    const priorStepId = lastPresentedStepRef.current;
    lastPresentedStepRef.current = lastStepId;
    if (priorStepId === lastStepId) return;
    recordOmniDiagnostic("progressive.follow-append", { lastStepId, following: scrollFollowRef.current, programmaticTarget: programmaticScrollTargetRef.current });
    if (scrollFollowRef.current && !document.querySelector("[data-pinned-lens]:hover, .omni-solution-flow [data-step-id]:hover")) {
      scrollSolutionToLatest();
    } else if (latestStepIsBelowViewport()) {
      setHasUnseenSteps(true);
    }
  }, [isProgressive, lastStepId, latestStepIsBelowViewport, progressiveAttemptId, scrollSolutionToLatest]);

  const pauseScrollFollow = useCallback(() => {
    programmaticScrollTargetRef.current = null;
    scrollFollowRef.current = false;
  }, []);
  const jumpToLatest = useCallback(() => {
    scrollFollowRef.current = true;
    setHasUnseenSteps(false);
    scrollSolutionToLatest();
  }, [scrollSolutionToLatest]);
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
  const solutionTitle = getConciseProblemTitle(problem, "Solution");
  const description = problem.description && hasLatexSyntax(problem.description)
    ? cleanLatexSnippet(problem.description, "", 90)
    : problem.description;
  const showDescription = description
    && description.trim().toLowerCase() !== solutionTitle.trim().toLowerCase();
  const selectionResetKey = problem.progressiveSolve?.mode === "progressive"
    ? `${problem.sessionId || ""}:${problem.progressiveSolve.attemptId}:${steps[0]?.id || ""}`
    : steps;

  useEffect(() => {
    const firstStepId = steps[0]?.id ?? null;
    setSelectedStepId(firstStepId);
    setExpandedStepIds(firstStepId ? { [firstStepId]: true } : {});
    setWorkspaceMode("board");
  }, [selectionResetKey]);

  const selectStep = useCallback((stepId) => {
    pauseScrollFollow();
    setSelectedStepId(stepId);
  }, [pauseScrollFollow]);

  const selectStepByOffset = (offset) => {
    if (steps.length === 0) return;
    pauseScrollFollow();
    const currentIndex = Math.max(0, steps.findIndex((step) => step.id === selectedStepId));
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), steps.length - 1);
    setSelectedStepId(steps[nextIndex].id);
  };

  const toggleStepExpanded = useCallback((stepId = selectedStepId) => {
    if (!stepId) return;
    pauseScrollFollow();
    setExpandedStepIds((current) => ({
      ...current,
      [stepId]: !current[stepId],
    }));
  }, [pauseScrollFollow, selectedStepId]);

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

  const hasProblemContent = Boolean(
    steps.length
    || hasExpression
    || getProblemSourceText(problem)
    || problem.extractedProblemText
    || problem.extractedProblemLatex
  );
  if (!loading && !hasProblemContent) return null;

  return (
    <section
      ref={solutionBoardRef}
      className="solution-board min-w-0 max-w-full overflow-x-hidden"
      onPointerOver={(event) => {
        if (!isProgressive) return;
        const hoveredStep = event.target instanceof Element
          ? event.target.closest("[data-step-id]")
          : null;
        if (hoveredStep) pauseScrollFollow();
      }}
      onFocusCapture={(event) => {
        if (isProgressive && event.target instanceof Element && event.target.closest("[data-step-id]")) {
          pauseScrollFollow();
        }
      }}
    >
      <div className="mb-3 grid gap-2">
        <div className="flex max-w-[96rem] flex-col gap-2 border-b border-neutral-200 pb-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 w-full max-w-full">
            <h2 className="text-xl font-semibold tracking-normal text-neutral-950 md:text-2xl">
              {solutionTitle}
            </h2>
            {showDescription && (
              <p className="omni-text-wrap-safe mt-1 max-w-5xl text-sm leading-6 text-neutral-600">
                {description}
              </p>
            )}
            {hasExpression ? (
              <ProblemSummaryCard problem={problem} lines={problemLines} title={solutionTitle} />
            ) : (
              <div className="mt-3 px-4 py-3 text-sm leading-6 text-neutral-600">
                Enter a problem or upload an image to begin.
              </div>
            )}
            <ExtractionReview problem={problem} />
          </div>
        </div>
      </div>

      {loading && steps.length === 0 ? (
        <div className="flex flex-col gap-3" aria-label="Generating solution steps">
          <StepSkeleton />
          <StepSkeleton />
          <StepSkeleton />
        </div>
      ) : steps.length === 0 ? (
        <div className="p-8 text-center text-sm text-neutral-500">
          No solution steps are available yet.
        </div>
      ) : (
        <>
          {problem.assurance?.version === "bounded-assurance-v1" && (
            <p className={cn(
              "mb-3 max-w-3xl rounded-md px-3 py-2 text-xs leading-relaxed",
              problem.assurance.status === "contradiction_detected"
                ? "border border-amber-500/50 bg-amber-950 text-amber-100"
                : "text-neutral-600",
            )} role={problem.assurance.status === "contradiction_detected" ? "alert" : "status"}>
              {{
                supported_checks_passed: "Checks passed for supported relations; the full solution was not independently proven.",
                inconclusive: "Mathematical verification was inconclusive for this solution.",
                not_checked: "This solution was not independently checked.",
                contradiction_detected: "A supported check found a contradiction. Review this solution before relying on it.",
              }[problem.assurance.status]}
            </p>
          )}
          <div className="mb-3 flex max-w-[96rem] flex-wrap gap-1.5 border-b border-neutral-200 pb-3">
            {[
              { key: "board", label: "Main board", icon: LayoutPanelTop },
              { key: "compare", label: "Compare Methods", icon: Columns2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setWorkspaceMode(key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400",
                  workspaceMode === key
                    ? "bg-neutral-200 text-neutral-900"
                    : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
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
              problem={problem}
              requestId={problem.requestId || problem.metadata?.requestId || ""}
              progressive={isProgressive}
              selectedStepId={selectedStepId}
              expandedStepIds={expandedStepIds}
              onSelect={selectStep}
              onToggleExpanded={toggleStepExpanded}
            />
          )}
          {isProgressive && workspaceMode === "board" && loading && (
            <div className="omni-progressive-status" role="status" aria-live="polite">
              <span className="omni-progressive-status-dot" aria-hidden="true" />
              Solving next step…
            </div>
          )}
          {isProgressive && workspaceMode === "board" && !loading && progressiveStatus === "failed" && (
            <div className="omni-progressive-status omni-progressive-status-stopped" role="status">
              Generation stopped before finishing. {steps.length} completed {steps.length === 1 ? "step remains" : "steps remain"} available.
            </div>
          )}
          {isProgressive && workspaceMode === "board" && !loading && progressiveStatus === "cancelled" && (
            <div className="omni-progressive-status omni-progressive-status-stopped" role="status">
              Generation cancelled. {steps.length} completed {steps.length === 1 ? "step remains" : "steps remain"} available.
            </div>
          )}
        </>
      )}
      {isProgressive && hasUnseenSteps && typeof document !== "undefined" && createPortal(
        <button type="button" className="omni-jump-to-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>,
        document.body
      )}
      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </section>
  );
}
