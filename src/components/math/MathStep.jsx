import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChevronDown } from "lucide-react";
import MathRenderer, { looksLikeMathExpression, splitLatexRenderBlocks } from "./MathRenderer";
import MathChunk from "./MathChunk";
import MathText from "./MathText";
import { useHoverActions, useHoverSemanticState } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";
import { markProgressiveStepInserted } from "@/lib/progressivePresentationDiagnostics";

// Only expose roles supplied by the solution; never classify from equation text.
const LINE_ROLES = {
  substitution: "Substitution", expansion: "Expansion", simplification: "Simplification",
  assumption: "Assumption", condition: "Condition", identity: "Identity",
  theorem: "Theorem", application: "Application", numerical_evaluation: "Evaluation",
  intermediate: "Intermediate result", derived_result: "Result", final_answer: "Final result",
  final: "Final result", warning: "Qualification", qualification: "Qualification",
};

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
  const renderableChunks = Array.isArray(step?.chunks)
    ? step.chunks.filter((chunk) => renderableTokenLatex(chunk))
    : [];
  if (renderableChunks.length > 0) {
    return {
      id: `${step.id || "step"}-line-1`,
      kind: "math",
      tokens: renderableChunks,
    };
  }

  if (typeof step?.math === "string" && step.math.trim()) {
    return {
      id: `${step.id || "step"}-line-1`,
      kind: "math",
      latex: step.math,
      tokens: [],
    };
  }

  if (typeof step?.summary === "string" && step.summary.trim()) {
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
    ? step.lines.filter((line) => (
      (typeof line?.text === "string" && line.text.trim())
      || (typeof line?.latex === "string" && line.latex.trim())
      || lineHasRenderableToken(line)
    ))
    : [];

  if (structuredLines.length > 0) return structuredLines;

  const fallback = fallbackLineFromStep(step);
  return fallback ? [fallback] : [];
}

// Each expression owns its overflow. Keeping the semantic chunk inside the
// scroller lets the existing geometry coordinator translate its painted owners.
export function MathExpressionScroll({ children, inline = false, className = "" }) {
  const Tag = inline ? "span" : "div";
  return (
    <Tag
      className={cn("math-render-shell math-render-shell-block omni-expression-scroll", inline && "omni-expression-scroll-inline", className)}
      tabIndex={0}
      role="region"
      aria-label="Mathematical expression; scroll horizontally if needed"
      data-math-shell="math"
    >
      {children}
    </Tag>
  );
}

function MathLineShell({ children }) {
  return (
    <MathExpressionScroll className="omni-solution-line omni-math-block font-serif text-[22px] italic leading-[2.35rem] text-neutral-950 md:text-[25px] md:leading-[2.75rem]">
      {children}
    </MathExpressionScroll>
  );
}

function MathInlineSegmentShell({ children }) {
  return (
    <MathExpressionScroll inline className="omni-equation-chain-segment font-serif text-[22px] italic leading-[2.35rem] text-neutral-950 md:text-[25px] md:leading-[2.75rem]">
      {children}
    </MathExpressionScroll>
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
    <p className="omni-solution-line omni-text-wrap-safe max-w-6xl text-base leading-8 text-neutral-600">
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
                isTextSeparator ? "text-neutral-600" : "text-neutral-400"
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

  useEffect(() => {
    if (
      !import.meta.env.DEV
      || import.meta.env.VITE_DEBUG_MATH_RENDER !== "true"
      || line?.role !== "final_answer"
    ) return;
    console.info("[omnimath:final-answer-render-boundary]", {
      stepId,
      lineId: line?.id || null,
      uiSelectedFinalAnswerLatex: line?.latex || singleTokenLatex || line?.text || "",
      tokenLatex: singleTokenLatex || null,
      selectedBlocks: hasTokens
        ? shouldSplitSingleToken ? singleTokenBlocks : [{ type: "math", latex: singleTokenLatex }]
        : line?.latex ? latexBlocks : textMathBlocks,
    });
  }, [hasTokens, latexBlocks, line?.id, line?.latex, line?.role, line?.text, shouldSplitSingleToken, singleTokenBlocks, singleTokenLatex, stepId, textMathBlocks]);

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
        className="omni-solution-line omni-equation-line flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2.5 gap-y-2 text-[22px] leading-[2.35rem] md:text-[25px] md:leading-[2.75rem]"
        data-line-role={line.role || "other"}
      >
        {showLineText && (
          <span className="omni-text-wrap-safe min-w-0 text-base leading-8 text-neutral-600">
            {line.text}
          </span>
        )}
        {tokens.map((token, tokenIndex) => (
          <MathExpressionScroll inline key={token.id || `${line.id || stepId}-token-${tokenIndex}`}>
            <MathChunk chunk={token} stepId={stepId} />
          </MathExpressionScroll>
        ))}
      </div>
    );
  }

  if ((line?.latex && latexBlocks.length === 0) || (textAsMath && textMathBlocks.length === 0)) {
    // A block split can normalize layout-only input to nothing. Keep that
    // position and send it through the real render-input diagnostic boundary.
    return (
      <MathLineShell>
        <MathRenderer math={line.latex || line.text} componentName="InteractiveMathLine.empty-split" />
      </MathLineShell>
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

function SolutionStepView({ step, index, requestId, progressive, selected, expanded, onSelect, onToggleExpanded, hoverSemantic, hoverActions }) {
  const articleRef = useRef(null);
  useLayoutEffect(() => {
    if (progressive && articleRef.current) {
      markProgressiveStepInserted({ requestId, stepId: step.id, element: articleRef.current });
    }
  }, [progressive, requestId, step.id]);
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
      ref={articleRef}
      data-state={state}
      data-solve-request-id={requestId || undefined}
      data-step-id={step.id || undefined}
      data-step-index={index}
      data-step-boundary-error={step.renderBoundaryError?.type || undefined}
      data-final-answer={isFinalAnswer ? "true" : undefined}
      onMouseLeave={handleStepLeave}
      className={cn(
        "step-card notebook-step group relative px-3 py-3.5 transition-colors duration-200 md:px-6 md:py-4",
        progressive && "omni-progressive-step",
        isFinalAnswer && "final-answer-step"
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          onClick={handleSelect}
          onKeyDown={handleKeyDown}
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 font-mono text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white",
            isFinalAnswer
              ? "border-neutral-300 bg-neutral-200 text-neutral-900"
              : selected || isActiveStep || hasWindow
              ? "border-neutral-300 bg-neutral-200 text-neutral-900"
              : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
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
              "block min-w-0 rounded-sm text-left text-base font-semibold leading-7 tracking-normal transition-colors hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white md:text-lg",
              "text-neutral-950"
            )}
          >
            <MathText>{title}</MathText>
          </button>

          <div className="omni-step-lines mt-2 grid min-w-0 max-w-full gap-4">
            {step.renderBoundaryError ? (
              <MathProseLine>This solution step was empty or malformed and could not be rendered.</MathProseLine>
            ) : lines.map((line, lineIndex) => (
              <div key={line.id || `${step.id}-line-${lineIndex}`} className="omni-step-line" data-presentation-role={line.role || step.role || undefined}>
                {LINE_ROLES[line.role] && <span className="omni-line-label">{LINE_ROLES[line.role]}</span>}
                <InteractiveMathLine line={line} stepId={step.id} />
              </div>
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
                className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-neutral-500 transition-colors hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
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
                  "omni-text-wrap-safe max-w-6xl border-l pl-3 text-sm leading-6",
                  isFinalAnswer
                    ? "border-neutral-400 text-neutral-700"
                    : "border-neutral-300 text-neutral-600"
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
    && previous.requestId === next.requestId
    && previous.progressive === next.progressive
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
