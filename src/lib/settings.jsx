import React, { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "omnimath.settings.v1";

const ACCENTS = {
  teal: "45 212 191",
  cyan: "34 211 238",
  emerald: "52 211 153",
  violet: "167 139 250",
  amber: "251 191 36",
};

export const DEFAULT_SETTINGS = {
  appearance: {
    theme: "midnight",
    accentColor: "teal",
    fontSize: 100,
    equationScale: 100,
  },
  interaction: {
    hoverLens: true,
    hoverDelay: 125,
    lensDragSmoothness: "balanced",
    stickyLensPositions: true,
  },
  learning: {
    explanationDepth: "intermediate",
    defaultLensLevel: "intermediate",
    socraticMode: false,
  },
  mathRendering: {
    animateEquationTransitions: true,
    equationDensity: "comfortable",
    coordinateVisuals: true,
  },
  productivity: {
    autosave: true,
    keyboardShortcuts: true,
  },
};

function mergeSettings(value) {
  return {
    appearance: { ...DEFAULT_SETTINGS.appearance, ...value?.appearance },
    interaction: { ...DEFAULT_SETTINGS.interaction, ...value?.interaction },
    learning: { ...DEFAULT_SETTINGS.learning, ...value?.learning },
    mathRendering: { ...DEFAULT_SETTINGS.mathRendering, ...value?.mathRendering },
    productivity: { ...DEFAULT_SETTINGS.productivity, ...value?.productivity },
  };
}

function readStoredSettings() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? mergeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(readStoredSettings);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.omniTheme = settings.appearance.theme;
    root.dataset.omniAccent = settings.appearance.accentColor;
    root.dataset.omniDragSmoothness = settings.interaction.lensDragSmoothness;
    root.dataset.omniEquationDensity = settings.mathRendering.equationDensity;
    root.dataset.omniEquationMotion = settings.mathRendering.animateEquationTransitions ? "on" : "off";
    root.style.setProperty("--omni-accent-rgb", ACCENTS[settings.appearance.accentColor] || ACCENTS.teal);
    root.style.setProperty("--omni-font-scale", String(settings.appearance.fontSize / 100));
    root.style.setProperty("--omni-equation-scale", String(settings.appearance.equationScale / 100));
  }, [settings]);

  const value = useMemo(() => ({
    settings,
    updateSetting(category, key, nextValue) {
      setSettings((current) => ({
        ...current,
        [category]: {
          ...current[category],
          [key]: typeof nextValue === "function" ? nextValue(current[category][key]) : nextValue,
        },
      }));
    },
    resetSettings() {
      setSettings(DEFAULT_SETTINGS);
    },
  }), [settings]);

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside SettingsProvider");
  return context;
}
