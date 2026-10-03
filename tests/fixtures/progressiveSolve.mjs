import { PROGRESSIVE_EVENT_TYPES } from "../../src/lib/progressiveSolve.js";

/** Deterministic transport-free fixture; callers control exactly when each event is delivered. */
export function syntheticSolveEvents(identity, { stepCount = 5, failAfter = null } = {}) {
  const events = [];
  const emit = (type, details = {}) => events.push({ ...identity, sequence: events.length + 1, type, ...details });
  emit(PROGRESSIVE_EVENT_TYPES.METADATA, { metadata: {
    title: "Progressive quadratic solve",
    problem: "Solve x^2-5x+6=0.",
    originalProblem: "Solve x^2-5x+6=0.",
    expression: "x^2-5x+6=0",
    assumptions: ["x is real"],
  } });
  for (let index = 0; index < stepCount; index += 1) {
    const stepId = `progressive-step-${index + 1}`;
    emit(PROGRESSIVE_EVENT_TYPES.STEP_STARTED, { stepId, stepIndex: index });
    if (failAfter === index) {
      emit(PROGRESSIVE_EVENT_TYPES.FAILED, { reason: `Failed at step ${index + 1}`, retryable: true });
      return events;
    }
    emit(PROGRESSIVE_EVENT_TYPES.STEP_COMPLETED, {
      stepId,
      stepIndex: index,
      step: {
        id: stepId,
        label: `Solve step ${index + 1}`,
        math: index === 0 ? "x^2-5x+6=(x-2)(x-3)" : `x=${index + 1}`,
        summary: `Completed reasoning for step ${index + 1}.`,
        assumptions: ["x is real"],
      },
      validation: { status: "accepted", authority: "synthetic-fixture" },
    });
  }
  emit(PROGRESSIVE_EVENT_TYPES.FINAL_ANSWER, { answer: {
    finalAnswer: "x=2 or x=3",
    finalAnswerLatex: "x=2\\text{ or }x=3",
  } });
  emit(PROGRESSIVE_EVENT_TYPES.COMPLETED);
  return events;
}

export async function deliverSyntheticEvents(events, dispatch, { delayMs = 0 } = {}) {
  const results = [];
  for (const event of events) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    results.push(await dispatch(event));
  }
  return results;
}
