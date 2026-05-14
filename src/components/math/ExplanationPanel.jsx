import React from "react";
import { InlineMath } from "react-katex";
import { useHover } from "@/lib/HoverContext";
import { motion, AnimatePresence } from "framer-motion";
import { Lightbulb, BookOpen, Sparkles, Play, Pin } from "lucide-react";

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
  const { activeChunkData, explanationLevel, pinnedChunkId, difficultyMode, setDifficultyMode } = useHover();

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl"
      style={{
        position: "fixed",
        top: 32,
        right: 32,
        width: 300,
        maxHeight: "calc(100vh - 64px)",
        background: "rgba(10, 24, 30, 0.9)",
        border: "1px solid rgba(34, 211, 238, 0.25)",
        boxShadow: "0 0 30px rgba(34, 211, 238, 0.08), inset 0 0 20px rgba(34, 211, 238, 0.02)",
        backdropFilter: "blur(16px)",
        zIndex: 50,
      }}
    >
      {/* Header */}
      <div className="px-5 pt-5 pb-3 flex items-start justify-between">
        <div>
          <h2 className="font-sans font-semibold" style={{ fontSize: 15, color: "hsl(185,60%,88%)" }}>
            Explanation
          </h2>
          <p className="font-sans mt-0.5" style={{ fontSize: 12, color: "rgba(150, 200, 210, 0.6)" }}>
            {pinnedChunkId ? "Pinned — left click to unpin" : "Hover to explore · Right-click to pin"}
          </p>
        </div>
        {pinnedChunkId && (
          <Pin className="w-3.5 h-3.5 mt-1" style={{ color: "rgba(34,211,238,0.7)" }} />
        )}
      </div>

      {/* Difficulty selector */}
      <div className="px-5 pb-3 flex items-center gap-1">
        {DIFFICULTIES.map((d) => (
          <button
            key={d.key}
            onClick={() => setDifficultyMode(d.key)}
            className="flex-1 py-1 rounded-md font-sans transition-all duration-200"
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.08em",
              background: difficultyMode === d.key ? "rgba(34,211,238,0.15)" : "rgba(34,211,238,0.04)",
              color: difficultyMode === d.key ? "rgba(34,211,238,0.95)" : "rgba(150,200,210,0.45)",
              border: difficultyMode === d.key ? "1px solid rgba(34,211,238,0.4)" : "1px solid rgba(34,211,238,0.1)",
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* Divider */}
      <div style={{ height: "1px", background: "rgba(34, 211, 238, 0.12)", margin: "0 20px" }} />

      {/* Content */}
      <div className="flex-1 px-5 py-5 overflow-y-auto flex flex-col justify-between" style={{ minHeight: 0 }}>
        <AnimatePresence mode="wait">
          {!activeChunkData ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col items-center justify-center text-center py-10"
            >
              <Play className="w-6 h-6 mb-4" style={{ color: "rgba(34,211,238,0.45)" }} />
              <p className="font-sans leading-relaxed max-w-[160px]"
                style={{ fontSize: 12, color: "rgba(150, 200, 210, 0.65)" }}>
                Hover over any symbol, term, or expression to see what it means
              </p>
            </motion.div>
          ) : (
            <motion.div
              key={activeChunkData.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
              className="flex flex-col gap-3"
            >
              {/* Active chunk badge */}
              <div className="mb-1">
                <span
                  className="inline-block px-3 py-1.5 rounded-lg katex-panel-badge"
                  style={{
                    fontSize: 20,
                    background: "rgba(34,211,238,0.1)",
                    filter: "drop-shadow(0 0 8px rgba(34,211,238,0.5))",
                    border: "1px solid rgba(34,211,238,0.25)",
                  }}
                >
                  <InlineMath math={activeChunkData.display} />
                </span>
              </div>

              {levelConfig.map((config, i) => {
                const level = i + 1;
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
                        transition={{ duration: 0.3, ease: "easeOut" }}
                        className="overflow-hidden"
                      >
                        <div
                          className="py-2.5 px-3 rounded-lg"
                          style={{
                            background: "rgba(34,211,238,0.05)",
                            borderLeft: "2px solid rgba(34,211,238,0.4)",
                          }}
                        >
                          <div className="flex items-center gap-1.5 mb-1">
                            <Icon className="w-3 h-3" style={{ color: "rgba(34,211,238,0.7)" }} />
                            <span className="font-sans font-semibold uppercase tracking-wider"
                              style={{ fontSize: 10, color: "rgba(34,211,238,0.7)" }}>
                              {config.label}
                            </span>
                          </div>
                          <p className="font-sans leading-relaxed"
                            style={{ fontSize: 12, color: "rgba(185,230,240,0.85)" }}>
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

        {/* Bottom legend */}
        <div className="mt-5 pt-3 flex items-center gap-1.5"
          style={{ borderTop: "1px solid rgba(34,211,238,0.1)" }}>
          {[
            { key: "beginner", label: "Hint only" },
            { key: "intermediate", label: "+ Explanation" },
            { key: "advanced", label: "+ Deep Dive" },
          ].map(({ key, label }) => (
            <span key={key} className="flex items-center gap-1 font-sans"
              style={{ fontSize: 10, color: difficultyMode === key ? "rgba(34,211,238,0.75)" : "rgba(150,200,210,0.4)" }}>
              <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0"
                style={{ background: difficultyMode === key ? "rgba(34,211,238,0.8)" : "rgba(34,211,238,0.2)" }} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}