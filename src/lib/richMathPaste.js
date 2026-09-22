const UNSUPPORTED_MATH_MESSAGE = "This formatted math has no editable LaTeX source. Copy the expression as LaTeX, then paste it using Advanced LaTeX.";

function escapeText(text) {
  return [...text].map((character) => {
    if (character === "\\") return "\\textbackslash{}";
    if (character === "^") return "\\textasciicircum{}";
    if (character === "~") return "\\textasciitilde{}";
    return /[{}$&#_%]/.test(character) ? `\\${character}` : character;
  }).join("");
}

function recoverAnnotatedMath(root) {
  const parts = [];
  let sawMath = false;
  let unsupported = false;

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ");
      if (text.trim()) parts.push({ type: "text", value: text });
      else if (text && parts.length) parts.push({ type: "space" });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const name = node.localName.toLowerCase();
    if (["script", "style", "svg"].includes(name)) return;
    if (name === "br") {
      if (parts.length) parts.push({ type: "space" });
      return;
    }
    const isMath = name === "math" || name === "annotation" || node.classList?.contains("katex") || node.classList?.contains("katex-html");
    if (isMath) {
      sawMath = true;
      const annotation = name === "annotation" ? node : node.querySelector('annotation[encoding="application/x-tex"]');
      const latex = annotation?.getAttribute("encoding")?.toLowerCase() === "application/x-tex" ? annotation.textContent.trim() : "";
      if (latex) parts.push({ type: "math", value: latex });
      else unsupported = true;
      return;
    }
    const block = ["p", "div", "li", "section", "article"].includes(name);
    if (block && parts.length) parts.push({ type: "space" });
    for (const child of node.childNodes) visit(child);
    if (block && parts.length) parts.push({ type: "space" });
  }

  visit(root);
  if (!sawMath) return { kind: "plain" };
  if (unsupported) return { kind: "error", message: UNSUPPORTED_MATH_MESSAGE };

  const latex = parts.map((part, index) => {
    if (part.type === "math") return part.value;
    if (part.type === "space") {
      const before = parts.slice(0, index).some((item) => item.type !== "space");
      const after = parts.slice(index + 1).some((item) => item.type !== "space");
      return before && after ? "\\," : "";
    }
    const text = part.value.trim();
    const leading = /^\s/.test(part.value) && index > 0 ? "\\," : "";
    const trailing = /\s$/.test(part.value) && index < parts.length - 1 ? "\\," : "";
    return `${leading}\\text{${escapeText(text)}}${trailing}`;
  }).reduce((source, fragment) => {
    // Separate a trailing control word from a Latin token in the next math node.
    if (/\\[A-Za-z]+$/.test(source) && /^[A-Za-z]/.test(fragment)) return `${source}{}${fragment}`;
    return source + fragment;
  }, "");
  return { kind: "latex", latex };
}

/** Recover semantic source from formatted clipboard math without flattening its visual DOM. */
export function readRichMathPaste(clipboardData) {
  if (!clipboardData) return { kind: "plain" };
  // MathLive's own rich clipboard formats carry its complete atom/LaTeX source.
  if (["application/json+mathlive", "application/x-latex"].some((type) => clipboardData.getData(type))) {
    return { kind: "native" };
  }
  const tex = clipboardData.getData("application/x-tex");
  if (tex?.trim()) return { kind: "latex", latex: tex.trim() };

  let htmlResult = { kind: "plain" };
  const html = clipboardData.getData("text/html");
  if (html) {
    htmlResult = recoverAnnotatedMath(new DOMParser().parseFromString(html, "text/html").body);
    if (htmlResult.kind === "latex") return htmlResult;
  }
  const mathml = clipboardData.getData("application/mathml+xml");
  if (mathml) {
    const document = new DOMParser().parseFromString(mathml, "application/xml");
    if (document.querySelector("parsererror")) return htmlResult.kind === "error" ? htmlResult : { kind: "error", message: UNSUPPORTED_MATH_MESSAGE };
    const result = recoverAnnotatedMath(document.documentElement);
    if (result.kind === "latex") return result;
    return htmlResult.kind === "error" ? htmlResult : { kind: "error", message: UNSUPPORTED_MATH_MESSAGE };
  }
  return htmlResult;
}
