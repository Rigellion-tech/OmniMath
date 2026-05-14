import React from "react";
import InlineMath from "./InlineMath";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

export default function MathChunk({ chunk, stepId }) {
  const {
    activeChunkId,
    pinnedChunkId,
    handleChunkEnter,
    handleChunkLeave,
    handleChunkRightClick,
    handleUnpin,
  } = useHover();

  const isActive = activeChunkId === chunk.id;
  const isPinned = pinnedChunkId === chunk.id;
  const isSiblingActive = activeChunkId && activeChunkId !== chunk.id;
  const mathColor = isActive || isPinned ? "#ccfbf1" : "rgba(224, 242, 254, 0.9)";

  const handleClick = () => {
    if (pinnedChunkId) handleUnpin();
  };

  return (
    <span
      aria-label={chunk.short}
      onMouseEnter={() => handleChunkEnter(chunk, stepId)}
      onMouseLeave={handleChunkLeave}
      onContextMenu={(event) => handleChunkRightClick(chunk, stepId, event)}
      onClick={handleClick}
      className={cn(
        "math-token relative inline-block cursor-help select-none rounded-lg px-1.5 py-1 transition-all duration-200 ease-out",
        isSiblingActive && !isPinned && "opacity-45"
      )}
      style={{
        transitionProperty: "opacity, background-color, transform, box-shadow, color",
        transform: isActive || isPinned ? "translateY(-1px)" : "translateY(0)",
        ...(isActive || isPinned
          ? {
              backgroundColor: isPinned ? "rgba(45, 212, 191, 0.16)" : "rgba(45, 212, 191, 0.11)",
              boxShadow: isPinned
                ? "0 0 0 1px rgba(94, 234, 212, 0.72), 0 10px 22px rgba(0, 0, 0, 0.24)"
                : "0 0 0 1px rgba(94, 234, 212, 0.42), 0 10px 22px rgba(0, 0, 0, 0.16)",
            }
          : {}),
      }}
    >
      <span
        style={{
          color: mathColor,
          filter: isActive || isPinned ? "drop-shadow(0 0 8px rgba(45, 212, 191, 0.38))" : "none",
        }}
        className="katex-chunk"
      >
        <InlineMath math={chunk.display} className="font-serif italic" />
      </span>
      {isPinned && (
        <span
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-teal-200 shadow-[0_0_10px_rgba(94,234,212,0.8)]"
          aria-hidden="true"
        />
      )}
    </span>
  );
}
