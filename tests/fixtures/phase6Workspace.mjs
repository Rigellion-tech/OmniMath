import { annotateMathExplanation } from "../../server/mathAnnotator.js";
import { submitCurrentComposer } from "../helpers/submitCurrentComposer.mjs";

export const PHASE6_PROBLEM = "Explain a+b+c=6 and verify the contribution of each term.";

const DENSE_EXPRESSIONS = [
  String.raw`a+b+c=6`,
  String.raw`\int_0^1 \frac{x^{n-1}}{1+x}\,dx`,
  String.raw`\nabla\times\mathbf F=\begin{vmatrix}\mathbf i&\mathbf j&\mathbf k\\\partial_x&\partial_y&\partial_z\\P&Q&R\end{vmatrix}`,
  String.raw`A=\begin{bmatrix}\alpha_{11}+\beta_{11}&\alpha_{12}+\beta_{12}&\alpha_{13}+\beta_{13}\\\alpha_{21}+\beta_{21}&\alpha_{22}+\beta_{22}&\alpha_{23}+\beta_{23}\end{bmatrix}`,
  String.raw`\sum_{k=0}^{N}\binom Nk p^k(1-p)^{N-k}=1`,
  String.raw`\frac{\partial}{\partial t}\int_{\Omega(t)}u\,dV=\int_{\Omega(t)}(\partial_tu+\nabla\cdot(u\mathbf v))\,dV`,
];

export function makePhase6WorkspaceSolution() {
  return annotateMathExplanation({
    title: "Three-term workspace",
    problem: PHASE6_PROBLEM,
    originalProblem: PHASE6_PROBLEM,
    expression: DENSE_EXPRESSIONS[0],
    steps: Array.from({ length: 18 }, (_, index) => ({
      id: index === 0 ? "phase6-anchor-step" : `phase6-dense-step-${index}`,
      label: index === 0 ? "Inspect the three terms" : `Check dense expression ${index}`,
      math: DENSE_EXPRESSIONS[index % DENSE_EXPRESSIONS.length],
      summary: index === 0
        ? "Each named term remains independently inspectable."
        : "This dense step keeps the document tall and exercises semantic geometry.",
    })),
    finalAnswerLatex: String.raw`a+b+c=6`,
  });
}

/**
 * Installs a browser-native, incrementally scheduled SSE response. Playwright
 * route fulfillment buffers bodies, so the follow-up endpoint is intercepted
 * inside the page while every other fixture remains a normal page route.
 */
export async function installPhase6WorkspaceFixture(page, {
  terminalMs = 1800,
  tokenIntervalMs = 80,
  repeatAnswer = 1,
  answerText = "",
} = {}) {
  const solution = makePhase6WorkspaceSolution();

  await page.addInitScript(({ configuredTerminalMs, configuredTokenIntervalMs, configuredRepeatAnswer, configuredAnswerText }) => {
    const nativeFetch = window.fetch.bind(window);
    window.__PHASE6_STREAM_MODE__ = "success";
    window.__PHASE6_FOLLOWUP_CALLS__ = [];
    window.__PHASE6_STREAM_TIMELINE__ = [];
    window.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || String(input);
      if (!url.includes("/api/explain-followup")) return nativeFetch(input, init);

      const rawBody = init?.body ?? (typeof input !== "string" ? await input.clone().text() : "{}");
      const body = JSON.parse(String(rawBody || "{}"));
      const modeValue = window.__PHASE6_STREAM_MODE__;
      const mode = typeof modeValue === "function" ? modeValue(body) : modeValue || "success";
      const call = { body, mode, startedAt: performance.now() };
      window.__PHASE6_FOLLOWUP_CALLS__.push(call);
      const identity = {
        requestId: body.requestId,
        conversationId: body.conversationId,
        targetRevision: mode === "mismatch" ? `${body.targetRevision}-stale` : body.targetRevision,
      };
      const subject = body.provenanceSnapshot?.target?.sourceText
        || body.selectedLatex || body.selectedText || body.problem || "the selected mathematics";
      const sentence = `Streamed explanation: ${body.question} The relevant object is ${subject}.`;
      const answer = configuredAnswerText || Array.from({ length: configuredRepeatAnswer }, () => sentence).join(" ");
      const words = answer.match(/\S+\s*/g) || [answer];
      const signal = init?.signal || (typeof input !== "string" ? input.signal : null);
      let closed = false;
      const timers = [];
      const encoder = new TextEncoder();
      const frame = (event) => encoder.encode(`data: ${JSON.stringify({ ...identity, ...event })}\n\n`);
      const stream = new ReadableStream({
        start(controller) {
          const schedule = (delay, callback) => {
            const timer = window.setTimeout(() => {
              if (!closed) callback();
            }, delay);
            timers.push(timer);
          };
          const emit = (event) => {
            window.__PHASE6_STREAM_TIMELINE__.push({
              conversationId: identity.conversationId,
              type: event.type,
              at: performance.now(),
            });
            controller.enqueue(frame(event));
          };
          schedule(0, () => emit({ type: "generating" }));
          if (mode === "mismatch") {
            schedule(configuredTokenIntervalMs, () => emit({ type: "delta", delta: "stale response" }));
            return;
          }
          words.forEach((word, index) => schedule(
            configuredTokenIntervalMs * (index + 1),
            () => emit({ type: "delta", delta: word })
          ));
          if (mode === "error") {
            schedule(Math.max(320, configuredTokenIntervalMs * 4), () => {
              emit({ type: "error", code: "PHASE6_FIXTURE_ERROR", message: "Fixture stream failed after partial text." });
              closed = true;
              controller.close();
            });
            return;
          }
          if (mode !== "timeout") {
            schedule(Math.max(configuredTerminalMs, configuredTokenIntervalMs * (words.length + 1)), () => {
              emit({ type: "complete", answer });
              closed = true;
              controller.close();
            });
          }
          signal?.addEventListener("abort", () => {
            if (closed) return;
            closed = true;
            timers.forEach(window.clearTimeout);
            controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
        cancel() {
          closed = true;
          timers.forEach(window.clearTimeout);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    };
  }, {
    configuredTerminalMs: terminalMs,
    configuredTokenIntervalMs: tokenIntervalMs,
    configuredRepeatAnswer: repeatAnswer,
    configuredAnswerText: answerText,
  });

  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route("**/api/explain", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...solution,
      usage: { tier: "test", kind: "explanation", used: 1, remaining: 99, limit: 100 },
    }),
  }));
  const explainTarget = (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: `Term ${body.selectedLatex || body.selectedText || "object"}`,
        explanation: `Pinned explanation for ${body.selectedLatex || body.selectedText || "this object"}.`,
        semanticId: body.semanticId,
        targetId: body.targetId,
      }),
    });
  };
  await page.route("**/api/explain-token", explainTarget);
  await page.route("**/api/explain-pin", explainTarget);
}

export async function openPhase6Workspace(page, options) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installPhase6WorkspaceFixture(page, options);
  await page.goto("/?mockAuth=1");
  await submitCurrentComposer(page, PHASE6_PROBLEM);
  await page.getByRole("button", { name: /Inspect the three terms/i }).scrollIntoViewIfNeeded();
  await expectSemanticReady(page);
}

async function expectSemanticReady(page) {
  await page.locator(".omni-solution-flow .step-card").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll(".omni-solution-flow [data-inspectable='math-subtoken']").length > 0);
  await page.waitForFunction(() => (window.__OMNIMATH_GEOMETRY_SCHEDULER__?.pending || 0) === 0);
}

export async function phase6Target(page, symbol) {
  const step = page.locator(".step-card", { has: page.getByRole("button", { name: /Inspect the three terms/i }) });
  const target = step.locator(`[data-inspectable='math-subtoken'][data-token-latex='${symbol}']`).first();
  await target.waitFor({ state: "visible" });
  const semanticId = await target.getAttribute("data-semantic-id");
  if (!semanticId) throw new Error(`No semantic identity found for ${symbol}`);
  return { target, semanticId };
}

export async function pinPhase6Target(page, symbol) {
  const { target, semanticId } = await phase6Target(page, symbol);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`No target box found for ${symbol}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const card = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await card.waitFor({ state: "visible" });
  return { card, semanticId, target };
}

export async function openLensConversation(card) {
  const input = card.getByPlaceholder("Ask about this");
  if (!(await input.isVisible().catch(() => false))) {
    await card.getByRole("button", { name: "Ask follow-up" }).click();
  }
  await input.waitFor({ state: "visible" });
  return input;
}

export async function setPhase6StreamMode(page, mode) {
  await page.evaluate((nextMode) => { window.__PHASE6_STREAM_MODE__ = nextMode; }, mode);
}
