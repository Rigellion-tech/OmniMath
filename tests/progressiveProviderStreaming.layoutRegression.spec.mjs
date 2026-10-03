import { expect, test } from "@playwright/test";

const fixtureBase = `http://127.0.0.1:${process.env.OMNIMATH_PROVIDER_FIXTURE_PORT || 4392}`;

async function configureScenario(request, scenario) {
  const response = await request.post(`${fixtureBase}/__fixture/scenario`, { data: { scenario } });
  expect(response.ok()).toBe(true);
}

async function fixtureState(request) {
  const response = await request.get(`${fixtureBase}/__fixture/state`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function installLazyExplanationRoutes(page) {
  for (const endpoint of ["explain-token", "explain-pin"]) {
    await page.route(`**/api/${endpoint}`, async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          title: `Fixture explanation for ${body.selectedLatex}`,
          explanation: `A controlled explanation for ${body.selectedLatex}.`,
          semanticId: body.semanticId,
          targetId: body.targetId,
        }),
      });
    });
  }
}

async function installWireObserver(page) {
  await page.addInitScript(() => {
    window.__OMNIMATH_PROVIDER_STREAM_EVENTS__ = [];
    window.__OMNIMATH_PROVIDER_STREAM_RESPONSE__ = null;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const requestUrl = String(args[0]?.url || args[0] || "");
      if (requestUrl.includes("/api/explain") && (response.headers.get("content-type") || "").includes("text/event-stream")) {
        window.__OMNIMATH_PROVIDER_STREAM_RESPONSE__ = {
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          contentEncoding: response.headers.get("content-encoding"),
          contentLength: response.headers.get("content-length"),
          transferEncoding: response.headers.get("transfer-encoding"),
        };
        const reader = response.clone().body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let pending = "";
          void (async () => {
            while (true) {
              const { value, done } = await reader.read();
              pending += decoder.decode(value || new Uint8Array(), { stream: !done });
              let boundary;
              while ((boundary = /\r?\n\r?\n/.exec(pending))) {
                const packet = pending.slice(0, boundary.index);
                pending = pending.slice(boundary.index + boundary[0].length);
                const data = packet.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
                if (data) {
                  try {
                    window.__OMNIMATH_PROVIDER_STREAM_EVENTS__.push({
                      ...JSON.parse(data),
                      __receivedAt: performance.now(),
                    });
                  }
                  catch { /* Ignore unrelated malformed packets in this observer. */ }
                }
              }
              if (done) break;
            }
          })();
        }
      }
      return response;
    };
  });
}

function stepCard(page, heading) {
  return page.locator(".step-card").filter({ has: page.getByRole("button", { name: heading, exact: true }) });
}

test("real backend stream renders and pins step one before the provider releases step two", async ({ page, request }, testInfo) => {
  await configureScenario(request, "success");
  await installLazyExplanationRoutes(page);
  await installWireObserver(page);
  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…").fill("Solve x+1=2, showing the algebra.");
  const requestStart = await page.evaluate(() => performance.now());
  await page.getByTestId("primary-composer-solve").click();

  const firstHeading = "Subtract 1 from both sides";
  const firstCard = stepCard(page, firstHeading);
  await expect(firstCard).toBeVisible();
  const firstStepVisibleMs = await page.evaluate((startedAt) => performance.now() - startedAt, requestStart);
  await expect(page.getByRole("button", { name: "Simplify both sides", exact: true })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .map((event) => event.type).slice(0, 3))).toEqual(["solve_started", "solution_metadata", "step_completed"]);
  const earlyEvents = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__.slice(0, 3));
  const firstStepEvent = earlyEvents.find((event) => event.type === "step_completed");
  const stepValidationToVisibleMs = firstStepVisibleMs
    - (firstStepEvent.__receivedAt - requestStart);
  expect(earlyEvents.map((event) => event.sequence)).toEqual([0, 1, 2]);
  expect(new Set(earlyEvents.map((event) => event.requestId)).size).toBe(1);
  const firstWireStep = firstStepEvent;
  expect(firstWireStep.stepIndex).toBe(0);
  expect(firstWireStep.validation).toMatchObject({ status: "accepted", authority: "server-provider-stream" });
  const staged = await fixtureState(request);
  expect(staged).toMatchObject({ providerRequests: 1, requestStream: true, model: "gpt-5.6-sol", emittedStepCount: 1, waitingForStep2: true, step2Released: false });
  // At this point the browser has consumed the validated first step while the
  // deterministic provider is still blocked before step two and terminal events.
  expect(earlyEvents.some((event) => event.type === "solve_completed" || event.type === "final_answer")).toBe(false);
  const streamResponse = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_RESPONSE__);
  expect(streamResponse).toMatchObject({ status: 200, cacheControl: "no-store, no-transform", contentLength: null });
  expect(streamResponse.contentType).toContain("text/event-stream");
  expect(streamResponse.contentEncoding).toBeNull();
  // HTTP/1.1 chunked transfer is expected for an open ended stream; the key
  // buffering regression is a fixed Content-Length or content compression.

  const firstTarget = firstCard.locator("[data-inspectable='math-subtoken']").first();
  await expect(firstTarget).toBeVisible();
  const semanticId = await firstTarget.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await expect(firstCard.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first()).toHaveAttribute("data-geometry-valid", "true");
  const stepPresentationTiming = await page.evaluate(() => window.__OMNIMATH_PROGRESSIVE_PRESENTATION__?.steps
    .find((entry) => entry.stepId === "provider-step-1") || null);
  expect(stepPresentationTiming?.eventToVisibleMs).toEqual(expect.any(Number));
  expect(stepPresentationTiming?.eventToHoverableMs).toEqual(expect.any(Number));
  await firstTarget.hover({ force: true });
  await expect(firstTarget).toHaveAttribute("data-active-target", "true");
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-semantic-id", semanticId);

  const box = await firstTarget.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const pinned = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await expect(pinned).toBeVisible();

  await page.evaluate(() => {
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_PERF__?.reset?.();
  });
  const released = await request.post(`${fixtureBase}/__fixture/release-step2`);
  expect(released.ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Simplify both sides", exact: true })).toBeVisible();
  await expect(firstTarget).toHaveAttribute("data-semantic-id", semanticId);
  await expect(pinned).toBeVisible();
  await expect(page.locator(".step-card[data-step-index='1']")).toContainText("x=1");
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .map((event) => event.type).slice(-2))).toEqual(["final_answer", "solve_completed"]);
  const incrementalCounters = await page.evaluate((previousStepId) => {
    const events = window.__OMNIMATH_HOVER_PERF__?.events || [];
    return {
      earlierStepRenders: events.filter((event) => event.event === "mathChunkRender" && event.stepId === previousStepId).length,
      newStepRenders: events.filter((event) => event.event === "mathChunkRender" && event.stepId === "provider-step-2").length,
      earlierStepGeometryMeasurements: events.filter((event) => event.event === "geometryMeasurement" && event.stepId === previousStepId).length,
      newStepGeometryMeasurements: events.filter((event) => event.event === "geometryMeasurement" && event.stepId === "provider-step-2").length,
      pointerResolves: events.filter((event) => event.event === "pointerResolve").length,
      pointerLayoutReads: events.filter((event) => event.event === "pointerResolveComplete")
        .reduce((total, event) => total + (Number(event.layoutReadCount) || 0), 0),
    };
  }, "provider-step-1");
  expect(incrementalCounters.newStepRenders).toBeGreaterThan(0);
  const longTasks = await page.evaluate(() => window.__OMNIMATH_PERF__?.longTasks || []);
  const browserMetrics = {
    firstStepVisibleMs,
    stepValidationToVisibleMs,
    eventToVisibleMs: stepPresentationTiming.eventToVisibleMs,
    eventToHoverableMs: stepPresentationTiming.eventToHoverableMs,
    earlierStepSemanticId: semanticId,
    oldStepRenders: incrementalCounters.earlierStepRenders,
    newStepRenders: incrementalCounters.newStepRenders,
    oldStepGeometryMeasurements: incrementalCounters.earlierStepGeometryMeasurements,
    newStepGeometryMeasurements: incrementalCounters.newStepGeometryMeasurements,
    pointerLayoutReads: incrementalCounters.pointerLayoutReads,
    pointerResolves: incrementalCounters.pointerResolves,
    longTaskCount: longTasks.length,
    longTasks,
  };
  await testInfo.attach("provider-stream-browser-metrics", {
    body: JSON.stringify(browserMetrics, null, 2),
    contentType: "application/json",
  });
  console.log("PROVIDER_STREAM_BROWSER_METRICS", JSON.stringify(browserMetrics));

  const finalState = await fixtureState(request);
  expect(finalState).toMatchObject({ emittedStepCount: 2, waitingForStep2: false, step2Released: true, providerRequests: 1 });
});

test("pre-prefix provider failure recovers inside one visible solve without publishing a failed draft", async ({ page, request }) => {
  await configureScenario(request, "recover-before-step1");
  await installLazyExplanationRoutes(page);
  await installWireObserver(page);
  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…")
    .fill("Solve x+1=2 and explain the subtraction in this recovery case.");
  await page.getByTestId("primary-composer-solve").click();

  await expect.poll(async () => (await fixtureState(request)).waitingForRecoveryStep1, { timeout: 30_000 }).toBe(true);
  const recovering = await fixtureState(request);
  expect(recovering).toMatchObject({
    scenario: "recover-before-step1", providerRequests: 2, emittedStepCount: 0,
    interruptedWithDraft: true, recoveryStep1Released: false,
  });
  await expect(page.getByRole("status").filter({ hasText: "Solving problem" }).first()).toBeVisible();
  await expect(page.locator(".step-card.notebook-step")).toHaveCount(0);
  await expect(page.getByText("failed draft", { exact: true })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .filter((event) => event.type === "solve_started").length)).toBe(1);
  const earlyEvents = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__);
  expect(earlyEvents.filter((event) => event.type === "solve_started")).toHaveLength(1);
  expect(earlyEvents.some((event) => event.type === "step_completed" || event.type === "solve_failed")).toBe(false);

  const releaseFirstStep = await request.post(`${fixtureBase}/__fixture/release-recovery-step1`);
  expect(releaseFirstStep.ok()).toBe(true);
  const firstCard = stepCard(page, "Subtract 1 from both sides");
  await expect(firstCard).toBeVisible();
  await expect(page.locator(".step-card.notebook-step")).toHaveCount(1);
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .filter((event) => event.type === "step_completed" && event.stepIndex === 0).length)).toBe(1);
  const firstTarget = firstCard.locator("[data-inspectable='math-subtoken']").first();
  await expect(firstTarget).toBeVisible();
  const semanticId = await firstTarget.getAttribute("data-semantic-id");
  expect(semanticId).toBeTruthy();
  await expect(firstCard.locator(`.math-semantic-hitbox[data-token-id="${semanticId}"]`).first())
    .toHaveAttribute("data-geometry-valid", "true");
  await firstTarget.hover({ force: true });
  await expect(firstTarget).toHaveAttribute("data-active-target", "true");

  const releaseSecondStep = await request.post(`${fixtureBase}/__fixture/release-step2`);
  expect(releaseSecondStep.ok()).toBe(true);
  await expect(stepCard(page, "Simplify both sides")).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__.at(-1)?.type))
    .toBe("solve_completed");
  const events = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__);
  expect(events.filter((event) => event.type === "solve_started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "solution_metadata")).toHaveLength(1);
  expect(events.filter((event) => event.type === "step_completed" && event.stepIndex === 0)).toHaveLength(1);
  expect(events.some((event) => event.step?.id === "failed-draft-step" || event.type === "solve_failed")).toBe(false);
  expect(events.at(-1).model).toBe((await fixtureState(request)).model);
  await expect(page.getByText("failed draft", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Explanation ready", { exact: true })).toBeVisible();
});

test("terminal pre-prefix provider failure creates no steps or semantic geometry", async ({ page, request }) => {
  await configureScenario(request, "terminal-pre-prefix");
  await installWireObserver(page);
  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…")
    .fill("Solve x+1=2 and explain the subtraction in this terminal failure case.");
  await page.getByTestId("primary-composer-solve").click();

  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__.at(-1)?.type))
    .toBe("solve_failed");
  await expect(page.getByText("Generation stopped", { exact: true })).toBeVisible();
  const events = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__);
  expect(events.map((event) => event.type)).toEqual(["solve_started", "solve_failed"]);
  expect(events.some((event) => event.type === "step_completed" || event.type === "solution_metadata")).toBe(false);
  expect((await fixtureState(request)).providerRequests).toBe(1);
  await expect(page.locator(".step-card.notebook-step")).toHaveCount(0);
  await expect(page.locator(".math-semantic-hitbox")).toHaveCount(0);
  await expect(page.locator("[data-inspectable='math-subtoken']")).toHaveCount(0);
});

test("interrupted provider output preserves three completed steps and discards its incomplete fourth step", async ({ page, request }) => {
  await configureScenario(request, "interrupted");
  await installLazyExplanationRoutes(page);
  await installWireObserver(page);
  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…").fill("Solve x+1=2 and show three steps.");
  await page.getByTestId("primary-composer-solve").click();

  const headings = ["Subtract 1 from both sides", "Simplify both sides", "Check the solution"];
  for (const heading of headings) await expect(stepCard(page, heading)).toBeVisible();
  await expect(page.getByText("unfinished draft", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Generation stopped/)).toBeVisible();
  await expect(page.getByText(/3 completed steps/)).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .at(-1)?.type)).toBe("solve_failed");
  const failedEvent = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__.at(-1));
  expect(failedEvent.retryable).toBe(true);

  const visiblePrefix = await page.evaluate(() => [...document.querySelectorAll(".step-card")]
    .map((card) => ({
      text: card.textContent || "",
      semanticIds: [...card.querySelectorAll("[data-semantic-id]")].map((node) => node.getAttribute("data-semantic-id")),
      provenance: [...card.querySelectorAll("[data-provenance-id]")].map((node) => node.getAttribute("data-provenance-id")),
    })));
  expect(visiblePrefix).toHaveLength(3);
  expect(visiblePrefix.some((card) => card.text.includes("unfinished draft"))).toBe(false);
  expect(visiblePrefix.flatMap((card) => card.semanticIds).some((id) => id?.includes("provider-step-4"))).toBe(false);
  expect(visiblePrefix.flatMap((card) => card.provenance).some((id) => id?.includes("provider-step-4"))).toBe(false);
  const firstTarget = stepCard(page, headings[0]).locator("[data-inspectable='math-subtoken']").first();
  const preservedSemanticId = await firstTarget.getAttribute("data-semantic-id");
  expect(preservedSemanticId).toBeTruthy();
  await expect(stepCard(page, headings[0]).locator(`.math-semantic-hitbox[data-token-id="${preservedSemanticId}"]`).first())
    .toHaveAttribute("data-geometry-valid", "true");
  await firstTarget.hover({ force: true });
  await expect(firstTarget).toHaveAttribute("data-active-target", "true");
  const failedState = await fixtureState(request);
  expect(failedState).toMatchObject({ scenario: "interrupted", emittedStepCount: 3, interruptedWithDraft: true, providerRequests: 1 });
});

test("retry after interrupted streaming uses a new attempt and preserves strict start-event identity", async ({ page, request }) => {
  await configureScenario(request, "interrupted");
  await installWireObserver(page);
  await page.goto("/?mockAuth=1");
  await page.getByTestId("primary-composer-activate").click();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…")
    .fill("Solve x+1=2 and show the algebra.");
  const firstSolveFinished = page.waitForEvent("requestfinished", (request) => request.url().includes("/api/explain"));
  await page.getByTestId("primary-composer-solve").click();
  await expect(page.getByText(/Generation stopped/)).toBeVisible();
  await firstSolveFinished;
  const previous = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .find((event) => event.type === "solve_started"));
  expect(previous?.attemptId).toBeTruthy();

  await configureScenario(request, "success");
  await page.getByTestId("primary-composer-compact-problem")
    .getByRole("button", { name: "Edit submitted problem" }).click();
  const solveButton = page.getByTestId("primary-composer-solve");
  await expect(solveButton).toHaveText("Solve");
  await expect(solveButton).toBeEnabled();
  await page.getByPlaceholder("Describe assumptions, boundary conditions, or what should be found…")
    .fill("Solve x+1=2 and show the algebra.");
  await page.getByTestId("primary-composer-solve").click();
  await expect.poll(async () => page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .filter((event) => event.type === "solve_started").length)).toBe(2);
  const retry = await page.evaluate(() => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .filter((event) => event.type === "solve_started").at(-1));
  expect(retry.requestId).not.toBe(previous.requestId);
  expect(retry.attemptId).not.toBe(previous.attemptId);
  expect(retry.supersedesAttemptId).toBe(previous.attemptId);
  await expect.poll(async () => page.evaluate((requestId) => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .filter((event) => event.type === "step_completed" && event.requestId === requestId).length, retry.requestId)).toBe(1);
  const released = await request.post(`${fixtureBase}/__fixture/release-step2`);
  expect(released.ok()).toBe(true);
  await expect.poll(async () => page.evaluate((requestId) => window.__OMNIMATH_PROVIDER_STREAM_EVENTS__
    .some((event) => event.type === "solve_completed" && event.requestId === requestId), retry.requestId)).toBe(true);
  await expect(page.getByText(/Generation stopped/)).toHaveCount(0);
});
