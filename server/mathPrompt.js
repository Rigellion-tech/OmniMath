const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_TEXT_CHARS = 4000;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  let totalChars = 0;
  const sanitized = [];

  for (const item of history.slice(-MAX_HISTORY_ITEMS)) {
    if (!item || typeof item !== "object") continue;
    const role = item.role === "tutor" || item.role === "assistant" ? "tutor" : "student";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;

    totalChars += text.length;
    if (totalChars > MAX_HISTORY_TEXT_CHARS) break;
    sanitized.push({ role, text });
  }

  return sanitized;
}

export function buildMathExplanationPrompt({ problem, history = [], image = false }) {
  const sanitizedHistory = sanitizeHistory(history);
  const conversationBlock = sanitizedHistory.length
    ? `Previous conversation:\n${sanitizedHistory
        .map((message) => `${message.role === "student" ? "Student" : "Tutor"}: ${message.text}`)
        .join("\n")}\n\n`
    : "";

  const sourceInstruction = image
    ? `The attached image contains the math problem. First read the actual problem from the image, then solve that extracted problem. The student text is only context and must not be treated as the problem unless it matches the image: "${problem}".`
    : `Student problem: "${problem}".`;

  const outputContract = image
    ? `Image output contract:
- Return JSON matching the image schema exactly.
- extractedProblemLatex must be the actual math problem read from the image in clean valid LaTeX.
- extractedProblemText must be a plain-language transcription of the same image problem.
- Preserve superscripts, nested exponents, subscripts, and parentheses exactly as shown. Do not simplify, flatten, drop, or reinterpret powers while extracting.
- Examples that must remain distinct: e^{x^2}, e^{x^3}, x^3z, x^{10}, y^2z^2, and \\cos(xy).
- steps[].title must be a short step title.
- steps[].equationLatex must be the displayed equation for that step in pure valid LaTeX only.
- steps[].explanation must explain that step in one concise sentence.
- steps[].tokens must be an array. Use [] if token/subtoken extraction is not useful.
- finalAnswerLatex must obey the standalone-final-expression contract below.
- Do not return prose-only content. Do not solve the generic prompt text.`
    : `Text output contract:
- The problemLatex field must be the original problem in clean pure valid LaTeX only.
- Each steps[].latex field must contain pure valid LaTeX only.
- The finalAnswerLatex field must obey the standalone-final-expression contract below.
- Do not use the first step to restate problemLatex.`;

  return `You are OmniMath, a careful AI math tutor.

${conversationBlock}${sourceInstruction}

Generate only the solved problem in the compact JSON schema plus a tiny list of high-value hover anchors. Do not generate hover explanations, pin explanations, related concepts, rule tags, token metadata, subtokens, or alternative methods.

Quality rules:
- The steps array must contain 3-8 meaningful items for most solved problems. Never return more than 8 unless the problem truly requires it.
- Prefer 3-5 steps for simple problems, 4-7 for moderate problems, and 5-8 for advanced vector calculus.
- For equation solving, each displayed steps[].latex must be a direct algebraic transformation of the equation currently being solved.
- Explanatory facts and identity checks belong in steps[].reasoning, not as standalone displayed equations.
- Never insert a displayed equation that is only a fact about coefficients, such as 1936=44^2, 44^2=1936, or 2\\cdot44=88, unless that equation is itself the problem being solved.
- For perfect-square quadratics, prefer the shortest transformation chain: original equation, factored square equation, linear equation, final answer.
- Example style for x^2+88x+1936=0: steps[].latex should be x^2+88x+1936=0, then (x+44)^2=0, then x+44=0, then x=-44. Put "1936=44^2 and 88=2\\cdot44" only in reasoning.
- Do not display identity-conversion steps such as x^2+88x+44^2=(x+44)^2 as separate steps; use them only as reasoning for the factoring transformation.
- Each step must correspond to a mathematical transformation or theorem application: theorem application, parameterization, symmetry, coordinate transformation, integral evaluation, or verification.
- Consecutive algebra manipulations must be merged into one conceptual step.
- Avoid separate steps for substituting z=0, evaluating \\ln(1), evaluating \\sin(0), removing zero terms, or other trivial algebra.
- Every displayed equation must transform the active expression, not merely justify it.
- Every step must include an anchors array, even when empty.
- Generate at most 3 anchors per step and at most 20 anchors across the whole solution.
- Anchors should target actual confusion points: substitutions, changed bounds, identities, integration-by-parts choices, algebraic transformations, or non-obvious simplifications.
- Do not create anchors for isolated differentials, single variables, basic operators, parentheses, random English words, or rule labels such as Power/Product/Chain/Leibniz.
- Anchor latex must be an exact meaningful subexpression from the step latex when possible.
- Never include filler headings such as "Define integral", "State the integral", "Apply math", or a standalone differential like "dx".
- For Stokes/Green/curl problems, identify the oriented boundary and use \\iint_S (\\nabla\\times\\mathbf F)\\cdot\\mathbf n\\,dS=\\oint_C\\mathbf F\\cdot d\\mathbf r when applicable.
- For the paraboloid z=9-x^2-y^2 above z=0 with upward orientation, use C: x^2+y^2=9, z=0, counterclockwise viewed from above.
- For an upper cap or upward orientation, the positive boundary orientation is counterclockwise viewed from above.
- For Green's theorem on the ellipse x^2/4+y^2/9=1, use x=2r\\cos\\theta, y=3r\\sin\\theta, 0\\le r\\le1, 0\\le\\theta\\le2\\pi, with Jacobian 6r.
- Never discard derivative terms from non-polynomial fractions such as \\frac{\\cos(xy)}{1+x^2+y^2}. If a term vanishes by symmetry, explicitly prove the parity over the transformed domain.
- Do not claim "odd", "oscillatory", or "cancels by symmetry" unless the integrand and domain parity are shown in the same step.
- If the resulting Green's theorem disk integral has no elementary closed form, state the non-elementary integral instead of hallucinating a simple value.
- Do not introduce undefined placeholders such as G(r,\theta), H(x), "symmetric function", or "defined above" unless that placeholder is explicitly defined in the same displayed formula with the full real expression.
- finalAnswerLatex must contain the actual final integral expression or a numeric/exact value. It must not depend on undefined placeholder functions.
- Standalone-final-expression contract for finalAnswerLatex:
  - It must be exactly one standalone mathematical expression.
  - It may be either the exact final value or one equation assigning the original expression to that value.
  - It must contain no prose, explanation, intermediate derivation, \\Rightarrow, multiline content, display separators, or multiple unrelated equations.
  - Valid: \\frac{\\pi^3}{12}
  - Valid: \\int_0^\\infty f(x)\\,dx = \\frac{\\pi^3}{12}
  - Invalid: I'(1)=\\cdots \\\\ \\Rightarrow \\int_0^\\infty f(x)\\,dx=\\cdots
  - Invalid: Therefore the answer is \\frac{\\pi^3}{12}
  - Invalid: A=B,\\quad C=D
- Every displayed equation must be valid LaTeX.
- Math-rendered fields must contain only the LaTeX expression. Do not wrap math-rendered fields in Markdown fences, latex code blocks, \\[...\\], $$...$$, or $...$.
- Never put plain text inside math unless it is wrapped in \\text{}.
- Preserve spacing commands for differentials, such as \\,dx.
- Use proper LaTeX function names: \\ln, \\arctan, \\sin, \\cos, and so on.
- Use LaTeX commands instead of Unicode math symbols: \\int, \\iiint, \\nabla, \\cdot, \\times, \\le, \\ge, \\frac{}{}.
- Never omit required backslashes from LaTeX commands.
- ${outputContract}
- numericCheck should be a decimal approximation when applicable, or an empty string.
- Keep each reasoning field to 1-2 concise sentences, maximum 35 words.
- Do not restate the entire original problem inside step 1; start with the first meaningful transformation or theorem setup.
- Do not repeat long problem text in both problemLatex and steps[].latex.
- Simplify displayed equations before returning them: \\sin(0)=0, \\cos(0)=1, \\ln(1)=0, e^0=1, zero products vanish, and additive zero terms are removed.
- The final answer belongs in finalAnswerLatex and, if included in steps, only as one clearly titled "Final Answer" step at the end.
- For compact responses, the last step's latex is treated as finalAnswerLatex and must obey the same standalone-final-expression contract.
- For verification sections, use compact equations instead of prose-heavy derivations.
- Return JSON only. Do not include markdown, comments, code fences, or explanatory prose outside JSON.`;
}

export function buildImageExtractionPrompt({ problem }) {
  return `You are OmniMath's OCR validation reader.

The attached image contains a math problem. Extract only the problem. Do not solve it.
The student text is only context and must not be treated as the problem unless it matches the image: "${problem}".

Return JSON matching the extraction schema exactly.

Extraction rules:
- extractedProblemLatex must be the actual math problem read from the image in clean valid LaTeX.
- extractedProblemText must be a plain-language transcription of the same image problem.
- Preserve superscripts, nested exponents, subscripts, vector components, integral bounds, function arguments, parentheses, boundary terms, and orientation wording exactly as shown.
- Do not simplify, flatten, drop, infer, or reinterpret powers while extracting.
- Keep these distinct: e^{x^2}, e^{x^3}, x^3z, x^{10}, y^2z^2, and \\cos(xy).
- confidence must be an integer from 0 to 100 for the extraction only.
- issues must list any ambiguity that could change the solved problem, including unclear superscripts/subscripts, dropped parentheses, changed function arguments, vector component count uncertainty, unclear integral bounds, or theorem-sensitive boundary/orientation structure.
- Return JSON only. Do not include markdown, comments, code fences, or prose outside JSON.`;
}

export function buildTokenExplanationPrompt({
  problemContext,
  stepLatex,
  selectedLatex,
  parentExpression,
  stepHeading,
  mode = "hover",
}) {
  const isPin = mode === "pin";
  return `You are OmniMath, a concise math tutor.

Explain only the selected math chunk in its current solution context.

Problem context:
${problemContext || "Math problem"}

Current step heading:
${stepHeading || "Current step"}

Current step LaTeX:
${stepLatex}

Parent expression:
${parentExpression || stepLatex}

Selected chunk:
${selectedLatex}

Rules:
- Do not recompute the whole solution.
- Do not discuss unrelated tokens.
- Use valid LaTeX for formulas.
- ${isPin ? "Give a deeper explanation of why the chunk matters and how it connects to the step in 2-4 sentences." : "Keep the explanation to 1-3 short sentences."}
- Return JSON only with title and explanation.`;
}

export function buildCompareMethodsPrompt({ problemLatex, finalAnswerLatex, steps = [] }) {
  return `You are OmniMath, a careful AI math tutor.

Generate alternative solution methods only because the user clicked Compare Methods.

Problem:
${problemLatex}

Current final answer:
${finalAnswerLatex || "Unknown"}

Current solution outline:
${steps.map((step, index) => `${index + 1}. ${step.heading || step.label || step.title}: ${step.latex || step.math}`).join("\n")}

Rules:
- Do not repeat the same method.
- Provide 1-3 alternative methods.
- Keep each method concise and mathematically valid.
- Use valid LaTeX in points where useful.
- Return JSON only with methods[].`;
}
