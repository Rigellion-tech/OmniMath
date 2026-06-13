import React, { useCallback, useEffect, useState } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { Download, FileText, Loader2 } from "lucide-react";

function downloadText(filename, content, type = "text/markdown") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

function formatWindowContent(window) {
  const content = window.content || {};
  return content[window.depth] || content.intermediate || content.beginner || window.title || "";
}

function buildMarkdownExport(problem, pinnedWindows = []) {
  const steps = problem?.steps || [];
  const lines = [
    `# ${problem?.title || "OmniMath Session"}`,
    "",
  ];

  if (problem?.originalProblem) {
    lines.push("## Problem", "", problem.originalProblem, "");
  }

  if (problem?.expression) {
    lines.push("## Expression", "", `\`${problem.expression}\``, "");
  }

  if (steps.length > 0) {
    lines.push("## Steps", "");
    steps.forEach((step, index) => {
      const expression = step.math || step.chunks?.map((chunk) => chunk.display).join(" ") || "";
      lines.push(`### ${index + 1}. ${step.label || "Step"}`);
      if (expression) lines.push("", `\`${expression}\``);
      if (step.summary) lines.push("", step.summary);
      lines.push("");
    });
  }

  if (problem?.finalAnswer) {
    lines.push("## Final Answer", "", `\`${problem.finalAnswer}\``, "");
  }

  if (pinnedWindows.length > 0) {
    lines.push("## Pinned Explanations", "");
    pinnedWindows.forEach((window, index) => {
      lines.push(`### ${index + 1}. ${window.title || "Explanation"}`);
      if (window.display) lines.push("", `\`${window.display}\``);
      lines.push("", `Depth: ${window.depth || "intermediate"}`, "", formatWindowContent(window), "");
    });
  }

  return `${lines.join("\n").trim()}\n`;
}

export default function ExportButton({
  targetRef,
  filename = "math-problem",
  problem,
  pinnedWindows = [],
}) {
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const capture = async () => {
    const el = targetRef.current;
    return await html2canvas(el, {
      backgroundColor: "#061116",
      scale: 2,
      useCORS: true,
      logging: false,
    });
  };

  const exportPNG = async () => {
    setMenuOpen(false);
    setLoading(true);
    const canvas = await capture();
    const link = document.createElement("a");
    link.download = `${filename}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    setLoading(false);
  };

  const exportPDF = async () => {
    setMenuOpen(false);
    setLoading(true);
    const canvas = await capture();
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width / 2, canvas.height / 2],
    });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);
    pdf.save(`${filename}.pdf`);
    setLoading(false);
  };

  const exportMarkdown = useCallback(() => {
    setMenuOpen(false);
    downloadText(`${filename}.md`, buildMarkdownExport(problem, pinnedWindows));
  }, [filename, pinnedWindows, problem]);

  useEffect(() => {
    const handleExportRequest = () => exportMarkdown();
    window.addEventListener("omnimath:export-session", handleExportRequest);
    return () => window.removeEventListener("omnimath:export-session", handleExportRequest);
  }, [exportMarkdown]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setMenuOpen((value) => !value)}
        disabled={loading}
        className="omni-button flex min-h-10 items-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Export
      </button>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="omni-panel absolute right-0 z-50 mt-2 flex min-w-36 flex-col overflow-hidden rounded-2xl p-1.5">
            {[
              { label: "Save as Markdown", action: exportMarkdown, icon: FileText },
              { label: "Save as PNG", action: exportPNG },
              { label: "Save as PDF", action: exportPDF },
            ].map(({ label, action, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={action}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-200/80 transition-colors hover:bg-white/[0.06]"
              >
                {Icon && <Icon className="h-3.5 w-3.5 text-teal-200/70" />}
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
