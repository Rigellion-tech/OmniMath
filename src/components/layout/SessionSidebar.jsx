import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import {
  BrainCircuit,
  History,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  UserCircle,
  X,
} from "lucide-react";
import AuthControls from "@/components/auth/AuthControls";
import SettingsPanel from "@/components/layout/SettingsPanel";
import { cleanLatexSnippet, getSessionLabel } from "@/lib/problemLabels";
import { cn } from "@/lib/utils";

function formatSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
  onRenameSession,
  onDeleteSession,
  loading = false,
  syncStatus = "",
  error = "",
  open,
  onClose,
  collapsed = false,
  onCollapse,
  onExpand,
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState(null);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const searchRef = useRef(null);
  const railControlClass = "omni-rail-control flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400";

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return sessions;
    return sessions.filter((session) => {
      const haystack = `${getSessionLabel(session)} ${getSessionPreview(session)}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [query, sessions]);

  const revealSearch = () => {
    if (collapsed) onExpand?.();
    setSearchOpen(true);
  };

  const beginRename = (session) => {
    setRenameValue(getSessionLabel(session));
    setRenamingSessionId(session.id);
    setMenuSessionId(null);
  };

  const finishRename = () => {
    const title = renameValue.trim();
    if (renamingSessionId && title) onRenameSession?.(renamingSessionId, title);
    setRenamingSessionId(null);
    setRenameValue("");
  };

  const requestDelete = (session) => {
    setMenuSessionId(null);
    const title = getSessionLabel(session);
    if (window.confirm(`Delete “${title}”? This cannot be undone.`)) onDeleteSession?.(session.id);
  };

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
        id="session-sidebar-navigation"
        data-testid="session-sidebar"
        data-sidebar-state={collapsed ? "collapsed" : "expanded"}
        className={cn(
          "omni-sidebar fixed bottom-0 left-0 top-0 z-[60] flex w-[250px] flex-col transition-[transform,width] duration-200 ease-out lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          collapsed ? "lg:w-14" : "lg:w-[250px]"
        )}
      >
        <div className={cn("flex h-11 shrink-0 items-center gap-1 overflow-hidden border-b border-neutral-200 px-2", collapsed && "lg:hidden")}>
          <Link
            to="/"
            onClick={onClose}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1"
            title="OmniMath"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100">
              <BrainCircuit className="h-4 w-4 text-neutral-700" />
            </span>
            <span className="truncate text-sm font-semibold text-neutral-950">OmniMath</span>
          </Link>
          <button
            type="button"
            onClick={revealSearch}
            className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Search sessions"
            aria-expanded={searchOpen}
          >
            <Search className="h-4 w-4" />
          </button>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 lg:hidden" aria-label="Close sessions">
            <X className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            className="hidden rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 lg:inline-flex"
            aria-label="Collapse sessions sidebar"
            aria-controls="session-sidebar-navigation"
            aria-expanded="true"
            data-testid="sidebar-collapse"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>

        {collapsed && (
          <div className="hidden h-11 shrink-0 items-center justify-center border-b border-neutral-200 lg:flex">
            <button
              type="button"
              onClick={onExpand}
              className={railControlClass}
              aria-label="Expand sidebar"
              aria-controls="session-sidebar-navigation"
              aria-expanded="false"
              data-testid="sidebar-expand"
              data-tooltip="Expand sidebar"
              title="Expand sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className={cn("shrink-0 overflow-hidden p-2", collapsed && "lg:hidden")}>
          <button
            type="button"
            onClick={onNewSession}
            className="omni-button flex min-h-9 w-full items-center justify-center gap-2 rounded-lg px-2 text-xs font-semibold"
            title="New session"
          >
            <Plus className="h-4 w-4 shrink-0" />
            <span>New session</span>
          </button>

          {(searchOpen || query) && (
            <label className="omni-control mt-2 flex min-h-9 items-center gap-2 rounded-lg px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    setSearchOpen(false);
                  }
                }}
                placeholder="Search sessions"
                className="min-w-0 flex-1 bg-transparent text-xs text-neutral-900 outline-none placeholder:text-neutral-400"
              />
              <button type="button" onClick={() => { setQuery(""); setSearchOpen(false); }} className="rounded p-0.5 text-neutral-400 hover:text-neutral-900" aria-label="Close session search">
                <X className="h-3.5 w-3.5" />
              </button>
            </label>
          )}

          {(syncStatus || error) && !collapsed && (
            <div className="mt-2 truncate rounded-lg bg-neutral-100 px-2.5 py-1.5 text-[11px] text-neutral-600" title={error || syncStatus}>
              {error || syncStatus}
            </div>
          )}
        </div>

        {collapsed && (
          <div className="hidden shrink-0 flex-col items-center gap-1 py-2 lg:flex" data-testid="collapsed-sidebar-actions">
            <button
              type="button"
              onClick={onNewSession}
              className={cn(railControlClass, "omni-button")}
              aria-label="New session"
              data-tooltip="New session"
              title="New session"
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={revealSearch}
              className={railControlClass}
              aria-label="Search"
              data-tooltip="Search"
              title="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className={cn("omni-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 pb-2", collapsed && "lg:hidden")}>
          {loading ? (
            <div className="grid gap-1" aria-label="Loading sessions">
              {[0, 1, 2].map((item) => <div key={item} className="h-9 animate-pulse rounded-lg bg-neutral-100" />)}
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className={cn("rounded-lg bg-neutral-100 px-2.5 py-3 text-xs leading-5 text-neutral-600", collapsed && "lg:hidden")}>
              No sessions match that search.
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filteredSessions.map((session) => {
                const active = session.id === activeSessionId;
                const label = getSessionLabel(session);
                const details = `${getSessionPreview(session)} · ${formatSessionTime(session.updatedAt)}`;
                const renaming = renamingSessionId === session.id;
                return (
                  <div key={session.id} className={cn("group relative flex min-h-9 flex-wrap items-center rounded-lg", active ? "bg-neutral-200/70" : "hover:bg-neutral-100")} title={collapsed ? `${label} — ${details}` : details}>
                    {renaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onBlur={finishRename}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") finishRename();
                          if (event.key === "Escape") setRenamingSessionId(null);
                        }}
                        className="mx-1.5 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 outline-none focus:ring-1 focus:ring-neutral-400"
                        aria-label={`Rename ${label}`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { onSelectSession(session.id); onClose?.(); }}
                        className={cn("flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left", collapsed && "lg:justify-center lg:px-0")}
                      >
                        <MessageSquare className={cn("h-3.5 w-3.5 shrink-0 text-neutral-400", !collapsed && "lg:hidden")} />
                        <span className={cn("block truncate text-[13px] font-medium text-neutral-800", collapsed && "lg:sr-only")}>{label}</span>
                      </button>
                    )}
                    {!renaming && (
                      <button
                        type="button"
                        onClick={() => setMenuSessionId((current) => current === session.id ? null : session.id)}
                        className={cn("mr-1 rounded-md p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-neutral-900 focus:opacity-100 group-hover:opacity-100", collapsed && "lg:hidden")}
                        aria-label={`Session actions for ${label}`}
                        aria-expanded={menuSessionId === session.id}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {menuSessionId === session.id && (
                      <div className="mx-1 mb-1 flex basis-full items-center gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
                        <button type="button" onClick={() => beginRename(session)} className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-neutral-700 hover:bg-neutral-100">
                          <Pencil className="h-3.5 w-3.5" /> Rename
                        </button>
                        <button type="button" onClick={() => requestDelete(session)} className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-rose-600 hover:bg-rose-50">
                          <Trash2 className="h-3.5 w-3.5" /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className={cn("shrink-0 overflow-hidden border-t border-neutral-200 p-1.5", collapsed && "lg:hidden")}>
          <div className={cn("grid gap-0.5", collapsed ? "lg:grid-cols-1" : "grid-cols-3 lg:grid-cols-1")}>
            {[
              { to: "/history", label: "History", icon: History },
              { to: "/account", label: "Profile", icon: UserCircle },
            ].map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} onClick={onClose} title={label} className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </Link>
            ))}
            <button type="button" onClick={() => setSettingsOpen(true)} title="Settings" className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900">
              <Settings className="h-4 w-4 shrink-0" />
              <span>Settings</span>
            </button>
          </div>
          <div className="mt-1 border-t border-neutral-200 pt-1.5">
            <AuthControls />
          </div>
        </div>

        {collapsed && (
          <div className="mt-auto hidden shrink-0 flex-col items-center gap-1 border-t border-neutral-200 py-2 lg:flex" data-testid="collapsed-sidebar-navigation">
            {[
              { to: "/history", label: "History", icon: History },
              { to: "/account", label: "Profile", icon: UserCircle },
            ].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={({ isActive }) => cn(railControlClass, isActive && "bg-neutral-200 text-neutral-950")}
                aria-label={label}
                data-tooltip={label}
                title={label}
              >
                <Icon className="h-4 w-4" />
              </NavLink>
            ))}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={railControlClass}
              aria-label="Settings"
              data-tooltip="Settings"
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </button>
            <div className="mt-1 flex flex-col items-center gap-1 border-t border-neutral-200 pt-2">
              <AuthControls compact />
            </div>
          </div>
        )}
      </aside>

      <div data-sidebar-layout-space aria-hidden="true" className={cn("hidden shrink-0 transition-[width] duration-200 ease-out lg:block", collapsed ? "w-14" : "w-[250px]")} />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
