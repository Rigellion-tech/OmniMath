import React from "react";
import { InlineMath } from "react-katex";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

export default function MathChunk({ chunk, stepId }) {
  const { activeChunkId, pinnedChunkId, handleChunkEnter, handleChunkLeave, handleChunkRightClick, handleUnpin } = useHover();

  const isActive = activeChunkId === chunk.id;
  const isPinned = pinnedChunkId === chunk.id;
  const isSiblingActive = activeChunkId && activeChunkId !== chunk.id;

  const handleClick = () => {
    if (pinnedChunkId) handleUnpin();
  };

  return (
    <span
      onMouseEnter={() => handleChunkEnter(chunk, stepId)}
      onMouseLeave={handleChunkLeave}
      onContextMenu={(e) => handleChunkRightClick(chunk, stepId, e)}
      onClick={handleClick}
      className={cn(
        "inline-block cursor-default transition-all duration-300 ease-out px-1 py-0.5 rounded-md relative select-none",
        isSiblingActive && !isPinned && "opacity-30",
      )}
      style={{
        transitionProperty: "opacity, background-color, transform, box-shadow",
        ...(isActive || isPinned ? {
          backgroundColor: isPinned ? "rgba(34, 211, 238, 0.18)" : "rgba(34, 211, 238, 0.12)",
          boxShadow: isPinned
            ? "0 0 0 1.5px rgba(34, 211, 238, 0.7), 0 0 16px rgba(34, 211, 238, 0.2)"
            : "0 0 0 1px rgba(34, 211, 238, 0.4), 0 0 16px rgba(34, 211, 238, 0.15)",
        } : {})
      }}
    >
      <span
        style={{
          "--katex-color": isActive || isPinned ? "#a5f3fc" : "hsl(185, 60%, 88%)",
          filter: isActive || isPinned ? "drop-shadow(0 0 6px rgba(34,211,238,0.7))" : "none",
        }}
        className="katex-chunk"
      >
        <KatexDisplay tex={chunk.display} />
      </span>
      {isPinned && (
        <span style={{
          position: "absolute", top: -4, right: -4,
          width: 6, height: 6, borderRadius: "50%",
          background: "rgba(34,211,238,0.9)",
          boxShadow: "0 0 6px rgba(34,211,238,0.8)"
        }} />
      )}
    </span>
  );
}

function KatexDisplay({ tex }) {
  try {
    return <InlineMath math={tex} />;
  } catch {
    // Fallback to plain text if LaTeX parsing fails
    return <span className="font-serif italic">{tex}</span>;
  }
}