import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, Lightbulb, MousePointer2, Pin, Sparkles } from "lucide-react";
import InlineMath from "./InlineMath";
import { useHover } from "@/lib/HoverContext";
import { cn } from "@/lib/utils";

const levelConfig = [
  { label: "Hint", icon: Lightbulb, key: "short" },
  { label: "Explanation", icon: BookOpen, key: "medium" },
  { label: "Deep Dive", icon: Sparkles, key: "deep" },
];

const DIFFICULTIES = [
  { key: "beginner", label: "Beginner" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
];

export default function ExplanationPanel() {
  const {
    activeChunkData,
    explanationLevel,
    pinnedChunkId,
    difficultyMode,
    setDifficultyMode,
  } = useHover();

  return (
    <aside className="omni-panel fixed bottom-5 right-5 top-5 z-50 flex w-[330px] flex-col overflow-hidden rounded-2xl max-lg:static max-lg:mx-5 max-lg:mb-8 max-lg:w-auto max-lg:max-h-none">
      <div className="border-b border-white/[0.07] px-5 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-teal-200/60">
              Tutor lens
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-normal text-cyan-50">
              Explanation
            </h2>
            <p className="mt-1 text-sm leading-5 text-slate-300/60">
              {pinnedChunkId ? "Pinned. Click a step to release it." : "Hover a token or right-click to pin it."}
            </p>
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-teal-300/[0.18] bg-teal-300/[0.075]">
            {pinnedChunkId ? (
              <Pin className="h-4 w-4 text-teal-100" />
            ) : (
              <MousePointer2 className="h-4 w-4 text-teal-100" />
            )}
          </div>
        </div>
      </div>

      <div className="border-b border-white/[0.07] px-5 py-4">
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-white/[0.08] bg-black/15 p-1">
          {DIFFICULTIES.map((difficulty) => (
            <button
              key={difficulty.key}
              type="button"
              aria-pressed={difficultyMode === difficulty.key}
              onClick={() => setDifficultyMode(difficulty.key)}
              className={cn(
                "rounded-lg px-2 py-2 text-center font-mono text-[10px] font-medium uppercase tracking-[0.1em] transition-all duration-200",
                difficultyMode === difficulty.key
                  ? "bg-teal-300/[0.16] text-teal-50 shadow-[0_8px_20px_rgba(0,0,0,0.18)]"
                  : "text-slate-400/70 hover:bg-white/[0.045] hover:text-slate-200"
              )}
            >
              {difficulty.label}
            </button>
          ))}
        </div>
      </div>

      <div className="omni-scrollbar flex min-h-0 flex-1 flex-col justify-between overflow-y-auto px-5 py-5">
        <AnimatePresence mode="wait">
          {!activeChunkData ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="flex flex-1 flex-col items-center justify-center py-12 text-center"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-teal-300/[0.16] bg-teal-300/[0.07]">
                <MousePointer2 className="h-5 w-5 text-teal-100/80" />
              </div>
              <p className="max-w-[220px] text-sm leading-6 text-slate-300/70">
                Inspect symbols, terms, and expressions to reveal context at the selected depth.
              </p>
            </motion.div>
          ) : (
            <motion.div
              key={activeChunkData.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="flex flex-col gap-3"
            >
              <div className="rounded-2xl border border-teal-300/[0.18] bg-teal-300/[0.07] p-4">
                <p className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/60">
                  Selected token
                </p>
                <div className="katex-panel-badge max-w-full overflow-x-auto font-serif text-2xl italic text-teal-50 omni-scrollbar">
                  <InlineMath math={activeChunkData.display} />
                </div>
              </div>

              {levelConfig.map((config, index) => {
                const level = index + 1;
                const text = activeChunkData[config.key];
                const isVisible = explanationLevel >= level;
                const Icon = config.icon;

                return (
                  <AnimatePresence key={config.key}>
                    {isVisible && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.26, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4">
                          <div className="mb-2 flex items-center gap-2">
                            <Icon className="h-3.5 w-3.5 text-teal-200/80" />
                            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/70">
                              {config.label}
                            </span>
                          </div>
                          <p className="text-sm leading-6 text-slate-200/80">
                            {text}
                          </p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-5 border-t border-white/[0.07] pt-4">
          <div className="grid grid-cols-3 gap-2">
            {[
              { key: "beginner", label: "Hint" },
              { key: "intermediate", label: "Explain" },
              { key: "advanced", label: "Deep" },
            ].map(({ key, label }) => (
              <div
                key={key}
                className={cn(
                  "rounded-lg border px-2 py-2 text-center font-mono text-[10px] uppercase tracking-[0.1em]",
                  difficultyMode === key
                    ? "border-teal-300/[0.24] bg-teal-300/[0.08] text-teal-100"
                    : "border-white/[0.07] bg-white/[0.025] text-slate-500"
                )}
              >
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
