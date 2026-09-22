import React, { useCallback, useEffect, useRef, useState } from "react";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { Ellipsis, FileText, Loader2 } from "lucide-react";

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
  const [error, setError] = useState("");
  const menuRef = useRef(null);

  const capture = async () => {
    const el = targetRef.current;
    return await html2canvas(el, {
      backgroundColor: "#061116",
      scale: 2,
      useCORS: true,
      logging: false,
    });
  };

  const runExport = async (action) => {
    setMenuOpen(false);
    setLoading(true);
    setError("");
    try {
      await action();
    } catch (exportError) {
      console.error("OmniMath export failed", exportError);
      setError("Export failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const exportPNG = () => runExport(async () => {
    const canvas = await capture();
    const link = document.createElement("a");
    link.download = `${filename}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  const exportPDF = () => runExport(async () => {
    const canvas = await capture();
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width / 2, canvas.height / 2],
    });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);
    pdf.save(`${filename}.pdf`);
  });

  const exportMarkdown = useCallback(() => {
    setMenuOpen(false);
    downloadText(`${filename}.md`, buildMarkdownExport(problem, pinnedWindows));
  }, [filename, pinnedWindows, problem]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const exportActions = [
    { label: "Save as Markdown", action: exportMarkdown, icon: FileText },
    { label: "Save as PNG", action: exportPNG },
    { label: "Save as PDF", action: exportPDF },
  ];

  const handleToggle = () => {
    if (!loading) setMenuOpen((value) => !value);
  };

  useEffect(() => {
    const handleExportRequest = () => exportMarkdown();
    window.addEventListener("omnimath:export-session", handleExportRequest);
    return () => window.removeEventListener("omnimath:export-session", handleExportRequest);
  }, [exportMarkdown]);

  return (
    <div ref={menuRef} className="relative" data-testid="export-menu">
      <button
        type="button"
        onClick={handleToggle}
        aria-label="Session actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={loading}
        className="omni-button flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-200"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ellipsis className="h-4 w-4" />}
      </button>

      {menuOpen && (
        <div className="omni-panel absolute right-0 z-50 mt-2 flex min-w-44 flex-col overflow-hidden rounded-2xl p-1.5" role="menu" aria-label="Session actions">
            {exportActions.map(({ label, action, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={action}
                role="menuitem"
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-200/80 transition-colors hover:bg-white/[0.06]"
              >
                {Icon && <Icon className="h-3.5 w-3.5 text-teal-200/70" />}
                {label}
              </button>
            ))}
        </div>
      )}
      {error && <p className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-rose-300/20 bg-[#160c12] px-3 py-2 text-xs text-rose-100" role="alert">{error}</p>}
    </div>
  );
}
