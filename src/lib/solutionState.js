import { getProblemLabel, getStatusStepText } from "./problemLabels.js";
import { getGeneratedProblemStatus } from "./generationStatus.js";
import { getSolutionSteps, withNormalizedSolutionSteps } from "./solutionSteps.js";

const emptyProblem = {
  title: "New session",
  expression: "",
  steps: [],
};

function stripDemoFields(problem) {
  if (!problem || typeof problem !== "object") return problem || emptyProblem;
  const { demoKey, tags, ...rest } = problem;
  return rest;
}

function titleFromProblem(problem, fallback = "Math Problem") {
  return getProblemLabel(problem, fallback);
}

function canonicalProblemKey(problem = {}) {
  return problem?.canonicalProblem?.hash
    || problem?.canonicalInputHash
    || problem?.imageSource?.canonicalProblem?.hash
    || "";
}

function shouldReplaceExistingProblem(existing = {}, next = {}) {
  const existingKey = canonicalProblemKey(existing);
  const nextKey = canonicalProblemKey(next);
  return Boolean(existingKey && nextKey && existingKey === nextKey);
}

function upsertProblemHistory(problems = [], problemData = {}) {
  const list = Array.isArray(problems) ? problems : [];
  const matchIndex = list.findIndex((item) => shouldReplaceExistingProblem(item, problemData));
  if (matchIndex === -1) return [...list, problemData];
  return list.map((item, index) => (index === matchIndex ? problemData : item));
}

/** @param {any} normalizedData */
export function createGeneratedProblemState(normalizedData = {}) {
  const problemData = withNormalizedSolutionSteps(stripDemoFields(normalizedData));
  const steps = getSolutionSteps(problemData);
  return {
    problemData,
    steps,
    status: getGeneratedProblemStatus(normalizedData, problemData),
  };
}

/**
 * @param {{
 *   sessions?: any[],
 *   activeSessionId?: string,
 *   requestSessionId?: string,
 *   problemData?: any,
 * }} options
 */
export function commitGeneratedProblemToSessions({
  sessions = [],
  activeSessionId = "",
  requestSessionId = "",
  problemData = {},
} = {}) {
  const targetId = (
    requestSessionId && sessions.some((session) => session.id === requestSessionId)
      ? requestSessionId
      : activeSessionId && sessions.some((session) => session.id === activeSessionId)
        ? activeSessionId
        : sessions[0]?.id || ""
  );
  const steps = getSolutionSteps(problemData);

  if (!targetId) {
    return {
      sessions,
      activeSessionId,
      committedSession: null,
      committedSteps: [],
      wrote: false,
    };
  }

  let committedSession = null;
  const nextSessions = sessions.map((session) => {
    if (session.id !== targetId) return session;
    committedSession = {
      ...session,
      problem: problemData,
      problems: upsertProblemHistory(session.problems, problemData),
      steps,
      title: titleFromProblem(problemData, "Math Problem"),
      updatedAt: new Date().toISOString(),
      dirty: true,
    };
    return committedSession;
  });

  return {
    sessions: nextSessions,
    activeSessionId: targetId,
    committedSession,
    committedSteps: getSolutionSteps(committedSession),
    wrote: Boolean(committedSession),
  };
}

export function createPendingReviewedProblemState({
  problem = "",
  problemText = "",
  problemLatex = "",
  canonicalProblem = null,
  extraction = {},
  solveDecision = "direct",
} = {}) {
  const reviewedText = String(problemText || canonicalProblem?.canonicalText || problem || "").trim();
  const reviewedLatex = String(problemLatex || canonicalProblem?.canonicalLatex || "").trim();
  const imageSource = {
    ...(extraction || {}),
    canonicalProblem,
    solveDecision,
    finalProblemText: reviewedText,
    editedBeforeSolving: solveDecision === "edited",
  };
  return withNormalizedSolutionSteps({
    title: titleFromProblem({
      canonicalProblem,
      originalProblem: reviewedText,
      problem: problem || reviewedText,
      problemLatex: reviewedLatex,
    }, "Reviewed math problem"),
    expression: reviewedLatex || problem || reviewedText,
    originalProblem: reviewedText,
    problem: problem || reviewedText,
    problemText: reviewedText,
    problemLatex: reviewedLatex,
    extractedProblemText: reviewedText,
    extractedProblemLatex: reviewedLatex,
    canonicalProblem,
    imageSource,
    pendingSolve: true,
    steps: [],
  });
}

export function commitReviewedProblemToSessions({
  sessions = [],
  activeSessionId = "",
  requestSessionId = "",
  problemData = {},
} = {}) {
  return commitGeneratedProblemToSessions({
    sessions,
    activeSessionId,
    requestSessionId,
    problemData,
  });
}

/** @param {any} session */
export function clearSessionSolution(session = {}) {
  return {
    ...session,
    title: "New math session",
    messages: [],
    problem: emptyProblem,
    problems: [],
    steps: [],
    updatedAt: new Date().toISOString(),
    dirty: Boolean(session.persisted),
  };
}

export function emptyGenerationStatus(detail = "Type a problem or upload an image to begin.") {
  return {
    type: "empty",
    label: "Session ready",
    detail,
    meta: "",
  };
}

export function enforceStatusMatchesRenderedSolution(status = {}, renderedSolution = {}) {
  const renderedSteps = getSolutionSteps(renderedSolution);
  const isReadyLike = status.type === "success" || status.label === "Explanation ready";
  const isWarningSolved = status.type === "warning" && /solved/i.test(status.label || "");

  if ((isReadyLike || isWarningSolved) && renderedSteps.length === 0) {
    return {
      type: "error",
      label: "Solution state mismatch",
      detail: "The solver returned steps, but the active rendered session has none.",
      meta: "",
    };
  }

  if ((isReadyLike || isWarningSolved) && renderedSteps.length > 0) {
    return {
      ...status,
      detail: getStatusStepText(renderedSteps),
    };
  }

  return status;
}

export function getActiveRenderedProblem(session = {}, fallbackProblem = emptyProblem) {
  const activeProblem = session?.problem || fallbackProblem;
  const activeSessionSteps = getSolutionSteps(session);
  const activeProblemSteps = getSolutionSteps(activeProblem);
  return withNormalizedSolutionSteps({
    ...activeProblem,
    steps: activeProblemSteps.length > 0 ? activeProblemSteps : activeSessionSteps,
  });
}
