import React, { useEffect, useMemo, useRef } from "react";
import InlineMath from "./InlineMath";
import { getConceptForChunk } from "@/data/conceptGraph";
import { useHover } from "@/lib/HoverContext";
import { userFacingTooltipTitle } from "@/lib/presentationLabels";
import { cn } from "@/lib/utils";

const OPERATOR_PATTERN = /^(=|\+|-|\\le|\\ge|<=|>=|<|>|\\cdot|\u00b7|,|\(|\)|\\Rightarrow|\\to)$/;
const noop = () => {};
const LARGE_ANNOTATED_CHUNK_CHARS = 48;

function safeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    return String(value.latex || value.display || value.text || fallback);
  }
  return String(value);
}

function safeList(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRenderableToken(token, fallbackId) {
  if (token && typeof token === "object") {
    return {
      ...token,
      id: safeText(token.id, fallbackId),
      display: safeText(token.display || token.latex || token.text),
      latex: safeText(token.latex || token.display || token.text),
      text: safeText(token.text || token.display || token.latex),
      role: safeText(token.role, "other"),
      short: safeText(token.short || token.explanation || token.display || token.latex, "Math token"),
      relatedTokenIds: safeList(token.relatedTokenIds),
      children: safeList(token.children).filter(Boolean),
      parts: safeList(token.parts).filter(Boolean),
    };
  }

  const display = safeText(token);
  return {
    id: fallbackId,
    display,
    latex: display,
    text: display,
    role: "other",
    short: display || "Math token",
    relatedTokenIds: [],
    children: [],
    parts: [],
  };
}

function tokenHitboxWeight(token) {
  if (isOperatorToken(token)) return 0.7;
  const compact = safeText(token?.display || token?.latex || token?.text)
    .replace(/\\[a-zA-Z]+/g, "x")
    .replace(/[{}()[\]]/g, "");
  return Math.max(1, Math.min(8, compact.length || 1));
}

function isOperatorToken(token) {
  return token?.role === "operator" || OPERATOR_PATTERN.test(String(token?.display || token?.latex || "").trim());
}

function isLargeAnnotatedToken(token, parts = []) {
  const compact = safeText(token?.display || token?.latex || token?.text).replace(/\s+/g, "");
  return parts.length > 2 && compact.length > LARGE_ANNOTATED_CHUNK_CHARS;
}

function isPowerToken(token) {
  return token?.role === "power" && /\^/.test(String(token?.latex || token?.display || ""));
}

function isFractionToken(token, children = []) {
  return token?.role === "fraction"
    || (
      children.length >= 2
      && children[0]?.role === "numerator"
      && children[1]?.role === "denominator"
    );
}

function isFunctionToken(token, children = []) {
  return token?.role === "function"
    && children.length >= 1
    && children[0]?.role === "function";
}

function MathSubToken({ part, parentChunk, stepId, depth = 0, tokenClassName = "" }) {
  const safePart = useMemo(
    () => normalizeRenderableToken(part, `subtoken-${stepId || "step"}-${depth}`),
    [depth, part, stepId]
  );
  const safeParentChunk = useMemo(
    () => normalizeRenderableToken(parentChunk, `parent-${stepId || "step"}`),
    [parentChunk, stepId]
  );
  const {
    activeChunkId,
    activeChunkData,
    inspectedConceptId,
    relatedConceptIds = [],
    pinnedChunkIds = [],
    openReferenceIds = [],
    handleChunkEnter = noop,
    handleChunkMove = noop,
    handleChunkLeave = noop,
    handleChunkRightClick = noop,
    selectChunk = noop,
    registerToken = noop,
    beginTokenSelection = noop,
    extendTokenSelection = noop,
    finishTokenSelection = noop,
    selectedTokenIds = [],
  } = useHover() || {};
  const concept = getConceptForChunk(safePart);
  const isActive = activeChunkId === safePart.id;
  const isConceptActive = concept?.id && concept.id === inspectedConceptId;
  const isConceptRelated = concept?.id && safeList(relatedConceptIds).includes(concept.id);
  const isExplicitlyRelated = safeList(activeChunkData?.relatedTokenIds).includes(safePart.id)
    || safePart.relatedTokenIds.includes(activeChunkId)
    || safePart.relatedTokenIds.includes(safeParentChunk.id);
  const isPinned = safeList(pinnedChunkIds).includes(safePart.id);
  const hasWindow = safeList(openReferenceIds).includes(safePart.id);
  const isSelected = safeList(selectedTokenIds).includes(safePart.id);
  const childParts = safePart.children;
  const hasChildParts = childParts.length > 0;
  const isPowerGroup = isPowerToken(safePart) && childParts.length >= 2;
  const isFractionGroup = isFractionToken(safePart, childParts);
  const isFunctionGroup = isFunctionToken(safePart, childParts);
  const isGroupActive = hasChildParts && (isActive || isPinned || hasWindow || isConceptActive);
  const canRecurse = depth < 8;
  const hitboxWeight = tokenHitboxWeight(safePart);
  const parentExpression = safeParentChunk.display || safeParentChunk.latex || safeParentChunk.text || "";
  const inspectablePart = useMemo(() => ({
    ...safePart,
    parentExpression,
    parentTokenId: safeParentChunk.id,
  }), [parentExpression, safeParentChunk.id, safePart]);
  const isDirectSubTokenTarget = (event) => {
    const closestToken = typeof Element !== "undefined" && event.target instanceof Element
      ? event.target.closest("[data-subtoken='true']")
      : null;
    return closestToken === event.currentTarget;
  };
  const accessibleTitle = userFacingTooltipTitle({
    title: safePart.short,
    selectedText: safePart.display || safePart.text,
    display: safePart.display,
    latex: safePart.latex,
    role: safePart.role,
  });

  const handleEnter = (event) => {
    event.stopPropagation();
    if (!isDirectSubTokenTarget(event)) return;
    extendTokenSelection(inspectablePart, stepId);
    handleChunkEnter(inspectablePart, stepId, event);
  };

  const handleMove = (event) => {
    event.stopPropagation();
    if (!isDirectSubTokenTarget(event)) return;
    if (activeChunkId !== safePart.id) {
      handleChunkEnter(inspectablePart, stepId, event);
    }
    handleChunkMove(event);
  };

  const handleLeave = (event) => {
    event.stopPropagation();
    handleChunkLeave(event);
  };

  const handleFocus = (event) => {
    handleChunkEnter(inspectablePart, stepId, event);
  };

  const handleBlur = (event) => {
    handleChunkLeave(event);
  };

  useEffect(() => registerToken(inspectablePart, stepId), [registerToken, inspectablePart, stepId]);

  return (
    <span
      data-subtoken="true"
      data-token-id={safePart.id}
      data-token-latex={safePart.latex}
      data-token-depth={depth}
      data-token-role={safePart.role || "other"}
      data-explainable="true"
      data-inspectable="math-subtoken"
      tabIndex={0}
      aria-label={accessibleTitle}
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onMouseDown={(event) => beginTokenSelection(inspectablePart, stepId, event)}
      onMouseUp={finishTokenSelection}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={(event) => {
        event.stopPropagation();
        selectChunk(inspectablePart, stepId);
      }}
      onContextMenu={(event) => {
        event.stopPropagation();
        handleChunkRightClick(inspectablePart, stepId, event);
      }}
      className={cn(
        "math-subtoken explainable-token relative inline-block cursor-help rounded-sm transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45",
        hasChildParts ? "math-subtoken-group px-0.5 pb-0.5 pt-0" : "math-subtoken-leaf px-0.5",
        isPowerGroup && "math-power-group",
        isFractionGroup && "math-fraction-group",
        isFunctionGroup && "math-function-group",
        isOperatorToken(safePart) && "math-subtoken-operator",
        isSelected && "omni-token-selected",
        isGroupActive && "math-subtoken-group-active",
        (isConceptRelated || isExplicitlyRelated) && !isConceptActive && "omni-related-subtoken",
        tokenClassName
      )}
      style={{
        transform: `translateY(calc(var(--math-subtoken-offset-y, 0em) + ${
          isActive || isConceptActive || isPinned || hasWindow ? "-1px" : "0px"
        }))`,
        color: isActive || isConceptActive || isPinned || hasWindow ? "#ccfbf1" : "inherit",
        textDecorationLine: isActive || isConceptActive || isPinned || hasWindow ? "underline" : "none",
        textDecorationColor: "rgba(94, 234, 212, 0.55)",
        textUnderlineOffset: "0.18em",
        flex: `${hitboxWeight} 1 0`,
        filter: isActive || isConceptActive || isPinned || hasWindow
          ? "drop-shadow(0 0 8px rgba(45, 212, 191, 0.42))"
          : "none",
      }}
    >
      {isPowerGroup && canRecurse ? (
        <span className="math-power-layout">
          <MathSubToken
            part={childParts[0]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-power-base"
          />
          <MathSubToken
            part={childParts[1]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-power-exponent"
          />
          {childParts.slice(2).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-child-${index + 2}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
            />
          ))}
        </span>
      ) : isFractionGroup && canRecurse ? (
        <span className="math-fraction-layout">
          <span className="math-fraction-row math-fraction-num">
            <MathSubToken
              part={childParts[0]}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-fraction-part"
            />
          </span>
          <span className="math-fraction-rule" aria-hidden="true" />
          <span className="math-fraction-row math-fraction-den">
            <MathSubToken
              part={childParts[1]}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-fraction-part"
            />
          </span>
          {childParts.slice(2).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-child-${index + 2}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
            />
          ))}
        </span>
      ) : isFunctionGroup && canRecurse ? (
        <span className="math-function-layout">
          <MathSubToken
            part={childParts[0]}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
            tokenClassName="math-function-name"
          />
          {childParts.slice(1).map((child, index) => (
            <MathSubToken
              key={child.id || `${safePart.id}-arg-${index + 1}`}
              part={child}
              parentChunk={safePart}
              stepId={stepId}
              depth={depth + 1}
              tokenClassName="math-function-argument"
            />
          ))}
        </span>
      ) : hasChildParts && canRecurse ? (
        childParts.map((child, index) => (
          <MathSubToken
            key={child.id || `${safePart.id}-child-${index}`}
            part={child}
            parentChunk={safePart}
            stepId={stepId}
            depth={depth + 1}
          />
        ))
      ) : (
        <InlineMath math={safePart.display} className="font-serif italic" />
      )}
      {(isPinned || hasWindow) && (
        <span
          className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-teal-200 shadow-[0_0_8px_rgba(94,234,212,0.8)]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function MathChunk({ chunk, stepId }) {
  const tokenRef = useRef(null);
  const safeChunk = useMemo(
    () => normalizeRenderableToken(chunk, `chunk-${stepId || "step"}`),
    [chunk, stepId]
  );
  const {
    activeChunkId,
    activeChunkData,
    inspectedConceptId,
    relatedConceptIds = [],
    pinnedChunkIds = [],
    openReferenceIds = [],
    handleChunkEnter = noop,
    handleChunkMove = noop,
    handleChunkLeave = noop,
    handleChunkRightClick = noop,
    selectChunk = noop,
    registerToken = noop,
    beginTokenSelection = noop,
    extendTokenSelection = noop,
    finishTokenSelection = noop,
    selectedTokenIds = [],
  } = useHover() || {};

  const concept = getConceptForChunk(safeChunk);
  const isActive = activeChunkId === safeChunk.id;
  const isConceptActive = concept?.id && concept.id === inspectedConceptId;
  const isConceptRelated = concept?.id && safeList(relatedConceptIds).includes(concept.id);
  const isExplicitlyRelated = safeList(activeChunkData?.relatedTokenIds).includes(safeChunk.id);
  const isPinned = safeList(pinnedChunkIds).includes(safeChunk.id);
  const hasWindow = safeList(openReferenceIds).includes(safeChunk.id);
  const isSelected = safeList(selectedTokenIds).includes(safeChunk.id);
  const accessibleTitle = userFacingTooltipTitle({
    title: safeChunk.short,
    selectedText: safeChunk.display || safeChunk.text,
    display: safeChunk.display,
    latex: safeChunk.latex,
    role: safeChunk.role,
  });
  const isSiblingActive = activeChunkId && activeChunkId !== safeChunk.id;
  const mathColor = isActive || isConceptActive || isPinned || hasWindow ? "#ccfbf1" : "rgba(224, 242, 254, 0.9)";
  const parts = safeChunk.parts;
  const hasParts = parts.length > 0;
  const isOperator = isOperatorToken(safeChunk);
  const deferToSubTokens = isLargeAnnotatedToken(safeChunk, parts);

  const handleClick = (event) => {
    event.stopPropagation();
    selectChunk(safeChunk, stepId);
  };

  useEffect(() => {
    if (hasParts) return undefined;
    const node = tokenRef.current;
    if (!node) return undefined;

    const handleNativeEnter = (event) => {
      node.dataset.hoverActive = "true";
      extendTokenSelection(safeChunk, stepId);
      handleChunkEnter(safeChunk, stepId, event);
    };

    const handleNativeMove = (event) => {
      const shouldActivate = node.dataset.hoverActive !== "true" || activeChunkId !== safeChunk.id;
      node.dataset.hoverActive = "true";
      if (shouldActivate) {
        handleChunkEnter(safeChunk, stepId, event);
      }
      handleChunkMove(event);
    };

    const handleNativeLeave = (event) => {
      node.dataset.hoverActive = "false";
      handleChunkLeave(event);
    };

    const handleDocumentMove = (event) => {
      if (node.dataset.hoverActive !== "true") return;
      const target = event.target;
      const isOverToken = typeof Node !== "undefined" && target instanceof Node && node.contains(target);
      const isOverTooltip = typeof Element !== "undefined" && target instanceof Element && target.closest(".omni-quick-tooltip");
      if (isOverToken || isOverTooltip) return;
      node.dataset.hoverActive = "false";
      handleChunkLeave(event);
    };

    node.addEventListener("mouseenter", handleNativeEnter);
    node.addEventListener("mousemove", handleNativeMove);
    node.addEventListener("mouseleave", handleNativeLeave);
    document.addEventListener("mousemove", handleDocumentMove, true);

    return () => {
      node.removeEventListener("mouseenter", handleNativeEnter);
      node.removeEventListener("mousemove", handleNativeMove);
      node.removeEventListener("mouseleave", handleNativeLeave);
      document.removeEventListener("mousemove", handleDocumentMove, true);
    };
  }, [activeChunkId, extendTokenSelection, safeChunk, handleChunkEnter, handleChunkLeave, handleChunkMove, hasParts, stepId]);

  const handleAnnotatedEnter = (event) => {
    if (typeof Element !== "undefined" && event.target instanceof Element && event.target.closest("[data-subtoken='true']")) return;
    extendTokenSelection(safeChunk, stepId);
    handleChunkEnter(safeChunk, stepId, event);
  };

  const handleAnnotatedMove = (event) => {
    if (typeof Element !== "undefined" && event.target instanceof Element && event.target.closest("[data-subtoken='true']")) return;
    if (activeChunkId !== safeChunk.id) {
      handleChunkEnter(safeChunk, stepId, event);
    }
    handleChunkMove(event);
  };

  const handleAnnotatedLeave = (event) => {
    handleChunkLeave(event);
  };

  const handleFocus = (event) => {
    handleChunkEnter(safeChunk, stepId, event);
  };

  const handleBlur = (event) => {
    handleChunkLeave(event);
  };

  useEffect(() => registerToken(safeChunk, stepId), [registerToken, safeChunk, stepId]);

  return (
    <span
      ref={tokenRef}
      data-explainable={deferToSubTokens ? undefined : "true"}
      data-inspectable="math-token"
      data-token-id={safeChunk.id}
      data-token-latex={safeChunk.latex}
      data-token-role={safeChunk.role || (isOperator ? "operator" : "other")}
      data-hover-active="false"
      tabIndex={deferToSubTokens ? undefined : 0}
      aria-label={accessibleTitle}
      onMouseEnter={hasParts && !deferToSubTokens ? handleAnnotatedEnter : undefined}
      onMouseMove={hasParts && !deferToSubTokens ? handleAnnotatedMove : undefined}
      onMouseLeave={hasParts && !deferToSubTokens ? handleAnnotatedLeave : undefined}
      onMouseDown={deferToSubTokens ? undefined : (event) => beginTokenSelection(safeChunk, stepId, event)}
      onMouseUp={deferToSubTokens ? undefined : finishTokenSelection}
      onFocus={deferToSubTokens ? undefined : handleFocus}
      onBlur={deferToSubTokens ? undefined : handleBlur}
      onContextMenu={deferToSubTokens ? undefined : (event) => {
        handleChunkRightClick(safeChunk, stepId, event);
      }}
      onClick={deferToSubTokens ? undefined : handleClick}
      className={cn(
        "math-token explainable-token relative -mx-0.5 inline-block cursor-help select-none rounded-sm px-0.5 py-0 transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal-300/45",
        hasParts && "math-token-group",
        deferToSubTokens && "math-token-defer-subtokens cursor-default",
        isOperator && "math-token-operator",
        isSelected && "omni-token-selected",
        isSiblingActive && !isPinned && !isConceptRelated && "opacity-45",
        (isConceptRelated || isExplicitlyRelated) && !isConceptActive && "omni-related-token"
      )}
      style={{
        transitionProperty: "opacity, background-color, transform, box-shadow, color",
        transform: isActive || isConceptActive || isPinned || hasWindow ? "translateY(-1px)" : "translateY(0)",
        ...(isActive || isConceptActive || isPinned || hasWindow
          ? {
              backgroundColor: "transparent",
              boxShadow: "none",
            }
          : {}),
      }}
    >
      <span
        style={{
          color: mathColor,
          filter: isActive || isConceptActive || isPinned || hasWindow ? "drop-shadow(0 0 8px rgba(45, 212, 191, 0.38))" : "none",
          textDecorationLine: isActive || isConceptActive || isPinned || hasWindow ? "underline" : "none",
          textDecorationColor: "rgba(94, 234, 212, 0.55)",
          textUnderlineOffset: "0.18em",
        }}
        className={cn("katex-chunk math-visual-layer", hasParts && "annotated-katex-chunk")}
      >
        <InlineMath math={safeChunk.display} className="font-serif italic" />
      </span>
      {hasParts && (
        <span className="math-interaction-layer">
          {parts.map((part, index) => (
            <MathSubToken
              key={part.id || `${safeChunk.id}-part-${index}`}
              part={part}
              parentChunk={safeChunk}
              stepId={stepId}
              depth={0}
            />
          ))}
        </span>
      )}
      {(isPinned || hasWindow) && (
        <span
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-teal-200 shadow-[0_0_10px_rgba(94,234,212,0.8)]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function ExplainableToken(props) {
  return <MathChunk {...props} />;
}

export default MathChunk;
