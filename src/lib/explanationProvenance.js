import { getHoverTargetIdentity } from "./hoverTargetIdentity.js";
import { getSolutionSteps } from "./solutionSteps.js";

const MAX_EVIDENCE_STEPS = 64;
const MAX_MATH_CHARS = 6000;
const MAX_REASONING_CHARS = 10000;

function boundedText(value, limit) {
  return String(value || "").slice(0, limit);
}

function detachedJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function stableHash(value = "") {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableRange(value) {
  const start = Number(value?.start);
  const end = Number(value?.end);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function problemText(problem = {}) {
  return problem.originalProblem
    || problem.problem
    || problem.expression
    || problem.problemLatex
    || problem.canonicalProblem?.canonicalText
    || "";
}

function branchIdForStep(step = {}) {
  return step.branchId || step.branch || step.caseId || step.case || null;
}

function stepEvidence(step = {}, index) {
  return {
    index,
    id: step.id || `step-${index + 1}`,
    title: boundedText(step.label || step.title, 500),
    math: boundedText(step.math || step.latex || step.expression, MAX_MATH_CHARS),
    reasoning: boundedText(step.reasoning || step.explanation || step.summary || step.text, MAX_REASONING_CHARS),
    branchId: branchIdForStep(step),
    assumptions: Array.isArray(step.assumptions) ? detachedJson(step.assumptions.slice(0, 32), []) : [],
  };
}

function selectBoundedEvidence(steps, selectedIndex) {
  if (steps.length <= MAX_EVIDENCE_STEPS) return steps.map(stepEvidence);
  const selectedStart = Math.max(0, Math.min(
    steps.length - MAX_EVIDENCE_STEPS,
    selectedIndex - Math.floor(MAX_EVIDENCE_STEPS / 2)
  ));
  return steps.slice(selectedStart, selectedStart + MAX_EVIDENCE_STEPS)
    .map((step, offset) => stepEvidence(step, selectedStart + offset));
}

function cloneNode(node = {}) {
  return {
    id: node.id || node.semanticNodeId || "",
    semanticNodeId: node.semanticNodeId || node.id || "",
    type: node.type || node.kind || "",
    role: node.role || "",
    source: boundedText(node.source || node.latex || node.display || node.text, MAX_MATH_CHARS),
    normalizedSource: boundedText(node.normalizedSource || node.latex || node.display || node.text, MAX_MATH_CHARS),
    sourceRange: stableRange(node.sourceRange),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

/** @param {{ item?: any, problem?: any }} options */
export function buildProvenanceSnapshot({ item = {}, problem = {} } = {}) {
  const context = item.context || {};
  const solution = context.solution || problem;
  const steps = getSolutionSteps(solution || {});
  const stepId = item.stepId || context.stepId || "";
  const selectedIndex = steps.findIndex((step) => step.id === stepId);
  const currentStep = context.currentStep || (selectedIndex >= 0 ? steps[selectedIndex] : null);
  const selectedToken = item.selectedTokens?.[0] || {};
  const identity = getHoverTargetIdentity(item);
  const selectedNode = cloneNode({
    ...selectedToken,
    id: identity.targetId || selectedToken.id,
    semanticNodeId: identity.semanticId || identity.targetId || selectedToken.semanticNodeId,
    source: identity.sourceText || selectedToken.source,
    sourceRange: identity.sourceRange || selectedToken.sourceRange,
  });
  const ancestors = (item.ancestors || item.semanticAncestors || selectedToken.ancestors || selectedToken.semanticAncestors || [])
    .slice(0, 32)
    .map(cloneNode);
  const evidenceSteps = selectBoundedEvidence(steps, selectedIndex);
  const canonicalProblemText = problemText(context.problem || problem);
  const problemId = context.problem?.id || problem.id || context.problem?.sessionId || problem.sessionId || "problem";
  const solutionRevision = stableHash(JSON.stringify({
    problem: canonicalProblemText,
    steps: evidenceSteps,
  }));
  const snapshot = {
    version: 1,
    target: {
      semanticId: identity.semanticId || identity.targetId || "",
      targetId: identity.targetId || identity.semanticId || "",
      stepId,
      sourceRange: stableRange(identity.sourceRange),
      sourceText: boundedText(identity.sourceText || item.selectedText || item.display, MAX_MATH_CHARS),
      role: identity.role || selectedToken.role || "",
      type: identity.semanticType || selectedToken.type || selectedToken.kind || "",
      parentExpression: boundedText(item.parentExpression || selectedToken.parentExpression || currentStep?.math || currentStep?.latex, MAX_MATH_CHARS),
      selectedNode,
      ancestors,
    },
    origin: {
      problemId: String(problemId),
      problemText: boundedText(canonicalProblemText, MAX_REASONING_CHARS),
      solutionRevision,
      stepIndex: selectedIndex >= 0 ? selectedIndex : null,
      stepId,
      stepTitle: boundedText(item.stepTitle || context.stepTitle || currentStep?.label || currentStep?.title, 500),
      currentStep: currentStep ? detachedJson(currentStep, null) : null,
      branchId: branchIdForStep(currentStep || {}),
    },
    evidence: {
      steps: evidenceSteps,
      relevantInputs: Array.isArray(solution?.relevantInputs) ? detachedJson(solution.relevantInputs.slice(0, 64), []) : [],
      assumptions: Array.isArray(solution?.assumptions) ? detachedJson(solution.assumptions.slice(0, 64), []) : [],
    },
    confidence: {
      kind: identity.targetId && selectedIndex >= 0
        ? "explicit"
        : identity.targetId && currentStep
          ? "reconstructed"
          : "insufficient",
    },
  };
  return deepFreeze(snapshot);
}

export function getTargetRevision(snapshot) {
  return stableHash(JSON.stringify({
    solutionRevision: snapshot?.origin?.solutionRevision || "",
    stepId: snapshot?.target?.stepId || "",
    targetId: snapshot?.target?.targetId || "",
    sourceRange: snapshot?.target?.sourceRange || null,
  }));
}

export function getConversationId(snapshot) {
  return `conversation-${stableHash(JSON.stringify({
    problemId: snapshot?.origin?.problemId || "",
    stepId: snapshot?.target?.stepId || "",
    targetId: snapshot?.target?.targetId || "",
    sourceRange: snapshot?.target?.sourceRange || null,
  }))}`;
}

/**
 * @param {{
 *   request?: any,
 *   provenanceSnapshot?: any,
 *   item?: any,
 *   problem?: any,
 *   displayedExplanation?: string,
 *   question?: string,
 *   history?: any[],
 * }} options
 */
export function buildFollowupPayload({
  request,
  provenanceSnapshot,
  item = {},
  problem = {},
  displayedExplanation = "",
  question = "",
  history = [],
} = {}) {
  const context = item.context || {};
  return {
    requestId: request?.requestId || "",
    conversationId: request?.conversationId || "",
    targetRevision: request?.targetRevision || "",
    provenanceSnapshot,
    problem: context.problem?.originalProblem
      || context.problem?.problem
      || context.problem?.expression
      || problem.originalProblem
      || problem.problem
      || problem.expression
      || "",
    solution: context.solution || problem,
    stepId: item.stepId || context.stepId,
    stepTitle: item.stepTitle || context.stepTitle,
    currentStep: context.currentStep || null,
    selectedText: item.selectedText || item.display || "",
    selectedTokens: item.selectedTokens || [],
    semanticSelection: item.semanticSelection || context.semanticSelection || null,
    pinnedExplanation: displayedExplanation,
    question,
    history,
  };
}

export const PROVENANCE_EVIDENCE_STEP_LIMIT = MAX_EVIDENCE_STEPS;
