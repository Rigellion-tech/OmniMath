import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProgressiveSolveEvent,
  createFullResponseEvents,
  createProgressiveSolveState,
  progressiveDurableSnapshot,
  progressiveProblemFromState,
  PROGRESSIVE_EVENT_TYPES as TYPES,
} from "../src/lib/progressiveSolve.js";
import { deliverSyntheticEvents, syntheticSolveEvents } from "./fixtures/progressiveSolve.mjs";
import { buildProvenanceSnapshot, getConversationId, getTargetRevision } from "../src/lib/explanationProvenance.js";
import { buildSessionPayload } from "../src/api/userClient.js";

const identity = { requestId: "request-a", attemptId: "attempt-a", sessionId: "session-a", conversationId: "conversation-a" };
const start = (id = identity) => ({ ...id, type: TYPES.STARTED, sequence: 0 });
const apply = (state, event) => applyProgressiveSolveEvent(state, event);

test("five completed steps and final answer follow the ordered contract", async () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const events = syntheticSolveEvents(identity);
  const results = await deliverSyntheticEvents(events, (event) => {
    const result = apply(state, event);
    state = result.state;
    return result;
  }, { delayMs: 1 });
  assert.ok(results.every((result) => result.accepted));
  assert.equal(state.status, "complete");
  assert.equal(state.completedSteps.length, 5);
  assert.equal(state.finalAnswer.finalAnswer, "x=2 or x=3");
  assert.equal(state.activeStepDraft, null);
});

test("an unvalidated step-complete event cannot enter the semantic solution", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const [metadata, started, completed] = syntheticSolveEvents(identity);
  state = apply(state, metadata).state;
  state = apply(state, started).state;
  assert.equal(apply(state, { ...completed, validation: null }).reason, "invalid-completed-step");
  assert.equal(apply(state, { ...completed, validation: { status: "accepted" } }).reason, "invalid-completed-step");
  assert.equal(apply(state, { ...completed, step: { ...completed.step, draftText: "\\frac{" } }).reason, "invalid-completed-step");
  assert.equal(state.completedSteps.length, 0);
  assert.equal(state.activeStepDraft.stepId, started.stepId);
});

test("accepted completed steps are detached and deeply immutable", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const [metadata, started, completed] = syntheticSolveEvents(identity);
  state = apply(state, metadata).state;
  state = apply(state, started).state;
  state = apply(state, completed).state;
  completed.step.math = "mutated after delivery";
  completed.step.assumptions.push("mutated assumption");
  assert.equal(state.completedSteps[0].math, "x^2-5x+6=(x-2)(x-3)");
  assert.deepEqual(state.completedSteps[0].assumptions, ["x is real"]);
  assert.equal(Object.isFrozen(state.completedSteps[0]), true);
  assert.equal(Object.isFrozen(state.completedSteps[0].assumptions), true);
});

test("duplicate and reordered events do not duplicate steps", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const [metadata, started, completed] = syntheticSolveEvents(identity);
  assert.equal(apply(state, completed).reason, "out-of-order");
  state = apply(state, metadata).state;
  state = apply(state, started).state;
  assert.equal(apply(state, started).reason, "duplicate");
  state = apply(state, completed).state;
  assert.equal(apply(state, { ...completed, step: { ...completed.step, math: "changed" } }).reason, "conflicting-duplicate");
  assert.equal(state.completedSteps.length, 1);
  assert.equal(apply(state, { ...syntheticSolveEvents(identity)[3], stepId: "progressive-step-1" }).reason, "invalid-step-start");
});

test("partial drafts never become authoritative or durable; failure preserves completed steps", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  for (const event of syntheticSolveEvents(identity, { failAfter: 3 })) state = apply(state, event).state;
  assert.equal(state.status, "failed");
  assert.equal(state.completedSteps.length, 3);
  assert.equal(state.activeStepDraft, null);
  const durable = progressiveProblemFromState(state);
  assert.equal(durable.steps.length, 3);
  assert.equal(durable.progressiveSolve.status, "failed");
  assert.equal(JSON.stringify(durable).includes("activeStepDraft"), false);
  assert.equal(JSON.stringify(durable).includes("eventSignatures"), false);
  assert.equal(JSON.stringify(durable).includes("Failed at step 4"), true);
  assert.equal(apply(state, { ...identity, sequence: state.lastSequence + 1, type: TYPES.STEP_COMPLETED,
    stepId: "progressive-step-4", stepIndex: 3, step: { id: "progressive-step-4", math: "x=4" } }).reason, "terminal-attempt");
});

test("cancel after step two seals the attempt and retains only completed steps", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const events = syntheticSolveEvents(identity);
  for (const event of events.slice(0, 5)) state = apply(state, event).state;
  assert.equal(state.completedSteps.length, 2);
  state = apply(state, { ...identity, sequence: state.lastSequence + 1, type: TYPES.CANCELLED }).state;
  assert.equal(state.status, "cancelled");
  assert.equal(state.completedSteps.length, 2);
  assert.equal(apply(state, events[5]).accepted, false);
});

test("new attempts and session identity reject stale events without mutating previous completed work", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  for (const event of syntheticSolveEvents(identity, { failAfter: 2 })) state = apply(state, event).state;
  const previousSteps = state.completedSteps;
  const retry = { ...identity, requestId: "request-b", attemptId: "attempt-b" };
  state = apply(state, start(retry)).state;
  assert.equal(state.previousAttempts[0].completedSteps, previousSteps);
  assert.equal(apply(state, syntheticSolveEvents(identity)[0]).reason, "stale-identity");
  assert.equal(apply(state, start(identity)).reason, "stale-attempt");
  assert.equal(apply(state, { ...syntheticSolveEvents(retry)[0], sessionId: "session-b" }).reason, "stale-identity");
  assert.equal(state.completedSteps.length, 0);
  for (const event of syntheticSolveEvents(retry, { stepCount: 5 })) {
    const result = apply(state, event);
    assert.equal(result.accepted, true, result.reason);
    state = result.state;
  }
  assert.equal(state.status, "complete");
  assert.equal(state.completedSteps.length, 5);
  assert.equal(state.previousAttempts[0].completedSteps, previousSteps);
});

test("superseding an active attempt cancels its version; a late old event is stale", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const events = syntheticSolveEvents(identity);
  for (const event of events.slice(0, 3)) state = apply(state, event).state;
  const next = { ...identity, requestId: "request-b", attemptId: "attempt-b" };
  state = apply(state, { ...start(next), supersedesAttemptId: identity.attemptId }).state;
  assert.equal(state.previousAttempts[0].status, "cancelled");
  assert.equal(state.previousAttempts[0].completedSteps.length, 1);
  assert.equal(apply(state, events[3]).reason, "stale-identity");
  assert.equal(apply(state, start(identity)).reason, "stale-attempt");
});

test("full-response adapter produces the same completed steps and durable final answer", () => {
  const problem = {
    title: "Canonical response", problem: "Solve x+1=2", steps: [
      { id: "a", math: "x+1=2" }, { id: "b", math: "x=1" },
    ], finalAnswerLatex: "x=1",
    assurance: { version: "bounded-assurance-v1", status: "supported_checks_passed" },
  };
  let state = createProgressiveSolveState();
  for (const event of createFullResponseEvents(problem, identity)) {
    const result = apply(state, event);
    assert.equal(result.accepted, true, result.reason);
    state = result.state;
  }
  assert.deepEqual(state.completedSteps, problem.steps);
  assert.equal(state.status, "complete");
  assert.equal(progressiveDurableSnapshot(state).finalAnswer.finalAnswerLatex, "x=1");
  assert.equal(progressiveProblemFromState(state).assurance.status, "supported_checks_passed");
});

test("an early completed step keeps immutable occurrence provenance as later steps arrive", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  const events = syntheticSolveEvents(identity);
  for (const event of events.slice(0, 3)) state = apply(state, event).state;
  const earlyProblem = { id: identity.sessionId, ...progressiveProblemFromState(state) };
  const item = {
    stepId: "progressive-step-1",
    selectedText: "x",
    selectedTokens: [{ id: "early-x", semanticNodeId: "early-x", source: "x", sourceRange: { start: 0, end: 1 } }],
    context: { problem: earlyProblem, solution: earlyProblem, stepId: "progressive-step-1", currentStep: earlyProblem.steps[0] },
  };
  const snapshot = buildProvenanceSnapshot({ item, problem: earlyProblem });
  const originalRevision = getTargetRevision(snapshot);
  const conversationId = getConversationId(snapshot);
  for (const event of events.slice(3, 5)) state = apply(state, event).state;
  assert.equal(state.completedSteps[0], earlyProblem.steps[0]);
  assert.equal(snapshot.evidence.steps.length, 1);
  assert.deepEqual(snapshot.evidence.steps[0].assumptions, ["x is real"]);
  assert.equal(snapshot.target.stepId, "progressive-step-1");
  assert.equal(snapshot.target.sourceRange.start, 0);
  assert.equal(getTargetRevision(snapshot), originalRevision);
  assert.equal(getConversationId(snapshot), conversationId);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("session persistence keeps completed provenance but strips all transient generation fields", () => {
  let state = apply(createProgressiveSolveState(), start()).state;
  for (const event of syntheticSolveEvents(identity).slice(0, 3)) state = apply(state, event).state;
  const problem = {
    ...progressiveProblemFromState(state),
    activeStepDraft: { text: "\\frac{" },
    queuedEvents: [{ type: "step_completed" }],
    transportBuffer: "\\frac{",
    steps: [...state.completedSteps, { id: "draft-step", math: "\\frac{", draftText: "\\frac{" }],
    progressiveSolve: { ...progressiveDurableSnapshot(state), mode: "progressive", activeStepDraft: "\\frac{" },
  };
  const payload = buildSessionPayload({
    id: identity.sessionId,
    title: "Partial solution",
    problem,
    problems: [problem],
    steps: problem.steps,
  });
  const serialized = JSON.stringify(payload);
  assert.equal(payload.steps.length, 1);
  assert.equal(payload.problem.steps.length, 1);
  assert.equal(payload.problems[0].steps.length, 1);
  assert.equal(payload.problem.steps[0].id, "progressive-step-1");
  assert.equal(serialized.includes("activeStepDraft"), false);
  assert.equal(serialized.includes("queuedEvents"), false);
  assert.equal(serialized.includes("transportBuffer"), false);
  assert.equal(serialized.includes("draft-step"), false);
});
