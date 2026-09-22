import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSolveResponse } from "../src/api/mathClient.js";
import { getGeneratedProblemStatus } from "../src/lib/generationStatus.js";
import {
  getSolutionSteps,
  hasPersistableSessionContent,
  mergeSessionListPreservingActiveSolution,
  mergeSessionPreservingSolutionSteps,
} from "../src/lib/solutionSteps.js";
import {
  clearSessionSolution,
  commitGeneratedProblemToSessions,
  commitReviewedProblemToSessions,
  createGeneratedProblemState,
  createPendingReviewedProblemState,
  emptyGenerationStatus,
  enforceStatusMatchesRenderedSolution,
  getActiveRenderedProblem,
} from "../src/lib/solutionState.js";

const steps = [
  { id: "s1", label: "Step 1", math: "x=1" },
  { id: "s2", label: "Step 2", math: "x+1=2" },
];

describe("solve response normalization", () => {
  it("renders and reports eight steps from the current solve response", () => {
    const eightSteps = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index + 1}`,
      label: `Step ${index + 1}`,
      math: `x_${index + 1}`,
    }));
    const normalized = normalizeSolveResponse({
      explanation: {
        steps: eightSteps,
      },
    }, { endpoint: "/api/explain" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(getSolutionSteps(normalized).length, 8);
    assert.equal(normalized.steps.length, 8);
    assert.equal(status.detail, "8 steps generated");
  });

  it("renders and reports six steps from a nested explanation solution", () => {
    const sixSteps = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 1}`,
      label: `Step ${index + 1}`,
      math: `x_${index + 1}`,
    }));
    const normalized = normalizeSolveResponse({
      steps: [],
      explanation: {
        solution: {
          steps: sixSteps,
        },
      },
    }, { endpoint: "/api/explain" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(getSolutionSteps(normalized).length, 6);
    assert.equal(normalized.steps.length, 6);
    assert.equal(status.detail, "6 steps generated");
  });

  it("promotes nested explanation.steps for rendering and status", () => {
    const normalized = normalizeSolveResponse({
      title: "Nested explanation",
      explanation: {
        steps,
        finalAnswer: "2",
      },
    }, { endpoint: "/api/solve-extracted-problem" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(normalized.steps.length, 2);
    assert.equal(normalized.finalAnswer, "2");
    assert.equal(status.label, "Explanation ready");
    assert.equal(status.detail, "2 steps generated");
  });

  it("promotes nested result.steps for rendering and status", () => {
    const normalized = normalizeSolveResponse({
      result: {
        title: "Nested result",
        steps,
        finalAnswerLatex: "\\boxed{2}",
      },
    }, { endpoint: "/api/explain" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(normalized.steps.length, 2);
    assert.equal(normalized.finalAnswer, "\\boxed{2}");
    assert.equal(status.detail, "2 steps generated");
  });

  it("keeps live steps when save/history reports request body too large", () => {
    const normalized = normalizeSolveResponse({
      steps,
      runtime: { saveWarning: "request_body_too_large" },
      metadata: { saveStatus: "failed" },
    }, { endpoint: "/api/solve-extracted-problem" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(normalized.steps.length, 2);
    assert.equal(normalized.metadata.saveStatus, "not_saved");
    assert.equal(status.label, "Solved but not saved");
    assert.equal(status.detail, "2 steps generated");
  });

  it("keeps visible live steps when a saved session response is summary-only", () => {
    const liveSession = {
      id: "local-session",
      title: "Solved session",
      problem: {
        expression: "x+1=2",
        steps,
      },
      steps,
    };
    const savedSummary = {
      id: "persisted-session",
      title: "Solved session",
      problem: {
        expression: "x+1=2",
      },
      steps: [],
      persisted: true,
      dirty: false,
    };

    const merged = mergeSessionPreservingSolutionSteps(liveSession, savedSummary);
    const status = getGeneratedProblemStatus(merged, merged.problem);

    assert.equal(merged.id, "persisted-session");
    assert.equal(merged.problem.steps.length, 2);
    assert.equal(getSolutionSteps(merged).length, 2);
    assert.equal(status.detail, "2 steps generated");
  });

  it("keeps active explanation if sessions:create returns no usable session payload", () => {
    const liveSession = {
      id: "active-solved-session",
      problem: {
        expression: "x+1=2",
        steps,
      },
      steps,
    };

    const merged = mergeSessionPreservingSolutionSteps(liveSession, {});

    assert.equal(getSolutionSteps(merged).length, 2);
    assert.equal(merged.problem.steps.length, 2);
  });

  it("keeps active explanation if sessions:list falls back to an empty local result", () => {
    const liveSession = {
      id: "active-solved-session",
      problem: {
        expression: "x+1=2",
        steps,
      },
      steps,
    };

    const merged = mergeSessionListPreservingActiveSolution([liveSession], liveSession.id, []);

    assert.equal(merged.preservedActive, true);
    assert.equal(merged.activeSessionId, liveSession.id);
    assert.equal(merged.sessions[0].problem.steps.length, 2);
  });

  it("keeps a dirty in-flight session when sessions:list falls back to an empty result", () => {
    const pendingSession = {
      id: "pending-typed-session",
      dirty: true,
      messages: [{ role: "user", text: "solve x+1=2" }],
      problem: { expression: "", steps: [] },
      steps: [],
    };

    const merged = mergeSessionListPreservingActiveSolution([pendingSession], pendingSession.id, []);

    assert.equal(merged.preservedActive, true);
    assert.equal(merged.activeSessionId, pendingSession.id);
    assert.equal(merged.sessions[0], pendingSession);
  });

  it("keeps an explicit operation owner while merging a delayed remote session list", () => {
    const pendingSession = {
      id: "pending-image-session",
      dirty: false,
      messages: [],
      problem: { expression: "", steps: [] },
      steps: [],
    };
    const remoteSession = {
      id: "remote-session",
      problem: { expression: "y=2", steps },
      steps,
    };

    const merged = mergeSessionListPreservingActiveSolution(
      [pendingSession],
      pendingSession.id,
      [remoteSession],
      { protectedSessionIds: [pendingSession.id] },
    );

    assert.equal(merged.preservedActive, true);
    assert.equal(merged.preservedPending, true);
    assert.equal(merged.activeSessionId, pendingSession.id);
    assert.equal(merged.sessions[0], pendingSession);
    assert.equal(merged.sessions[1], remoteSession);
  });

  it("does not replace newer dirty chat with a delayed restored snapshot of the same session", () => {
    const liveSession = {
      id: "same-session",
      dirty: true,
      messages: [{ role: "user", text: "why?" }],
      pinnedWindows: [{ id: "pin", chatHistory: [{ role: "user", text: "why?" }] }],
      problem: { expression: "x+1=2", steps },
      steps,
    };
    const restoredSession = {
      id: "same-session",
      dirty: false,
      messages: [],
      pinnedWindows: [{ id: "pin", chatHistory: [] }],
      problem: { expression: "x+1=2", steps },
      steps,
    };

    const merged = mergeSessionListPreservingActiveSolution(
      [liveSession],
      liveSession.id,
      [restoredSession],
    );

    assert.equal(merged.sessions[0], liveSession);
    assert.deepEqual(merged.sessions[0].pinnedWindows[0].chatHistory, [{ role: "user", text: "why?" }]);
  });

  it("does not autosave a blank dirty session, preventing repeated sessions:create loops", () => {
    const blankSession = {
      id: "blank",
      dirty: true,
      problem: { title: "New session", expression: "", steps: [] },
      messages: [],
      pinnedWindows: [],
      steps: [],
    };
    const solvedSession = {
      ...blankSession,
      problem: { expression: "x+1=2", steps },
      steps,
    };

    assert.equal(hasPersistableSessionContent(blankSession), false);
    assert.equal(hasPersistableSessionContent(solvedSession), true);
  });

  it("treats nested session explanation steps as non-empty even without problem text", () => {
    const session = {
      id: "session-with-nested-steps",
      problem: {},
      session: {
        explanation: {
          solution: {
            steps,
          },
        },
      },
    };
    const status = getGeneratedProblemStatus(session, session.problem);

    assert.equal(getSolutionSteps(session).length, 2);
    assert.equal(status.type, "success");
    assert.equal(status.detail, "2 steps generated");
  });

  it("does not report ready when normalized renderer steps are empty", () => {
    const normalized = normalizeSolveResponse({
      title: "No steps",
      explanation: { steps: [] },
    }, { endpoint: "/api/solve-extracted-problem" });
    const status = getGeneratedProblemStatus(normalized, normalized);

    assert.equal(normalized.steps.length, 0);
    assert.equal(status.type, "error");
    assert.notEqual(status.label, "Explanation ready");
  });

  it("retains empty step positions as visible boundary errors", () => {
    const normalized = normalizeSolveResponse({
      title: "Malformed steps",
      steps: [{}, { id: "heading-only", label: "Intermediate step" }],
    }, { endpoint: "/api/explain" });
    assert.equal(normalized.steps.length, 2);
    assert.deepEqual(normalized.steps.map((step) => step.renderBoundaryError), [
      { type: "accepted_empty", field: "steps[0]", index: 0 },
      { type: "accepted_empty", field: "steps[1]", index: 1 },
    ]);
    assert.ok(normalized.steps.every((step) => /empty or malformed/u.test(step.summary)));
  });

  it("retains malformed middle positions without closing the solution gap", () => {
    const normalized = normalizeSolveResponse({
      steps: [null, "", { id: "valid", math: "x=1" }],
      finalAnswerLatex: "x=1",
    }, { endpoint: "/api/explain" });

    assert.equal(normalized.steps.length, 3);
    assert.equal(normalized.steps[0].renderBoundaryError.index, 0);
    assert.equal(normalized.steps[1].renderBoundaryError.index, 1);
    assert.deepEqual(normalized.steps[2], { id: "valid", math: "x=1" });
  });

  it("does not let an unusable outer step array mask valid nested solution steps", () => {
    const normalized = normalizeSolveResponse({
      steps: [{}],
      explanation: { steps },
    }, { endpoint: "/api/explain" });

    assert.deepEqual(normalized.steps, steps);
  });

  it("preserves duplicate provider ids without inventing client suffixes", () => {
    const normalized = normalizeSolveResponse({
      requestId: "req-duplicate",
      steps: [
        { id: "same", math: "x=1" },
        { id: "same", math: "x=2" },
      ],
    }, { endpoint: "/api/explain" });

    assert.deepEqual(normalized.steps.map((step) => step.id), ["same", "same"]);
    assert.equal(normalized.metadata.requestId, "req-duplicate");
  });

  it("commits typed solve steps to the currently active render session if request session was replaced", () => {
    const normalized = normalizeSolveResponse({
      problem: "3x+45=67",
      steps,
    }, { endpoint: "/api/explain" });
    const { problemData, steps: normalizedSteps } = createGeneratedProblemState(normalized);
    const sessions = [
      { id: "restored-active", problem: { title: "New session", expression: "", steps: [] }, steps: [] },
    ];
    const committed = commitGeneratedProblemToSessions({
      sessions,
      activeSessionId: "restored-active",
      requestSessionId: "stale-local-session",
      problemData,
    });

    assert.equal(normalizedSteps.length, 2);
    assert.equal(committed.activeSessionId, "restored-active");
    assert.equal(getSolutionSteps(committed.committedSession).length, 2);
    assert.equal(committed.sessions[0].problem.steps.length, 2);
  });

  it("keeps status ready and rendered active step count matched after commit", () => {
    const normalized = normalizeSolveResponse({
      title: "Math Problem",
      expression: "3x+45=67",
      steps,
    }, { endpoint: "/api/explain" });
    const generated = createGeneratedProblemState(normalized);
    const committed = commitGeneratedProblemToSessions({
      sessions: [{ id: "s1", problem: {}, steps: [] }],
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: generated.problemData,
    });
    const renderedSteps = getSolutionSteps(committed.sessions[0]);

    assert.equal(generated.status.label, "Explanation ready");
    assert.equal(generated.status.detail, "2 steps generated");
    assert.equal(renderedSteps.length, 2);
    assert.equal(generated.status.detail, `${renderedSteps.length} steps generated`);
  });

  it("selecting a saved committed session still renders its steps", () => {
    const generated = createGeneratedProblemState(normalizeSolveResponse({
      expression: "3x+45=67",
      steps,
    }, { endpoint: "/api/explain" }));
    const committed = commitGeneratedProblemToSessions({
      sessions: [
        { id: "blank", problem: {}, steps: [] },
        { id: "saved", persisted: true, problem: {}, steps: [] },
      ],
      activeSessionId: "saved",
      requestSessionId: "saved",
      problemData: generated.problemData,
    });
    const selected = committed.sessions.find((session) => session.id === "saved");

    assert.equal(getSolutionSteps(selected).length, 2);
  });

  it("renders saved session steps when they are stored at session level but problem.steps is empty", () => {
    const selectedSession = {
      id: "saved-session",
      problem: {
        expression: "3x^2 + 5x - 7 = 0",
        steps: [],
      },
      steps,
    };
    const renderedProblem = getActiveRenderedProblem(selectedSession);
    const status = getGeneratedProblemStatus(selectedSession, renderedProblem);

    assert.equal(getSolutionSteps(renderedProblem).length, 2);
    assert.equal(status.label, "Explanation ready");
    assert.equal(status.detail, "2 steps generated");
  });

  it("commits and renders quadratic typed equations containing powers", () => {
    const quadraticSteps = [{ id: "q1", label: "Step 1", math: "x=\\frac{-5\\pm\\sqrt{109}}{6}" }];
    const normalized = normalizeSolveResponse({
      expression: "3x^2 + 5x - 7 = 0",
      steps: quadraticSteps,
    }, { endpoint: "/api/explain" });
    const generated = createGeneratedProblemState(normalized);
    const committed = commitGeneratedProblemToSessions({
      sessions: [{ id: "s1", problem: {}, steps: [] }],
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: generated.problemData,
    });
    const renderedProblem = getActiveRenderedProblem(committed.sessions[0]);
    const renderedSteps = getSolutionSteps(renderedProblem);
    const guardedStatus = enforceStatusMatchesRenderedSolution(generated.status, renderedProblem);

    assert.equal(renderedSteps.length, 1);
    assert.equal(guardedStatus.label, "Explanation ready");
    assert.equal(guardedStatus.detail, "1 step generated");
  });

  it("reset clears both solution steps and ready status together", () => {
    const session = {
      id: "s1",
      persisted: true,
      problem: { expression: "3x+45=67", steps },
      steps,
      messages: [{ role: "user", text: "3x+45=67" }],
    };
    const reset = clearSessionSolution(session);
    const status = emptyGenerationStatus();

    assert.equal(getSolutionSteps(reset).length, 0);
    assert.equal(status.type, "empty");
    assert.notEqual(status.label, "Explanation ready");
  });

  it("does not allow ready status when the committed render session has no steps", () => {
    const status = getGeneratedProblemStatus({}, { steps: [] });

    assert.equal(status.type, "error");
    assert.notEqual(status.label, "Explanation ready");
  });

  it("downgrades impossible ready status when rendered steps are empty", () => {
    const guarded = enforceStatusMatchesRenderedSolution({
      type: "success",
      label: "Explanation ready",
      detail: "1 step generated",
      meta: "",
    }, { expression: "", steps: [] });

    assert.equal(guarded.type, "error");
    assert.notEqual(guarded.label, "Explanation ready");
  });

  it("commits reviewed OCR problem before solve success and preserves it through failure", () => {
    const canonicalProblem = {
      canonicalText: "Evaluate: integral of arctan",
      canonicalLatex: "\\int_0^1 \\arctan(x)\\,dx",
      hash: "ocr-reviewed-hash",
      source: "ocr-reviewed",
    };
    const pendingProblem = createPendingReviewedProblemState({
      problem: canonicalProblem.canonicalLatex,
      problemText: canonicalProblem.canonicalText,
      problemLatex: canonicalProblem.canonicalLatex,
      canonicalProblem,
      extraction: { confidence: 92 },
      solveDecision: "confirmed",
      reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: canonicalProblem.hash },
    });
    const committed = commitReviewedProblemToSessions({
      sessions: [{ id: "s1", problem: {}, problems: [], steps: [] }],
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: pendingProblem,
    });
    const rendered = getActiveRenderedProblem(committed.sessions[0]);
    const failedStatus = {
      type: "error",
      label: "Mathematical validation failed",
      detail: "The generated solution failed mathematical validation. Your reviewed problem has been preserved.",
      meta: "",
    };

    assert.equal(committed.sessions[0].problems.length, 1);
    assert.equal(rendered.canonicalProblem.hash, "ocr-reviewed-hash");
    assert.equal(rendered.expression, canonicalProblem.canonicalLatex);
    assert.equal(getSolutionSteps(rendered).length, 0);
    assert.equal(failedStatus.detail.includes("preserved"), true);
  });

  it("retry and success replace the same reviewed OCR session problem without duplicating history", () => {
    const canonicalProblem = {
      canonicalText: "Evaluate: integral of arctan",
      canonicalLatex: "\\int_0^1 \\arctan(x)\\,dx",
      hash: "ocr-reviewed-retry-hash",
      source: "ocr-reviewed",
    };
    const pendingProblem = createPendingReviewedProblemState({
      problem: canonicalProblem.canonicalLatex,
      problemText: canonicalProblem.canonicalText,
      problemLatex: canonicalProblem.canonicalLatex,
      canonicalProblem,
      extraction: { confidence: 92 },
      solveDecision: "confirmed",
      reviewAction: { kind: "confirmed_unchanged", canonicalInputHash: canonicalProblem.hash },
    });
    const firstPending = commitReviewedProblemToSessions({
      sessions: [{ id: "s1", problem: {}, problems: [], steps: [] }],
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: pendingProblem,
    });
    const secondPending = commitReviewedProblemToSessions({
      sessions: firstPending.sessions,
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: pendingProblem,
    });
    const solved = createGeneratedProblemState(normalizeSolveResponse({
      expression: canonicalProblem.canonicalLatex,
      canonicalProblem,
      steps,
    }, { endpoint: "/api/solve-extracted-problem" }));
    const success = commitGeneratedProblemToSessions({
      sessions: secondPending.sessions,
      activeSessionId: "s1",
      requestSessionId: "s1",
      problemData: solved.problemData,
    });

    assert.equal(secondPending.sessions[0].problems.length, 1);
    assert.equal(success.sessions[0].problems.length, 1);
    assert.equal(success.sessions[0].problem.canonicalProblem.hash, "ocr-reviewed-retry-hash");
    assert.equal(getSolutionSteps(success.sessions[0]).length, 2);
  });
});
