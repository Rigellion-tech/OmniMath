import React from "react";
import { ChevronDown } from "lucide-react";
import MathRenderer, { looksLikeMathExpression, splitLatexRenderBlocks } from "./MathRenderer";
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
    <div className="omni-solution-line omni-math-block font-serif text-[18px] italic leading-8 text-cyan-50/90 omni-scrollbar md:text-[20px]">
      {children}
    </div>
  );
}

function MathProseLine({ children }) {
  return (
    <p className="omni-solution-line max-w-3xl text-sm leading-7 text-slate-300/72">
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
        className="omni-solution-line omni-equation-line flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[18px] leading-[1.7] md:text-[20px]"
        data-line-role={line.role || "other"}
      >
        {showLineText && (
          <span className="text-sm leading-7 text-slate-300/70">
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
      className="step-card notebook-step group relative px-0 py-2.5 transition-colors duration-200"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <button
          type="button"
          onClick={handleSelect}
          onKeyDown={handleKeyDown}
          className={cn(
            "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm font-mono text-[10px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071116]",
            selected || isActiveStep || hasWindow
              ? "text-teal-100"
              : "text-slate-500/70 hover:text-teal-100"
          )}
          aria-label={`Select step ${index + 1}`}
        >
          {index + 1}
        </button>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={handleSelect}
            className="block min-w-0 rounded-sm text-left text-[15px] font-semibold leading-6 tracking-normal text-cyan-50/90 transition-colors hover:text-teal-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071116] sm:text-base"
          >
            <MathText>{step.label || step.title || `Step ${index + 1}`}</MathText>
          </button>

          <div className="mt-1.5 grid gap-1.5">
            {lines.map((line, lineIndex) => (
              <InteractiveMathLine
                key={line.id || `${step.id}-line-${lineIndex}`}
                line={line}
                stepId={step.id}
              />
            ))}
          </div>

          {selected && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleExpanded?.(step.id);
                }}
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[11px] text-slate-500/72 transition-colors hover:text-teal-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45"
                aria-expanded={expanded}
              >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                Reasoning
              </button>
            </div>
          )}

          {selected && expanded && (
            <div className="mt-2 grid gap-2">
              {step.summary && (
                <p className="max-w-3xl border-l border-teal-300/20 pl-3 text-sm leading-7 text-slate-300/72">
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
