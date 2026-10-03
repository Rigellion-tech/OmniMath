import { buildProvenanceSnapshot, getConversationId, getTargetRevision } from "./explanationProvenance.js";

export const MAX_CANVAS_EXTENT = 100_000;

export function clampCanvasPosition(x, y, width, size = { width: 320, height: 340 }) {
  return {
    x: Math.max(12, Math.min(Math.max(12, width - size.width - 12), Number.isFinite(x) ? x : 12)),
    y: Math.max(12, Math.min(MAX_CANVAS_EXTENT - size.height - 24, Number.isFinite(y) ? y : 12)),
  };
}

export function presentationDepth(value) {
  return ({ beginner: "concise", exam: "concise", intermediate: "standard", intuition: "standard", advanced: "detailed", professor: "detailed" })[value]
    || (["concise", "standard", "detailed"].includes(value) ? value : "standard");
}

/** A lens stores bounded evidence and UI state, never another live solution tree. */
export function preparePinnedLens(item, problem) {
  if (item.lensId && item.provenanceSnapshot) return item;
  const snapshot = item.provenanceSnapshot || buildProvenanceSnapshot({ item, problem });
  const context = { ...item.context };
  delete context.solution;
  delete context.problem;
  return {
    ...item, lensId: item.lensId || item.id, pinned: true, context,
    selectedTokens: (item.selectedTokens || []).map((token) => {
      if (!token.context) return token;
      const context = { ...token.context };
      delete context.solution;
      delete context.problem;
      return { ...token, context };
    }),
    depth: presentationDepth(item.depth),
    provenanceSnapshot: snapshot,
    targetRevision: item.targetRevision || getTargetRevision(snapshot),
    conversationId: item.conversationId || getConversationId(snapshot),
    chatHistory: Array.isArray(item.chatHistory) ? item.chatHistory : [],
    // Legacy viewport pixels cannot safely be restored into a different paper.
    placementMode: item.coordinateSpace === "canvas-v1" && item.placementMode === "manual" ? "manual" : "stacked",
    coordinateSpace: "canvas-v1",
  };
}

export function lensTargetIsCurrent(item, problem) {
  const origin = item.provenanceSnapshot?.origin;
  if (!origin || !problem) return true;
  const text = problem.originalProblem || problem.problem || problem.expression || "";
  if (origin.problemText && text && origin.problemText !== text) return false;
  if (!item.stepId) return true;
  const step = (problem.steps || []).find((value) => value.id === item.stepId);
  const saved = origin.currentStep;
  return Boolean(step && (!saved || (saved.math || saved.latex || "") === (step.math || step.latex || "")));
}

/** All inputs/outputs are canvas CSS pixels; viewport scroll is deliberately absent. */
export function resolveLensPositions(lenses, sizes, width, targetTops = {}) {
  const padding = 12;
  const gap = 12;
  const result = {};
  const manual = lenses.filter((item) => item.placementMode === "manual").map((item) => {
    const size = sizes[item.id] || { width: Math.min(320, width - padding * 2), height: item.collapsed ? 48 : 340 };
    const available = Math.max(0, width - size.width - padding * 2);
    const x = Number.isFinite(item.xRatio) ? padding + Math.max(0, Math.min(1, item.xRatio)) * available
      : Math.min(padding + available, Math.max(padding, item.x || padding));
    // Placement is independent of source geometry once the user moves a note.
    const { y } = clampCanvasPosition(x, item.y, width, size);
    result[item.id] = { x, y, width: size.width, height: size.height, spawnState: "manual" };
    return result[item.id];
  });
  let cursor = padding;
  for (const item of lenses) {
    if (item.placementMode === "manual") continue;
    const size = sizes[item.id] || { width: Math.min(320, Math.max(180, width - padding * 2)), height: item.collapsed ? 48 : 340 };
    const x = Math.max(padding, width - size.width - padding);
    let y = Math.max(cursor, targetTops[item.id] ?? item.canvasAnchorY ?? padding);
    // Only automatic notes move to make space for manually placed notes.
    for (const obstacle of manual.sort((a, b) => a.y - b.y)) {
      if (x < obstacle.x + obstacle.width + gap && x + size.width + gap > obstacle.x
        && y < obstacle.y + obstacle.height + gap && y + size.height + gap > obstacle.y) y = obstacle.y + obstacle.height + gap;
    }
    result[item.id] = { x, y, width: size.width, height: size.height, spawnState: "organized" };
    cursor = y + size.height + gap;
  }
  return result;
}
