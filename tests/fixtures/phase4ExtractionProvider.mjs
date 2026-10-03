export const shortImageExtraction = Object.freeze({
  extractedProblemLatex: "x^2+5x+6=0",
  extractedProblemText: "Solve x squared plus 5x plus 6 equals zero.",
  confidence: 96,
  issues: [],
});

const denseTerms = Array.from({ length: 72 }, (_, index) => (
  `a_{${index + 1}}x^{${index + 2}}`
));

export const denseMultilineImageExtraction = Object.freeze({
  extractedProblemLatex: String.raw`\begin{aligned}${denseTerms.slice(0, 24).join("+")} &= 0\\${denseTerms.slice(24, 48).join("+")} &= 1\\${denseTerms.slice(48).join("+")} &= 2\end{aligned}`,
  extractedProblemText: `Solve the multiline system: ${denseTerms.join(" plus ")}. Preserve all three right-hand sides.`,
  confidence: 88,
  issues: [{
    type: "dense_multiline_layout",
    message: "Review the three line breaks and right-hand sides.",
    severity: "medium",
  }],
});

export const nearBudgetImageExtraction = Object.freeze({
  extractedProblemLatex: String.raw`\sum_{k=1}^{240} \frac{(-1)^{k+1}}{k^2+x_k^2}=\int_0^1 \prod_{j=1}^{120}(1+t^j)\,dt`,
  extractedProblemText: "Evaluate the displayed finite-index expression while preserving every summation and product bound.",
  confidence: 91,
  issues: [],
});

export const truncatedImageExtractionJson = '{"extractedProblemLatex":"\\\\int_0^1 x^2\\\\,dx","extractedProblemText":"Integrate x squared from zero to one","confidence":92,"issues":[{"type":"bounds","message":"The upper bound';

export const malformedCompleteImageExtractionJson = '{"extractedProblemLatex":,"extractedProblemText":"Solve x equals one","confidence":90,"issues":[]}';

export const schemaInvalidImageExtractionJson = JSON.stringify({
  extractedProblemLatex: "x=1",
  confidence: 90,
  issues: [],
});
