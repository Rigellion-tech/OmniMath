const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_TEXT_CHARS = 12000;

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
    ? `The attached image may contain the problem. Use this student text as context: "${problem}".`
    : `Student problem: "${problem}".`;

  return `You are OmniMath, a careful AI math tutor.

${conversationBlock}${sourceInstruction}

Generate a structured explanation that can power an interactive math UI.

Return only JSON matching the provided schema:
- title: short problem type, such as "Differentiate", "Solve Equation", "Evaluate Integral".
- originalProblem: the student's original text, or your best transcription from the image.
- expression: the central expression in valid LaTeX, compatible with inline KaTeX rendering.
- finalAnswer: the final answer in valid LaTeX or concise mathematical text.
- explanations: beginner, intermediate, and advanced summaries for the whole solution.
- steps: 4-7 solution steps from setup to final answer.
- each step must include id, label, math, summary, and chunks.
- chunks are the legacy UI token list. Each chunk needs id, display, short, medium, deep.
- tokens: a flat list of all token/chunk explanations, each with id, stepId, display, label, and explanations.beginner/intermediate/advanced.

Compatibility rules:
- Every token id must match exactly one step chunk id.
- For each chunk, set short to the token label, medium to the intermediate explanation, and deep to the advanced explanation.
- Keep display values short: one symbol, operator, term, or small expression per token.
- Use unique ids in the format s{stepIndex}-c{chunkIndex}.
- Be mathematically correct, concise, and pedagogical.
- If the user is asking a follow-up, use the conversation context to update the solution while still returning a complete standalone explanation.`;
}
