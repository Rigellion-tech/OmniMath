import React, { useRef, useState } from "react";
import { BrainCircuit, GraduationCap } from "lucide-react";
import AuthControls from "@/components/auth/AuthControls";
import { HoverProvider } from "@/lib/HoverContext";
import ProblemBlock from "@/components/math/ProblemBlock";
import ExplanationPanel from "@/components/math/ExplanationPanel";
import ProblemInput from "@/components/math/ProblemInput";
import RecentProblems from "@/components/math/RecentProblems";
import ExportButton from "@/components/math/ExportButton";
import ImageUpload from "@/components/math/ImageUpload";
import GenerationStatus from "@/components/math/GenerationStatus";
import { demoProblem } from "@/data/demoProblem";

function getUsageMeta(usage) {
  if (!usage) return "";

  const parts = [`${usage.used}/${usage.limit} used today`];
  if (usage.resetsAt) {
    const resetDate = new Date(usage.resetsAt);
    if (!Number.isNaN(resetDate.getTime())) {
      parts.push(`resets ${resetDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })}`);
    }
  }

  return parts.join(" | ");
}

export default function Home() {
  const [customProblem, setCustomProblem] = useState(null);
  const [recents, setRecents] = useState([]);
  const [generationStatus, setGenerationStatus] = useState({
    type: "empty",
    label: "Demo problem loaded",
    detail: "A sample explanation is ready on the board.",
    meta: "",
  });
  const boardRef = useRef(null);

  const problem = customProblem ?? demoProblem;
  const providerKey = customProblem ? customProblem.expression : "default";

  const handleProblemGenerated = (data) => {
    setCustomProblem(data);
    setGenerationStatus({
      type: "success",
      label: "Explanation ready",
      detail: data.title ? `${data.title} generated` : "New explanation generated",
      meta: data.steps?.length ? `${data.steps.length} steps` : "",
    });
    setRecents((prev) => {
      const filtered = prev.filter((r) => r.expression !== data.expression);
      return [data, ...filtered].slice(0, 5);
    });
  };

  const handleRecentSelect = (data) => {
    setCustomProblem(data);
    setGenerationStatus({
      type: "success",
      label: "Recent explanation loaded",
      detail: data.title || data.expression,
      meta: data.steps?.length ? `${data.steps.length} steps` : "",
    });
  };

  const handleGenerationStart = ({ source }) => {
    setGenerationStatus({
      type: "loading",
      label: source === "image" ? "Reading image" : "Solving problem",
      detail: "Building the structured explanation.",
      meta: "",
    });
  };

  const handleGenerationError = ({ source, message, status, code, usage }) => {
    const isLimitError = status === 429 && code === "USAGE_LIMIT_EXCEEDED";
    if (isLimitError) {
      setGenerationStatus({
        type: "limit",
        label: source === "image" ? "Image limit reached" : "Daily limit reached",
        detail: message || "You've reached today's limit for this action.",
        meta: getUsageMeta(usage),
      });
      return;
    }

    const isServerError = status >= 500;
    setGenerationStatus({
      type: "error",
      label: source === "image" ? "Image analysis failed" : "Generation failed",
      detail: isServerError
        ? "The AI backend could not complete the request."
        : message || "The solver could not complete that request.",
      meta: "",
    });
  };

  return (
    <HoverProvider key={providerKey}>
      <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
        <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#061116]/80 backdrop-blur-xl">
          <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-4 lg:pr-[380px]">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10 shadow-[0_12px_32px_rgba(0,0,0,0.28)]">
                  <BrainCircuit className="h-5 w-5 text-teal-200" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="font-sans text-xl font-semibold tracking-normal text-cyan-50">
                      OmniMath
                    </h1>
                    <span className="rounded-full border border-teal-300/20 bg-teal-300/10 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/80">
                      AI Tutor
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-300/60">
                    Guided math explanations with inspectable steps.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="hidden items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-xs text-slate-300/60 md:flex">
                  <GraduationCap className="h-3.5 w-3.5 text-teal-200/70" />
                  Hover tokens, right-click to pin.
                </div>
                <AuthControls />
                <ExportButton
                  targetRef={boardRef}
                  filename={problem.title.toLowerCase().replace(/\s+/g, "-")}
                />
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
              <div className="min-w-0 flex-1">
                <ProblemInput
                  onProblemGenerated={handleProblemGenerated}
                  onGenerationStart={handleGenerationStart}
                  onGenerationError={handleGenerationError}
                />
              </div>
              <ImageUpload
                onProblemGenerated={handleProblemGenerated}
                onGenerationStart={handleGenerationStart}
                onGenerationError={handleGenerationError}
              />
            </div>

            <GenerationStatus status={generationStatus} />
          </div>
        </header>

        <main ref={boardRef} className="relative z-10 mx-auto max-w-[1500px] px-5 py-6 lg:pr-[380px]">
          <div className={recents.length > 0 ? "grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)]" : "grid gap-5"}>
            {recents.length > 0 && (
              <RecentProblems
                recents={recents}
                onSelect={handleRecentSelect}
                onClear={() => setRecents([])}
              />
            )}
            <div className="min-w-0">
              <ProblemBlock problem={problem} />
            </div>
          </div>
        </main>

        <ExplanationPanel />
      </div>
    </HoverProvider>
  );
}
