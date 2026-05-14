import React, { createContext, useContext, useState, useRef, useCallback } from "react";

const HoverContext = createContext(null);

// difficultyMode: "beginner" | "intermediate" | "advanced"
const DIFFICULTY_MAX_LEVEL = { beginner: 1, intermediate: 2, advanced: 3 };

export function HoverProvider({ children }) {
  const [activeChunkId, setActiveChunkId] = useState(null);
  const [activeChunkData, setActiveChunkData] = useState(null);
  const [explanationLevel, setExplanationLevel] = useState(0);
  const [activeStepId, setActiveStepId] = useState(null);
  const [pinnedChunkId, setPinnedChunkId] = useState(null);
  const [pinnedChunkData, setPinnedChunkData] = useState(null);
  const [pinnedStepId, setPinnedStepId] = useState(null);
  const [difficultyMode, setDifficultyMode] = useState("intermediate");
  const timerRefs = useRef({});

  const startTimers = useCallback((mode) => {
    const max = DIFFICULTY_MAX_LEVEL[mode] ?? 3;
    setExplanationLevel(0);
    if (max >= 1) timerRefs.current.short = setTimeout(() => setExplanationLevel(1), 300);
    if (max >= 2) timerRefs.current.medium = setTimeout(() => setExplanationLevel(2), 800);
    if (max >= 3) timerRefs.current.deep = setTimeout(() => setExplanationLevel(3), 1500);
  }, []);

  const handleChunkEnter = useCallback((chunk, stepId) => {
    Object.values(timerRefs.current).forEach(clearTimeout);
    timerRefs.current = {};
    setActiveChunkId(chunk.id);
    setActiveChunkData(chunk);
    setActiveStepId(stepId);
    startTimers(difficultyMode);
  }, [startTimers, difficultyMode]);

  const handleChunkLeave = useCallback(() => {
    Object.values(timerRefs.current).forEach(clearTimeout);
    timerRefs.current = {};
    if (pinnedChunkId) {
      setActiveChunkId(pinnedChunkId);
      setActiveChunkData(pinnedChunkData);
      setActiveStepId(pinnedStepId);
      setExplanationLevel(DIFFICULTY_MAX_LEVEL[difficultyMode] ?? 3);
    } else {
      setActiveChunkId(null);
      setActiveChunkData(null);
      setExplanationLevel(0);
      setActiveStepId(null);
    }
  }, [pinnedChunkId, pinnedChunkData, pinnedStepId, difficultyMode]);

  const handleChunkRightClick = useCallback((chunk, stepId, e) => {
    e.preventDefault();
    Object.values(timerRefs.current).forEach(clearTimeout);
    timerRefs.current = {};
    setPinnedChunkId(chunk.id);
    setPinnedChunkData(chunk);
    setPinnedStepId(stepId);
    setActiveChunkId(chunk.id);
    setActiveChunkData(chunk);
    setActiveStepId(stepId);
    setExplanationLevel(DIFFICULTY_MAX_LEVEL[difficultyMode] ?? 3);
  }, [difficultyMode]);

  const handleUnpin = useCallback(() => {
    setPinnedChunkId(null);
    setPinnedChunkData(null);
    setPinnedStepId(null);
    setActiveChunkId(null);
    setActiveChunkData(null);
    setExplanationLevel(0);
    setActiveStepId(null);
  }, []);

  // Displayed data: prefer hover, fall back to pinned
  const displayChunkData = activeChunkData;
  const displayLevel = explanationLevel;

  return (
    <HoverContext.Provider
      value={{
        activeChunkId,
        activeChunkData: displayChunkData,
        explanationLevel: displayLevel,
        activeStepId,
        pinnedChunkId,
        difficultyMode,
        setDifficultyMode,
        handleChunkEnter,
        handleChunkLeave,
        handleChunkRightClick,
        handleUnpin,
      }}
    >
      {children}
    </HoverContext.Provider>
  );
}

export function useHover() {
  const ctx = useContext(HoverContext);
  if (!ctx) throw new Error("useHover must be used inside HoverProvider");
  return ctx;
}