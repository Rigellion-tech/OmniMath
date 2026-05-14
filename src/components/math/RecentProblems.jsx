import React from "react";
import { History, X } from "lucide-react";

export default function RecentProblems({ recents, onSelect, onClear }) {
  if (recents.length === 0) return null;

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: "rgba(10, 24, 30, 0.75)",
        border: "1px solid rgba(34,211,238,0.15)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid rgba(34,211,238,0.1)" }}
      >
        <div className="flex items-center gap-1.5">
          <History className="w-3 h-3" style={{ color: "rgba(34,211,238,0.5)" }} />
          <span className="font-sans font-semibold uppercase tracking-widest"
            style={{ fontSize: 9, color: "rgba(34,211,238,0.5)" }}>
            Recent
          </span>
        </div>
        <button onClick={onClear} className="transition-opacity hover:opacity-70">
          <X className="w-3 h-3" style={{ color: "rgba(150,200,210,0.35)" }} />
        </button>
      </div>

      {/* List */}
      <div className="flex flex-col">
        {recents.map((item, i) => (
          <button
            key={i}
            onClick={() => onSelect(item)}
            className="flex flex-col items-start px-3 py-2 text-left transition-all duration-150 hover:bg-white/5"
            style={{ borderBottom: i < recents.length - 1 ? "1px solid rgba(34,211,238,0.07)" : "none" }}
          >
            <span className="font-sans uppercase tracking-widest"
              style={{ fontSize: 9, color: "rgba(34,211,238,0.4)" }}>
              {item.title}
            </span>
            <span className="font-serif italic truncate w-full mt-0.5"
              style={{ fontSize: 12, color: "hsl(185,60%,80%)" }}>
              {item.expression}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}