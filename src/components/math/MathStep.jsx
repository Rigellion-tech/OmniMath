import React, { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { MathRenderShell, looksLikeMathExpression, splitLatexRenderBlocks } from "./MathRenderer";
import MathChunk from "./MathChunk";
import MathText from "./MathText";
import { useHoverActions, useHoverSemanticState } from "@/lib/HoverContext";
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

function MathInlineSegmentShell({ children }) {
  return (
    <MathRenderShell
      displayMode={false}
      className="omni-equation-chain-segment font-serif text-[22px] italic leading-[2.35rem] text-cyan-50/92 md:text-[25px] md:leading-[2.75rem]"
    >
      {children}
    </MathRenderShell>
  );
}

function cleanMathBlockId(value = "math") {
  return String(value || "math")
    .replace(/\\/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    || "math";
}

function mathBlockChunk(latex, idHint, role = "equation") {
  const display = String(latex || "").trim();
  return {
    id: `rendered-${cleanMathBlockId(idHint)}-${cleanMathBlockId(display)}`,
    display,
    latex: display,
    text: display,
    role,
    short: "Math expression",
    medium: `${display} is the selected expression in this step.`,
    deep: `${display} is part of the rendered mathematical work for this step.`,
  };
}

function SemanticMathBlock({ latex, idHint, stepId, role = "equation" }) {
  const chunk = useMemo(
    () => mathBlockChunk(latex, `${idHint || "math"}-${stepId || "step"}`, role),
    [idHint, latex, role, stepId]
  );

  return (
    <MathChunk
      chunk={chunk}
      stepId={stepId}
    />
  );
}

function renderableTokenLatex(token) {
  return String(token?.display || token?.latex || token?.text || "").trim();
}

function MathProseLine({ children }) {
  return (
    <p className="omni-solution-line omni-text-wrap-safe max-w-6xl text-base leading-8 text-slate-300/78">
      {children}
    </p>
  );
}

function SplitMathBlocks({ blocks, idBase, stepId, displayMode }) {
  if (blocks.length === 1 && blocks[0].type === "math") {
    return (
      <MathLineShell>
        <SemanticMathBlock
          latex={blocks[0].latex}
          idHint={`${blocks[0].idHint || 0}-${idBase || "line"}`}
          stepId={stepId}
          role={displayMode ? "equation" : "expression"}
        />
      </MathLineShell>
    );
  }

  if (blocks.some((block) => block.type === "separator")) {
    return (
      <div className="omni-solution-line omni-equation-chain flex max-w-full flex-wrap items-center gap-x-3 gap-y-2">
        {blocks.map((block, blockIndex) => {
          const separatorText = String(block.text || "").trim();
          const isTextSeparator = /^(?:or|and)$/i.test(separatorText);
          return block.type === "math" ? (
            <MathInlineSegmentShell key={`${block.idHint || "math"}-${blockIndex}`}>
              <SemanticMathBlock
                latex={block.latex}
                idHint={`${block.idHint || blockIndex}-${idBase || "chain"}`}
                stepId={stepId}
                role="expression"
              />
            </MathInlineSegmentShell>
          ) : (
            <span
              key={`${block.idHint || "separator"}-${blockIndex}`}
              className={cn(
                "omni-equation-chain-separator font-serif text-lg leading-none md:text-xl",
                isTextSeparator ? "text-cyan-50/72" : "text-teal-200/65"
              )}
              aria-hidden={isTextSeparator ? undefined : "true"}
            >
              {isTextSeparator ? separatorText : "=>"}
            </span>
          )
        })}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      {blocks.map((block, blockIndex) => (
        block.type === "math" ? (
          <MathLineShell key={`${block.idHint || "math"}-${blockIndex}`}>
            <SemanticMathBlock
              latex={block.latex}
              idHint={`${block.idHint || blockIndex}-${idBase || "split"}`}
              stepId={stepId}
              role={displayMode ? "equation" : "expression"}
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
  const tokens = useMemo(
    () => (Array.isArray(line?.tokens) ? line.tokens : []),
    [line?.tokens]
  );
  const hasTokens = lineHasRenderableToken(line);
  const showLineText = shouldRenderLineText(line, tokens);
  const textAsMath = !hasTokens && !line?.latex && line?.text && looksLikeMathExpression(line.text);
  const singleTokenLatex = tokens.length === 1 ? renderableTokenLatex(tokens[0]) : "";
  const singleTokenBlocks = useMemo(
    () => (singleTokenLatex ? splitLatexRenderBlocks(singleTokenLatex) : []),
    [singleTokenLatex]
  );
  const latexBlocks = useMemo(
    () => (line?.latex ? splitLatexRenderBlocks(line.latex) : []),
    [line?.latex]
  );
  const textMathBlocks = useMemo(
    () => (textAsMath ? splitLatexRenderBlocks(line.text) : []),
    [line?.text, textAsMath]
  );
  const shouldSplitSingleToken = hasTokens
    && tokens.length === 1
    && !showLineText
    && singleTokenBlocks.some((block) => block.type === "separator");

  if (hasTokens) {
    if (shouldSplitSingleToken) {
      return (
        <SplitMathBlocks
          blocks={singleTokenBlocks}
          idBase={line.id || tokens[0]?.id || `${stepId}-token`}
          stepId={stepId}
          displayMode={line.kind === "block" || line.displayMode === true}
        />
      );
    }

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
    return (
      <SplitMathBlocks
        blocks={latexBlocks}
        idBase={line.id || `${stepId}-latex`}
        stepId={stepId}
        displayMode={line.kind === "block" || line.displayMode === true}
      />
    );
  }

  if (textAsMath) {
    return (
      <SplitMathBlocks
        blocks={textMathBlocks}
        idBase={line.id || `${stepId}-text`}
        stepId={stepId}
        displayMode
      />
    );
  }

  if (line?.text) {
    return <MathProseLine>{line.text}</MathProseLine>;
  }

  return null;
}

function SolutionStepView({ step, index, selected, expanded, onSelect, onToggleExpanded, hoverSemantic, hoverActions }) {
  const {
    activeStepId,
    openReferenceIds = [],
  } = hoverSemantic;
  const {
    clearSelectedConcept,
    handleStepLeave,
  } = hoverActions;
  const lines = useMemo(() => solutionLinesForStep(step), [step]);
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
      onMouseLeave={handleStepLeave}
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
                  <MathText diagnosticStepIndex={index}>{step.summary}</MathText>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function solutionStepHoverSignature(stepId, state = {}) {
  return [
    state.activeStepId === stepId,
    (state.openReferenceIds || []).includes(stepId),
  ].join("|");
}

function sameSolutionStepViewProps(previous, next) {
  return previous.step === next.step
    && previous.index === next.index
    && previous.selected === next.selected
    && previous.expanded === next.expanded
    && previous.onSelect === next.onSelect
    && previous.onToggleExpanded === next.onToggleExpanded
    && previous.hoverActions === next.hoverActions
    && solutionStepHoverSignature(previous.step?.id, previous.hoverSemantic)
      === solutionStepHoverSignature(next.step?.id, next.hoverSemantic);
}

SolutionStepView.displayName = "SolutionStep";
const MemoizedSolutionStepView = React.memo(SolutionStepView, sameSolutionStepViewProps);

export function SolutionStep(props) {
  const hoverSemantic = useHoverSemanticState();
  const hoverActions = useHoverActions();
  return (
    <MemoizedSolutionStepView
      {...props}
      hoverSemantic={hoverSemantic}
      hoverActions={hoverActions}
    />
  );
}

SolutionStep.displayName = "SolutionStepContextBridge";

export default SolutionStep;
