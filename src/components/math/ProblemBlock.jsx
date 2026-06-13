import React, { useEffect, useMemo, useState } from "react";
import { Columns2, LayoutPanelTop } from "lucide-react";
import KeyboardShortcutsModal from "./KeyboardShortcutsModal";
import { InteractiveMathLine } from "./MathStep";
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
    <section className="solution-board min-w-0">
      <div className="mb-5 grid gap-4">
        <div className="flex flex-col gap-4 border-b border-white/[0.07] pb-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-normal text-cyan-50 md:text-3xl">
              {solutionTitle}
            </h2>
            {description && (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300/66">
                {description}
              </p>
            )}
            {hasExpression ? (
              <div className="mt-4 grid gap-2 border-l border-teal-300/25 py-2 pl-4">
                {problemLines.map((line) => (
                  <div
                    key={line.id}
                    className="max-w-full overflow-x-auto font-serif italic text-cyan-50/92 omni-scrollbar"
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
