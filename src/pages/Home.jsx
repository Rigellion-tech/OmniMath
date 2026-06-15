import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GraduationCap, Menu } from "lucide-react";
import { HoverProvider } from "@/lib/HoverContext";
import { useAuthToken } from "@/lib/auth";
import { cleanLatexSnippet, getProblemLabel, getSessionLabel, getStatusStepText } from "@/lib/problemLabels";
import { useSettings } from "@/lib/settings";
import {
  createUserSession,
  fetchUsageSnapshot,
  fetchUserSessions,
  updateUserSession,
} from "@/api/userClient";
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
    dirty: true,
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
  const normalizedProblem = stripDemoFields(problem);
  const normalizedProblems = Array.isArray(session.problems)
    ? session.problems.map(stripDemoFields)
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
    steps: Array.isArray(session.steps) ? session.steps : normalizedProblem?.steps || [],
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

  const parts = [`${usage.used}/${usage.limit} used today`];
  if (usage.monthly) {
    parts.push(`${usage.monthly.used}/${usage.monthly.limit} used this month`);
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

function IssueCard({ status }) {
  if (status.type !== "error" && status.type !== "limit") return null;

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
      </div>
    </div>
  );
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
  const { getToken, isLoaded, isSignedIn, isMock } = useAuthToken();
  const { settings } = useSettings();

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const problem = useMemo(() => {
    const activeProblem = activeSession?.problem ?? emptyProblem;
    return {
      ...activeProblem,
      id: activeProblem.id || activeSession?.id,
      sessionId: activeSession?.id,
    };
  }, [activeSession]);
  const providerKey = activeSession?.id ?? "default";

  const updateActiveSession = useCallback((updater, { markDirty = true } = {}) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === activeSessionId
          ? {
              ...session,
              ...updater(session),
              updatedAt: new Date().toISOString(),
              dirty: markDirty || session.dirty,
            }
          : session
      )
    );
  }, [activeSessionId]);

  useEffect(() => {
    if (!isLoaded) return undefined;
    if (!isSignedIn || isMock) {
      setSessionLoading(false);
      return undefined;
    }

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

        if (restored.length > 0) {
          setSessions(restored);
          setActiveSessionId(restored[0].id);
          setGenerationStatus({
            type: restored[0].problem?.steps?.length ? "success" : "empty",
            label: restored[0].problem?.steps?.length ? "Session restored" : "Session ready",
            detail: restored[0].problem?.steps?.length
              ? getStatusStepText(restored[0].problem.steps)
              : getSessionLabel(restored[0], "Ready for a problem."),
            meta: "",
          });
        } else {
          const session = createSession({ title: "New math session" });
          setSessions([session]);
          setActiveSessionId(session.id);
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
    if (!activeSession?.dirty || !isSignedIn || isMock || !settings.productivity.autosave) return undefined;
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

        setSessions((prev) =>
          prev.map((session) => (
            session.id === activeSession.id ? savedSession : session
          ))
        );
        if (activeSessionId === activeSession.id) setActiveSessionId(savedSession.id);
        setSyncStatus("Saved");
      } catch (error) {
        setSessionError(error.message || "Could not save this session.");
        setSyncStatus("");
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
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setSidebarOpen(false);
    setGenerationStatus({
      type: "empty",
      label: "New session ready",
      detail: "Type a problem or upload an image to begin.",
      meta: "",
    });
  };

  const handleSessionSelect = (sessionId) => {
    const selectedSession = sessions.find((session) => session.id === sessionId);
    setActiveSessionId(sessionId);
    setGenerationStatus({
      type: selectedSession?.problem?.steps?.length ? "success" : "empty",
      label: selectedSession?.problem?.steps?.length ? "Session restored" : "Session ready",
      detail: selectedSession?.problem?.steps?.length
        ? getStatusStepText(selectedSession.problem.steps)
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
    handleUsageUpdate(data.usage);
    const problemData = stripDemoFields(data);
    updateActiveSession((session) => ({
      problem: problemData,
      problems: [...(session.problems || []), problemData],
      steps: problemData.steps || [],
      title: titleFromProblem(problemData, "Math Problem"),
    }));
    setGenerationStatus({
      type: "success",
      label: "Explanation ready",
      detail: getStatusStepText(problemData.steps),
      meta: data.runtimeNotice || "",
    });
  };

  const handleGenerationStart = ({ source }) => {
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

  const handleGenerationError = ({ source, message, status, code, usage }) => {
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
    const showBackendMessage = isServerError && import.meta.env.DEV && message;
    setGenerationStatus({
      type: "error",
      label: source === "image"
        ? "Image analysis failed"
        : source === "image-solve"
          ? "Solution generation failed"
          : "Generation failed",
      detail: isServerError
        ? showBackendMessage
          ? message
          : "The AI backend could not complete the request."
        : message || "The solver could not complete that request.",
      meta: "",
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
            <div className="mx-auto flex max-w-[1080px] flex-col gap-4 px-4 py-4 sm:px-6 xl:px-8">
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
                      {label}: {usage.remaining}/{usage.limit} today
                      {usage.monthly ? ` · ${usage.monthly.remaining}/${usage.monthly.limit} month` : ""}
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
                    history={activeSession?.messages ?? []}
                    onHistoryChange={handleHistoryChange}
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
                />
              </div>

              <GenerationStatus status={generationStatus} />
            </div>
          </header>

          <main ref={boardRef} className="relative z-10 mx-auto max-w-[1080px] px-4 py-7 sm:px-6 xl:px-8">
            <div className="mx-auto min-w-0">
              <IssueCard status={generationStatus} />
              <ProblemBlock problem={problem} loading={isGenerating} />
            </div>
          </main>
        </div>

        <ExplanationPanel problem={problem} />
      </div>
    </HoverProvider>
  );
}
