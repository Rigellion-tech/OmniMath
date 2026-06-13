import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BrainCircuit, History, Plus, Search, Settings, UserCircle, X } from "lucide-react";
import AuthControls from "@/components/auth/AuthControls";
import SettingsPanel from "@/components/layout/SettingsPanel";
import { cleanLatexSnippet, getSessionLabel } from "@/lib/problemLabels";
import { cn } from "@/lib/utils";

function formatSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getSessionPreview(session) {
  const lastMessage = session.messages?.at(-1)?.text;
  if (lastMessage) return cleanLatexSnippet(lastMessage, "Recent question", 64);
  if (session.problem?.expression) return cleanLatexSnippet(session.problem.expression, "Math problem", 64);
  return "Ready for a new problem";
}

export default function SessionSidebar({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
  loading = false,
  syncStatus = "",
  error = "",
  open,
  onClose,
}) {
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return sessions;

    return sessions.filter((session) => {
      const haystack = `${getSessionLabel(session)} ${getSessionPreview(session)}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [query, sessions]);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={cn(
          "omni-sidebar fixed bottom-0 left-0 top-0 z-[60] flex w-[280px] flex-col overflow-hidden transition-transform duration-300 lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="border-b border-white/[0.07] p-4">
          <div className="flex items-center justify-between gap-3">
            <Link to="/" onClick={onClose} className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10 shadow-[0_12px_32px_rgba(0,0,0,0.28)]">
                <BrainCircuit className="h-5 w-5 text-teal-200" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-normal text-cyan-50">
                  OmniMath
                </h1>
                <p className="truncate text-xs text-slate-300/55">AI Tutor</p>
              </div>
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-300/60 transition-colors hover:bg-white/[0.06] hover:text-slate-100 lg:hidden"
              aria-label="Close sessions"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={onNewSession}
            className="omni-button mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200"
          >
            <Plus className="h-4 w-4" />
            New session
          </button>

          <label className="omni-control mt-3 flex min-h-10 items-center gap-2 rounded-xl px-3">
            <Search className="h-4 w-4 text-slate-400/70" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              className="min-w-0 flex-1 bg-transparent text-sm text-cyan-50 outline-none placeholder:text-slate-500"
            />
          </label>

          {(syncStatus || error) && (
            <div className="mt-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-xs leading-5 text-slate-300/60">
              {error || syncStatus}
            </div>
          )}
        </div>

        <div className="omni-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex flex-col gap-2 p-1" aria-label="Loading sessions">
              {[0, 1, 2].map((item) => (
                <div key={item} className="rounded-2xl border border-white/[0.06] bg-white/[0.025] px-3 py-3">
                  <div className="h-4 w-36 animate-pulse rounded-full bg-teal-300/[0.08]" />
                  <div className="mt-2 h-3 w-48 animate-pulse rounded-full bg-white/[0.055]" />
                  <div className="mt-3 h-2.5 w-16 animate-pulse rounded-full bg-white/[0.045]" />
                </div>
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] px-3 py-4 text-sm leading-6 text-slate-300/60">
              No sessions match that search.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredSessions.map((session) => {
                const active = session.id === activeSessionId;

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      onSelectSession(session.id);
                      onClose?.();
                    }}
                    className={cn(
                      "rounded-2xl border px-3 py-3 text-left transition-all duration-200",
                      active
                        ? "border-teal-300/[0.28] bg-teal-300/[0.1] shadow-[0_12px_30px_rgba(0,0,0,0.2)]"
                        : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.045]"
                    )}
                    >
                    <span className="block truncate text-sm font-medium text-cyan-50/90">
                      {getSessionLabel(session)}
                    </span>
                    <span className="mt-1 block truncate text-xs text-slate-300/55">
                      {getSessionPreview(session)}
                    </span>
                    <span className="mt-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-teal-200/48">
                      {formatSessionTime(session.updatedAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.07] p-3">
          <div className="mb-3 grid grid-cols-3 gap-2">
            <Link
              to="/history"
              onClick={onClose}
              className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] text-xs font-medium text-slate-200/70 transition-colors hover:text-teal-100"
            >
              <History className="h-4 w-4" />
              History
            </Link>
            <Link
              to="/account"
              onClick={onClose}
              className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] text-xs font-medium text-slate-200/70 transition-colors hover:text-teal-100"
            >
              <UserCircle className="h-4 w-4" />
              Profile
            </Link>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.035] text-xs font-medium text-slate-200/70 transition-colors hover:text-teal-100"
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
          </div>
          <AuthControls />
        </div>
      </aside>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
