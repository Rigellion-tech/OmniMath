import React from "react";
import { History, X } from "lucide-react";
import InlineMath from "./InlineMath";
import { getProblemLabel } from "@/lib/problemLabels";

export default function RecentProblems({ recents, onSelect, onClear }) {
  if (recents.length === 0) return null;

  return (
    <aside className="omni-surface overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-teal-200/70" />
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-teal-200/70">
            Recent
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg p-1 text-slate-400/60 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Clear recent problems"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-col p-2">
        {recents.map((item, index) => (
          <button
            key={`${item.expression}-${index}`}
            type="button"
            onClick={() => onSelect(item)}
            className="rounded-xl px-3 py-3 text-left transition-all duration-200 hover:bg-white/[0.055]"
          >
            <span className="block truncate font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/50">
              {getProblemLabel(item, "Recent problem")}
            </span>
            <span className="mt-1 block truncate font-serif text-sm italic text-cyan-50/80">
              <InlineMath math={item.expression} />
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
