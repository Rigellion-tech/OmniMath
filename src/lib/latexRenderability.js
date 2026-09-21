import katex from "katex";

// These are TeX structures whose backslashes and whitespace have presentation
// meaning. Plain math such as `1/2` still goes through OmniMath's text-to-math
// converter, even though KaTeX can render it literally.
const EXPLICIT_TEX_STRUCTURE = /\\begin\s*\{|\\end\s*\{|\\\\|\\[ ,;!:{}()[\]\\]|\\(?:left|right|middle|newline|quad|qquad)\b|\\[A-Za-z]+\s*\{|\\(?:frac|sqrt)\b|(?:^|[^A-Za-z\\])[A-Za-z]\s*\(|\([^()\n]*,[^()\n]*\)|\[[^\[\]\n]*,[^\[\]\n]*\]/u;

export function isExplicitLatex(value = "") {
  return EXPLICIT_TEX_STRUCTURE.test(String(value || ""));
}

export function katexParsesLatex(value = "", { displayMode = true } = {}) {
  const source = String(value || "");
  if (!source.trim()) return false;
  try {
    katex.renderToString(source, {
      throwOnError: true,
      strict: "ignore",
      trust: false,
      displayMode,
    });
    return true;
  } catch {
    return false;
  }
}

export function isRenderableExplicitLatex(value = "", options = {}) {
  const source = String(value || "");
  // A leading run of doubled control-word slashes usually comes from JSON
  // escaping twice. KaTeX may render those as row breaks plus plain letters,
  // which would silently lose the mathematical commands.
  // A row break cannot begin a standalone math field with no preceding row.
  // Treat a leading doubled control word as a transport-escaped command even
  // when it is the only command in the field.
  if (/^\\\\[A-Za-z]{2,}/u.test(source)) return false;
  return isExplicitLatex(source) && katexParsesLatex(source, options);
}
