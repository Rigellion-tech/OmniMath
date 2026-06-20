import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import InlineMath from "./InlineMath";
import { getConceptForChunk } from "@/data/conceptGraph";
import { useHover } from "@/lib/HoverContext";
import { userFacingTooltipTitle } from "@/lib/presentationLabels";
import { chooseSemanticHit, normalizeSemanticRect, rectArea, rectContainsPoint } from "@/lib/semanticHitboxes";
import { cn } from "@/lib/utils";

const OPERATOR_PATTERN = /^(=|\+|-|\\le|\\ge|<=|>=|<|>|\\cdot|\u00b7|,|\(|\)|\\Rightarrow|\\to)$/;
const noop = () => {};
const LARGE_ANNOTATED_CHUNK_CHARS = 48;
const DEBUG_SEMANTIC_HITBOXES = import.meta.env.DEV
  && import.meta.env.VITE_DEBUG_SEMANTIC_HITBOXES === "true";

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
    const children = safeList(token.children).filter(Boolean);
    const parts = safeList(token.parts).filter(Boolean);
    return {
      ...token,
      id: safeText(token.id, fallbackId),
      display: safeText(token.display || token.latex || token.text),
      latex: safeText(token.latex || token.display || token.text),
      text: safeText(token.text || token.display || token.latex),
      role: safeText(token.role, "other"),
      short: safeText(token.short || token.explanation || token.display || token.latex, "Math token"),
      relatedTokenIds: safeList(token.relatedTokenIds),
      children,
      parts: parts.length > 0 ? parts : children,
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

function semanticText(value = "") {
  return String(value || "")
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1$2")
    .replace(/\\pi/g, "π")
    .replace(/\\theta/g, "θ")
    .replace(/\\phi/g, "φ")
    .replace(/\\rho/g, "ρ")
    .replace(/\\nabla/g, "∇")
    .replace(/\\times/g, "×")
    .replace(/\\cdot/g, "·")
    .replace(/\\cos/g, "cos")
    .replace(/\\sin/g, "sin")
    .replace(/\\tan/g, "tan")
    .replace(/\\int/g, "∫")
    .replace(/\\iint/g, "∬")
    .replace(/[{}_^\\,\s]/g, "")
    .trim();
}

function rectIntersects(left, right) {
  if (!left || !right) return false;
  return !(left.right <= right.left || left.left >= right.right || left.bottom <= right.top || left.top >= right.bottom);
}

function rectCenter(rect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function splitRectHorizontally(rect, parts, index) {
  if (!rect || parts <= 0) return null;
  const width = rect.width / parts;
  const left = rect.left + width * index;
  return normalizeSemanticRect({
    left,
    right: left + width,
    top: rect.top,
    bottom: rect.bottom,
  });
}

function splitRectVertically(rect, parts, index) {
  if (!rect || parts <= 0) return null;
  const height = rect.height / parts;
  const top = rect.top + height * index;
  return normalizeSemanticRect({
    left: rect.left,
    right: rect.right,
    top,
    bottom: top + height,
  });
}

function getElementRects(element) {
  if (!element?.getClientRects) return [];
  return [...element.getClientRects()].map(normalizeSemanticRect).filter(Boolean);
}

function getMergedRect(rects = []) {
  const safeRects = rects.filter(Boolean);
  if (safeRects.length === 0) return null;
  return normalizeSemanticRect({
    left: Math.min(...safeRects.map((rect) => rect.left)),
    right: Math.max(...safeRects.map((rect) => rect.right)),
    top: Math.min(...safeRects.map((rect) => rect.top)),
    bottom: Math.max(...safeRects.map((rect) => rect.bottom)),
  });
}

function flattenSemanticNodes(parts = [], parent = null, depth = 1) {
  return safeList(parts).flatMap((part, index) => {
    const token = normalizeRenderableToken(part, `${parent?.id || "semantic"}-${index}`);
    const node = {
      ...token,
      parentId: parent?.id || null,
      parentRole: parent?.role || null,
      siblingIndex: index,
      siblingCount: safeList(parts).length,
      depth,
    };
    const syntheticChildren = node.role === "integral" && /^\\(?:int|iint|iiint|oint)/.test(node.latex)
      ? [{
          id: `${node.id}-integral-symbol`,
          display: node.latex.match(/^\\(?:int|iint|iiint|oint)/)?.[0] || "\\int",
          latex: node.latex.match(/^\\(?:int|iint|iiint|oint)/)?.[0] || "\\int",
          text: "integral",
          role: "operator",
          kind: "integral_symbol",
          short: "Integral symbol",
          medium: "What is this? The integral sign marks accumulation. Why is it here? It tells OmniMath to combine values over the bounds or domain. How does it connect? The integrand and differential specify what is accumulated.",
          deep: "What is this? The integral sign marks accumulation. Why is it here? It tells OmniMath to combine values over the bounds or domain. How does it connect? The integrand and differential specify what is accumulated.",
          relatedTokenIds: [],
          children: [],
          parentId: node.id,
          parentRole: node.role,
          siblingIndex: -1,
          siblingCount: token.children.length + 1,
          depth: depth + 1,
        }]
      : [];
    return [
      node,
      ...syntheticChildren,
      ...(node.role === "numerator" || node.role === "denominator" || node.role === "differential"
        ? []
        : flattenSemanticNodes(token.children, node, depth + 1)),
    ];
  });
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
        zIndex: depth + 3,
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
  const mathVisualRef = useRef(null);
  const semanticTargetsRef = useRef([]);
  const [overlayTargets, setOverlayTargets] = useState([]);
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
  const semanticNodes = useMemo(() => flattenSemanticNodes(parts), [parts]);
  const semanticNodeById = useMemo(() => new Map(semanticNodes.map((node) => [
    node.id,
    {
      ...node,
      parentExpression: safeChunk.display || safeChunk.latex || safeChunk.text || "",
      parentTokenId: safeChunk.id,
    },
  ])), [safeChunk.display, safeChunk.id, safeChunk.latex, safeChunk.text, semanticNodes]);

  const measureSemanticTargets = useCallback(() => {
    const root = tokenRef.current;
    const visualRoot = mathVisualRef.current;
    if (!root || !visualRoot || semanticNodes.length === 0) {
      semanticTargetsRef.current = [];
      setOverlayTargets([]);
      return [];
    }

    const rootRect = normalizeSemanticRect(root.getBoundingClientRect());
    const visualRect = normalizeSemanticRect(visualRoot.getBoundingClientRect());
    const katexRoot = visualRoot.querySelector(".katex-html") || visualRoot.querySelector(".katex") || visualRoot;
    const elements = [...katexRoot.querySelectorAll("*")]
      .map((element) => {
        const rects = getElementRects(element);
        const rect = getMergedRect(rects);
        const text = semanticText(element.textContent || "");
        return rect ? { element, rect, rects, text } : null;
      })
      .filter(Boolean);

    const measuredById = new Map();

    const nearestElementRect = (node, parentRect = null) => {
      const targetText = semanticText(node.latex || node.display || node.text);
      if (!targetText) return null;
      const candidates = elements
        .filter((item) => {
          if (!item.text) return false;
          if (parentRect && !rectIntersects(item.rect, parentRect)) return false;
          if (node.role === "fraction" && /^\\frac/.test(node.latex || "")) {
            const requiredGlyphs = [...new Set(targetText.split(""))];
            return requiredGlyphs.every((glyph) => item.text.includes(glyph))
              && item.text.length <= targetText.length + 4;
          }
          return item.text === targetText || item.text.includes(targetText);
        })
        .map((item) => {
          const exact = item.text === targetText ? 0 : 1;
          const lengthPenalty = Math.abs(item.text.length - targetText.length);
          return { ...item, score: exact * 1000 + lengthPenalty * 10 + rectArea(item.rect) / 1000 };
        })
        .sort((left, right) => left.score - right.score || rectArea(left.rect) - rectArea(right.rect));
      return candidates[0]?.rect || null;
    };

    const estimateRect = (node) => {
      const parent = node.parentId ? measuredById.get(node.parentId) : null;
      const parentRect = getMergedRect(parent?.rects || []) || (!node.parentId ? visualRect : null);
      if (parentRect && node.parentRole === "fraction") {
        const verticalIndex = node.role === "denominator" ? 1 : 0;
        const split = splitRectVertically(parentRect, 2, verticalIndex);
        return split ? [split] : [];
      }

      if ((parentRect || visualRect) && node.role === "differential") {
        const scopeRect = visualRect || parentRect;
        const directDifferential = elements
          .filter((item) => item.text.includes(semanticText(node.latex)) && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (directDifferential) return [directDifferential];
        const dRect = elements
          .filter((item) => item.text === "d" && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (dRect) {
          return [normalizeSemanticRect({
            left: dRect.left,
            right: Math.min(scopeRect.right, dRect.right + Math.max(14, dRect.width * 2.6)),
            top: dRect.top,
            bottom: dRect.bottom,
          })].filter(Boolean);
        }
        const chunkLatex = safeChunk.latex || safeChunk.display || "";
        const sourceIndex = chunkLatex.indexOf(node.latex);
        if (sourceIndex >= 0 && chunkLatex.length > 0) {
          const startRatio = Math.max(0, Math.min(1, sourceIndex / chunkLatex.length));
          const endRatio = Math.max(startRatio, Math.min(1, (sourceIndex + node.latex.length) / chunkLatex.length));
          return [normalizeSemanticRect({
            left: scopeRect.left + scopeRect.width * startRatio,
            right: scopeRect.left + scopeRect.width * Math.max(endRatio, startRatio + 0.08),
            top: scopeRect.top,
            bottom: scopeRect.bottom,
          })].filter(Boolean);
        }
        const variableText = semanticText(String(node.latex || "").replace(/^d/, ""));
        const variableRect = elements
          .filter((item) => item.text === variableText && rectIntersects(item.rect, scopeRect))
          .sort((left, right) => right.rect.left - left.rect.left)[0]?.rect;
        if (variableRect) {
          return [normalizeSemanticRect({
            left: Math.max(scopeRect.left, variableRect.left - Math.max(10, variableRect.width * 1.2)),
            right: variableRect.right,
            top: variableRect.top,
            bottom: variableRect.bottom,
          })].filter(Boolean);
        }
      }

      const direct = nearestElementRect(node, parentRect);
      if (direct) return [direct];

      if (parentRect && node.role === "exponent") {
        return [normalizeSemanticRect({
          left: parentRect.left + parentRect.width * 0.48,
          right: parentRect.right,
          top: parentRect.top,
          bottom: parentRect.top + parentRect.height * 0.55,
        })].filter(Boolean);
      }

      if (parentRect && (node.role === "domain" || node.role === "bound")) {
        const isUpper = node.role === "bound";
        return [normalizeSemanticRect({
          left: parentRect.left,
          right: parentRect.left + Math.max(parentRect.width * 0.35, 18),
          top: isUpper ? parentRect.top : parentRect.top + parentRect.height * 0.5,
          bottom: isUpper ? parentRect.top + parentRect.height * 0.5 : parentRect.bottom,
        })].filter(Boolean);
      }

      if (parentRect && node.siblingCount > 1 && node.siblingIndex >= 0) {
        const split = splitRectHorizontally(parentRect, node.siblingCount, node.siblingIndex);
        return split ? [split] : [];
      }

      return [];
    };

    const targets = semanticNodes.map((node) => {
      const measured = {
        ...semanticNodeById.get(node.id),
        depth: node.depth,
        rects: estimateRect(node),
      };
      measuredById.set(node.id, measured);
      return measured;
    }).filter((target) => target.rects.length > 0);

    const parentTarget = {
      ...safeChunk,
      depth: 0,
      rects: [visualRect || rootRect].filter(Boolean),
    };
    semanticTargetsRef.current = [...targets, parentTarget];

    if (rootRect) {
      setOverlayTargets(targets.map((target) => ({
        ...target,
        rects: target.rects.map((rect) => ({
          left: rect.left - rootRect.left,
          top: rect.top - rootRect.top,
          width: rect.width,
          height: rect.height,
        })),
      })));
    }

    return semanticTargetsRef.current;
  }, [safeChunk, semanticNodeById, semanticNodes]);

  const resolvePointerToken = useCallback((event) => {
    if (!event) return null;
    const targets = semanticTargetsRef.current.length > 0
      ? semanticTargetsRef.current
      : measureSemanticTargets();
    const fractionBarHit = targets
      .filter((target) => target.role === "fraction")
      .flatMap((target) => target.rects.map((rect) => ({ target, rect })))
      .filter(({ rect }) => {
        if (!rectContainsPoint(rect, event.clientX, event.clientY)) return false;
        const centerY = rect.top + rect.height / 2;
        return Math.abs(event.clientY - centerY) <= Math.max(3, rect.height * 0.18);
      })
      .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0]?.target;
    if (fractionBarHit) return fractionBarHit;
    const differentialHit = targets
      .filter((target) => target.role === "differential")
      .flatMap((target) => target.rects.map((rect) => ({ target, rect })))
      .filter(({ rect }) => rectContainsPoint(rect, event.clientX, event.clientY))
      .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0]?.target;
    if (differentialHit) return differentialHit;
    const hit = chooseSemanticHit(targets.filter((target) => target.id !== safeChunk.id), event.clientX, event.clientY, null);
    return hit || null;
  }, [measureSemanticTargets, safeChunk.id]);

  const resolvePointerTokenOrChunk = useCallback((event) => (
    resolvePointerToken(event) || safeChunk
  ), [resolvePointerToken, safeChunk]);

  const handleClick = (event) => {
    event.stopPropagation();
    selectChunk(resolvePointerTokenOrChunk(event), stepId);
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
    const token = resolvePointerTokenOrChunk(event);
    extendTokenSelection(token, stepId);
    handleChunkEnter(token, stepId, event);
  };

  const handleAnnotatedMove = (event) => {
    const token = resolvePointerTokenOrChunk(event);
    if (activeChunkId !== token.id) {
      handleChunkEnter(token, stepId, event);
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

  useEffect(() => {
    if (!hasParts) return undefined;
    const cleanups = semanticNodes.map((node) => {
      const token = semanticNodeById.get(node.id);
      return token ? registerToken(token, stepId) : undefined;
    }).filter(Boolean);
    return () => cleanups.forEach((cleanup) => cleanup?.());
  }, [hasParts, registerToken, semanticNodeById, semanticNodes, stepId]);

  useLayoutEffect(() => {
    if (!hasParts) return undefined;
    let frame = 0;
    const scheduleMeasure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureSemanticTargets();
      });
    };

    scheduleMeasure();

    const resizeObserver = typeof ResizeObserver !== "undefined" && tokenRef.current
      ? new ResizeObserver(scheduleMeasure)
      : null;
    resizeObserver?.observe(tokenRef.current);
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    document.fonts?.ready?.then(scheduleMeasure).catch(() => {});

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
    };
  }, [hasParts, measureSemanticTargets]);

  return (
    <span
      ref={tokenRef}
      data-explainable="true"
      data-inspectable="math-token"
      data-token-id={safeChunk.id}
      data-token-latex={safeChunk.latex}
      data-token-role={safeChunk.role || (isOperator ? "operator" : "other")}
      data-hover-active="false"
      tabIndex={0}
      aria-label={accessibleTitle}
      onMouseEnter={hasParts ? handleAnnotatedEnter : undefined}
      onMouseMove={hasParts ? handleAnnotatedMove : undefined}
      onMouseLeave={hasParts ? handleAnnotatedLeave : undefined}
      onMouseDown={(event) => beginTokenSelection(resolvePointerTokenOrChunk(event), stepId, event)}
      onMouseUp={finishTokenSelection}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onContextMenu={(event) => {
        handleChunkRightClick(resolvePointerTokenOrChunk(event), stepId, event);
      }}
      onClick={handleClick}
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
        ref={mathVisualRef}
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
        <span
          className={cn(
            "math-semantic-overlay-layer",
            DEBUG_SEMANTIC_HITBOXES && "math-semantic-overlay-debug"
          )}
          aria-hidden="true"
        >
          {overlayTargets.flatMap((target) => target.rects.map((rect, rectIndex) => (
            <span
              key={`${target.id}-${rectIndex}`}
              className={cn(
                "math-semantic-hitbox",
                safeList(selectedTokenIds).includes(target.id) && "omni-token-selected"
              )}
              data-inspectable="math-subtoken"
              data-token-id={target.id}
              data-token-latex={target.latex}
              data-token-depth={target.depth}
              data-token-role={target.role || target.kind || "other"}
              data-active-target={activeChunkId === target.id ? "true" : undefined}
              style={{
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                zIndex: target.depth + 1,
              }}
            />
          )))}
          {DEBUG_SEMANTIC_HITBOXES && activeChunkId && (
            <span className="math-semantic-active-label">
              {activeChunkId}
            </span>
          )}
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
