import React, { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Download,
  Gauge,
  Keyboard,
  MousePointer2,
  Palette,
  RotateCcw,
  Sigma,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { useSettings } from "@/lib/settings";
import { keyboardShortcuts } from "@/data/keyboardShortcuts";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "interaction", label: "Interaction", icon: MousePointer2 },
  { key: "learning", label: "Learning", icon: BookOpen },
  { key: "mathRendering", label: "Math Rendering", icon: Sigma },
  { key: "productivity", label: "Productivity", icon: Gauge },
];

function Section({ eyebrow, title, children }) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4 shadow-[0_14px_38px_rgba(0,0,0,0.18)]">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/60">
        {eyebrow}
      </p>
      <h3 className="mt-1 text-base font-semibold tracking-normal text-cyan-50">
        {title}
      </h3>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function SettingRow({ label, description, children }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-black/10 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-100/86">{label}</p>
        {description && <p className="mt-1 text-xs leading-5 text-slate-300/54">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "omni-toggle",
        checked && "omni-toggle-on"
      )}
    >
      <span className="omni-toggle-knob" />
    </button>
  );
}

function SegmentedControl({ value, options, onChange }) {
  return (
    <div className="grid rounded-xl border border-white/[0.08] bg-black/15 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-lg px-2.5 py-1.5 text-center text-xs font-medium transition-all duration-200",
            value === option.value
              ? "bg-teal-300/[0.16] text-teal-50 shadow-[0_8px_20px_rgba(0,0,0,0.18)]"
              : "text-slate-400/72 hover:bg-white/[0.045] hover:text-slate-200"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step = 1, suffix = "", onChange }) {
  return (
    <div className="min-w-[190px]">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="omni-range w-full"
      />
      <div className="mt-1 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-teal-200/65">
        {value}{suffix}
      </div>
    </div>
  );
}

function KeyboardShortcuts({ onClose }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-teal-200/60">
            Productivity
          </p>
          <h4 className="mt-1 text-sm font-semibold text-cyan-50">Keyboard shortcuts</h4>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-slate-300/60 transition-colors hover:bg-white/[0.06] hover:text-slate-100"
          aria-label="Close keyboard shortcuts"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-3 grid gap-2">
        {keyboardShortcuts.map((shortcut) => (
          <div key={shortcut.keys} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-black/12 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-teal-100/72">{shortcut.keys}</span>
            <span className="text-xs text-slate-300/62">{shortcut.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPanel({ open, onClose }) {
  const { settings, updateSetting, resetSettings } = useSettings();
  const [activeCategory, setActiveCategory] = useState("appearance");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const content = useMemo(() => {
    switch (activeCategory) {
      case "interaction":
        return (
          <Section eyebrow="Interaction" title="Lens behavior">
            <SettingRow label="Hover lens" description="Show temporary mini lenses while inspecting tokens.">
              <Toggle
                checked={settings.interaction.hoverLens}
                onChange={(value) => updateSetting("interaction", "hoverLens", value)}
                label="Toggle hover lens"
              />
            </SettingRow>
            <SettingRow label="Hover delay" description="How quickly a preview graduates from tiny hint to richer explanation.">
              <Slider
                value={settings.interaction.hoverDelay}
                min={120}
                max={900}
                step={20}
                suffix="ms"
                onChange={(value) => updateSetting("interaction", "hoverDelay", value)}
              />
            </SettingRow>
            <SettingRow label="Lens drag smoothness" description="Controls how aggressively lens drag updates are smoothed.">
              <SegmentedControl
                value={settings.interaction.lensDragSmoothness}
                options={[
                  { value: "precise", label: "Precise" },
                  { value: "balanced", label: "Balanced" },
                  { value: "fast", label: "Fast" },
                ]}
                onChange={(value) => updateSetting("interaction", "lensDragSmoothness", value)}
              />
            </SettingRow>
            <SettingRow label="Sticky lens positions" description="Remember pinned lens positions with the current session.">
              <Toggle
                checked={settings.interaction.stickyLensPositions}
                onChange={(value) => updateSetting("interaction", "stickyLensPositions", value)}
                label="Toggle sticky lens positions"
              />
            </SettingRow>
            <SettingRow label="Debug token overlay" description="Visualize leaf tokens, semantic groups, hover targets, and selected clusters.">
              <Toggle
                checked={settings.interaction.debugSemanticHitboxes}
                onChange={(value) => updateSetting("interaction", "debugSemanticHitboxes", value)}
                label="Toggle debug token overlay"
              />
            </SettingRow>
          </Section>
        );
      case "learning":
        return (
          <Section eyebrow="Learning" title="Explanation defaults">
            <SettingRow label="Explanation depth" description="Controls how much detail hover previews and lenses can reveal.">
              <SegmentedControl
                value={settings.learning.explanationDepth}
                options={[
                  { value: "beginner", label: "Beginner" },
                  { value: "intermediate", label: "Intermediate" },
                  { value: "advanced", label: "Advanced" },
                  { value: "exam", label: "Exam" },
                  { value: "intuition", label: "Intuition" },
                  { value: "professor", label: "Professor" },
                ]}
                onChange={(value) => updateSetting("learning", "explanationDepth", value)}
              />
            </SettingRow>
            <SettingRow label="Default lens level" description="New pinned lenses start at this explanation level.">
              <SegmentedControl
                value={settings.learning.defaultLensLevel}
                options={[
                  { value: "beginner", label: "Beginner" },
                  { value: "intermediate", label: "Intermediate" },
                  { value: "advanced", label: "Advanced" },
                  { value: "exam", label: "Exam" },
                  { value: "intuition", label: "Intuition" },
                  { value: "professor", label: "Professor" },
                ]}
                onChange={(value) => updateSetting("learning", "defaultLensLevel", value)}
              />
            </SettingRow>
            <SettingRow label="Socratic mode" description="Stored for upcoming tutor prompts; not applied to generated solutions yet.">
              <Toggle
                checked={settings.learning.socraticMode}
                onChange={(value) => updateSetting("learning", "socraticMode", value)}
                label="Toggle Socratic mode"
              />
            </SettingRow>
          </Section>
        );
      case "mathRendering":
        return (
          <Section eyebrow="Math Rendering" title="Equation display">
            <SettingRow label="Animate equation transitions" description="Keep step entrances and equation changes lightly animated.">
              <Toggle
                checked={settings.mathRendering.animateEquationTransitions}
                onChange={(value) => updateSetting("mathRendering", "animateEquationTransitions", value)}
                label="Toggle equation animation"
              />
            </SettingRow>
            <SettingRow label="Equation density" description="Adjust vertical rhythm around rendered math.">
              <SegmentedControl
                value={settings.mathRendering.equationDensity}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "comfortable", label: "Comfort" },
                  { value: "spacious", label: "Spacious" },
                ]}
                onChange={(value) => updateSetting("mathRendering", "equationDensity", value)}
              />
            </SettingRow>
            <SettingRow label="Coordinate visuals" description="Show coordinate-system previews for supported Calc 3 demos.">
              <Toggle
                checked={settings.mathRendering.coordinateVisuals}
                onChange={(value) => updateSetting("mathRendering", "coordinateVisuals", value)}
                label="Toggle coordinate visuals"
              />
            </SettingRow>
          </Section>
        );
      case "productivity":
        return (
          <Section eyebrow="Productivity" title="Session workflow">
            <SettingRow label="Autosave" description="Save signed-in sessions after edits settle.">
              <Toggle
                checked={settings.productivity.autosave}
                onChange={(value) => updateSetting("productivity", "autosave", value)}
                label="Toggle autosave"
              />
            </SettingRow>
            <SettingRow label="Export session" description="Download the current board as Markdown.">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("omnimath:export-session"))}
                className="omni-button flex min-h-9 items-center gap-2 rounded-xl px-3 text-xs font-semibold"
              >
                <Download className="h-3.5 w-3.5" />
                Export Markdown
              </button>
            </SettingRow>
            <SettingRow label="Keyboard shortcuts" description="Review the current interaction map.">
              <button
                type="button"
                onClick={() => setShortcutsOpen((value) => !value)}
                className="flex min-h-9 items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 text-xs font-semibold text-slate-200/75 transition-colors hover:text-teal-100"
              >
                <Keyboard className="h-3.5 w-3.5" />
                {shortcutsOpen ? "Hide" : "Show"}
              </button>
            </SettingRow>
          </Section>
        );
      case "appearance":
      default:
        return (
          <Section eyebrow="Appearance" title="Workspace style">
            <SettingRow label="Theme selector" description="Shift the dashboard treatment while preserving the OmniMath dark UI.">
              <SegmentedControl
                value={settings.appearance.theme}
                options={[
                  { value: "midnight", label: "Midnight" },
                  { value: "deep", label: "Deep" },
                  { value: "contrast", label: "Contrast" },
                ]}
                onChange={(value) => updateSetting("appearance", "theme", value)}
              />
            </SettingRow>
            <SettingRow label="Accent color" description="Applies to core controls and the settings surface immediately.">
              <SegmentedControl
                value={settings.appearance.accentColor}
                options={[
                  { value: "teal", label: "Teal" },
                  { value: "cyan", label: "Cyan" },
                  { value: "emerald", label: "Emerald" },
                  { value: "violet", label: "Violet" },
                  { value: "amber", label: "Amber" },
                ]}
                onChange={(value) => updateSetting("appearance", "accentColor", value)}
              />
            </SettingRow>
            <SettingRow label="Font size" description="Scales the main tutor workspace text.">
              <Slider
                value={settings.appearance.fontSize}
                min={90}
                max={115}
                step={1}
                suffix="%"
                onChange={(value) => updateSetting("appearance", "fontSize", value)}
              />
            </SettingRow>
            <SettingRow label="Equation scale" description="Scales KaTeX-rendered math throughout the board and lenses.">
              <Slider
                value={settings.appearance.equationScale}
                min={90}
                max={125}
                step={1}
                suffix="%"
                onChange={(value) => updateSetting("appearance", "equationScale", value)}
              />
            </SettingRow>
          </Section>
        );
    }
  }, [activeCategory, settings, shortcutsOpen, updateSetting]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/62 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="omni-settings-panel relative flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl">
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-teal-200/72" />
              <p className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-teal-200/68">
                Settings
              </p>
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-normal text-cyan-50">
              Tune OmniMath
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-300/62">
              Settings are saved locally and applied live where the current app surface supports it.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={resetSettings}
              className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-2.5 text-slate-300/62 transition-colors hover:text-teal-100"
              aria-label="Reset settings"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-2.5 text-slate-300/62 transition-colors hover:bg-rose-400/10 hover:text-rose-100"
              aria-label="Close settings"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="border-b border-white/[0.08] p-3 md:border-b-0 md:border-r">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-1">
              {CATEGORIES.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveCategory(key)}
                  className={cn(
                    "flex min-h-11 items-center gap-2 rounded-xl border px-3 text-left text-sm font-medium transition-all duration-200",
                    activeCategory === key
                      ? "border-teal-300/[0.28] bg-teal-300/[0.12] text-teal-50"
                      : "border-transparent text-slate-300/66 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-slate-100"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="omni-scrollbar min-h-0 overflow-y-auto p-4">
            <div className="transition-all duration-200">
              {content}
              <div className="mt-4 rounded-2xl border border-teal-300/[0.12] bg-teal-300/[0.05] p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-teal-200/68" />
                  <p className="text-xs leading-5 text-slate-300/62">
                    Placeholder settings are intentionally persisted now, so future solver and rendering work can adopt them without changing the user-facing control model.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {shortcutsOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/58 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg">
            <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
