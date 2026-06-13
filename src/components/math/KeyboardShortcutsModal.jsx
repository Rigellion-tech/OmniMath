import React, { useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { keyboardShortcuts } from "@/data/keyboardShortcuts";

export default function KeyboardShortcutsModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/62 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="omni-floating-window w-full max-w-lg overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.08] p-4">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-teal-200/72" />
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/62">
                Keyboard
              </p>
              <h2 className="text-base font-semibold text-cyan-50">Shortcuts</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-2 text-slate-300/62 transition-colors hover:bg-rose-400/10 hover:text-rose-100"
            aria-label="Close keyboard shortcuts"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-2 p-4">
          {keyboardShortcuts.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/12 px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-teal-100/76">{shortcut.keys}</span>
              <span className="text-xs text-slate-300/68">{shortcut.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
