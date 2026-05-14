import React from "react";
import MathChunk from "./MathChunk";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

export default function MathStep({ step, index }) {
  const { activeStepId, pinnedChunkId, handleUnpin } = useHover();
  const isActiveStep = activeStepId === step.id;
  const isOtherStepActive = activeStepId && activeStepId !== step.id;

  const offset = "";

  return (
    <div className={cn("transition-all duration-300 ease-out", isOtherStepActive && "opacity-40")}>
      <div
        className={cn("relative rounded-lg p-3 transition-all duration-300", offset)}
        onClick={() => { if (pinnedChunkId) handleUnpin(); }}
        style={{
          background: "rgba(14, 30, 37, 0.7)",
          border: isActiveStep
            ? "1px solid rgba(34, 211, 238, 0.85)"
            : "1px solid rgba(34, 211, 238, 0.28)",
          boxShadow: isActiveStep
            ? "0 0 24px rgba(34, 211, 238, 0.25), inset 0 0 16px rgba(34, 211, 238, 0.06)"
            : "0 2px 12px rgba(0,0,0,0.3)",
          backdropFilter: "blur(8px)",
        }}
      >
        {/* Step label */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-sans font-semibold tracking-[0.15em] uppercase"
            style={{ fontSize: 11, color: "rgba(34, 211, 238, 0.7)" }}>
            {index + 1}
          </span>
          <span className="font-sans font-semibold tracking-[0.15em] uppercase"
            style={{ fontSize: 11, color: "rgba(185, 220, 230, 0.6)" }}>
            {step.label}
          </span>
        </div>

        {/* Math chunks */}
        <div className="flex flex-wrap items-baseline gap-0 leading-snug">
          {step.chunks.map((chunk) => (
            <MathChunk key={chunk.id} chunk={chunk} stepId={step.id} />
          ))}
        </div>
      </div>
    </div>
  );
}