import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GraduationCap, Menu } from "lucide-react";
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
  fetchUsageSnapshot,
  fetchUserSessions,
  updateUserSession,
} from "@/api/userClient";
import { normalizeSolveResponse } from "@/api/mathClient";
import { createCanonicalProblemPayload, logCanonicalProblem } from "@/lib/canonicalProblem";
import ProblemBlock from "@/components/math/ProblemBlock";
import ExplanationPanel from "@/components/math/ExplanationPanel";
import ProblemInput from "@/components/math/ProblemInput";
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

  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  const [usageByKind, setUsageByKind] = useState({ ai: null, explanation: null, image: null });
  const [generationStatus, setGenerationStatus] = useState({
    type: "empty",
    label: "Ready",
    detail: "Enter a problem or upload an image to begin.",
    meta: "",
  });
  const boardRef = useRef(null);
  const saveTimerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const sessionRestoreAttemptedRef = useRef(false);
  const { getToken, isLoaded, isSignedIn, isMock } = useAuthToken();
  const { settings } = useSettings();

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const problem = useMemo(() => {
    const renderedProblem = getActiveRenderedProblem(activeSession, emptyProblem);
    return {
      ...renderedProblem,
      id: renderedProblem.id || activeSession?.id,
      sessionId: activeSession?.id,
    };
  }, [activeSession]);
  const providerKey = activeSession?.id ?? "default";

  useEffect(() => {
    sessionsRef.current = sessions;
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId, sessions]);

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

    Promise.all([
      fetchUserSessions({ getToken }),
      fetchUsageSnapshot({ getToken }).catch(() => null),
    ])
      .then(([data, usageData]) => {
        if (cancelled) return;
        if (usageData?.usage) setUsageByKind(usageData.usage);
        const restored = (data.sessions || [])
          .filter((session) => !isDemoSession(session))
          .map((session) => normalizeSession({
            ...session,
            persisted: true,
            dirty: false,
          }));

        const currentSessions = sessionsRef.current;
        const currentActiveSessionId = activeSessionIdRef.current;
        const merged = mergeSessionListPreservingActiveSolution(currentSessions, currentActiveSessionId, restored);

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
          setGenerationStatus({
            type: restoredSteps.length ? "success" : "empty",
            label: restoredSteps.length
              ? merged.preservedActive ? "Explanation ready" : "Session restored"
              : "Session ready",
            detail: restoredSteps.length
              ? getStatusStepText(restoredSteps)
              : getSessionLabel(nextActive, "Ready for a problem."),
            meta: "",
          });
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
  }, [getToken, isLoaded, isMock, isSignedIn]);

  useEffect(() => {
    if (
      !activeSession?.dirty
      || !hasPersistableSessionContent(activeSession)
      || !isSignedIn
      || isMock
      || !settings.productivity.autosave
    ) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(async () => {
      setSyncStatus("Saving session...");
      setSessionError("");

      try {
        const data = activeSession.persisted
          ? await updateUserSession({ getToken, session: activeSession })
          : await createUserSession({ getToken, session: activeSession });
        const savedSession = normalizeSession({
          ...data.session,
          persisted: true,
          dirty: false,
        });
        const mergedSession = normalizeSession(mergeSessionPreservingSolutionSteps(activeSession, savedSession));

        setSessions((prev) => {
          const nextSessions = prev.map((session) => (
            session.id === activeSession.id ? mergedSession : session
          ));
          sessionsRef.current = nextSessions;
          return nextSessions;
        });
        if (activeSessionId === activeSession.id) {
          setActiveSessionId(mergedSession.id);
          activeSessionIdRef.current = mergedSession.id;
        }
        setSyncStatus("Saved");
      } catch (error) {
        setSessionError(error.message || "Could not save this session.");
        const hasLiveSteps = getSolutionSteps(activeSession).length > 0;
        setSyncStatus(hasLiveSteps ? "Solved but not saved" : "");
      }
    }, 700);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [activeSession, activeSessionId, getToken, isMock, isSignedIn, settings.productivity.autosave]);

  const handleUsageUpdate = (usage) => {
    if (!usage?.kind) return;
    setUsageByKind((prev) => ({
      ...prev,
      [usage.kind]: usage,
      ...(usage.aggregateKind ? { [usage.aggregateKind]: { ...usage, kind: usage.aggregateKind } } : {}),
    }));
  };

  const handleNewSession = () => {
    const session = createSession();
    const nextSessions = [session, ...sessionsRef.current];
    setSessions(nextSessions);
    setActiveSessionId(session.id);
    sessionsRef.current = nextSessions;
    activeSessionIdRef.current = session.id;
    setSidebarOpen(false);
    setGenerationStatus({
      type: "empty",
      label: "New session ready",
      detail: "Type a problem or upload an image to begin.",
      meta: "",
    });
  };

  const handleProblemReset = () => {
    const resetSessionId = activeSessionIdRef.current;
    const nextSessions = sessionsRef.current.map((session) => (
      session.id === resetSessionId ? clearSessionSolution(session) : session
    ));
    setSessions(nextSessions);
    sessionsRef.current = nextSessions;
    setGenerationStatus(emptyGenerationStatus());
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
    setGenerationStatus({
      type: selectedSteps.length ? "success" : "empty",
      label: selectedSteps.length ? "Session restored" : "Session ready",
      detail: selectedSteps.length
        ? getStatusStepText(selectedSteps)
        : getSessionLabel(selectedSession, "Ready for a problem."),
      meta: "",
    });
  };

  const handleHistoryChange = (messages) => {
    updateActiveSession((session) => ({
      messages,
      title:
        session.problem?.steps?.length || messages.length === 0
          ? session.title
          : compactTitle(messages[0]?.text),
    }));
  };

  const handleProblemGenerated = (data) => {
    const normalizedData = normalizeSolveResponse(data, { endpoint: "Home.handleProblemGenerated" });
    if (normalizedData.canonicalProblem) {
      logCanonicalProblem("solve response", normalizedData.canonicalProblem, { endpoint: normalizedData.metadata?.endpoint });
    }
    handleUsageUpdate(normalizedData.usage || normalizedData.metadata?.usage);
    const requestSessionId = data?._requestSessionId || data?.requestSessionId || activeSessionIdRef.current;
    const beforeActiveSessionId = activeSessionIdRef.current;
    const { problemData, steps: normalizedSteps, status: responseStatus } = createGeneratedProblemState(normalizedData);
    logSolutionState("solve response", {
      submittedProblemText: normalizedData.originalProblem || normalizedData.problem || normalizedData.expression || "",
      requestSessionId,
      activeSessionIdBeforeWrite: beforeActiveSessionId,
      apiResponseStepCount: getSolutionSteps(data).length,
      normalizedSolutionStepCount: normalizedSteps.length,
    });

    const commitResult = commitGeneratedProblemToSessions({
      sessions: sessionsRef.current,
      activeSessionId: activeSessionIdRef.current,
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

    setSessions(commitResult.sessions);
    sessionsRef.current = commitResult.sessions;

    const committedStepCount = commitResult.committedSteps.length;
    const nextActiveSessionId = commitResult.activeSessionId || activeSessionIdRef.current;
    if (nextActiveSessionId && nextActiveSessionId !== activeSessionIdRef.current) {
      setActiveSessionId(nextActiveSessionId);
      activeSessionIdRef.current = nextActiveSessionId;
    }

    const nextStatus = committedStepCount > 0
      ? responseStatus
      : createGeneratedProblemState({ steps: [] }).status;
    setGenerationStatus(nextStatus);
    logSolutionState("status commit", {
      activeSessionIdAfterWrite: nextActiveSessionId,
      solutionStepCountInActiveSession: committedStepCount,
      statusType: nextStatus.type,
      statusLabel: nextStatus.label,
      statusDetail: nextStatus.detail,
    });
  };

  const handleGenerationStart = (event = {}) => {
    const { source } = event;
    logSolutionState("submit", {
      source,
      submittedProblemText: event.problem || "",
      activeSessionIdBeforeRequest: activeSessionIdRef.current,
      requestSessionId: event.requestSessionId || activeSessionIdRef.current,
    });
    setGenerationStatus({
      type: "loading",
      label: source === "image" ? "Reading image" : "Solving problem",
      detail: "Building the structured explanation.",
      meta: "",
    });
  };

  const handleExtractionReview = (extraction) => {
    handleUsageUpdate(extraction?.usage);
    const tier = extraction?.confidenceTier || extraction?.extractionValidation?.tier || "medium";
    setGenerationStatus({
      type: tier === "low" ? "limit" : "empty",
      label: "Review extracted problem",
      detail: tier === "low"
        ? "Confidence is low or a critical math mismatch was detected."
        : "Confirm or edit the extracted problem before solving.",
      meta: extraction?.confidence !== undefined ? `${extraction.confidence}% confidence` : "",
    });
  };

  const handleReviewedProblemSubmitted = (payload = {}) => {
    const requestSessionId = activeSessionIdRef.current;
    const problemData = createPendingReviewedProblemState(payload);
    const commitResult = commitReviewedProblemToSessions({
      sessions: sessionsRef.current,
      activeSessionId: activeSessionIdRef.current,
      requestSessionId,
      problemData,
    });
    setSessions(commitResult.sessions);
    sessionsRef.current = commitResult.sessions;
    if (commitResult.activeSessionId && commitResult.activeSessionId !== activeSessionIdRef.current) {
      setActiveSessionId(commitResult.activeSessionId);
      activeSessionIdRef.current = commitResult.activeSessionId;
    }
    logSolutionState("reviewed problem committed", {
      requestSessionId,
      activeSessionId: commitResult.activeSessionId,
      canonicalInputHash: payload.canonicalProblem?.hash || "",
      wrote: commitResult.wrote,
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
  }) => {
    handleUsageUpdate(usage);
    const isLimitError = status === 429 && code === "USAGE_LIMIT_EXCEEDED";
    if (isLimitError) {
      setGenerationStatus({
        type: "limit",
        label: source === "image" ? "Image limit reached" : "Daily limit reached",
        detail: message || "You've reached today's limit for this action.",
        meta: getUsageMeta(usage),
      });
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
    setGenerationStatus(nextStatus);
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

  const handleWindowsChange = useCallback((windows) => {
    if (!settings.interaction.stickyLensPositions) return;
    const pinnedWindows = windows.filter((window) => window.pinned);
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== activeSessionId) return session;
        const current = JSON.stringify(session.pinnedWindows || []);
        const next = JSON.stringify(pinnedWindows);
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
  const aiUsage = usageByKind.ai || usageByKind.explanation || usageByKind.image;
  const tokenDaily = aiUsage?.tokens?.daily;
  const tokenMonthly = aiUsage?.tokens?.monthly;
  const usageBadges = [
    { key: "ai", label: "AI", usage: aiUsage },
    tokenDaily && {
      key: "tokens",
      label: "Tokens",
      usage: {
        ...tokenDaily,
        monthly: tokenMonthly,
      },
    },
  ].filter((item) => item?.usage);

  return (
    <HoverProvider
      key={providerKey}
      initialWindows={activeSession?.pinnedWindows || []}
      onWindowsChange={handleWindowsChange}
      settings={settings}
      problem={problem}
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
            <div className="mx-auto flex w-full max-w-[clamp(1100px,88vw,1680px)] flex-col gap-4 px-4 py-4 sm:px-6 xl:px-10">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-2.5 text-slate-200/75 transition-colors hover:text-teal-100 lg:hidden"
                    aria-label="Open sessions"
                  >
                    <Menu className="h-5 w-5" />
                  </button>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h1 className="truncate font-sans text-xl font-semibold tracking-normal text-cyan-50">
                        {getSessionLabel(activeSession, "OmniMath")}
                      </h1>
                      <span className="shrink-0 rounded-full border border-teal-300/20 bg-teal-300/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/80">
                        AI Tutor
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-300/60">
                      Guided math explanations with inspectable steps.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {usageBadges.map(({ key, label, usage }) => (
                    <div
                      key={key}
                      className="rounded-full border border-teal-300/[0.16] bg-teal-300/[0.055] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-teal-100/75"
                    >
                      {label}: {getUsageUsed(usage)}/{usage.limit} used today
                      {usage.monthly ? ` · ${getUsageUsed(usage.monthly)}/${usage.monthly.limit} used this month` : ""}
                    </div>
                  ))}
                  <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-xs text-slate-300/60 md:flex">
                    <GraduationCap className="h-3.5 w-3.5 text-teal-200/70" />
                    Hover, drag-select, or right-click to pin.
                  </div>
                  <ExportButton
                    targetRef={boardRef}
                    filename={getProblemLabel(problem, "omnimath-session").toLowerCase().replace(/\s+/g, "-")}
                    problem={problem}
                    pinnedWindows={activeSession?.pinnedWindows || []}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
                <div className="min-w-0 flex-1">
                  <ProblemInput
                    key={activeSession?.id}
                    activeSessionId={activeSession?.id}
                    history={activeSession?.messages ?? []}
                    onHistoryChange={handleHistoryChange}
                    onReset={handleProblemReset}
                    onProblemGenerated={handleProblemGenerated}
                    onGenerationStart={handleGenerationStart}
                    onGenerationError={handleGenerationError}
                  />
                </div>
                <ImageUpload
                  onProblemGenerated={handleProblemGenerated}
                  onGenerationStart={handleGenerationStart}
                  onGenerationError={handleGenerationError}
                  onExtractionReview={handleExtractionReview}
                  onUsageUpdate={handleUsageUpdate}
                  onReviewedProblemSubmitted={handleReviewedProblemSubmitted}
                />
              </div>

              {displayedGenerationStatus.type !== "error" && displayedGenerationStatus.type !== "limit" && (
                <GenerationStatus status={displayedGenerationStatus} />
              )}
            </div>
          </header>

          <main ref={boardRef} className="relative z-10 mx-auto w-full max-w-[clamp(1100px,88vw,1680px)] px-4 py-8 sm:px-6 xl:px-10">
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
