/** @param {any} value */
function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * A step object is only useful to the renderer when it carries visible
 * content.  Historically any non-empty array won this lookup, so a payload
 * such as `{ steps: [{}], explanation: { steps: [...] } }` masked the valid
 * nested solution and produced blank cards.  Keep this check deliberately
 * structural; mathematical correctness is a server concern.
 *
 * @param {any} step
 */
function isRenderableSolutionStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return false;

  const directValues = [step.math, step.latex, step.equationLatex, step.display];
  if (directValues.some((value) => typeof value === "string" && value.trim())) return true;

  const lines = Array.isArray(step.lines) ? step.lines : [];
  if (lines.some((line) => line && typeof line === "object" && [line.latex, line.math, line.text]
    .some((value) => typeof value === "string" && value.trim()))) return true;

  const chunks = Array.isArray(step.chunks) ? step.chunks : [];
  return chunks.some((chunk) => chunk && typeof chunk === "object" && [chunk.display, chunk.latex, chunk.text]
    .some((value) => typeof value === "string" && value.trim()));
}

function retainedBoundaryErrorStep(step, index) {
  const source = step && typeof step === "object" && !Array.isArray(step) ? step : {};
  return {
    ...source,
    id: typeof source.id === "string" && source.id.trim() ? source.id : `step-${index + 1}`,
    label: source.label || source.title || `Step ${index + 1}`,
    summary: "This solution step was empty or malformed and could not be rendered.",
    renderBoundaryError: {
      type: "accepted_empty",
      field: `steps[${index}]`,
      index,
    },
  };
}

/** @param {any[]} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length > 0)
    || values.find(Array.isArray)
    || [];
}

/**
 * Prefer the first complete candidate array. If every candidate is incomplete,
 * retain the first candidate's exact positions and replace only malformed
 * entries with visible boundary-error steps. Never silently close a gap in a
 * solution, because doing so destroys the evidence needed to trace a blank.
 *
 * @param {any} value
 */
export function getRenderableSolutionSteps(value = {}) {
  const source = objectOrEmpty(value);
  const explanation = objectOrEmpty(source.explanation);
  const solution = objectOrEmpty(source.solution);
  const result = objectOrEmpty(source.result);
  const problem = objectOrEmpty(source.problem);
  const nestedExplanation = objectOrEmpty(explanation.explanation);
  const explanationSolution = objectOrEmpty(explanation.solution);
  const sessionExplanation = objectOrEmpty(source.session?.explanation);
  const sessionExplanationSolution = objectOrEmpty(sessionExplanation.solution);
  const arrays = [
    source.steps,
    solution.steps,
    result.steps,
    explanation.steps,
    explanationSolution.steps,
    nestedExplanation.steps,
    problem.steps,
    sessionExplanation.steps,
    sessionExplanationSolution.steps,
  ];
  for (const valueArray of arrays) {
    if (
      Array.isArray(valueArray)
      && valueArray.length > 0
      && valueArray.every(isRenderableSolutionStep)
    ) return valueArray;
  }
  const incomplete = arrays.find((valueArray) => Array.isArray(valueArray) && valueArray.length > 0);
  return incomplete?.map((step, index) => (
    isRenderableSolutionStep(step) ? step : retainedBoundaryErrorStep(step, index)
  )) || [];
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
export function mergeSessionListPreservingActiveSolution(
  currentSessions = [],
  activeSessionId = "",
  incomingSessions = [],
  { protectedSessionIds = [] } = {},
) {
  const activeSession = currentSessions.find((session) => session.id === activeSessionId) || currentSessions[0] || null;
  const activeSteps = getSolutionSteps(activeSession);
  const explicitlyProtectedIds = new Set(protectedSessionIds.filter(Boolean));
  const locallyOwnedSessions = currentSessions.filter((session) => (
    Boolean(session?.dirty) || explicitlyProtectedIds.has(session?.id)
  ));
  const locallyOwnedIds = new Set(locallyOwnedSessions.map((session) => session.id));
  const activeIsLocallyOwned = locallyOwnedIds.has(activeSession?.id);
  const shouldPreserveActive = activeSteps.length > 0 || activeIsLocallyOwned;

  if (incomingSessions.length === 0) {
    return shouldPreserveActive || locallyOwnedSessions.length > 0
      ? {
          sessions: currentSessions,
          activeSessionId: activeSession?.id || activeSessionId,
          preservedActive: shouldPreserveActive,
          preservedPending: explicitlyProtectedIds.has(activeSession?.id),
        }
      : {
          sessions: incomingSessions,
          activeSessionId: "",
          preservedActive: false,
          preservedPending: false,
        };
  }

  if (!shouldPreserveActive && locallyOwnedSessions.length === 0) {
    return {
      sessions: incomingSessions,
      activeSessionId: incomingSessions[0]?.id || "",
      preservedActive: false,
      preservedPending: false,
    };
  }

  const currentById = new Map(currentSessions.map((session) => [session.id, session]));
  const mergedIncoming = incomingSessions.map((incoming) => {
    const current = currentById.get(incoming.id);
    if (!current) return incoming;
    if (locallyOwnedIds.has(incoming.id)) return current;
    return incoming.id === activeSession?.id
      ? mergeSessionPreservingSolutionSteps(current, incoming)
      : incoming;
  });
  const incomingIds = new Set(incomingSessions.map((session) => session.id));
  const missingLocallyOwned = locallyOwnedSessions.filter((session) => !incomingIds.has(session.id));
  const sessions = [...missingLocallyOwned, ...mergedIncoming];

  return {
    sessions,
    activeSessionId: shouldPreserveActive ? activeSession.id : sessions[0]?.id || "",
    preservedActive: shouldPreserveActive,
    preservedPending: explicitlyProtectedIds.has(activeSession?.id),
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
