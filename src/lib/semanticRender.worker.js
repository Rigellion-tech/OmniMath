import { serializeSemanticTreeToLatex } from "./semanticMathRenderer.js";

self.onmessage = ({ data: { id, tree } }) => {
  try {
    const started = performance.now();
    const value = serializeSemanticTreeToLatex(tree);
    self.postMessage({ id, value, durationMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
