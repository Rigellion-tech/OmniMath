import React, { useState, useRef } from "react";
import { HoverProvider } from "@/lib/HoverContext";
import ProblemBlock from "@/components/math/ProblemBlock";
import ExplanationPanel from "@/components/math/ExplanationPanel";
import ProblemInput from "@/components/math/ProblemInput";
import RecentProblems from "@/components/math/RecentProblems";
import ExportButton from "@/components/math/ExportButton";
import ImageUpload from "@/components/math/ImageUpload";
import { demoProblem } from "@/lib/mathData";

const BOARD_BG = "https://media.base44.com/images/public/69e14ba1cbd2bd63c17b7136/75b5f229b_generated_image.png";

export default function Home() {
  const [customProblem, setCustomProblem] = useState(null);
  const [recents, setRecents] = useState([]);
  const boardRef = useRef(null);

  const problem = customProblem ?? demoProblem;
  const providerKey = customProblem ? customProblem.expression : "default";

  const handleProblemGenerated = (data) => {
    setCustomProblem(data);
    setRecents((prev) => {
      const filtered = prev.filter((r) => r.expression !== data.expression);
      return [data, ...filtered].slice(0, 5);
    });
  };

  const handleRecentSelect = (data) => {
    setCustomProblem(data);
  };

  return (
    <HoverProvider key={providerKey}>
      <div
        className="min-h-screen w-full"
        style={{
          backgroundImage: `url(${BOARD_BG})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundColor: "#162028",
        }}
      >
        {/* Top bar */}
        <div
          className="flex flex-col gap-2 px-5 py-2"
          style={{ borderBottom: "1px solid rgba(34,211,238,0.1)" }}
        >
          {/* Row 1: branding + hint */}
          <div className="flex items-center justify-between">
            <span className="font-sans font-medium tracking-[0.25em] uppercase" style={{ fontSize: 11, color: "rgba(150,210,220,0.45)" }}>
              Universal Math Explainer
            </span>
            <div className="flex items-center gap-3">
              <ExportButton targetRef={boardRef} filename={problem.title.toLowerCase().replace(/\s+/g, "-")} />
              <span className="font-sans" style={{ fontSize: 11, color: "rgba(150,210,220,0.3)" }}>
                Hover · Right-click to pin
              </span>
            </div>
          </div>

          {/* Row 2: input + preset tabs */}
          <div className="flex items-center gap-3" style={{ marginRight: 316 }}>
            <div className="flex-1">
              <ProblemInput onProblemGenerated={handleProblemGenerated} />
            </div>
            <ImageUpload onProblemGenerated={handleProblemGenerated} />
          </div>
        </div>

        {/* Main content */}
        <div ref={boardRef} className="flex gap-4 px-5 pt-4 pb-8" style={{ marginRight: 316 }}>
          {/* Recent problems sidebar */}
          {recents.length > 0 && (
            <div className="w-44 shrink-0">
              <RecentProblems
                recents={recents}
                onSelect={handleRecentSelect}
                onClear={() => setRecents([])}
              />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <ProblemBlock problem={problem} />
          </div>
        </div>

        {/* Fixed explanation panel */}
        <ExplanationPanel />
      </div>
    </HoverProvider>
  );
}