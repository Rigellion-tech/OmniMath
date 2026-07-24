function safeString(value = "") {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUnicodeMath(value = "") {
  return safeString(value)
    .replace(/π/g, "\\pi")
    .replace(/θ/g, "\\theta")
    .replace(/φ/g, "\\phi")
    .replace(/ρ/g, "\\rho")
    .replace(/δ/g, "\\delta")
    .replace(/α/g, "\\alpha")
    .replace(/β/g, "\\beta")
    .replace(/γ/g, "\\gamma")
    .replace(/λ/g, "\\lambda")
    .replace(/μ/g, "\\mu")
    .replace(/σ/g, "\\sigma")
    .replace(/ω/g, "\\omega")
    .replace(/∞/g, "\\infty");
}

export function normalizeGeneratedMathSource(value = "") {
  let text = normalizeUnicodeMath(value)
    .replace(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    const next = text
      .replace(/^\\\(([\s\S]*)\\\)$/u, "$1")
      .replace(/^\\\[([\s\S]*)\\\]$/u, "$1")
      .replace(/^\$\$([\s\S]*)\$\$$/u, "$1")
      .replace(/^\$([\s\S]*)\$$/u, "$1")
      .trim();
    if (next !== text) {
      text = next;
      changed = true;
    }
  }
  return text;
}

function inlineMathFragments(value = "") {
  const text = normalizeUnicodeMath(value);
  const fragments = [];
  const patterns = [
    /\\\(([\s\S]*?)\\\)/gu,
    /\\\[([\s\S]*?)\\\]/gu,
    /\$\$([\s\S]*?)\$\$/gu,
    /(^|[^$])\$([^$\n]+?)\$/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const fragment = normalizeGeneratedMathSource(match[2] || match[1]);
      if (fragment) fragments.push(fragment);
    }
  }
  return fragments;
}

function equationLikeFragments(value = "") {
  const text = normalizeUnicodeMath(value)
    .replace(/\\(?:quad|qquad|,|;|!| )/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || inlineMathFragments(text).length > 0) return [];
  const fragments = [];
  const variable = String.raw`(?:\\?(?:alpha|beta|gamma|delta|epsilon|theta|phi|rho|lambda|mu|sigma|omega)|[A-Za-z])`;
  const equationPattern = new RegExp(String.raw`(${variable}\s*(?::=|=)\s*[^,.;\n]+)`, "giu");
  for (const match of text.matchAll(equationPattern)) {
    const fragment = normalizeGeneratedMathSource(match[1]);
    if (fragment && /(?:=|:=)/u.test(fragment)) fragments.push(fragment);
  }
  return fragments;
}

function proseMathFragments(value = "") {
  return [...inlineMathFragments(value), ...equationLikeFragments(value)];
}

function addField(fields, {
  fieldPath,
  value,
  rawValue = value,
  sourceType = "math",
  stepIndex = null,
  lineIndex = null,
  anchorIndex = null,
  finalAnswer = false,
} = {}) {
  const normalized = normalizeGeneratedMathSource(value);
  if (!normalized) return;
  fields.push({
    fieldPath,
    value: normalized,
    normalized,
    rawValue,
    sourceType,
    stepIndex,
    lineIndex,
    anchorIndex,
    finalAnswer,
  });
}

function addProseFields(fields, { basePath, value, sourceType, stepIndex = null } = {}) {
  const rawValue = safeString(value);
  if (!rawValue) return;
  proseMathFragments(rawValue).forEach((fragment, index) => {
    addField(fields, {
      fieldPath: `${basePath}${index > 0 ? `#math[${index}]` : ""}`,
      value: fragment,
      rawValue,
      sourceType,
      stepIndex,
    });
  });
}

export function collectGeneratedMath(result = {}, {
  includeStepProseMath = true,
  includeAnchors = true,
  includeFinalAnswer = true,
} = {}) {
  const fields = [];
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  for (const [stepIndex, step] of steps.entries()) {
    if (includeStepProseMath) {
      for (const field of ["label", "title", "heading", "summary", "reasoning", "plainExplanation"]) {
        addProseFields(fields, {
          basePath: `steps[${stepIndex}].${field}`,
          value: step?.[field],
          sourceType: field,
          stepIndex,
        });
      }
    }
    for (const field of ["math", "latex", "equationLatex"]) {
      if (typeof step?.[field] === "string" && step[field].trim()) {
        addField(fields, {
          fieldPath: `steps[${stepIndex}].${field}`,
          value: step[field],
          sourceType: field,
          stepIndex,
        });
      }
    }
    for (const [lineIndex, line] of (Array.isArray(step?.lines) ? step.lines : []).entries()) {
      for (const field of ["latex", "math", "equationLatex"]) {
        if (typeof line?.[field] === "string" && line[field].trim()) {
          addField(fields, {
            fieldPath: `steps[${stepIndex}].lines[${lineIndex}].${field}`,
            value: line[field],
            sourceType: `lines[].${field}`,
            stepIndex,
            lineIndex,
          });
        }
      }
    }
    if (includeAnchors) {
      for (const [anchorIndex, anchor] of (Array.isArray(step?.anchors) ? step.anchors : []).entries()) {
        for (const field of ["latex", "targetLatex", "math"]) {
          if (typeof anchor?.[field] === "string" && anchor[field].trim()) {
            addField(fields, {
              fieldPath: `steps[${stepIndex}].anchors[${anchorIndex}].${field}`,
              value: anchor[field],
              sourceType: `anchors[].${field}`,
              stepIndex,
              anchorIndex,
            });
          }
        }
      }
    }
  }
  if (includeFinalAnswer && (result?.finalAnswerLatex || result?.finalAnswer)) {
    addField(fields, {
      fieldPath: result?.finalAnswerLatex ? "finalAnswerLatex" : "finalAnswer",
      value: result.finalAnswerLatex || result.finalAnswer,
      sourceType: "finalAnswer",
      finalAnswer: true,
    });
  }
  return fields;
}

export function generatedMathText(result = {}, options = {}) {
  return collectGeneratedMath(result, options).map((field) => field.normalized).join(" ");
}
