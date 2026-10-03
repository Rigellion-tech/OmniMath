import { isRenderableSolutionStep, getSolutionSteps } from "./solutionSteps.js";

// Transport-independent contract. Sequence numbers start at zero and are
// contiguous. Gaps and out-of-order events are rejected, never buffered.
export const PROGRESSIVE_EVENT_TYPES = Object.freeze({
  STARTED: "solve_started",
  METADATA: "solution_metadata",
  STEP_STARTED: "step_started",
  STEP_COMPLETED: "step_completed",
  FINAL_ANSWER: "final_answer",
  COMPLETED: "solve_completed",
  FAILED: "solve_failed",
  CANCELLED: "solve_cancelled",
});

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function createProgressiveSolveState() {
  return {
    status: "idle",
    requestId: "",
    attemptId: "",
    sessionId: "",
    conversationId: "",
    lastSequence: -1,
    eventSignatures: {},
    metadata: null,
    completedSteps: [],
    activeStepDraft: null,
    finalAnswer: null,
    assurance: null,
    failure: null,
    previousAttempts: [],
  };
}

function eventIdentity(event) {
  return Boolean(event && typeof event.requestId === "string" && event.requestId
    && typeof event.attemptId === "string" && event.attemptId
    && typeof event.sessionId === "string" && event.sessionId
    && typeof event.conversationId === "string" && event.conversationId
    && Number.isSafeInteger(event.sequence) && event.sequence >= 0);
}

function signature(event) {
  return JSON.stringify(event);
}

function hasTransientStepFields(step) {
  return ["draft", "draftText", "partialText", "activeStepDraft", "tokenBuffer", "transportBuffer"]
    .some((field) => Object.hasOwn(step || {}, field)) || step?.isComplete === false;
}

function durableFinalAnswer(answer) {
  if (!answer || typeof answer !== "object") return null;
  return {
    finalAnswer: typeof answer.finalAnswer === "string" ? answer.finalAnswer : "",
    finalAnswerLatex: typeof answer.finalAnswerLatex === "string" ? answer.finalAnswerLatex : "",
    ...(answer.finalAnswerPresentation?.version === 1
      ? { finalAnswerPresentation: answer.finalAnswerPresentation } : {}),
    ...(Array.isArray(answer.finalAnswerStepPresentations)
      ? { finalAnswerStepPresentations: answer.finalAnswerStepPresentations } : {}),
  };
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeDeep);
  return Object.freeze(value);
}

function detachedImmutableStep(step) {
  const detached = typeof structuredClone === "function"
    ? structuredClone(step)
    : JSON.parse(JSON.stringify(step));
  return freezeDeep(detached);
}

function accepted(state, event, change) {
  return {
    state: {
      ...state,
      ...change,
      lastSequence: event.sequence,
      eventSignatures: { ...state.eventSignatures, [event.sequence]: signature(event) },
    },
    accepted: true,
    reason: "accepted",
  };
}

function rejected(state, reason) {
  return { state, accepted: false, reason };
}

/** A pure reducer result deliberately includes the rejection reason for diagnostics. */
export function applyProgressiveSolveEvent(currentState, event) {
  const state = currentState || createProgressiveSolveState();
  if (!eventIdentity(event)) return rejected(state, "invalid-identity");
  if (event.type === PROGRESSIVE_EVENT_TYPES.STARTED) {
    if (event.sequence !== 0) return rejected(state, "out-of-order");
    if (state.status !== "idle" && event.sessionId !== state.sessionId) {
      return rejected(state, "session-mismatch");
    }
    if (state.status !== "idle" && event.requestId === state.requestId
      && event.attemptId !== state.attemptId) return rejected(state, "reused-request");
    if (state.previousAttempts.some((attempt) => attempt.requestId === event.requestId
      || attempt.attemptId === event.attemptId)) return rejected(state, "stale-attempt");
    if (state.status !== "idle" && !TERMINAL.has(state.status)) {
      if (state.requestId === event.requestId && state.attemptId === event.attemptId) {
        return state.eventSignatures[0] === signature(event)
          ? rejected(state, "duplicate") : rejected(state, "conflicting-duplicate");
      }
      if (event.supersedesAttemptId !== state.attemptId || event.sessionId !== state.sessionId) {
        return rejected(state, "active-attempt");
      }
    }
    if (state.status !== "idle" && event.attemptId === state.attemptId) {
      return state.eventSignatures[0] === signature(event)
        ? rejected(state, "duplicate") : rejected(state, "reused-attempt");
    }
    const previousAttempts = state.status === "idle" ? [] : [
      ...state.previousAttempts,
      {
        requestId: state.requestId,
        attemptId: state.attemptId,
        status: TERMINAL.has(state.status) ? state.status : "cancelled",
        completedSteps: state.completedSteps,
        finalAnswer: state.finalAnswer,
        assurance: state.assurance,
        failure: state.failure,
      },
    ];
    return accepted(createProgressiveSolveState(), event, {
      status: "starting",
      requestId: event.requestId,
      attemptId: event.attemptId,
      sessionId: event.sessionId,
      conversationId: event.conversationId,
      previousAttempts,
    });
  }

  if (state.status === "idle") return rejected(state, "missing-solve");
  if (event.requestId !== state.requestId || event.attemptId !== state.attemptId
    || event.sessionId !== state.sessionId || event.conversationId !== state.conversationId) {
    return rejected(state, "stale-identity");
  }
  if (event.sequence <= state.lastSequence) {
    return rejected(state, state.eventSignatures[event.sequence] === signature(event)
      ? "duplicate" : "conflicting-duplicate");
  }
  if (TERMINAL.has(state.status)) return rejected(state, "terminal-attempt");
  if (event.sequence !== state.lastSequence + 1) return rejected(state, "out-of-order");

  switch (event.type) {
    case PROGRESSIVE_EVENT_TYPES.METADATA:
      if (state.metadata || state.completedSteps.length || !event.metadata || typeof event.metadata !== "object"
        || Array.isArray(event.metadata) || "steps" in event.metadata
        || "activeStepDraft" in event.metadata || "draft" in event.metadata) {
        return rejected(state, "invalid-metadata");
      }
      return accepted(state, event, { metadata: event.metadata, status: "generating" });
    case PROGRESSIVE_EVENT_TYPES.STEP_STARTED:
      if (!state.metadata || state.activeStepDraft || typeof event.stepId !== "string" || !event.stepId
        || state.completedSteps.some((completed) => completed.id === event.stepId)
        || event.stepIndex !== state.completedSteps.length || state.finalAnswer) {
        return rejected(state, "invalid-step-start");
      }
      return accepted(state, event, {
        activeStepDraft: { stepId: event.stepId, stepIndex: event.stepIndex },
        status: state.completedSteps.length ? "partial" : "generating",
      });
    case PROGRESSIVE_EVENT_TYPES.STEP_COMPLETED: {
      const step = event.step;
      if (!state.metadata || typeof event.stepId !== "string" || !event.stepId
        || event.stepIndex !== state.completedSteps.length
        || step?.id !== event.stepId
        || event.validation?.status !== "accepted"
        || typeof event.validation?.authority !== "string" || !event.validation.authority
        || state.completedSteps.some((completed) => completed.id === event.stepId)
        || hasTransientStepFields(step)
        || (!isRenderableSolutionStep(step) && !step?.renderBoundaryError)
        || (state.activeStepDraft && (state.activeStepDraft.stepId !== event.stepId
          || state.activeStepDraft.stepIndex !== event.stepIndex))
        || state.finalAnswer) return rejected(state, "invalid-completed-step");
      return accepted(state, event, {
        completedSteps: [...state.completedSteps, detachedImmutableStep(step)],
        activeStepDraft: null,
        status: "partial",
      });
    }
    case PROGRESSIVE_EVENT_TYPES.FINAL_ANSWER:
      if (state.finalAnswer || state.activeStepDraft || !state.completedSteps.length
        || !event.answer || typeof event.answer !== "object") {
        return rejected(state, "invalid-final-answer");
      }
      return accepted(state, event, {
        finalAnswer: durableFinalAnswer(event.answer),
        assurance: event.assurance?.version === "bounded-assurance-v1" ? event.assurance : null,
        status: "partial",
      });
    case PROGRESSIVE_EVENT_TYPES.COMPLETED:
      if (state.activeStepDraft || !state.completedSteps.length || !state.finalAnswer) {
        return rejected(state, "incomplete-solve");
      }
      return accepted(state, event, { status: "complete" });
    case PROGRESSIVE_EVENT_TYPES.FAILED:
      return accepted(state, event, {
        status: "failed",
        activeStepDraft: null,
        failure: { message: String(event.reason || "The solve did not complete."), retryable: event.retryable !== false },
      });
    case PROGRESSIVE_EVENT_TYPES.CANCELLED:
      return accepted(state, event, { status: "cancelled", activeStepDraft: null });
    default:
      return rejected(state, "unknown-event");
  }
}

export function createFullResponseEvents(problem, identity) {
  const base = {
    requestId: identity.requestId,
    attemptId: identity.attemptId,
    sessionId: identity.sessionId,
    conversationId: identity.conversationId,
  };
  const events = [];
  const emit = (type, details = {}) => events.push({ ...base, sequence: events.length, type, ...details });
  const metadata = pickProgressiveMetadata(problem);
  emit(PROGRESSIVE_EVENT_TYPES.STARTED);
  emit(PROGRESSIVE_EVENT_TYPES.METADATA, { metadata });
  getSolutionSteps(problem).forEach((step, stepIndex) => {
    const stepId = step.id || `step-${stepIndex + 1}`;
    emit(PROGRESSIVE_EVENT_TYPES.STEP_COMPLETED, {
      stepId, stepIndex, step: { ...step, id: stepId },
      validation: { status: "accepted", authority: "canonical-full-response" },
    });
  });
  emit(PROGRESSIVE_EVENT_TYPES.FINAL_ANSWER, { answer: {
    finalAnswer: problem.finalAnswer || "",
    finalAnswerLatex: problem.finalAnswerLatex || "",
    ...(problem.finalAnswerPresentation ? { finalAnswerPresentation: problem.finalAnswerPresentation } : {}),
    ...(Array.isArray(problem.finalAnswerStepPresentations) ? { finalAnswerStepPresentations: problem.finalAnswerStepPresentations } : {}),
  }, ...(problem.assurance?.version === "bounded-assurance-v1"
    ? { assurance: problem.assurance } : {}) });
  emit(PROGRESSIVE_EVENT_TYPES.COMPLETED);
  return events;
}

/** Only these values cross the durable session boundary. */
export function progressiveDurableSnapshot(state) {
  if (!state || state.status === "idle") return null;
  return {
    requestId: state.requestId,
    attemptId: state.attemptId,
    sessionId: state.sessionId,
    conversationId: state.conversationId,
    status: TERMINAL.has(state.status) ? state.status : "failed",
    completedStepIds: state.completedSteps.map((step) => step.id),
    finalAnswer: state.finalAnswer,
    assurance: state.assurance,
    failure: state.failure || (TERMINAL.has(state.status) ? null : {
      message: "Generation was interrupted before completion.",
      retryable: true,
    }),
  };
}

const DURABLE_METADATA_FIELDS = [
  "id", "title", "description", "summary", "problem", "originalProblem", "problemText",
  "problemLatex", "expression", "canonicalProblem", "canonicalInputHash", "imageSource",
  "assumptions", "relevantInputs", "requestId", "model", "modelRouting",
];

export function pickProgressiveMetadata(value = {}) {
  const metadata = {};
  for (const field of DURABLE_METADATA_FIELDS) {
    if (value[field] !== undefined) metadata[field] = value[field];
  }
  return metadata;
}

export function progressiveProblemFromState(state) {
  const metadata = pickProgressiveMetadata(state.metadata);
  return {
    ...metadata,
    requestId: state.requestId,
    steps: state.completedSteps,
    ...(state.finalAnswer || {}),
    assurance: state.assurance,
    progressiveSolve: { ...progressiveDurableSnapshot(state), mode: "progressive" },
  };
}

/** Defensive persistence boundary for existing session save routes. */
export function sanitizeProgressiveProblemForPersistence(problem) {
  if (!problem?.progressiveSolve) return problem;
  const progressive = problem.progressiveSolve;
  const completedIds = new Set(Array.isArray(progressive.completedStepIds) ? progressive.completedStepIds : []);
  const { activeStepDraft: _draft, queuedEvents: _queued, transportBuffer: _buffer, ...safeProblem } = problem;
  const steps = getSolutionSteps(problem).filter((step) => completedIds.has(step.id) && !hasTransientStepFields(step));
  return {
    ...safeProblem,
    steps,
    progressiveSolve: {
      requestId: progressive.requestId,
      attemptId: progressive.attemptId,
      sessionId: progressive.sessionId,
      conversationId: progressive.conversationId,
      status: progressive.status,
      completedStepIds: steps.map((step) => step.id),
      finalAnswer: durableFinalAnswer(progressive.finalAnswer),
      assurance: progressive.assurance?.version === "bounded-assurance-v1"
        ? progressive.assurance : null,
      failure: progressive.failure || null,
      mode: progressive.mode || "progressive",
    },
  };
}
