/** @param {any} value */
function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @param {any[]} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0)
    || values.find(Array.isArray)
    || [];
}

/** @param {any} value */
export function getSolutionSteps(value = {}) {
  const source = objectOrEmpty(value);
  const explanation = objectOrEmpty(source.explanation);
  const solution = objectOrEmpty(source.solution);
  const result = objectOrEmpty(source.result);
  const problem = objectOrEmpty(source.problem);
  const nestedExplanation = objectOrEmpty(explanation.explanation);
  const explanationSolution = objectOrEmpty(explanation.solution);
  const sessionExplanation = objectOrEmpty(source.session?.explanation);
  const sessionExplanationSolution = objectOrEmpty(sessionExplanation.solution);

  return firstArray(
    source.steps,
    solution.steps,
    result.steps,
    explanation.steps,
    explanationSolution.steps,
    nestedExplanation.steps,
    problem.steps,
    sessionExplanation.steps,
    sessionExplanationSolution.steps
  );
}

/** @param {any} value */
export function withNormalizedSolutionSteps(value = {}) {
  if (!value || typeof value !== "object") return value;
  const steps = getSolutionSteps(value);
  if (!steps.length && Array.isArray(value.steps)) return value;
  return { ...value, steps };
}

/**
 * @param {any} current
 * @param {any} incoming
 */
export function mergeSessionPreservingSolutionSteps(current = {}, incoming = {}) {
  const incomingSteps = getSolutionSteps(incoming);
  if (incomingSteps.length > 0) return withNormalizedSolutionSteps(incoming);

  const currentSteps = getSolutionSteps(current);
  if (currentSteps.length === 0) return withNormalizedSolutionSteps(incoming);

  const currentProblem = objectOrEmpty(current.problem);
  const incomingProblem = objectOrEmpty(incoming.problem);
  return {
    ...incoming,
    problem: {
      ...currentProblem,
      ...incomingProblem,
      steps: currentSteps,
    },
    problems: Array.isArray(incoming.problems) && incoming.problems.length > 0
      ? incoming.problems
      : current.problems,
    steps: currentSteps,
  };
}

/**
 * @param {any[]} currentSessions
 * @param {string} activeSessionId
 * @param {any[]} incomingSessions
 */
export function mergeSessionListPreservingActiveSolution(currentSessions = [], activeSessionId = "", incomingSessions = []) {
  const activeSession = currentSessions.find((session) => session.id === activeSessionId) || currentSessions[0] || null;
  const activeSteps = getSolutionSteps(activeSession);

  if (incomingSessions.length === 0) {
    return activeSteps.length > 0
      ? { sessions: currentSessions, activeSessionId: activeSession?.id || activeSessionId, preservedActive: true }
      : { sessions: incomingSessions, activeSessionId: "", preservedActive: false };
  }

  if (activeSteps.length === 0) {
    return { sessions: incomingSessions, activeSessionId: incomingSessions[0]?.id || "", preservedActive: false };
  }

  const matchingIncoming = incomingSessions.find((session) => session.id === activeSession?.id);
  if (!matchingIncoming) {
    return { sessions: currentSessions, activeSessionId: activeSession.id, preservedActive: true };
  }

  const mergedActive = mergeSessionPreservingSolutionSteps(activeSession, matchingIncoming);
  return {
    sessions: incomingSessions.map((session) => (
      session.id === matchingIncoming.id ? mergedActive : session
    )),
    activeSessionId: mergedActive.id,
    preservedActive: true,
  };
}

/** @param {any} session */
export function hasPersistableSessionContent(session = {}) {
  const problem = objectOrEmpty(session.problem);
  return getSolutionSteps(session).length > 0
    || (Array.isArray(session.messages) && session.messages.length > 0)
    || (Array.isArray(session.pinnedWindows) && session.pinnedWindows.length > 0)
    || Boolean(problem.expression || problem.problem || problem.originalProblem || problem.problemLatex);
}
