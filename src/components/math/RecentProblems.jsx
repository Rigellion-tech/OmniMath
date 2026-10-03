import React from "react";
import { History, X } from "lucide-react";
import InlineMath from "./InlineMath";
import { getProblemLabel } from "@/lib/problemLabels";

export default function RecentProblems({ recents, onSelect, onClear }) {
  if (recents.length === 0) return null;

  return (
    <aside className="overflow-hidden rounded-xl bg-neutral-50">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-neutral-500" />
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            Recent
          </span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg p-1 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900"
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
            className="rounded-lg px-3 py-3 text-left transition-all duration-200 hover:bg-neutral-200/70"
          >
            <span className="block truncate font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              {getProblemLabel(item, "Recent problem")}
            </span>
            <span className="mt-1 block truncate font-serif text-sm italic text-neutral-800">
              <InlineMath math={item.expression} />
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
