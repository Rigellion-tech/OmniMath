import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Menu } from "lucide-react";
import { HoverProvider } from "@/lib/HoverContext";
import ExportButton from "@/components/math/ExportButton";
import { useAuthToken } from "@/lib/auth";
import { cleanLatexSnippet, getConciseProblemTitle, getSessionLabel, getStatusStepText } from "@/lib/problemLabels";
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
  createPendingTypedProblemState,
  emptyGenerationStatus,
  enforceStatusMatchesRenderedSolution,
  getActiveRenderedProblem,
} from "@/lib/solutionState";
import { getFinalSolveTimeoutStatus } from "@/lib/generationStatus";
import {
  createUserSession,
  deleteUserSession,
  fetchUserSessions,
  updateUserSession,
} from "@/api/userClient";
import { normalizeSolveResponse } from "@/api/mathClient";
import { createCanonicalProblemPayload, logCanonicalProblem } from "@/lib/canonicalProblem";
import { measureOmniSync } from "@/lib/performanceDiagnostics";
import { markProgressiveEventReceived } from "@/lib/progressivePresentationDiagnostics";
import {
  applyProgressiveSolveEvent,
  createFullResponseEvents,
  createProgressiveSolveState,
  progressiveProblemFromState,
  progressiveDurableSnapshot,
  PROGRESSIVE_EVENT_TYPES,
} from "@/lib/progressiveSolve";
import { createOperationId, logSessionOperation } from "@/lib/sessionOperations";
import ProblemBlock from "@/components/math/ProblemBlock";
import ExplanationPanel from "@/components/math/ExplanationPanel";
import PrimaryMathComposer from "@/components/math/PrimaryMathComposer";
import ImageUpload from "@/components/math/ImageUpload";
import GenerationStatus from "@/components/math/GenerationStatus";
import SessionSidebar from "@/components/layout/SessionSidebar";
import { normalizeWorkspaceConversation } from "@/lib/workspaceConversation";
import "@/workspace.css";

const emptyProblem = {
  title: "New session",
  expression: "",
  steps: [],
};

const DEBUG_SOLUTION_STATE = import.meta.env.DEV
  && import.meta.env.VITE_DEBUG_SOLUTION_STATE === "true";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "omnimath.sidebar.collapsed";

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
    workspaceConversation: normalizeWorkspaceConversation(),
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
    workspaceConversation: normalizeWorkspaceConversation(session.workspaceConversation),
    pinnedWindows: Array.isArray(session.pinnedWindows) ? session.pinnedWindows : [],
    persisted: Boolean(session.persisted),
    dirty: Boolean(session.dirty),
  };
}

function titleFromProblem(problem, fallback = "Math Problem") {
  return getConciseProblemTitle(problem, fallback);
}

function compactTitle(value) {
  return getConciseProblemTitle({ problem: value }, "Math Problem");
}

function hasWorkspaceProblem(problem = {}) {
  return Boolean(
    getSolutionSteps(problem).length
    || problem.canonicalProblem?.canonicalText
    || problem.canonicalProblem?.canonicalLatex
    || problem.imageSource
    || problem.extractedProblemText
    || problem.extractedProblemLatex
    || problem.originalProblem
    || problem.problem
    || problem.problemLatex
    || problem.expression
  );
}

function withoutManualLensPosition(window) {
  const next = { ...window, placementMode: "stacked" };
  delete next.x;
  delete next.y;
  delete next.manualOffset;
  delete next.manualPosition;
  delete next.horizontalRatio;
  delete next.position;
  return next;
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

function solveIdentity(operationContext, sessionId, fallbackRequestId = "") {
  const requestId = operationContext?.operationId || fallbackRequestId || createOperationId("solve");
  return {
    requestId,
    attemptId: operationContext ? `${requestId}:${operationContext.revision}` : requestId,
    sessionId,
    conversationId: sessionId,
  };
}

function getSessionGenerationStatus(session = null) {
  const steps = getSolutionSteps(session);
  const progressive = session?.problem?.progressiveSolve;
  if (progressive?.status === "failed" || progressive?.status === "cancelled") {
    return {
      type: progressive.status === "failed" ? "error" : "warning",
      label: progressive.status === "failed" ? "Generation stopped" : "Generation cancelled",
      detail: progressive.failure?.message || `${steps.length} completed steps preserved.`,
      meta: steps.length ? `${steps.length} completed steps` : "",
      retryable: progressive.failure?.retryable !== false,
    };
  }
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
    <div className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-200 bg-rose-100">
        <AlertTriangle className="h-4 w-4 text-rose-700" />
      </div>
      <div className="min-w-0">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-rose-800">
          {status.label}
        </p>
        <p className="mt-1 text-sm leading-6 text-neutral-700">
          {cleanLatexSnippet(status.detail, "", 100)}
        </p>
        {status.meta && (
          <p className="mt-2 text-xs text-neutral-500">{status.meta}</p>
        )}
        {hints.length > 0 && (
          <ul className="mt-2 grid gap-1 text-xs leading-5 text-neutral-600">
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;

    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [syncStatus, setSyncStatus] = useState("");
  const [generationStatusBySession, setGenerationStatusBySession] = useState({});
  const [imageTaskBySession, setImageTaskBySession] = useState({});
  const boardRef = useRef(null);
  const workspaceRef = useRef(null);
  const toolbarRef = useRef(null);
  const composerDockRef = useRef(null);
  const saveTimerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const operationRevisionsRef = useRef({});
  const activeOperationsRef = useRef({});
  const progressiveBySessionRef = useRef({});
  const generationStatusBySessionRef = useRef({});
  const sessionRestoreAttemptedRef = useRef(false);
  const inFlightSessionSavesRef = useRef(new Set());
  const deletedSessionIdsRef = useRef(new Set());
  const { getToken, isLoaded, isSignedIn, isMock, user } = useAuthToken();
  const { settings } = useSettings();

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const composer = composerDockRef.current;
    const toolbar = toolbarRef.current;
    if (!workspace || !composer) return undefined;

    const measure = () => {
      const workspaceRect = workspace.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const toolbarRect = toolbar?.getBoundingClientRect();
      workspace.style.setProperty("--omni-workspace-left", `${workspaceRect.left}px`);
      workspace.style.setProperty("--omni-workspace-width", `${workspaceRect.width}px`);
      workspace.style.setProperty("--omni-composer-height", `${composerRect.height}px`);
      workspace.style.setProperty("--omni-toolbar-height", `${toolbarRect?.height || 0}px`);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(workspace);
    observer?.observe(composer);
    if (toolbar) observer?.observe(toolbar);
    window.addEventListener("resize", measure, { passive: true });
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        String(sidebarCollapsed)
      );
    } catch {
      // The preference is optional when browser storage is unavailable.
    }
  }, [sidebarCollapsed]);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const generationStatus = generationStatusBySession[activeSession?.id] || getSessionGenerationStatus(activeSession);
  // Conversation/placement persistence changes the session record, not its
  // mathematics. Keep the rendered problem identity stable across those writes.
  const {
    id: mathematicalSessionId, problem: sessionProblem, steps: sessionSteps,
    solution: sessionSolution, result: sessionResult, explanation: sessionExplanation,
    session: nestedSession,
  } = /** @type {any} */ (activeSession || {});
  const problem = useMemo(() => {
    const renderedProblem = getActiveRenderedProblem({
      problem: sessionProblem, steps: sessionSteps, solution: sessionSolution,
      result: sessionResult, explanation: sessionExplanation, session: nestedSession,
    }, emptyProblem);
    return {
      ...renderedProblem,
      id: renderedProblem.id || mathematicalSessionId,
      sessionId: mathematicalSessionId,
    };
  }, [mathematicalSessionId, sessionProblem, sessionSteps, sessionSolution, sessionResult, sessionExplanation, nestedSession]);
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

  const resetSessionWorkspaceConversation = useCallback((sessionId, revision = "") => {
    if (!sessionId) return;
    const workspaceConversation = normalizeWorkspaceConversation({ revision });
    setSessions((prev) => {
      const nextSessions = prev.map((session) => session.id === sessionId
        ? {
            ...session,
            workspaceConversation,
            updatedAt: new Date().toISOString(),
            dirty: true,
          }
        : session);
      sessionsRef.current = nextSessions;
      return nextSessions;
    });
  }, []);

  const handleWorkspaceConversationChange = useCallback((sessionId, value) => {
    if (!sessionId) return;
    if (generationStatusBySessionRef.current[sessionId]?.workflowActive) return;
    const current = sessionsRef.current.find((session) => session.id === sessionId)?.workspaceConversation;
    const workspaceConversation = normalizeWorkspaceConversation({
      ...value,
      revision: value?.revision || current?.revision || "",
    });
    setSessions((prev) => {
      const nextSessions = prev.map((session) => session.id === sessionId
        ? {
            ...session,
            workspaceConversation,
            updatedAt: new Date().toISOString(),
            dirty: true,
          }
        : session);
      sessionsRef.current = nextSessions;
      return nextSessions;
    });
  }, []);

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
            setSessionGenerationStatus(nextActive.id, getSessionGenerationStatus(nextActive));
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
        inFlightSessionSavesRef.current.add(sessionSnapshot.id);
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
          if (deletedSessionIdsRef.current.has(sessionSnapshot.id)) {
            await deleteUserSession({ getToken, sessionId: sessionSnapshot.id }).catch(() => {});
            deletedSessionIdsRef.current.delete(sessionSnapshot.id);
            continue;
          }
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
          if (deletedSessionIdsRef.current.has(sessionSnapshot.id)) {
            await deleteUserSession({ getToken, sessionId: sessionSnapshot.id }).catch(() => {});
            deletedSessionIdsRef.current.delete(sessionSnapshot.id);
            continue;
          }
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
        } finally {
          inFlightSessionSavesRef.current.delete(sessionSnapshot.id);
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
      session.id === resetSessionId
        ? { ...clearSessionSolution(session), workspaceConversation: normalizeWorkspaceConversation() }
        : session
    ));
    setSessions(nextSessions);
    sessionsRef.current = nextSessions;
    activeOperationsRef.current[resetSessionId] = null;
    delete progressiveBySessionRef.current[resetSessionId];
    setSessionGenerationStatus(resetSessionId, emptyGenerationStatus());
    logSolutionState("reset", {
      activeSessionId: resetSessionId,
      renderedStepCount: 0,
      statusType: "empty",
    });
  };

  const handleSessionSelect = (sessionId) => {
    const selectedSession = sessions.find((session) => session.id === sessionId);
    setActiveSessionId(sessionId);
    activeSessionIdRef.current = sessionId;
    if (!generationStatusBySessionRef.current[sessionId]) {
      setSessionGenerationStatus(sessionId, getSessionGenerationStatus(selectedSession));
    }
    logSessionOperation("session-switched", {
      originSessionId: sessionId,
      activeSessionId: sessionId,
      reason: "select-session",
    });
  };

  const handleSessionRename = (sessionId, title) => {
    const nextTitle = cleanLatexSnippet(title, "Math Problem", 42);
    const nextSessions = sessionsRef.current.map((session) => session.id === sessionId
      ? {
          ...session,
          title: nextTitle,
          updatedAt: new Date().toISOString(),
          dirty: true,
        }
      : session);
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
  };

  const handleSessionDelete = async (sessionId) => {
    const previousSessions = sessionsRef.current;
    const previousActiveSessionId = activeSessionIdRef.current;
    const target = previousSessions.find((session) => session.id === sessionId);
    if (!target) return;
    delete progressiveBySessionRef.current[sessionId];

    let nextSessions = previousSessions.filter((session) => session.id !== sessionId);
    if (nextSessions.length === 0) nextSessions = [createSession()];
    const nextActiveSessionId = previousActiveSessionId === sessionId
      ? nextSessions[0].id
      : previousActiveSessionId;
    sessionsRef.current = nextSessions;
    activeSessionIdRef.current = nextActiveSessionId;
    setSessions(nextSessions);
    setActiveSessionId(nextActiveSessionId);

    const saveInFlight = inFlightSessionSavesRef.current.has(sessionId);
    if (saveInFlight) deletedSessionIdsRef.current.add(sessionId);
    if (!isSignedIn || isMock || (!target.persisted && !saveInFlight)) return;
    if (!target.persisted) return;
    try {
      await deleteUserSession({ getToken, sessionId });
      if (!saveInFlight) deletedSessionIdsRef.current.delete(sessionId);
      setSyncStatus("Session deleted");
    } catch (deleteError) {
      deletedSessionIdsRef.current.delete(sessionId);
      sessionsRef.current = previousSessions;
      activeSessionIdRef.current = previousActiveSessionId;
      setSessions(previousSessions);
      setActiveSessionId(previousActiveSessionId);
      setSessionError(deleteError.message || "Could not delete this session.");
    }
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
    const { problemData: canonicalProblemData, steps: normalizedSteps, status: responseStatus } = import.meta.env.DEV
      ? measureOmniSync("solve-response.create-generated-state", () => (
        createGeneratedProblemState(normalizedData)
      ))
      : createGeneratedProblemState(normalizedData);
    const identity = solveIdentity(operationContext, requestSessionId, normalizedData.requestId);
    let progressive = progressiveBySessionRef.current[requestSessionId] || createProgressiveSolveState();
    for (const event of createFullResponseEvents(canonicalProblemData, identity)) {
      if (event.type === PROGRESSIVE_EVENT_TYPES.STARTED
        && progressive.requestId === identity.requestId
        && progressive.attemptId === identity.attemptId) continue;
      const result = applyProgressiveSolveEvent(progressive, event);
      if (!result.accepted && result.reason !== "duplicate") {
        console.error("Full-response progressive adapter rejected a validated solve event", result.reason, event.type);
        setSessionGenerationStatus(requestSessionId, {
          type: "error",
          label: "Solution state mismatch",
          detail: "The completed solution could not be applied safely.",
          meta: "",
        }, operationContext);
        return;
      }
      progressive = result.state;
    }
    if (progressive.status !== "complete") return;
    progressiveBySessionRef.current[requestSessionId] = progressive;
    const problemData = {
      ...canonicalProblemData,
      steps: progressive.completedSteps,
      progressiveSolve: { ...progressiveDurableSnapshot(progressive), mode: "full-response" },
    };
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
    resetSessionWorkspaceConversation(requestSessionId, `${operationContext.operationId}:${operationContext.revision}`);
    const identity = solveIdentity(operationContext, requestSessionId);
    const prior = progressiveBySessionRef.current[requestSessionId] || createProgressiveSolveState();
    const previousAttempt = prior.status !== "idle"
      && (prior.requestId !== identity.requestId || prior.attemptId !== identity.attemptId)
      ? prior.attemptId : "";
    if (previousAttempt) operationContext.supersedesAttemptId = previousAttempt;
    const started = applyProgressiveSolveEvent(prior, {
      ...identity,
      sequence: 0,
      type: PROGRESSIVE_EVENT_TYPES.STARTED,
      ...(previousAttempt ? { supersedesAttemptId: previousAttempt } : {}),
    });
    if (started.accepted) progressiveBySessionRef.current[requestSessionId] = started.state;
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
    submittedProblem = null,
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
    const isSolveTimeout = code === "AI_SOLVE_TIMEOUT";
    const progressive = progressiveBySessionRef.current[targetSessionId];
    const hasPublishedProgress = (progressive?.completedSteps?.length || 0) > 0;
    if (isSolveTimeout && source === "text" && submittedProblem?.canonicalProblem && !hasPublishedProgress) {
      const pendingProblem = createPendingTypedProblemState(submittedProblem);
      const commitResult = commitGeneratedProblemToSessions({
        sessions: sessionsRef.current,
        activeSessionId: targetSessionId,
        requestSessionId: targetSessionId,
        problemData: pendingProblem,
        strictTarget: true,
      });
      if (commitResult.wrote) {
        sessionsRef.current = commitResult.sessions;
        setSessions(commitResult.sessions);
      }
    }
    if (progressive && !["complete", "failed", "cancelled"].includes(progressive.status)) {
      const failureEvent = {
        ...solveIdentity(operationContext, targetSessionId),
        sequence: progressive.lastSequence + 1,
        type: PROGRESSIVE_EVENT_TYPES.FAILED,
        reason: message || "The solve did not complete.",
        retryable,
      };
      if (progressive.completedSteps.length > 0) {
        applyProgressiveEventToSession(failureEvent);
      } else {
        const failed = applyProgressiveSolveEvent(progressive, failureEvent);
        if (failed.accepted) progressiveBySessionRef.current[targetSessionId] = failed.state;
      }
    }
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
    const nextStatus = isSolveTimeout ? {
      ...getFinalSolveTimeoutStatus({ source, code, retryable }),
    } : {
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

  // Retain the transport-independent synthetic driver for deterministic
  // lifecycle tests alongside the provider-backed Phase 6B path.
  const beginSyntheticProgressiveSolve = () => {
    const sessionId = activeSessionIdRef.current;
    const operationContext = createOperationContext({ originSessionId: sessionId, source: "synthetic-progressive" });
    const identity = solveIdentity(operationContext, sessionId);
    const prior = progressiveBySessionRef.current[sessionId] || createProgressiveSolveState();
    const result = applyProgressiveSolveEvent(prior, {
      ...identity,
      sequence: 0,
      type: PROGRESSIVE_EVENT_TYPES.STARTED,
      ...(prior.status !== "idle" ? { supersedesAttemptId: prior.attemptId } : {}),
    });
    if (!result.accepted) return { accepted: false, reason: result.reason };
    progressiveBySessionRef.current[sessionId] = result.state;
    setSessionGenerationStatus(sessionId, {
      type: "loading", label: "Solving problem", detail: "Waiting for completed steps.", meta: "", workflowActive: true,
    }, operationContext);
    return { accepted: true, ...identity };
  };

  const applyProgressiveEventToSession = (event) => {
    const sessionId = event?.sessionId;
    const operation = activeOperationsRef.current[sessionId];
    if (!operation || operation.operationId !== event.requestId
      || `${operation.operationId}:${operation.revision}` !== event.attemptId
      || !sessionsRef.current.some((session) => session.id === sessionId)) {
      return { accepted: false, reason: "stale-operation" };
    }
    const current = progressiveBySessionRef.current[sessionId] || createProgressiveSolveState();
    const result = applyProgressiveSolveEvent(current, event);
    // Submission already installed start locally; only a byte-for-byte
    // duplicate of that event may be acknowledged from the wire.
    if (event.type === PROGRESSIVE_EVENT_TYPES.STARTED && result.reason === "duplicate") {
      return { accepted: true, duplicate: true, status: current.status };
    }
    if (!result.accepted) return { accepted: false, reason: result.reason };
    markProgressiveEventReceived(event);
    progressiveBySessionRef.current[sessionId] = result.state;
    const next = result.state;
    if (event.type !== PROGRESSIVE_EVENT_TYPES.STEP_STARTED && next.metadata) {
      const problemData = progressiveProblemFromState(next);
      const commit = commitGeneratedProblemToSessions({
        sessions: sessionsRef.current,
        requestSessionId: sessionId,
        problemData,
        strictTarget: true,
      });
      if (commit.wrote) {
        sessionsRef.current = commit.sessions;
        setSessions(commit.sessions);
      }
    }
    const stepCount = next.completedSteps.length;
    const status = next.status === "failed"
      ? { type: "error", label: "Generation stopped", detail: next.failure.message, meta: `${stepCount} completed steps`, retryable: next.failure.retryable }
      : next.status === "cancelled"
        ? { type: "warning", label: "Generation cancelled", detail: `${stepCount} completed steps preserved.`, meta: "" }
        : next.status === "complete"
          ? { type: "success", label: "Explanation ready", detail: getStatusStepText(next.completedSteps), meta: "" }
          : { type: "loading", label: stepCount ? "Solution in progress" : "Solving problem", detail: `${stepCount} completed steps`, meta: "", workflowActive: true };
    setSessionGenerationStatus(sessionId, status, operation);
    return { accepted: true, status: next.status, completedStepCount: stepCount };
  };

  const handleGenerationCancelled = (operationContext) => {
    const sessionId = operationContext?.originSessionId;
    const current = progressiveBySessionRef.current[sessionId];
    if (!current || ["complete", "failed", "cancelled"].includes(current.status)) return;
    applyProgressiveEventToSession({
      ...solveIdentity(operationContext, sessionId),
      sequence: current.lastSequence + 1,
      type: PROGRESSIVE_EVENT_TYPES.CANCELLED,
    });
  };

  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(window.location.search).has("progressiveFixture")) return undefined;
    /** @type {any} */ (window).__OMNIMATH_PROGRESSIVE_FIXTURE__ = {
      start: beginSyntheticProgressiveSolve,
      dispatch: applyProgressiveEventToSession,
      snapshot: (sessionId = activeSessionIdRef.current) => progressiveBySessionRef.current[sessionId] || null,
      sessions: () => sessionsRef.current,
    };
    return () => { delete /** @type {any} */ (window).__OMNIMATH_PROGRESSIVE_FIXTURE__; };
  });

  const handleWindowsChange = useCallback((windows, sessionId = activeSessionId) => {
    const pinnedWindows = windows
      .filter((window) => window.pinned)
      .map((window) => settings.interaction.stickyLensPositions
        ? window
        : withoutManualLensPosition(window));
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
  const hasRenderedProblem = hasWorkspaceProblem(problem);
  const imageTaskActive = Boolean(imageTaskBySession[activeSessionId]);
  const isWorkspaceEmpty = !isGenerating && !hasRenderedProblem && !imageTaskActive;
  const showWorkspaceConversation = renderedStepCount > 0 && !isGenerating;
  const handleImageWorkspaceStateChange = useCallback(({ sessionId, active }) => {
    if (!sessionId) return;
    setImageTaskBySession((current) => {
      if (Boolean(current[sessionId]) === active) return current;
      const next = { ...current };
      if (active) next[sessionId] = true;
      else delete next[sessionId];
      return next;
    });
  }, []);
  const presentationDepth = ({
    basic: "concise",
    beginner: "concise",
    intermediate: "standard",
    advanced: "detailed",
  })[settings.learning.explanationDepth] || settings.learning.explanationDepth || "standard";
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
      <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground lg:flex lg:items-start">
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onNewSession={handleNewSession}
          onSelectSession={handleSessionSelect}
          onRenameSession={handleSessionRename}
          onDeleteSession={handleSessionDelete}
          loading={sessionLoading}
          syncStatus={syncStatus}
          error={sessionError}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          collapsed={sidebarCollapsed}
          onCollapse={() => setSidebarCollapsed(true)}
          onExpand={() => setSidebarCollapsed(false)}
        />

        <div
          ref={workspaceRef}
          data-math-workspace
          data-workspace-state={isWorkspaceEmpty ? "empty" : imageTaskActive && !showWorkspaceConversation ? "image" : "active"}
          className="omni-workspace-shell min-h-screen min-w-0 flex-1"
        >
          <header ref={toolbarRef} className="omni-workspace-toolbar sticky top-0 z-40 border-b border-neutral-200 bg-white/90 backdrop-blur-xl">
            <div className="mx-auto flex w-full max-w-[clamp(1100px,88vw,1680px)] flex-col gap-1.5 px-4 py-1.5 sm:px-6 xl:px-10">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="rounded-xl border border-neutral-200 bg-white p-2 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900 lg:hidden"
                    aria-label="Open sessions"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2 lg:hidden">
                      <h1 className="shrink-0 font-sans text-base font-semibold tracking-normal text-neutral-950">
                        OmniMath
                      </h1>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </header>

          <main
            ref={boardRef}
            data-lens-canvas
            className="omni-workspace-canvas relative z-10 mx-auto w-full max-w-[clamp(1100px,88vw,1680px)] px-4 py-3 sm:px-6 xl:px-10"
          >
            <div className="mx-auto min-w-0">
              {(isGenerating || hasRenderedProblem) && displayedGenerationStatus.type !== "error" && displayedGenerationStatus.type !== "limit" && (
                <GenerationStatus status={displayedGenerationStatus} />
              )}
              {(isGenerating || hasRenderedProblem) && !(problem.progressiveSolve?.mode === "progressive"
                && problem.progressiveSolve.status === "failed"
                && getSolutionSteps(problem).length > 0) && (
                <IssueCard status={displayedGenerationStatus} />
              )}
              {(isGenerating || hasRenderedProblem) && <ProblemBlock problem={problem} loading={isGenerating} />}
            </div>
          </main>

          <div ref={composerDockRef} className="omni-composer-dock" data-testid="workspace-composer-dock">
            <div className="omni-composer-dock-inner">
              <PrimaryMathComposer
                isWorkspaceEmpty={isWorkspaceEmpty}
                isImageTaskActive={imageTaskActive}
                userName={user?.firstName || user?.fullName?.split(" ")?.[0] || user?.username || ""}
                showWorkspaceConversation={showWorkspaceConversation}
                conversation={activeSession?.workspaceConversation}
                onConversationChange={(value) => handleWorkspaceConversationChange(activeSession?.id, value)}
                presentationDepth={presentationDepth}
                activeSessionId={activeSession?.id}
                problem={problem}
                history={activeSession?.messages ?? []}
                onHistoryChange={handleHistoryChange}
                onReset={handleProblemReset}
                onProblemGenerated={handleProblemGenerated}
                onGenerationStart={handleGenerationStart}
                onGenerationError={handleGenerationError}
                onGenerationCancelled={handleGenerationCancelled}
                onProgressiveEvent={applyProgressiveEventToSession}
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
                    onGenerationCancelled={handleGenerationCancelled}
                    onProgressiveEvent={applyProgressiveEventToSession}
                    onExtractionReview={handleExtractionReview}
                    onUsageUpdate={null}
                    onReviewedProblemSubmitted={handleReviewedProblemSubmitted}
                    onWorkspaceStateChange={handleImageWorkspaceStateChange}
                  />
                )}
              />
            </div>
          </div>
        </div>

        <ExplanationPanel problem={problem} />
        <ExportButton showControls={false} targetRef={boardRef} problem={problem} pinnedWindows={activeSession?.pinnedWindows || []} />
      </div>
    </HoverProvider>
  );
}
