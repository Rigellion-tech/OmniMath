function normalizeComposerText(value = "") {
  return String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Keep the editable source separate from its human-facing rendering. MathLive
 * owns visual LaTeX serialization; this function only combines it with the
 * optional prose prompt at the existing canonical ProblemInput boundary.
 */
export function serializePrimaryComposer({
  prose = "",
  visualLatex = "",
  rawLatex = "",
  sourceMode = "visual",
} = {}) {
  const canonicalLatex = normalizeComposerText(sourceMode === "raw" ? rawLatex : visualLatex);
  const canonicalProse = normalizeComposerText(prose);
  const canonicalText = [canonicalProse, canonicalLatex].filter(Boolean).join("\n\n");

  return {
    canonicalText,
    canonicalLatex,
    displayText: canonicalProse,
    sourceMode: sourceMode === "raw" ? "raw" : "visual",
    isEmpty: !canonicalText,
  };
}

export function restorePrimaryComposerSource(problem = {}) {
  const canonicalProblem = problem?.canonicalProblem || {};
  const source = canonicalProblem.source || "";
  const canonicalLatex = String(canonicalProblem.canonicalLatex || "").trim();
  const canonicalText = String(
    canonicalProblem.canonicalText
      || problem?.originalProblem
      || problem?.problem
      || ""
  ).trim();

  if (source !== "typed") {
    return {
      prose: "",
      visualLatex: "",
      rawLatex: "",
      sourceMode: "visual",
      submitted: canonicalText
        ? { displayText: canonicalText, canonicalText, canonicalLatex, sourceMode: "external" }
        : null,
    };
  }

  if (!canonicalLatex) {
    return {
      prose: canonicalText,
      visualLatex: "",
      rawLatex: "",
      sourceMode: "visual",
      submitted: canonicalText
        ? { displayText: canonicalText, canonicalText, canonicalLatex: "", sourceMode: "visual" }
        : null,
    };
  }

  const latexSuffix = `\n\n${canonicalLatex}`;
  const prose = canonicalText.endsWith(latexSuffix)
    ? canonicalText.slice(0, -latexSuffix.length)
    : canonicalText === canonicalLatex ? "" : canonicalText;

  const savedMode = canonicalProblem.composerSourceMode === "visual" ? "visual" : "raw";
  return {
    prose,
    visualLatex: savedMode === "visual" ? canonicalLatex : "",
    rawLatex: canonicalLatex,
    sourceMode: savedMode,
    submitted: {
      displayText: prose,
      canonicalText,
      canonicalLatex,
      sourceMode: savedMode,
    },
  };
}
