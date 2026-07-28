import { looksLikeBrokenMathLabel, userFacingTooltipTitle } from "./presentationLabels.js";

function stableRange(sourceRange) {
  const start = Number(sourceRange?.start);
  const end = Number(sourceRange?.end);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function firstSelectedToken(item = {}) {
  return Array.isArray(item.selectedTokens) && item.selectedTokens.length > 0
    ? item.selectedTokens[0]
    : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function stableSemanticNode(item = {}, identity = {}) {
  const token = firstSelectedToken(item);
  const sourceRange = stableRange(item.sourceRange || token?.sourceRange || identity.sourceRange);
  const childIds = Array.isArray(item.childIds)
    ? item.childIds
    : (Array.isArray(token?.childIds) ? token.childIds : []);
  const children = Array.isArray(item.children)
    ? item.children
    : (Array.isArray(token?.children) ? token.children : []);
  const aggregateFlag = item.aggregate
    ?? item.isAggregateTarget
    ?? token?.aggregate
    ?? token?.isAggregateTarget;
  const leafFlag = item.leaf
    ?? item.isLeafTarget
    ?? token?.leaf
    ?? token?.isLeafTarget;
  const isAggregate = Boolean(aggregateFlag || childIds.length > 0 || children.length > 0);
  return {
    id: identity.semanticId || identity.targetId || item.semanticNodeId || item.id || "",
    semanticNodeId: item.semanticNodeId || identity.semanticId || identity.targetId || item.id || "",
    type: firstString(item.type, item.kind, token?.type, token?.kind, identity.semanticType, identity.role),
    role: firstString(item.role, token?.role, identity.role),
    aggregate: isAggregate,
    leaf: isAggregate ? false : (typeof leafFlag === "boolean" ? leafFlag : true),
    childIds,
    source: firstString(item.source, item.latex, item.display, item.text, token?.source, token?.latex, token?.display, token?.text, identity.sourceText),
    normalizedSource: firstString(item.normalizedSource, item.latex, item.display, item.text, token?.normalizedSource, token?.latex, token?.display, token?.text, identity.sourceText),
    start: item.start ?? token?.start ?? sourceRange?.start ?? null,
    end: item.end ?? token?.end ?? sourceRange?.end ?? null,
    sourceRange,
  };
}

function stableAncestors(item = {}) {
  const ancestors = item.ancestors || item.semanticAncestors || item.context?.ancestors || [];
  if (!Array.isArray(ancestors)) return [];
  return ancestors.map((ancestor) => ({
    id: ancestor.id || ancestor.semanticNodeId || "",
    semanticNodeId: ancestor.semanticNodeId || ancestor.id || "",
    type: ancestor.type || ancestor.kind || "",
    role: ancestor.role || "",
    source: ancestor.source || ancestor.latex || ancestor.display || ancestor.text || "",
    normalizedSource: ancestor.normalizedSource || ancestor.latex || ancestor.display || ancestor.text || "",
    start: ancestor.start ?? ancestor.sourceRange?.start ?? null,
    end: ancestor.end ?? ancestor.sourceRange?.end ?? null,
    sourceRange: stableRange(ancestor.sourceRange),
  })).filter((ancestor) => ancestor.id || ancestor.source);
}

export function createSemanticIdentity(item = {}, overrides = {}) {
  const semanticSelection = item.semanticSelection || item.selectedSemanticRange || item.context?.semanticSelection || null;
  const isSelection = item.referenceType === "selection" || Boolean(semanticSelection);
  if (!isSelection && (item?.semanticIdentity?.semanticId || item?.semanticIdentity?.targetId)) {
    return {
      ...item.semanticIdentity,
      ...overrides,
      sourceRange: stableRange(overrides.sourceRange || item.semanticIdentity.sourceRange),
      targetSourceRange: stableRange(overrides.targetSourceRange || item.semanticIdentity.targetSourceRange || item.semanticIdentity.sourceRange),
    };
  }
  const token = Array.isArray(item.selectedTokens) ? item.selectedTokens[0] : null;
  const tokenIdentity = token?.semanticIdentity || null;
  if (!isSelection && (tokenIdentity?.semanticId || tokenIdentity?.targetId)) {
    return {
      ...tokenIdentity,
      ...overrides,
      sourceRange: stableRange(overrides.sourceRange || tokenIdentity.sourceRange),
      targetSourceRange: stableRange(overrides.targetSourceRange || tokenIdentity.targetSourceRange || tokenIdentity.sourceRange),
    };
  }
  const targetId = isSelection
    ? semanticSelection?.id || item.referenceId || item.id || ""
    : token?.id || token?.semanticNodeId || item.referenceId || item.id || "";
  const sourceText = semanticSelection?.selectedText
    || item.selectedText
    || item.display
    || item.latex
    || token?.display
    || token?.latex
    || token?.text
    || "";
  const label = userFacingTooltipTitle({
    title: item.title,
    selectedText: sourceText,
    display: item.display,
    latex: item.latex,
    role: item.role,
  });
  const sourceRange = stableRange(semanticSelection?.sourceRange || token?.sourceRange || item.sourceRange);

  return {
    semanticId: targetId,
    targetId,
    stepId: item.stepId || item.context?.stepId || token?.stepId || "",
    sourceRange,
    targetSourceRange: sourceRange,
    sourceText,
    targetSourceText: sourceText,
    label,
    tooltipTitle: label,
    semanticType: isSelection ? semanticSelection?.kind || "selection" : item.type || item.kind || token?.type || token?.kind || "",
    role: isSelection ? semanticSelection?.kind || "selection" : item.role || token?.role || "",
    source: item.source || token?.source || sourceText,
    normalizedSource: item.normalizedSource || token?.normalizedSource || sourceText,
    ...overrides,
  };
}

export function getHoverTargetIdentity(item = {}) {
  return createSemanticIdentity(item);
}

export function isValidHoverTarget(item = {}) {
  const identity = getHoverTargetIdentity(item);
  return Boolean(identity.targetId) && !looksLikeBrokenMathLabel(identity.label);
}

export function assertSemanticIdentityConsistency(stage, expected = {}, actual = {}, details = {}) {
  const expectedId = expected?.semanticId || expected?.targetId || "";
  const actualId = actual?.semanticId || actual?.targetId || "";
  const matches = !expectedId || !actualId || expectedId === actualId;
  if (!matches) {
    const payload = {
      stage,
      expectedSemanticId: expectedId,
      actualSemanticId: actualId,
      expected,
      actual,
      ...details,
    };
    if (typeof console !== "undefined") {
      console.error("[omnimath:semantic-identity-mismatch]", payload);
    }
  }
  return matches;
}

export function createStableLazyPayload(item = {}, basePayload = {}) {
  const identity = getHoverTargetIdentity(item);
  const semanticSelection = item.semanticSelection || item.selectedSemanticRange || item.context?.semanticSelection || null;
  const selectedNode = semanticSelection
    ? {
        id: semanticSelection.id || identity.targetId || "",
        semanticNodeId: semanticSelection.id || identity.targetId || "",
        type: semanticSelection.kind || "selection",
        role: "selection",
        source: semanticSelection.selectedText || identity.sourceText || "",
        normalizedSource: semanticSelection.selectedText || identity.sourceText || "",
        start: semanticSelection.sourceRange?.start ?? null,
        end: semanticSelection.sourceRange?.end ?? null,
      sourceRange: stableRange(semanticSelection.sourceRange),
      aggregate: true,
      leaf: false,
      }
    : stableSemanticNode(item, identity);
  const ancestors = stableAncestors(item);
  return {
    ...basePayload,
    semanticId: identity.semanticId || identity.targetId,
    semanticType: identity.semanticType || identity.role,
    semanticSourceText: identity.sourceText || basePayload.selectedLatex || "",
    semanticSourceRange: identity.sourceRange,
    tooltipSemanticId: identity.semanticId || identity.targetId,
    targetId: identity.targetId,
    targetLabel: identity.label,
    targetRole: identity.role,
    targetSourceRange: identity.sourceRange,
    targetSourceText: identity.sourceText || basePayload.selectedLatex || "",
    selectedNode,
    ancestors,
    semanticSelection,
    selectedSemanticRange: semanticSelection,
  };
}

export function resolveLazyExplanationForTarget(data = {}, item = {}) {
  const identity = getHoverTargetIdentity(item);
  const responseIdentity = {
    semanticId: data.semanticId || data.targetId || identity.semanticId || identity.targetId,
    targetId: data.targetId || data.semanticId || identity.targetId,
  };
  assertSemanticIdentityConsistency("api-response", identity, responseIdentity, {
    responseTitle: data.title || "",
  });
  return {
    semanticId: responseIdentity.semanticId,
    targetId: responseIdentity.targetId,
    stepId: identity.stepId,
    sourceRange: identity.sourceRange,
    role: identity.role,
    label: identity.label,
    title: identity.label,
    explanation: data.explanation || "",
    semanticIdentity: {
      ...identity,
      semanticId: responseIdentity.semanticId,
      targetId: responseIdentity.targetId,
      responseSemanticId: data.semanticId || data.targetId || null,
    },
  };
}

export function shouldApplyLazyExplanation(currentItem = {}, resolved = {}) {
  const current = getHoverTargetIdentity(currentItem);
  if (!current.targetId || !resolved.targetId) return false;
  if (current.targetId !== resolved.targetId) return false;
  if (current.stepId && resolved.stepId && current.stepId !== resolved.stepId) return false;
  return true;
}
