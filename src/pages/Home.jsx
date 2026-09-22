import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Menu } from "lucide-react";
import { HoverProvider } from "@/lib/HoverContext";
import { useAuthToken } from "@/lib/auth";
import { cleanLatexSnippet, getProblemLabel, getSessionLabel, getStatusStepText } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import {
  getSolutionSteps,
  hasPersistableSessionContent,
  mergeSessionListPreservingActiveSolution,
  mergeSessionPreservingSolutionSteps,
  withNormalizedSolutionSteps,
} from "@/lib/solutionSteps";
import {
  clearSessionSolution,
  commitGeneratedProblemToSessions,
  commitReviewedProblemToSessions,
  createGeneratedProblemState,
  createPendingReviewedProblemState,
  emptyGenerationStatus,
  enforceStatusMatchesRenderedSolution,
  getActiveRenderedProblem,
} from "@/lib/solutionState";
import {
  createUserSession,
  fetchUserSessions,
  updateUserSession,
} from "@/api/userClient";
import { normalizeSolveResponse } from "@/api/mathClient";
import { createCanonicalProblemPayload, logCanonicalProblem } from "@/lib/canonicalProblem";
import { measureOmniSync } from "@/lib/performanceDiagnostics";
import { createOperationId, logSessionOperation } from "@/lib/sessionOperations";
import ProblemBlock from "@/components/math/ProblemBlock";
import ExplanationPanel from "@/components/math/ExplanationPanel";
import PrimaryMathComposer from "@/components/math/PrimaryMathComposer";
import ExportButton from "@/components/math/ExportButton";
import ImageUpload from "@/components/math/ImageUpload";
import GenerationStatus from "@/components/math/GenerationStatus";
import SessionSidebar from "@/components/layout/SessionSidebar";

const emptyProblem = {
  title: "New session",
  expression: "",
  steps: [],
};

const DEBUG_SOLUTION_STATE = import.meta.env.DEV
  && import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true";

function logSolutionState(event, details = {}) {
  if (!DEBUG_SOLUTION_STATE) return;
  console.info("[omnimath:solution-state]", {
    event,
    ...details,
  });
}

function createSession(overrides = {}) {
  const now = new Date().toISOString();
  const id = globalThis.crypto?.randomUUID?.()
    || `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    demoKey: null,
    title: "New math session",
    createdAt: now,
    updatedAt: now,
    messages: [],
    problem: emptyProblem,
    problems: [],
    steps: [],
    pinnedWindows: [],
    persisted: false,
    dirty: false,
    ...overrides,
  };
}

function isDemoSession(session = {}) {
  const demoKey = session.demoKey || session.problem?.demoKey;
  return typeof demoKey === "string" && demoKey.startsWith("demo-");
}

function stripDemoFields(problem) {
  if (!problem || typeof problem !== "object") return problem || emptyProblem;
  const { demoKey, tags, ...rest } = problem;
  return rest;
}

function normalizeSession(session) {
  const problem = session.problem
    || (Array.isArray(session.problems) ? session.problems[session.problems.length - 1] : null)
    || emptyProblem;
  const sessionSteps = getSolutionSteps(session);
  const problemSteps = getSolutionSteps(problem);
  const normalizedProblem = withNormalizedSolutionSteps({
    ...stripDemoFields(problem),
    steps: problemSteps.length > 0 ? problemSteps : sessionSteps,
  });
  const normalizedProblems = Array.isArray(session.problems)
    ? session.problems.map((item) => withNormalizedSolutionSteps(stripDemoFields(item)))
    : normalizedProblem?.expression
      ? [normalizedProblem]
      : [];

  return {
    ...createSession(),
    ...session,
    demoKey: null,
    title: session.title || titleFromProblem(normalizedProblem, "New math session"),
    problem: normalizedProblem,
    problems: normalizedProblems,
    steps: sessionSteps.length > 0 ? sessionSteps : getSolutionSteps(normalizedProblem),
    messages: Array.isArray(session.messages) ? session.messages : [],
    pinnedWindows: Array.isArray(session.pinnedWindows) ? session.pinnedWindows : [],
    persisted: Boolean(session.persisted),
    dirty: Boolean(session.dirty),
  };
}

function titleFromProblem(problem, fallback = "Math Problem") {
  return getProblemLabel(problem, fallback);
}

function compactTitle(value) {
  return cleanLatexSnippet(value, "Math Problem", 42);
}

function getUsageMeta(usage) {
  if (!usage) return "";

  const parts = [`${getUsageUsed(usage)}/${usage.limit} used today`];
  if (usage.monthly) {
    parts.push(`${getUsageUsed(usage.monthly)}/${usage.monthly.limit} used this month`);
  }
  if (usage.resetsAt) {
    const resetDate = new Date(usage.resetsAt);
    if (!Number.isNaN(resetDate.getTime())) {
      parts.push(`resets ${resetDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`);
    }
  }

  return parts.join(" | ");
}

function getUsageUsed(usage) {
  return Number.isFinite(Number(usage?.used))
    ? Number(usage.used)
    : Math.max(0, Number(usage?.limit || 0) - Number(usage?.remaining || 0));
}

function getSessionGenerationStatus(session = null) {
  const steps = getSolutionSteps(session);
  if (steps.length > 0) {
    return {
      type: "success",
      label: "Explanation ready",
      detail: getStatusStepText(steps),
      meta: "",
    };
  }
  return {
    type: "empty",
    label: session ? "Session ready" : "Ready",
    detail: session ? getSessionLabel(session, "Ready for a problem.") : "Enter a problem or upload an image to begin.",
    meta: "",
  };
}

function isPersistingWorkflow(status = {}) {
  return status.type === "loading" || status.workflowActive;
}

function IssueCard({ status }) {
  if (status.type !== "error" && status.type !== "limit") return null;
  const hints = Array.isArray(status.hints) ? status.hints : [];

  return (
    <div className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-300/[0.16] bg-rose-400/[0.055] p-4 shadow-[0_18px_44px_rgba(0,0,0,0.2)]">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-300/[0.18] bg-rose-400/[0.09]">
        <AlertTriangle className="h-4 w-4 text-rose-100" />
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rose-100/80">
          {status.label}
        </p>
        <p className="mt-1 text-sm leading-6 text-slate-200/75">
          {cleanLatexSnippet(status.detail, "", 100)}
        </p>
        {status.meta && (
          <p className="mt-2 text-xs text-slate-300/55">{status.meta}</p>
        )}
        {hints.length > 0 && (
          <ul className="mt-2 grid gap-1 text-xs leading-5 text-slate-200/68">
            {hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function qualityFailureHints(solutionIssues = []) {
  const issueSet = new Set(Array.isArray(solutionIssues) ? solutionIssues : []);
  const hints = [];
  if (issueSet.has("numerical_final_answer_mismatch")) {
    hints.push("The proposed final value disagreed with an independent numerical check.");
  }
  if (issueSet.has("detached_relation_leading_fragment")) {
    hints.push("A generated equation fragment had invalid presentation structure.");
  }
  return hints;
}

export default function Home() {
  const [sessions, setSessions] = useState(() => {
    const session = createSession({ title: "New math session" });
    return [session];
  });
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [syncStatus, setSyncStatus] = useState("");
  const [generationStatusBySession, setGenerationStatusBySession] = useState({});
  const boardRef = useRef(null);
  const saveTimerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const operationRevisionsRef = useRef({});
  const activeOperationsRef = useRef({});
  const generationStatusBySessionRef = useRef({});
  const sessionRestoreAttemptedRef = useRef(false);
  const { getToken, isLoaded, isSignedIn, isMock } = useAuthToken();
  const { settings } = useSettings();

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const generationStatus = generationStatusBySession[activeSession?.id] || getSessionGenerationStatus(activeSession);
  const problem = useMemo(() => {
    const renderedProblem = getActiveRenderedProblem(activeSession, emptyProblem);
    return {
      ...renderedProblem,
      id: renderedProblem.id || activeSession?.id,
      sessionId: activeSession?.id,
    };
  }, [activeSession]);
  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.VITE_DEBUG_MATH_RENDER !== "true") return;
    const finalLine = getSolutionSteps(problem).flatMap((step) => step?.lines || [])
      .find((line) => line?.role === "final_answer");
    if (finalLine) {
      console.info("[omnimath:final-answer-session-boundary]", {
        sessionId: activeSession?.id || null,
        problemFinalAnswerLatex: problem.finalAnswerLatex || "",
        activeProblemFinalLineLatex: finalLine.latex || "",
      });
    }
  }, [activeSession?.id, problem]);
  const providerKey = activeSession?.id ?? "default";

  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIdRef.current = activeSessionId;
    generationStatusBySessionRef.current = generationStatusBySession;
  }, [activeSessionId, generationStatusBySession, sessions]);

  const updateActiveSession = useCallback((updater, { markDirty = true } = {}) => {
    setSessions((prev) => {
      const nextSessions = prev.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              ...updater(session),
              updatedAt: new Date().toISOString(),
              dirty: markDirty || session.dirty,
            }
          : session
      );
      sessionsRef.current = nextSessions;
      return nextSessions;
    });
  }, [activeSessionId]);

  const setSessionGenerationStatus = useCallback((sessionId, status, operationContext = null) => {
    if (!sessionId) return;
    setGenerationStatusBySession((prev) => {
      const next = {
        ...prev,
        [sessionId]: status,
      };
      generationStatusBySessionRef.current = next;
      return next;
    });
    logSessionOperation("operation-status-updated", {
      operationContext,
      originSessionId: sessionId,
      activeSessionId: activeSessionIdRef.current,
      reason: status?.label || status?.type || "",
      applied: true,
    });
  }, []);

  const createOperationContext = useCallback(({
    originSessionId = "",
    workflowType = "solve",
    problemHash = "",
    imageHash = "",
    source = "",
  } = {}) => {
    const targetSessionId = originSessionId || activeSessionIdRef.current;
    const revision = (operationRevisionsRef.current[targetSessionId] || 0) + 1;
    operationRevisionsRef.current[targetSessionId] = revision;
    const operationContext = {
      operationId: createOperationId(source || workflowType),
      originSessionId: targetSessionId,
      workflowType,
      revision,
      problemHash,
      imageHash,
      createdAt: new Date().toISOString(),
    };
    activeOperationsRef.current[targetSessionId] = operationContext;
    logSessionOperation("operation-created", {
      operationContext,
      activeSessionId: activeSessionIdRef.current,
      reason: "new-session-operation",
    });
    return operationContext;
  }, []);

  const getOperationApplyDecision = useCallback((operationContext = null) => {
    const originSessionId = operationContext?.originSessionId || "";
    if (!originSessionId) {
      return { apply: false, targetSessionId: "", reason: "missing-origin-session" };
    }
    if (!sessionsRef.current.some((session) => session.id === originSessionId)) {
      return { apply: false, targetSessionId: originSessionId, reason: "origin-session-missing" };
    }
    const activeOperation = activeOperationsRef.current[originSessionId];
    if (operationContext?.operationId && activeOperation?.operationId !== operationContext.operationId) {
      return { apply: false, targetSessionId: originSessionId, reason: "stale-operation" };
    }
    if (operationContext?.revision && activeOperation?.revision !== operationContext.revision) {
      return { apply: false, targetSessionId: originSessionId, reason: "stale-revision" };
    }
    return { apply: true, targetSessionId: originSessionId, reason: "current-operation" };
  }, []);

  const canApplyOperation = useCallback((operationContext = null) => (
    getOperationApplyDecision(operationContext).apply
  ), [getOperationApplyDecision]);

  useEffect(() => {
    if (!isLoaded) return undefined;
    if (!isSignedIn || isMock) {
      sessionRestoreAttemptedRef.current = false;
      setSessionLoading(false);
      return undefined;
    }
    if (sessionRestoreAttemptedRef.current) return undefined;
    sessionRestoreAttemptedRef.current = true;

    let cancelled = false;
    setSessionLoading(true);
    setSessionError("");

    fetchUserSessions({ getToken })
      .then((data) => {
        if (cancelled) return;
        const restored = (data.sessions || [])
          .filter((session) => !isDemoSession(session))
          .map((session) => normalizeSession({
            ...session,
            persisted: true,
            dirty: false,
          }));

        const currentSessions = sessionsRef.current;
        const currentActiveSessionId = activeSessionIdRef.current;
        const protectedSessionIds = Object.entries(activeOperationsRef.current)
          .filter(([, operation]) => Boolean(operation))
          .map(([sessionId]) => sessionId);
        const merged = mergeSessionListPreservingActiveSolution(
          currentSessions,
          currentActiveSessionId,
          restored,
          { protectedSessionIds },
        );

        if (merged.sessions.length > 0) {
          const nextActive = merged.sessions.find((session) => session.id === merged.activeSessionId) || merged.sessions[0];
          const restoredSteps = getSolutionSteps(nextActive);
          const restoredCanonical = nextActive.problem?.canonicalProblem || (nextActive.problem?.expression || nextActive.problem?.problem
            ? createCanonicalProblemPayload({
                canonicalText: nextActive.problem?.originalProblem || nextActive.problem?.problem || nextActive.problem?.expression || "",
                canonicalLatex: nextActive.problem?.problemLatex || "",
                source: nextActive.problem?.imageSource ? "ocr-reviewed" : "typed",
                extractionWarnings: nextActive.problem?.extractionValidation?.issues || [],
                extractionConfidence: nextActive.problem?.extractionValidation?.confidence,
              })
            : null);
          if (restoredCanonical) {
            logCanonicalProblem("saved session restore", restoredCanonical, { sessionId: nextActive.id });
          }
          setSessions(merged.sessions);
          setActiveSessionId(nextActive.id);
          sessionsRef.current = merged.sessions;
          activeSessionIdRef.current = nextActive.id;
          if (!merged.preservedPending) {
            setSessionGenerationStatus(nextActive.id, {
              type: restoredSteps.length ? "success" : "empty",
              label: restoredSteps.length
                ? merged.preservedActive ? "Explanation ready" : "Session restored"
                : "Session ready",
              detail: restoredSteps.length
                ? getStatusStepText(restoredSteps)
                : getSessionLabel(nextActive, "Ready for a problem."),
              meta: "",
            });
          }
        } else {
          const session = createSession({ title: "New math session", dirty: false });
          setSessions([session]);
          setActiveSessionId(session.id);
          sessionsRef.current = [session];
          activeSessionIdRef.current = session.id;
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setSessionError(error.message || "Could not load your saved sessions.");
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isMock, isSignedIn, setSessionGenerationStatus]);

  useEffect(() => {
    if (!isSignedIn || isMock || !settings.productivity.autosave) return undefined;
    const sessionsToSave = sessions.filter((session) => (
      session?.dirty
      && hasPersistableSessionContent(session)
      && !isPersistingWorkflow(generationStatusBySessionRef.current[session.id])
    ));
    if (sessionsToSave.length === 0) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      setSyncStatus(sessionsToSave.length > 1 ? "Saving sessions..." : "Saving session...");
      setSessionError("");

      for (const sessionSnapshot of sessionsToSave) {
        const saveRevision = sessionSnapshot.updatedAt || "";
        logSessionOperation("session-save-started", {
          originSessionId: sessionSnapshot.id,
          activeSessionId: activeSessionIdRef.current,
          revision: saveRevision,
          reason: sessionSnapshot.persisted ? "update" : "create",
        });
        try {
          const data = sessionSnapshot.persisted
            ? await updateUserSession({ getToken, session: sessionSnapshot })
            : await createUserSession({ getToken, session: sessionSnapshot });
          const savedSession = import.meta.env.DEV
            ? measureOmniSync("session.save-response.normalize", () => normalizeSession({
              ...data.session,
              persisted: true,
              dirty: false,
            }))
            : normalizeSession({
              ...data.session,
              persisted: true,
              dirty: false,
            });
          let applied = false;
          const scheduleSessionSaveUpdate = () => setSessions((prev) => {
            const current = prev.find((session) => session.id === sessionSnapshot.id);
            if (!current) {
              logSessionOperation("session-save-discarded", {
                originSessionId: sessionSnapshot.id,
                activeSessionId: activeSessionIdRef.current,
                revision: saveRevision,
                reason: "session-missing",
                applied: false,
              });
              return prev;
            }
            if ((current.updatedAt || "") !== saveRevision && current.dirty) {
              logSessionOperation("session-save-discarded", {
                originSessionId: sessionSnapshot.id,
                activeSessionId: activeSessionIdRef.current,
                revision: saveRevision,
                reason: "newer-local-revision",
                applied: false,
              });
              return prev;
            }
            const mergedSession = import.meta.env.DEV
              ? measureOmniSync("session.save-response.merge-live-steps", () => (
                normalizeSession(mergeSessionPreservingSolutionSteps(current, savedSession))
              ))
              : normalizeSession(mergeSessionPreservingSolutionSteps(current, savedSession));
            const nextSessions = prev.map((session) => (
              session.id === sessionSnapshot.id ? mergedSession : session
            ));
            sessionsRef.current = nextSessions;
            applied = true;
            return nextSessions;
          });
          if (import.meta.env.DEV) {
            measureOmniSync("react-state.schedule-session-save-update", scheduleSessionSaveUpdate);
          } else {
            scheduleSessionSaveUpdate();
          }
          logSessionOperation(applied ? "session-save-completed" : "session-save-discarded", {
            originSessionId: sessionSnapshot.id,
            activeSessionId: activeSessionIdRef.current,
            revision: saveRevision,
            reason: applied ? "saved" : "not-applied",
            applied,
          });
          if (applied) setSyncStatus("Saved");
        } catch (error) {
          logSessionOperation("session-save-discarded", {
            originSessionId: sessionSnapshot.id,
            activeSessionId: activeSessionIdRef.current,
            revision: saveRevision,
            reason: error.body?.code || error.message || "save-failed",
            applied: false,
          });
          setSessionError(error.message || "Could not save this session.");
          const hasLiveSteps = getSolutionSteps(sessionSnapshot).length > 0;
          setSyncStatus(hasLiveSteps ? "Solved but not saved" : "");
        }
      }
    }, 700);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [getToken, isMock, isSignedIn, sessions, settings.productivity.autosave]);

  const handleNewSession = () => {
    const session = createSession();
    const nextSessions = [session, ...sessionsRef.current];
    setSessions(nextSessions);
    setActiveSessionId(session.id);
    sessionsRef.current = nextSessions;
    activeSessionIdRef.current = session.id;
    setSidebarOpen(false);
    setSessionGenerationStatus(session.id, {
      type: "empty",
      label: "New session ready",
      detail: "Type a problem or upload an image to begin.",
      meta: "",
    });
    logSessionOperation("session-switched", {
      originSessionId: session.id,
      activeSessionId: session.id,
      reason: "new-session",
    });
  };

  const handleProblemReset = () => {
    const resetSessionId = activeSessionIdRef.current;
    const nextSessions = sessionsRef.current.map((session) => (
      session.id === resetSessionId ? clearSessionSolution(session) : session
    ));
    setSessions(nextSessions);
    sessionsRef.current = nextSessions;
    activeOperationsRef.current[resetSessionId] = null;
    setSessionGenerationStatus(resetSessionId, emptyGenerationStatus());
    logSolutionState("reset", {
      activeSessionId: resetSessionId,
      renderedStepCount: 0,
      statusType: "empty",
    });
  };

  const handleSessionSelect = (sessionId) => {
    const selectedSession = sessions.find((session) => session.id === sessionId);
    const selectedSteps = getSolutionSteps(selectedSession);
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    if (!generationStatusBySessionRef.current[sessionId]) {
      setSessionGenerationStatus(sessionId, {
        type: selectedSteps.length ? "success" : "empty",
        label: selectedSteps.length ? "Session restored" : "Session ready",
        detail: selectedSteps.length
          ? getStatusStepText(selectedSteps)
          : getSessionLabel(selectedSession, "Ready for a problem."),
        meta: "",
      });
    }
    logSessionOperation("session-switched", {
      originSessionId: sessionId,
      activeSessionId: sessionId,
      reason: "select-session",
    });
  };

  const handleHistoryChange = (messages, { operationContext = null, targetSessionId = "" } = {}) => {
    const operationDecision = operationContext
      ? getOperationApplyDecision(operationContext)
      : { apply: true, targetSessionId: targetSessionId || activeSessionIdRef.current, reason: "legacy-history" };
    if (!operationDecision.apply) {
      logSessionOperation("operation-history-discarded", {
        operationContext,
        activeSessionId: activeSessionIdRef.current,
        reason: operationDecision.reason,
        applied: false,
      });
      return;
    }
    const sessionId = operationDecision.targetSessionId;
    setSessions((prev) => {
      const nextSessions = prev.map((session) => session.id === sessionId
        ? {
            ...session,
            messages,
            title: session.problem?.steps?.length || messages.length === 0
              ? session.title
              : compactTitle(messages[0]?.text),
            updatedAt: new Date().toISOString(),
            dirty: true,
          }
        : session);
      sessionsRef.current = nextSessions;
      return nextSessions;
    });
  };

  const handleProblemGenerated = (data, operationContext = data?._operationContext || null) => {
    const normalizedData = import.meta.env.DEV
      ? measureOmniSync("solve-response.home-normalize", () => (
        normalizeSolveResponse(data, { endpoint: "Home.handleProblemGenerated" })
      ))
      : normalizeSolveResponse(data, { endpoint: "Home.handleProblemGenerated" });
    if (normalizedData.canonicalProblem) {
      logCanonicalProblem("solve response", normalizedData.canonicalProblem, { endpoint: normalizedData.metadata?.endpoint });
    }
    const operationDecision = operationContext
      ? getOperationApplyDecision(operationContext)
      : { apply: true, targetSessionId: data?._requestSessionId || data?.requestSessionId || activeSessionIdRef.current, reason: "legacy-request" };
    if (!operationDecision.apply) {
      logSessionOperation("operation-result-discarded", {
        operationContext,
        activeSessionId: activeSessionIdRef.current,
        reason: operationDecision.reason,
        applied: false,
      });
      return;
    }
    const requestSessionId = operationDecision.targetSessionId;
    const beforeActiveSessionId = activeSessionIdRef.current;
    const { problemData, steps: normalizedSteps, status: responseStatus } = import.meta.env.DEV
      ? measureOmniSync("solve-response.create-generated-state", () => (
        createGeneratedProblemState(normalizedData)
      ))
      : createGeneratedProblemState(normalizedData);
    logSolutionState("solve response", {
      submittedProblemText: normalizedData.originalProblem || normalizedData.problem || normalizedData.expression || "",
      requestSessionId,
      activeSessionIdBeforeWrite: beforeActiveSessionId,
      apiResponseStepCount: getSolutionSteps(data).length,
      normalizedSolutionStepCount: normalizedSteps.length,
    });

    const commitResult = import.meta.env.DEV
      ? measureOmniSync("solve-response.commit-session-model", () => commitGeneratedProblemToSessions({
        sessions: sessionsRef.current,
        activeSessionId: requestSessionId,
        requestSessionId,
        problemData,
      }), {
        sessionCount: sessionsRef.current.length,
      })
      : commitGeneratedProblemToSessions({
        sessions: sessionsRef.current,
        activeSessionId: requestSessionId,
        requestSessionId,
        problemData,
      });
    logSolutionState("session write", {
      requestedSessionId: requestSessionId,
      sessionIdBeingWritten: commitResult.activeSessionId,
      activeSessionIdBeforeWrite: activeSessionIdRef.current,
      normalizedSolutionStepCount: normalizedSteps.length,
      renderedStepCountAfterWrite: commitResult.committedSteps.length,
      wrote: commitResult.wrote,
    });

    const scheduleSolveSessionUpdate = () => {
      setSessions(commitResult.sessions);
      sessionsRef.current = commitResult.sessions;
    };
    if (import.meta.env.DEV) {
      measureOmniSync("react-state.schedule-solve-session-update", scheduleSolveSessionUpdate, {
        sessionCount: commitResult.sessions.length,
        committedStepCount: commitResult.committedSteps.length,
      });
    } else {
      scheduleSolveSessionUpdate();
    }

    const committedStepCount = commitResult.committedSteps.length;
    const targetSessionId = commitResult.activeSessionId || requestSessionId;

    const nextStatus = committedStepCount > 0
      ? responseStatus
      : createGeneratedProblemState({ steps: [] }).status;
    const scheduleGenerationStatusUpdate = () => {
      setSessionGenerationStatus(targetSessionId, nextStatus, operationContext);
    };
    if (import.meta.env.DEV) {
      measureOmniSync("react-state.schedule-generation-status-update", scheduleGenerationStatusUpdate, {
        statusType: nextStatus.type,
        statusLabel: nextStatus.label,
      });
    } else {
      scheduleGenerationStatusUpdate();
    }
    logSolutionState("status commit", {
      activeSessionIdAfterWrite: activeSessionIdRef.current,
      targetSessionId,
      solutionStepCountInActiveSession: committedStepCount,
      statusType: nextStatus.type,
      statusLabel: nextStatus.label,
      statusDetail: nextStatus.detail,
    });
    logSessionOperation("operation-result-applied", {
      operationContext,
      originSessionId: targetSessionId,
      activeSessionId: activeSessionIdRef.current,
      problemHash: normalizedData.canonicalInputHash || normalizedData.canonicalProblem?.hash || "",
      reason: "current-operation",
      applied: true,
    });
  };

  const handleGenerationStart = (event = {}) => {
    const { source } = event;
    const operationContext = event.operationContext || createOperationContext({
      originSessionId: event.requestSessionId || activeSessionIdRef.current,
      workflowType: source === "image" ? "image-ocr-solve" : "typed-solve",
      problemHash: event.problemHash || "",
      imageHash: event.imageHash || "",
      source,
    });
    const requestSessionId = operationContext.originSessionId;
    logSolutionState("submit", {
      source,
      submittedProblemText: event.problem || "",
      activeSessionIdBeforeRequest: activeSessionIdRef.current,
      requestSessionId,
    });
    setSessionGenerationStatus(requestSessionId, {
      type: "loading",
      label: source === "image" ? "Reading image" : "Solving problem",
      detail: "Building the structured explanation.",
      meta: "",
      workflowActive: true,
    }, operationContext);
    return operationContext;
  };

  const handleExtractionReview = (extraction, operationContext = extraction?._operationContext || null) => {
    const operationDecision = getOperationApplyDecision(operationContext);
    if (!operationDecision.apply) {
      logSessionOperation("operation-result-discarded", {
        operationContext,
        activeSessionId: activeSessionIdRef.current,
        reason: operationDecision.reason,
        applied: false,
      });
      return;
    }
    const tier = extraction?.confidenceTier || extraction?.extractionValidation?.tier || "medium";
    setSessionGenerationStatus(operationDecision.targetSessionId, {
      type: tier === "low" ? "limit" : "empty",
      label: "Review extracted problem",
      detail: tier === "low"
        ? "Confidence is low or a critical math mismatch was detected."
        : "Confirm or edit the extracted problem before solving.",
      meta: extraction?.confidence !== undefined ? `${extraction.confidence}% confidence` : "",
    }, operationContext);
    logSessionOperation("extraction-completed", {
      operationContext,
      activeSessionId: activeSessionIdRef.current,
      problemHash: extraction?.canonicalProblem?.hash || "",
      reason: "review-required",
      applied: true,
    });
  };

  const handleReviewedProblemSubmitted = (payload = {}, operationContext = payload._operationContext || null) => {
    const operationDecision = getOperationApplyDecision(operationContext);
    if (!operationDecision.apply) {
      logSessionOperation("operation-result-discarded", {
        operationContext,
        activeSessionId: activeSessionIdRef.current,
        reason: operationDecision.reason,
        applied: false,
      });
      return "";
    }
    const requestSessionId = operationDecision.targetSessionId;
    const problemData = createPendingReviewedProblemState(payload);
    const commitResult = commitReviewedProblemToSessions({
      sessions: sessionsRef.current,
      activeSessionId: requestSessionId,
      requestSessionId,
      problemData,
    });
    setSessions(commitResult.sessions);
    sessionsRef.current = commitResult.sessions;
    setSessionGenerationStatus(requestSessionId, {
      type: "loading",
      label: "Solving reviewed problem",
      detail: "Building the structured explanation.",
      meta: "",
      workflowActive: true,
    }, operationContext);
    logSolutionState("reviewed problem committed", {
      requestSessionId,
      activeSessionId: commitResult.activeSessionId,
      canonicalInputHash: payload.canonicalProblem?.hash || "",
      wrote: commitResult.wrote,
    });
    logSessionOperation("operation-result-applied", {
      operationContext,
      activeSessionId: activeSessionIdRef.current,
      problemHash: payload.canonicalProblem?.hash || "",
      reason: "reviewed-problem-committed",
      applied: true,
    });
    return commitResult.activeSessionId || requestSessionId;
  };

  const handleGenerationError = ({
    source,
    message,
    status,
    code,
    usage,
    solutionIssues = [],
    retryable = false,
    operationContext = null,
  }) => {
    const operationDecision = operationContext
      ? getOperationApplyDecision(operationContext)
      : { apply: true, targetSessionId: activeSessionIdRef.current, reason: "legacy-error" };
    if (!operationDecision.apply) {
      logSessionOperation("operation-error-discarded", {
        operationContext,
        activeSessionId: activeSessionIdRef.current,
        reason: operationDecision.reason,
        applied: false,
      });
      return;
    }
    const targetSessionId = operationDecision.targetSessionId;
    const isLimitError = status === 429 && code === "USAGE_LIMIT_EXCEEDED";
    if (isLimitError) {
      setSessionGenerationStatus(targetSessionId, {
        type: "limit",
        label: source === "image" ? "Image limit reached" : "Daily limit reached",
        detail: message || "You've reached today's limit for this action.",
        meta: getUsageMeta(usage),
      }, operationContext);
      return;
    }

    const isServerError = status >= 500;
    const isAiUnavailable = code === "AI_SERVICE_UNAVAILABLE";
    const isQualityInvalid = code === "AI_SOLUTION_QUALITY_INVALID";
    const showBackendMessage = isServerError && import.meta.env.DEV && message;
    const qualityHints = qualityFailureHints(solutionIssues);
    const nextStatus = {
      type: "error",
      label: isQualityInvalid
        ? "Mathematical validation failed"
        : source === "image"
        ? "Image analysis failed"
        : source === "image-solve"
          ? "Solution generation failed"
          : "Generation failed",
      detail: isQualityInvalid
        ? "The generated solution failed mathematical validation. Your reviewed problem has been preserved."
        : isAiUnavailable
        ? "AI service timed out or connection dropped. Try again."
        : isServerError
        ? showBackendMessage
          ? message
          : "The AI backend could not complete the request."
        : message || "The solver could not complete that request.",
      meta: retryable && source === "image-solve" ? "Retry solve from the reviewed extraction." : "",
      code,
      solutionIssues,
      retryable,
      hints: qualityHints.length > 0
        ? qualityHints
        : isQualityInvalid
          ? ["Retry from the reviewed problem when ready."]
          : [],
    };
    setSessionGenerationStatus(targetSessionId, nextStatus, operationContext);
    logSessionOperation("operation-error-applied", {
      operationContext,
      activeSessionId: activeSessionIdRef.current,
      reason: code || message || "generation-error",
      applied: true,
    });
    logSolutionState("status commit", {
      source,
      statusType: nextStatus.type,
      statusLabel: nextStatus.label,
      statusDetail: nextStatus.detail,
      httpStatus: status,
      code,
      finalUiState: "error-status-rendered",
    });
  };

  const handleWindowsChange = useCallback((windows, sessionId = activeSessionId) => {
    if (!settings.interaction.stickyLensPositions) return;
    const pinnedWindows = windows.filter((window) => window.pinned);
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== sessionId) return session;
        const current = import.meta.env.DEV
          ? measureOmniSync("session.pinned-windows.stringify-current", () => JSON.stringify(session.pinnedWindows || []), {
            pinnedWindowCount: session.pinnedWindows?.length || 0,
          })
          : JSON.stringify(session.pinnedWindows || []);
        const next = import.meta.env.DEV
          ? measureOmniSync("session.pinned-windows.stringify-next", () => JSON.stringify(pinnedWindows), {
            pinnedWindowCount: pinnedWindows.length,
          })
          : JSON.stringify(pinnedWindows);
        if (current === next) return session;

        return {
          ...session,
          pinnedWindows,
          updatedAt: new Date().toISOString(),
          dirty: true,
        };
      })
    );
  }, [activeSessionId, settings.interaction.stickyLensPositions]);

  const isGenerating = generationStatus.type === "loading";
  const displayedGenerationStatus = useMemo(
    () => enforceStatusMatchesRenderedSolution(generationStatus, problem),
    [generationStatus, problem]
  );
  const renderedStepCount = getSolutionSteps(problem).length;
  useEffect(() => {
    logSolutionState("active render state", {
      activeSessionId,
      problemSessionId: problem.sessionId,
      renderedSessionId: problem.sessionId,
      solutionStepCountInActiveSession: renderedStepCount,
      statusType: generationStatus.type,
      statusLabel: generationStatus.label,
      statusDetail: generationStatus.detail,
      displayedStatusType: displayedGenerationStatus.type,
      displayedStatusLabel: displayedGenerationStatus.label,
    });
  }, [
    activeSessionId,
    displayedGenerationStatus.label,
    displayedGenerationStatus.type,
    generationStatus.detail,
    generationStatus.label,
    generationStatus.type,
    problem.sessionId,
    renderedStepCount,
  ]);

  return (
    <HoverProvider
      initialWindows={activeSession?.pinnedWindows || []}
      onWindowsChange={handleWindowsChange}
      settings={settings}
      problem={problem}
      sessionId={providerKey}
    >
      <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={handleNewSession}
          onSelectSession={handleSessionSelect}
          loading={sessionLoading}
          syncStatus={syncStatus}
          error={sessionError}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <div className="min-h-screen lg:pl-[280px]">
          <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#061116]/80 backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-[clamp(1100px,88vw,1680px)] flex-col gap-2 px-4 py-2 sm:px-6 xl:px-10">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-2 text-slate-200/75 transition-colors hover:text-teal-100 lg:hidden"
                    aria-label="Open sessions"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h1 className="shrink-0 font-sans text-base font-semibold tracking-normal text-cyan-50">
                        OmniMath
                      </h1>
                      <span className="truncate text-xs text-slate-400" title={getSessionLabel(activeSession, "New session")}>
                        {getSessionLabel(activeSession, "New session")}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <ExportButton
                    targetRef={boardRef}
                    filename={getProblemLabel(problem, "omnimath-session").toLowerCase().replace(/\s+/g, "-")}
                    problem={problem}
                    pinnedWindows={activeSession?.pinnedWindows || []}
                  />
                </div>
              </div>

              <div>
                  <PrimaryMathComposer
                    activeSessionId={activeSession?.id}
                    problem={problem}
                    history={activeSession?.messages ?? []}
                    onHistoryChange={handleHistoryChange}
                    onReset={handleProblemReset}
                    onProblemGenerated={handleProblemGenerated}
                    onGenerationStart={handleGenerationStart}
                    onGenerationError={handleGenerationError}
                    canApplyOperation={canApplyOperation}
                    imageUpload={(
                      <ImageUpload
                        activeSessionId={activeSession?.id}
                        history={activeSession?.messages ?? []}
                        onCreateOperation={createOperationContext}
                        canApplyOperation={canApplyOperation}
                        onProblemGenerated={handleProblemGenerated}
                        onGenerationStart={handleGenerationStart}
                        onGenerationError={handleGenerationError}
                        onExtractionReview={handleExtractionReview}
                        onUsageUpdate={null}
                        onReviewedProblemSubmitted={handleReviewedProblemSubmitted}
                      />
                    )}
                  />
              </div>

              {displayedGenerationStatus.type !== "error" && displayedGenerationStatus.type !== "limit" && (
                <GenerationStatus status={displayedGenerationStatus} />
              )}
            </div>
          </header>

          <main ref={boardRef} className="relative z-10 mx-auto w-full max-w-[clamp(1100px,88vw,1680px)] px-4 py-4 sm:px-6 xl:px-10">
            <div className="mx-auto min-w-0">
              <IssueCard status={displayedGenerationStatus} />
              <ProblemBlock problem={problem} loading={isGenerating} />
            </div>
          </main>
        </div>

        <ExplanationPanel problem={problem} />
      </div>
    </HoverProvider>
  );
}
