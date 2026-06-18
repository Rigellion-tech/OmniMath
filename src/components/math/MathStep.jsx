import React from "react";
import { ChevronDown } from "lucide-react";
import MathRenderer, { MathRenderShell, looksLikeMathExpression, splitLatexRenderBlocks } from "./MathRenderer";
import MathChunk from "./MathChunk";
import MathText from "./MathText";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

function lineHasRenderableToken(line) {
  return Array.isArray(line?.tokens)
    && line.tokens.some((token) => String(token?.display || token?.latex || token?.text || "").trim());
}

function normalizeEquationText(value) {
  return String(value || "")
    .replace(/\\left|\\right/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function shouldRenderLineText(line, tokens) {
  if (!line?.text) return false;

  const text = String(line.text).trim();
  const tokenText = tokens
    .map((token) => token?.display || token?.latex || token?.text || "")
    .join(" ");

  if (normalizeEquationText(text) === normalizeEquationText(tokenText)) return false;
  return !looksLikeMathExpression(text);
}

function fallbackLineFromStep(step) {
  if (Array.isArray(step?.chunks) && step.chunks.length > 0) {
    return {
      id: `${step.id || "step"}-line-1`,
      kind: "math",
      tokens: step.chunks,
    };
  }

  if (step?.math) {
    return {
      id: `${step.id || "step"}-line-1`,
      kind: "math",
      latex: step.math,
      tokens: [],
    };
  }

  if (step?.summary) {
    return {
      id: `${step.id || "step"}-line-1`,
      kind: "text",
      text: step.summary,
      tokens: [],
    };
  }

  return null;
}

function solutionLinesForStep(step) {
  const structuredLines = Array.isArray(step?.lines)
    ? step.lines.filter((line) => line?.text || line?.latex || lineHasRenderableToken(line))
    : [];

  if (structuredLines.length > 0) return structuredLines;

  const fallback = fallbackLineFromStep(step);
  return fallback ? [fallback] : [];
}

function MathLineShell({ children }) {
  return (
    <MathRenderShell className="omni-solution-line omni-math-block font-serif text-[22px] italic leading-[2.35rem] text-cyan-50/92 md:text-[25px] md:leading-[2.75rem]">
      {children}
    </MathRenderShell>
  );
}

function MathProseLine({ children }) {
  return (
    <p className="omni-solution-line omni-text-wrap-safe max-w-6xl text-base leading-8 text-slate-300/78">
      {children}
    </p>
  );
}

function SplitMathBlocks({ blocks, componentName, displayMode }) {
  if (blocks.length === 1 && blocks[0].type === "math") {
    return (
      <MathLineShell>
        <MathRenderer
          math={blocks[0].latex}
          displayMode={displayMode}
          componentName={componentName}
        />
      </MathLineShell>
    );
  }

  return (
    <div className="grid gap-1.5">
      {blocks.map((block, blockIndex) => (
        block.type === "math" ? (
          <MathLineShell key={`${block.idHint || "math"}-${blockIndex}`}>
            <MathRenderer
              math={block.latex}
              displayMode
              componentName={`${componentName}.split`}
            />
          </MathLineShell>
        ) : (
          <MathProseLine key={`${block.idHint || "text"}-${blockIndex}`}>
            {block.text}
          </MathProseLine>
        )
      ))}
    </div>
  );
}

export function InteractiveMathLine({ line, stepId }) {
  const tokens = Array.isArray(line?.tokens) ? line.tokens : [];
  const hasTokens = lineHasRenderableToken(line);
  const showLineText = shouldRenderLineText(line, tokens);
  const textAsMath = !hasTokens && !line?.latex && line?.text && looksLikeMathExpression(line.text);

  if (hasTokens) {
    return (
      <div
        className="math-render-shell math-render-shell-block omni-solution-line omni-equation-line flex max-w-full flex-wrap items-baseline gap-x-2.5 gap-y-2 text-[22px] leading-[2.35rem] md:text-[25px] md:leading-[2.75rem]"
        data-line-role={line.role || "other"}
      >
        {showLineText && (
          <span className="omni-text-wrap-safe min-w-0 text-base leading-8 text-slate-300/74">
            {line.text}
          </span>
        )}
        {tokens.map((token, tokenIndex) => (
          <MathChunk
            key={token.id || `${line.id || stepId}-token-${tokenIndex}`}
            chunk={token}
            stepId={stepId}
          />
        ))}
      </div>
    );
  }

  if (line?.latex) {
    const blocks = splitLatexRenderBlocks(line.latex);
    return (
      <SplitMathBlocks
        blocks={blocks}
        displayMode={line.kind === "block" || line.displayMode === true}
        componentName="InteractiveMathLine.latex"
      />
    );
  }

  if (textAsMath) {
    const blocks = splitLatexRenderBlocks(line.text);
    return (
      <SplitMathBlocks
        blocks={blocks}
        displayMode
        componentName="InteractiveMathLine.textAsMath"
      />
    );
  }

  if (line?.text) {
    return <MathProseLine>{line.text}</MathProseLine>;
  }

  return null;
}

export function SolutionStep({ step, index, selected, expanded, onSelect, onToggleExpanded }) {
  const {
    activeStepId,
    clearSelectedConcept,
    openReferenceIds = [],
  } = useHover();
  const lines = solutionLinesForStep(step);
  const isActiveStep = activeStepId === step.id;
  const hasWindow = openReferenceIds.includes(step.id);
  const state = isActiveStep ? "active" : selected ? "selected" : "idle";
  const title = step.label || step.title || `Step ${index + 1}`;
  const isFinalAnswer = /final\s+answer|answer$/iu.test(String(title || "")) || step.role === "final";

  const handleSelect = () => {
    clearSelectedConcept();
    onSelect?.(step.id);
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.key === " ") onToggleExpanded?.(step.id);
      else handleSelect();
    }
  };

  return (
    <article
      data-state={state}
      data-final-answer={isFinalAnswer ? "true" : undefined}
      className={cn(
        "step-card notebook-step group relative px-4 py-5 transition-colors duration-200 md:px-6 md:py-5",
        isFinalAnswer && "final-answer-step"
      )}
    >
      <div className="flex min-w-0 items-start gap-4">
        <button
          type="button"
          onClick={handleSelect}
          onKeyDown={handleKeyDown}
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.035] font-mono text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071116]",
            isFinalAnswer
              ? "border-emerald-300/35 bg-emerald-300/[0.09] text-emerald-50"
              : selected || isActiveStep || hasWindow
              ? "border-teal-300/30 bg-teal-300/[0.09] text-teal-50"
              : "text-slate-500/70 hover:text-teal-100"
          )}
          aria-label={`Select step ${index + 1}`}
        >
          {index + 1}
        </button>

        <div className="min-w-0 max-w-full flex-1">
          <button
            type="button"
            onClick={handleSelect}
            className={cn(
              "block min-w-0 rounded-sm text-left text-lg font-semibold leading-8 tracking-normal transition-colors hover:text-teal-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071116] md:text-xl",
              isFinalAnswer ? "text-emerald-50" : "text-cyan-50/94"
            )}
          >
            <MathText>{title}</MathText>
          </button>

          <div className="mt-3 grid min-w-0 max-w-full gap-4">
            {lines.map((line, lineIndex) => (
              <InteractiveMathLine
                key={line.id || `${step.id}-line-${lineIndex}`}
                line={line}
                stepId={step.id}
              />
            ))}
          </div>

          {selected && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExpanded?.(step.id);
                }}
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-slate-400/78 transition-colors hover:text-teal-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45"
                aria-expanded={expanded}
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                Reasoning
              </button>
            </div>
          )}

          {selected && expanded && (
            <div className="mt-3 grid gap-2">
              {step.summary && (
                <p className={cn(
                  "omni-text-wrap-safe max-w-6xl border-l pl-4 text-base leading-8",
                  isFinalAnswer
                    ? "border-emerald-300/30 text-emerald-50/82"
                    : "border-teal-300/22 text-slate-300/78"
                )}>
                  <MathText>{step.summary}</MathText>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export default SolutionStep;
