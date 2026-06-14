import assert from "node:assert/strict";
import test from "node:test";
import { validateExtraction } from "../server/extractionValidation.js";

test("valid vector calculus OCR extraction with powers is not low confidence", () => {
  const extractedProblemText = `Let S be the portion of the paraboloid z = 9 - x^2 - y^2 lying above the plane z = 0, oriented upward. Its boundary curve is C. Evaluate

∬_S (∇ × F) · n dS

where

F(x,y,z) =
< yz^2 + e^(x^2) sin(y),
  x^3 z + ln(1 + z^2),
  x y^2 + z cos(xy) >`;

  const extractedProblemLatex = String.raw`\begin{aligned}
&\text{Let } S \text{ be the portion of } z = 9 - x^2 - y^2 \text{ lying above } z = 0 \text{, oriented upward. Its boundary curve is } C.\\
&\text{Evaluate } \iint_S (\nabla \times \mathbf{F}) \cdot \mathbf{n}\, dS,\\
&\text{where } \mathbf{F}(x,y,z) =
\left\langle
yz^2 + e^{x^2}\sin(y),
x^3 z + \ln(1 + z^2),
x y^2 + z\cos(xy)
\right\rangle.
\end{aligned}`;

  const result = validateExtraction({
    extractedProblemText,
    extractedProblemLatex,
    ocrConfidence: 92,
    modelConfidence: 94,
    modelIssues: [],
  });

  assert.notEqual(result.tier, "low");
  assert.equal(result.critical, false);
  assert.equal(result.issues.some((issue) => issue.type === "many_superscripts"), false);
});
