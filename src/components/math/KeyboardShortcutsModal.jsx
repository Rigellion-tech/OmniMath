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
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 p-4">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-neutral-500" />
            <div>
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">
                Keyboard
              </p>
              <h2 className="text-base font-semibold text-neutral-900">Shortcuts</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
            aria-label="Close keyboard shortcuts"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-2 p-4">
          {keyboardShortcuts.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-neutral-700">{shortcut.keys}</span>
              <span className="text-xs text-neutral-600">{shortcut.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
