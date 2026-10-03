import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";
import {
  installPhase6WorkspaceFixture,
  openLensConversation,
  openPhase6Workspace,
  PHASE6_PROBLEM,
  phase6Target,
  pinPhase6Target,
  setPhase6StreamMode,
} from "./fixtures/phase6Workspace.mjs";
import { submitCurrentComposer } from "./helpers/submitCurrentComposer.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function readableWorkspaceImage() {
  const width = 1000;
  const height = 760;
  const channels = 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height, 255);
  for (let y = 0; y < height; y += 1) raw[y * (rowLength + 1)] = 0;
  for (let line = 0; line < 9; line += 1) {
    for (let y = 70 + line * 70; y < 88 + line * 70; y += 1) {
      const rowStart = y * (rowLength + 1) + 1;
      for (let x = 130; x < 820 - line * 12; x += 1) {
        const offset = rowStart + x * channels;
        raw[offset] = 8; raw[offset + 1] = 16; raw[offset + 2] = 20;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function expectNoCardOverlap(cards) {
  await expect.poll(async () => {
    const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
    if (boxes.some((box) => !box)) return Number.POSITIVE_INFINITY;
    let maximumOverlap = 0;
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left];
        const b = boxes[right];
        const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        maximumOverlap = Math.max(maximumOverlap, width * height);
      }
    }
    return maximumOverlap;
  }).toBe(0);
  return Promise.all(cards.map((card) => card.boundingBox()));
}

async function installStatusObserver(page) {
  await page.evaluate(() => {
    window.__PHASE6_OBSERVED_STATUSES__ = [];
    const capture = () => {
      document.querySelectorAll("[data-conversation-status]").forEach((node) => {
        const entry = `${node.getAttribute("data-conversation-id")}:${node.getAttribute("data-conversation-status")}`;
        if (!window.__PHASE6_OBSERVED_STATUSES__.includes(entry)) window.__PHASE6_OBSERVED_STATUSES__.push(entry);
      });
    };
    capture();
    window.__PHASE6_STATUS_OBSERVER__?.disconnect();
    window.__PHASE6_STATUS_OBSERVER__ = new MutationObserver(capture);
    window.__PHASE6_STATUS_OBSERVER__.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-conversation-status"] });
  });
}

async function dragCard(page, card, deltaX, deltaY) {
  const handle = card.locator("[data-pinned-drag-handle]");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box.x + 18, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + deltaX, start.y + deltaY, { steps: 8 });
  await page.mouse.up();
}

async function chooseWorkspacePresentation(page, presentation) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Interaction", exact: true }).click();
  await dialog.getByRole("button", { name: presentation, exact: true }).click();
  await dialog.getByRole("button", { name: "Close settings" }).click();
}

test("empty workspace centers a personalized greeting above one restrained composer", async ({ page }) => {
  await page.goto("/?mockAuth=1");
  const greeting = page.locator(".omni-empty-greeting");
  const composer = page.getByTestId("primary-math-composer");
  await expect(greeting.getByRole("heading", { name: "What are we solving today, Dev?" })).toBeVisible();
  await expect(composer).toBeVisible();
  const geometry = await page.evaluate(() => {
    const heading = document.querySelector(".omni-empty-greeting h2")?.getBoundingClientRect();
    const composer = document.querySelector("[data-testid='primary-math-composer']")?.getBoundingClientRect();
    const upload = document.querySelector("[aria-label='Upload an image']")?.getBoundingClientRect();
    return { headingBottom: heading?.bottom, composerTop: composer?.top, composerWidth: composer?.width, uploadWidth: upload?.width };
  });
  expect(geometry.headingBottom).toBeLessThan(geometry.composerTop);
  expect(geometry.composerWidth).toBeGreaterThan(500);
  expect(geometry.uploadWidth).toBeLessThanOrEqual(48);
  await expect(page.locator("header svg.lucide-ellipsis, header svg.lucide-more-horizontal")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open visual math editor" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Advanced LaTeX" })).toHaveCount(0);
  await page.screenshot({ path: "test-artifacts/phase6-resume-empty-workspace.png", fullPage: true });
});

test("selecting an image replaces the generic empty state with an image-aware instruction task", async ({ page }) => {
  await page.goto("/?mockAuth=1");
  await expect(page.locator(".omni-empty-greeting")).toBeVisible();
  await page.locator("input[type='file']").setInputFiles({
    name: "phase6-workspace.png",
    mimeType: "image/png",
    buffer: readableWorkspaceImage(),
  });

  const imageComposer = page.getByTestId("image-aware-composer");
  await expect(imageComposer).toBeVisible();
  await expect(page.locator(".omni-empty-greeting")).toHaveCount(0);
  await expect(page.getByPlaceholder("Add instructions or describe what you want solved…")).toBeVisible();
  await expect(page.getByPlaceholder("Enter a math problem…")).toBeHidden();
  const instructions = page.getByRole("textbox", { name: "Instructions for the selected image" });
  await instructions.fill("Solve the second equation and explain the substitution.");
  await expect(instructions).toHaveValue("Solve the second equation and explain the substitution.");
  await expect(page.getByTestId("image-review-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: /Analyze with AI/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace selected image" })).toBeVisible();
  await page.screenshot({ path: "test-artifacts/phase6-resume-image-workspace.png", fullPage: true });

  await page.getByRole("button", { name: "Clear selected image" }).click();
  await expect(imageComposer).toHaveCount(0);
  await expect(page.locator(".omni-empty-greeting")).toBeVisible();
});

test("three semantic pins live in the document canvas and move with document scrolling", async ({ page }, testInfo) => {
  await openPhase6Workspace(page);
  const canvas = page.locator("[data-lens-canvas]");
  await expect(canvas).toBeVisible();
  const pins = [];
  for (const symbol of ["a", "b", "c"]) pins.push(await pinPhase6Target(page, symbol));

  expect(new Set(pins.map(({ semanticId }) => semanticId)).size).toBe(3);
  await expect(page.locator("[data-pinned-lens]" )).toHaveCount(3);
  const cards = pins.map(({ card }) => card);
  await expectNoCardOverlap(cards);
  for (const { card, semanticId } of pins) {
    await expect(card).toHaveAttribute("data-pinned-lens", /.+/);
    await expect(card).toHaveAttribute("data-semantic-id", semanticId);
    expect(await card.evaluate((node) => getComputedStyle(node).position)).toBe("absolute");
    expect(await card.evaluate((node) => node.parentElement?.closest("[data-lens-canvas]") !== null)).toBe(true);
    await expect(card.locator("[data-lens-target-preview] .katex")).toHaveCount(1);
  }

  const before = await cards[0].evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
  await page.evaluate(() => window.scrollTo(0, Math.min(document.documentElement.scrollHeight, 1100)));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  const after = await cards[0].evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
  expect(Math.abs(after - before)).toBeLessThan(3);
  await expect(cards[0]).toBeAttached();
  await testInfo.attach("phase6-canvas-scroll", {
    body: JSON.stringify({ semanticIds: pins.map(({ semanticId }) => semanticId), beforeDocumentTop: before, afterDocumentTop: after }, null, 2),
    contentType: "application/json",
  });
});

test("settings switch one mounted conversation between Canvas and Inspector without losing card state", async ({ page }) => {
  await openPhase6Workspace(page);
  const a = await pinPhase6Target(page, "a");
  const b = await pinPhase6Target(page, "b");
  const c = await pinPhase6Target(page, "c");
  const cards = [a.card, b.card, c.card];
  await expect(page.locator("[data-pinned-lens-layer]")).toHaveAttribute("data-explanation-workspace", "canvas");
  for (const card of cards) await expect(card).toHaveAttribute("data-presentation-visible", "true");

  const input = await openLensConversation(b.card);
  await input.fill("Keep the b conversation through presentation changes");
  await input.press("Enter");
  await expect(b.card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await dragCard(page, b.card, -120, 150);
  await b.card.getByRole("button", { name: "Collapse explanation" }).click();
  await expect(b.card).toHaveAttribute("data-collapsed", "true");
  const canvasPosition = await b.card.evaluate((node) => node.style.transform);
  await b.card.evaluate((node) => { node.dataset.phase6MountedIdentity = "same-card"; });

  await page.evaluate(() => window.__OMNIMATH_PERF__?.reset?.());
  await chooseWorkspacePresentation(page, "Inspector");
  const panel = page.locator(".omni-inspector-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-pinned-lens]")).toHaveCount(3);
  await expect(panel.locator("[data-presentation-visible='true']")).toHaveCount(1);
  await expect(c.card).toHaveAttribute("data-presentation-visible", "true");
  await expect(b.card).toHaveAttribute("data-presentation-visible", "false");
  await expect(b.card).toHaveAttribute("data-phase6-mounted-identity", "same-card");
  await expect(b.card.locator("[data-message-role='assistant']")).toContainText("Streamed explanation");
  await page.screenshot({ path: "test-artifacts/phase6-resume-inspector-workspace.png", fullPage: true });

  await b.target.scrollIntoViewIfNeeded();
  const targetBox = await b.target.boundingBox();
  expect(targetBox).not.toBeNull();
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { button: "right" });
  await expect(b.card).toHaveAttribute("data-presentation-visible", "true");
  await expect(panel.locator("[data-presentation-visible='true']")).toHaveCount(1);
  await expect(b.card.locator("[data-message-role='assistant']")).toContainText("Streamed explanation");

  await chooseWorkspacePresentation(page, "Canvas");
  await expect(page.locator("[data-pinned-lens-layer]")).toHaveAttribute("data-explanation-workspace", "canvas");
  for (const card of cards) await expect(card).toHaveAttribute("data-presentation-visible", "true");
  await expect(b.card).toHaveAttribute("data-phase6-mounted-identity", "same-card");
  await expect(b.card).toHaveAttribute("data-placement-mode", "manual");
  await expect(b.card).toHaveAttribute("data-collapsed", "true");
  await expect.poll(() => b.card.evaluate((node) => node.style.transform)).toBe(canvasPosition);
  console.log("PHASE6_MODE_SWITCH_METRICS", JSON.stringify(await page.evaluate(() => ({
    entries: (window.__OMNIMATH_PERF__?.measurements || []).filter((entry) => /^lens\./.test(entry.name)),
    longTasks: window.__OMNIMATH_PERF__?.longTasks || [],
  }))));
});

test("keyboard placement intentionally expands beyond solution content without losing binding", async ({ page }) => {
  await openPhase6Workspace(page);
  const { card, semanticId } = await pinPhase6Target(page, "a");
  const input = await openLensConversation(card);
  await input.fill("Remember this target at a distant canvas position");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  const handle = card.getByRole("button", { name: "Move explanation with arrow keys" });
  await handle.focus();
  const baseline = await page.evaluate(() => {
    const canvas = document.querySelector("[data-lens-canvas]").getBoundingClientRect();
    const solution = document.querySelector(".omni-solution-flow").getBoundingClientRect();
    const card = document.querySelector("[data-pinned-lens]").getBoundingClientRect();
    return { solutionBottom: solution.bottom - canvas.top, cardTop: card.top - canvas.top };
  });
  const steps = Math.min(240, Math.max(40, Math.ceil((baseline.solutionBottom + 600 - baseline.cardTop) / 40)));
  for (let step = 0; step < steps; step += 1) await handle.press("Shift+ArrowDown");
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  const expanded = await page.evaluate(() => {
    const canvasNode = document.querySelector("[data-lens-canvas]");
    const canvas = canvasNode.getBoundingClientRect();
    const card = document.querySelector("[data-pinned-lens]").getBoundingClientRect();
    return {
      cardTop: card.top - canvas.top,
      cardBottom: card.bottom - canvas.top,
      logicalExtent: Number(canvasNode.dataset.logicalCanvasExtent),
    };
  });
  expect(expanded.cardTop).toBeGreaterThan(baseline.solutionBottom + 300);
  expect(expanded.logicalExtent).toBeGreaterThanOrEqual(expanded.cardBottom);
  await expect(card).toHaveAttribute("data-semantic-id", semanticId);
  await expect(card.locator("[data-message-role='user']")).toContainText("distant canvas position");
  await expect(card.locator("[data-message-role='assistant']")).toContainText("Streamed explanation");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(baseline.solutionBottom);
  console.log("PHASE6_LARGE_CANVAS_METRICS", JSON.stringify({ baseline, expanded, keyboardSteps: steps }));
});

test("manual canvas placement reprojects through viewport resize without losing conversation", async ({ page }) => {
  await openPhase6Workspace(page);
  const { card } = await pinPhase6Target(page, "b");
  const input = await openLensConversation(card);
  await input.fill("Keep this explanation while the layout narrows");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await dragCard(page, card, -120, 180);
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  const originalPosition = await card.evaluate((node) => ({
    x: node.getBoundingClientRect().left + window.scrollX,
    y: node.getBoundingClientRect().top + window.scrollY,
  }));

  await page.evaluate(() => window.__OMNIMATH_PERF__?.reset?.());
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect.poll(() => card.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= document.documentElement.clientWidth + 1;
  })).toBe(true);
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  await expect(card.locator("[data-message-role='assistant']")).toContainText("Streamed explanation");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => card.evaluate((node, saved) => {
    const rect = node.getBoundingClientRect();
    return Math.max(Math.abs(rect.left + window.scrollX - saved.x), Math.abs(rect.top + window.scrollY - saved.y));
  }, originalPosition)).toBeLessThan(8);
  await expect(card.locator("[data-message-role='user']")).toContainText("Keep this explanation");
  console.log("PHASE6_RESIZE_REFLOW_METRICS", JSON.stringify(await page.evaluate(() => ({
    entries: (window.__OMNIMATH_PERF__?.measurements || []).filter((entry) => /^lens\./.test(entry.name)),
    longTasks: window.__OMNIMATH_PERF__?.longTasks || [],
  }))));
});

test("independent lens streams survive concurrent drag and mounted-body collapse", async ({ page }, testInfo) => {
  await openPhase6Workspace(page);
  const pinA = await pinPhase6Target(page, "a");
  const pinB = await pinPhase6Target(page, "b");
  const pinC = await pinPhase6Target(page, "c");
  const cards = [pinA.card, pinB.card, pinC.card];
  const inputs = [];
  for (const card of cards) inputs.push(await openLensConversation(card));
  await installStatusObserver(page);

  await inputs[0].fill("Why is a independent?");
  await inputs[1].fill("How does b contribute?");
  await inputs[0].press("Enter");
  await inputs[1].press("Enter");
  const conversations = [cards[0], cards[1]].map((card) => card.locator("[data-conversation-status]"));
  for (const conversation of conversations) {
    await expect(conversation).toHaveAttribute("data-conversation-status", /generating|streaming/);
  }

  await dragCard(page, cards[0], -180, 170);
  await expect(cards[0]).toHaveAttribute("data-placement-mode", "manual");
  await cards[1].getByRole("button", { name: "Collapse explanation" }).click();
  await expect(cards[1]).toHaveAttribute("data-collapsed", "true");
  await expect(cards[1].locator(".omni-lens-body")).toHaveCount(1);
  await expect(cards[1].locator("[data-message-role='user']")).toHaveCount(1);

  for (const conversation of conversations) {
    await expect(conversation).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  }
  for (const card of cards.slice(0, 2)) {
    await expect(card.locator("[data-message-role='user']")).toHaveCount(1);
    await expect(card.locator("[data-message-role='assistant']")).toHaveCount(1);
    await expect(card.locator(".omni-stream-text")).toHaveCount(0);
  }
  await expect(cards[1].locator("[data-message-role='assistant']")).toHaveCount(1);
  await cards[1].getByRole("button", { name: "Expand explanation" }).click();
  await expect(cards[1]).toContainText("Streamed explanation");

  await cards[0].getByLabel("More actions for this object").click();
  await cards[0].getByRole("button", { name: "Simplify", exact: true }).click();
  await expect(cards[0].locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await expect(cards[0].locator("[data-message-role='user']")).toHaveCount(2);
  await expect(cards[0].locator("[data-message-role='assistant']")).toHaveCount(2);

  await inputs[2].focus();
  await cards[1].getByRole("button", { name: "Collapse explanation" }).evaluate((button) => button.click());
  await expect(inputs[2]).toBeFocused();
  // Manual Canvas coordinates are intentionally freeform. The automatic cards
  // remain organized without rewriting the user's dragged position.
  await expect(cards[0]).toHaveAttribute("data-placement-mode", "manual");
  await expectNoCardOverlap(cards.slice(1));

  const evidence = await page.evaluate(() => ({
    calls: window.__PHASE6_FOLLOWUP_CALLS__,
    timeline: window.__PHASE6_STREAM_TIMELINE__,
    statuses: window.__PHASE6_OBSERVED_STATUSES__,
    lensOperations: (window.__OMNIMATH_PERF__?.measurements || []).filter((entry) => /^lens\./.test(entry.name)),
  }));
  expect(new Set(evidence.calls.slice(0, 2).map(({ body }) => body.conversationId)).size).toBe(2);
  expect(evidence.statuses.some((value) => value.endsWith(":streaming"))).toBe(true);
  console.log("PHASE6_CONCURRENT_LENS_METRICS", JSON.stringify(evidence));
  await testInfo.attach("phase6-concurrent-streams", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

test("stop and stale-correlation failures keep partial history without committing a wrong answer", async ({ page }) => {
  await openPhase6Workspace(page, { terminalMs: 12_000 });
  const { card } = await pinPhase6Target(page, "a");
  const input = await openLensConversation(card);
  const conversation = card.locator("[data-conversation-status]");
  await input.fill("Give a deliberately interruptible explanation");
  await input.press("Enter");
  await expect(conversation).toHaveAttribute("data-conversation-status", "streaming");
  await expect(card.locator(".omni-stream-text")).toContainText(/\S+/);
  await card.getByRole("button", { name: "Stop response" }).click();
  await expect(conversation).toHaveAttribute("data-conversation-status", "aborted");
  await expect(card.locator("[data-message-role='user']")).toHaveCount(1);
  await expect(card.locator("[data-message-role='assistant']")).toHaveCount(1);
  await expect(card.locator("[data-message-role='assistant']")).toContainText("Partial response");
  await expect(input).toHaveValue("Give a deliberately interruptible explanation");
  expect(await page.evaluate(() => window.__PHASE6_FOLLOWUP_CALLS__.length)).toBe(1);

  await setPhase6StreamMode(page, "mismatch");
  await input.press("Enter");
  await expect(conversation).toHaveAttribute("data-conversation-status", "failed");
  await expect(card.getByRole("alert")).toContainText(/no longer matched/i);
  await expect(card.locator("[data-message-role='user']")).toHaveCount(2);
  await expect(card.locator("[data-message-role='assistant']")).toHaveCount(1);
  expect(await page.evaluate(() => window.__PHASE6_FOLLOWUP_CALLS__.length)).toBe(2);
  await expect(card).not.toContainText("stale response");
});

test("a duplicate send is blocked and a failed stream preserves its partial turn for retry", async ({ page }) => {
  await openPhase6Workspace(page, { terminalMs: 12_000 });
  const { card } = await pinPhase6Target(page, "a");
  const input = await openLensConversation(card);
  await setPhase6StreamMode(page, "error");
  await input.fill("Explain a with recoverable partial text");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", /generating|streaming/);
  await input.press("Enter");
  const callsDuringRequest = await page.evaluate(() => window.__PHASE6_FOLLOWUP_CALLS__.length);
  expect(callsDuringRequest).toBe(1);
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "failed", { timeout: 5000 });
  await expect(card.getByRole("alert")).toContainText("Fixture stream failed");
  await expect(card.locator("[data-message-role='assistant']")).toContainText("Partial response");
  await expect(input).toHaveValue("Explain a with recoverable partial text");

  await setPhase6StreamMode(page, "success");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 15_000 });
  await expect(card.locator("[data-message-role='user']")).toHaveCount(2);
  await expect(card.locator("[data-message-role='assistant']")).toHaveCount(2);
  await expect(card.locator("[data-message-role='assistant']").last()).toContainText("Streamed explanation");
});

test("a timed-out stream keeps partial text and offers a retry", async ({ page }) => {
  await openPhase6Workspace(page);
  const { card } = await pinPhase6Target(page, "a");
  const input = await openLensConversation(card);
  await setPhase6StreamMode(page, "timeout");
  await input.fill("Explain this until the request timeout");
  await input.press("Enter");
  await expect(card.locator(".omni-stream-text")).toContainText("Streamed explanation");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "timed_out", { timeout: 40_000 });
  await expect(card.getByRole("alert")).toContainText(/timed out/i);
  await expect(card.locator("[data-message-role='assistant']")).toContainText("Partial response");
  await expect(input).toHaveValue("Explain this until the request timeout");
  await setPhase6StreamMode(page, "success");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await expect(card.locator("[data-message-role='assistant']")).toHaveCount(2);
});

test("manual placement and complete lens history restore across sidebar reflow and sessions", async ({ page }) => {
  await openPhase6Workspace(page);
  const { card, semanticId } = await pinPhase6Target(page, "b");
  const input = await openLensConversation(card);
  await input.fill("Remember why b matters");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await dragCard(page, card, -150, 210);
  const manualBefore = await card.evaluate((node) => ({
    x: node.getBoundingClientRect().left + window.scrollX,
    y: node.getBoundingClientRect().top + window.scrollY,
  }));

  await page.evaluate(() => window.__OMNIMATH_PERF__?.reset?.());
  await page.getByTestId("sidebar-collapse").click();
  await expect(page.getByTestId("session-sidebar")).toHaveAttribute("data-sidebar-state", "collapsed");
  await expect(card).toHaveAttribute("data-placement-mode", "manual");
  await page.getByTestId("sidebar-expand").click();
  await expect(page.getByTestId("session-sidebar")).toHaveAttribute("data-sidebar-state", "expanded");

  await page.getByRole("button", { name: "New session", exact: true }).click();
  await expect(page.locator("[data-pinned-lens]")).toHaveCount(0);
  await page.getByTestId("session-sidebar").getByRole("button", { name: "Three-term workspace", exact: true }).click();
  const restored = page.locator(`.omni-floating-window[data-semantic-id="${semanticId}"]`);
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute("data-placement-mode", "manual");
  await expect(restored.locator("[data-message-role='user']")).toContainText("Remember why b matters");
  await expect(restored.locator("[data-message-role='assistant']")).toContainText("Streamed explanation");
  const manualAfter = await restored.evaluate((node) => ({
    x: node.getBoundingClientRect().left + window.scrollX,
    y: node.getBoundingClientRect().top + window.scrollY,
  }));
  expect(Math.abs(manualAfter.x - manualBefore.x)).toBeLessThan(6);
  expect(Math.abs(manualAfter.y - manualBefore.y)).toBeLessThan(6);
  console.log("PHASE6_SIDEBAR_SESSION_REFLOW_METRICS", JSON.stringify(await page.evaluate(() => ({
    entries: (window.__OMNIMATH_PERF__?.measurements || []).filter((entry) => /^lens\./.test(entry.name)),
    longTasks: window.__OMNIMATH_PERF__?.longTasks || [],
  }))));
});

test("one composer shell docks without replacement and global conversation stays solution-scoped", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installPhase6WorkspaceFixture(page);
  await page.goto("/?mockAuth=1");
  const composer = page.getByTestId("primary-math-composer");
  const dock = page.getByTestId("workspace-composer-dock");
  await expect(dock).toHaveCount(1);
  await expect(composer).toHaveCount(1);
  await composer.evaluate((node) => { node.dataset.phase6DomIdentity = "persistent-composer"; });
  const composerTransitionStartedAt = Date.now();
  await submitCurrentComposer(page, PHASE6_PROBLEM);
  await expect(page.getByRole("heading", { name: "Three-term workspace", exact: true })).toBeVisible();
  await expect(composer).toHaveAttribute("data-phase6-dom-identity", "persistent-composer");
  await expect(page.getByTestId("primary-math-composer")).toHaveCount(1);
  console.log("PHASE6_COMPOSER_TRANSITION_METRICS", JSON.stringify({ solveToDockedMs: Date.now() - composerTransitionStartedAt }));

  const workspace = page.locator(".omni-workspace-conversation");
  await expect(workspace.getByPlaceholder("Ask about this solution…")).toBeVisible();
  await workspace.getByLabel("More actions for this solution").click();
  for (const action of ["Simplify", "Different method", "Verify", "Expand", "Intuition", "Assumptions", "Sanity check", "Practice"]) {
    await expect(workspace.getByRole("button", { name: action, exact: true })).toBeVisible();
  }
  await workspace.getByRole("button", { name: "Simplify", exact: true }).click();
  await expect(workspace.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  await expect(workspace.locator("[data-message-role='assistant']")).toHaveCount(1);
  await page.screenshot({ path: "test-artifacts/phase6-resume-solved-workspace.png", fullPage: true });

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const clearance = await page.evaluate(() => {
    const lastCard = [...document.querySelectorAll(".omni-solution-flow .step-card")].at(-1)?.getBoundingClientRect();
    const dockRect = document.querySelector("[data-testid='workspace-composer-dock']")?.getBoundingClientRect();
    return { lastBottom: lastCard?.bottom, dockTop: dockRect?.top, width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
  });
  expect(clearance.width).toBeLessThanOrEqual(clearance.viewport + 1);
  expect(clearance.lastBottom).toBeLessThanOrEqual(clearance.dockTop + 1);

  await workspace.getByLabel("More actions for this solution").click();
  await workspace.getByRole("button", { name: "Edit problem", exact: true }).click();
  await expect(composer).toHaveAttribute("data-composer-state", "expanded");
  await page.getByRole("button", { name: "Open universal symbol browser" }).click();
  const browser = page.getByTestId("math-symbol-browser");
  await browser.locator("[aria-label='Symbol categories']").getByRole("button", { name: /^structures$/i }).click();
  const structureGeometry = await browser.getByRole("gridcell").evaluateAll((cells) => cells.slice(0, 12).map((cell) => {
    const preview = cell.querySelector(".omni-symbol-preview-area")?.getBoundingClientRect();
    const label = cell.querySelector(".omni-symbol-preview-label")?.getBoundingClientRect();
    return { title: cell.getAttribute("title"), previewBottom: preview?.bottom, labelTop: label?.top, cellBottom: cell.getBoundingClientRect().bottom, labelBottom: label?.bottom };
  }));
  expect(structureGeometry.length).toBeGreaterThan(5);
  for (const item of structureGeometry) {
    expect(item.previewBottom).toBeLessThanOrEqual(item.labelTop + 1);
    expect(item.labelBottom).toBeLessThanOrEqual(item.cellBottom + 1);
  }
  const representativeNames = [
    "aligned equations",
    "mixed tensor indices",
    "Ito stochastic integral",
    "multinomial coefficient",
    "3 by 3 matrix",
    "piecewise cases",
    "fraction",
  ];
  const representativeGeometry = [];
  const symbolSearch = browser.getByRole("textbox", { name: "Search mathematical symbols" });
  for (const name of representativeNames) {
    await symbolSearch.fill(name);
    const cell = browser.getByRole("gridcell", { name: `Insert ${name}`, exact: true });
    await expect(cell).toBeVisible();
    representativeGeometry.push(await cell.evaluate((node) => {
      const area = node.querySelector(".omni-symbol-preview-area")?.getBoundingClientRect();
      const ink = node.querySelector(".omni-symbol-preview-ink")?.getBoundingClientRect();
      const label = node.querySelector(".omni-symbol-preview-label")?.getBoundingClientRect();
      const cell = node.getBoundingClientRect();
      const transform = node.querySelector(".omni-symbol-preview-ink")?.style.transform || "scale(1)";
      return { name: node.getAttribute("title"), area, ink, label, cell, scale: Number(transform.match(/scale\(([^)]+)\)/)?.[1] || 1) };
    }));
  }
  for (const item of representativeGeometry) {
    expect(item.ink.left).toBeGreaterThanOrEqual(item.area.left - 1);
    expect(item.ink.right).toBeLessThanOrEqual(item.area.right + 1);
    expect(item.ink.top).toBeGreaterThanOrEqual(item.area.top - 1);
    expect(item.ink.bottom).toBeLessThanOrEqual(item.area.bottom + 1);
    expect(item.area.bottom).toBeLessThanOrEqual(item.label.top + 1);
    expect(item.label.bottom).toBeLessThanOrEqual(item.cell.bottom + 1);
  }
  const simpleFraction = representativeGeometry.find((item) => item.name === "fraction");
  expect(simpleFraction.scale).toBeGreaterThanOrEqual(0.65);
  console.log("PHASE6_SYMBOL_PREVIEW_GEOMETRY", JSON.stringify(representativeGeometry));
});

test("lens responses render headings, lists, and display mathematics without raw Markdown", async ({ page }) => {
  const answerText = [
    "### Example",
    "The balance is",
    "$$a+b+c=6$$",
    "- each term remains independently inspectable",
    "- the equality is preserved",
  ].join("\n\n");
  await openPhase6Workspace(page, { answerText, terminalMs: 900, tokenIntervalMs: 10 });
  const { card } = await pinPhase6Target(page, "a");
  const input = await openLensConversation(card);
  await input.fill("Show a formatted example");
  await input.press("Enter");
  await expect(card.locator("[data-conversation-status]")).toHaveAttribute("data-conversation-status", "complete", { timeout: 5000 });
  const response = card.locator("[data-message-role='assistant']");
  await expect(response.getByRole("heading", { name: "Example" })).toBeVisible();
  await expect(response.locator(".katex-display")).toContainText("a+b+c=6");
  await expect(response.getByRole("listitem")).toHaveCount(2);
  await expect(response).not.toContainText("###");
  await expect(card.locator("[data-lens-target-preview] .katex")).toContainText("a");
  await expect(card).not.toContainText(/Selected (?:region|token)/i);
});

test("dense streaming stays isolated to its lens, batches text, and keeps hover responsive", async ({ page }, testInfo) => {
  await openPhase6Workspace(page, { terminalMs: 8000, tokenIntervalMs: 10, repeatAnswer: 35 });
  const { card } = await pinPhase6Target(page, "a");
  const { card: idleCard } = await pinPhase6Target(page, "b");
  const activeLensId = await card.getAttribute("data-pinned-lens");
  const idleLensId = await idleCard.getAttribute("data-pinned-lens");
  const input = await openLensConversation(card);
  const messageRegion = card.locator(".omni-conversation-messages");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    window.__OMNIMATH_PERF__?.reset?.();
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_LENS_STREAM_METRICS__ = { flushes: 0, chars: 0 };
  });
  await input.fill("Give a dense explanation of a");
  await input.press("Enter");
  const conversation = card.locator("[data-conversation-status]");
  await expect(conversation).toHaveAttribute("data-conversation-status", "streaming");
  await expect(card.locator(".omni-stream-text")).toContainText("Streamed explanation");
  await expect.poll(() => messageRegion.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await messageRegion.evaluate((node) => { node.scrollTop = 0; });
  const flushesBeforePausedScroll = await page.evaluate(() => window.__OMNIMATH_LENS_STREAM_METRICS__?.flushes || 0);
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_LENS_STREAM_METRICS__?.flushes || 0))
    .toBeGreaterThan(flushesBeforePausedScroll + 2);
  expect(await messageRegion.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(1);
  await messageRegion.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const flushesBeforeFollowing = await page.evaluate(() => window.__OMNIMATH_LENS_STREAM_METRICS__?.flushes || 0);
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_LENS_STREAM_METRICS__?.flushes || 0))
    .toBeGreaterThan(flushesBeforeFollowing + 2);
  expect(await messageRegion.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(4);

  const collectMetrics = async () => page.evaluate(({ activeId, idleId }) => {
    const measurements = window.__OMNIMATH_PERF__?.measurements || [];
    const count = (pattern) => measurements.filter((entry) => pattern.test(entry.name)).length;
    const commitsFor = (lensId) => measurements.filter((entry) => (
      entry.name === "react.commit.lens-card" && entry.details?.lensId === lensId
    )).length;
    return {
      stream: window.__OMNIMATH_LENS_STREAM_METRICS__,
      mathChunkRenders: count(/react\.render\.math-chunk/),
      semanticTreeBuilds: count(/semantic-tree\.(?:generate|flatten-targets)/),
      geometryMeasurements: count(/semantic\.geometry\.(?:measurement|snapshot-construction)/),
      lensCommits: { active: commitsFor(activeId), idle: commitsFor(idleId) },
      workspaceGeometryRuns: count(/^lens\.workspace-geometry$/),
      positionReflows: count(/^lens\.position-reflow$/),
      dragFrames: measurements.filter((entry) => entry.name === "lens.drag-frame").map((entry) => entry.durationMs),
      pointerMeasurements: count(/^semantic\.hover\.pointer/),
      hoverCounters: { ...(window.__OMNIMATH_HOVER_PERF__?.counters || {}) },
      longTasks: window.__OMNIMATH_PERF__?.longTasks || [],
    };
  }, { activeId: activeLensId, idleId: idleLensId });

  const rampUp = await collectMetrics();
  // The first overflow legitimately changes the active card's measured height and
  // moves stacked neighbors. Sample steady streaming only after that transition.
  await page.waitForTimeout(350);
  await expect(conversation).toHaveAttribute("data-conversation-status", "streaming");
  await page.evaluate(() => {
    window.__OMNIMATH_PERF__?.reset?.();
    window.__OMNIMATH_HOVER_PERF__?.reset?.();
    window.__OMNIMATH_LENS_STREAM_METRICS__ = { flushes: 0, chars: 0 };
  });
  await expect.poll(() => page.evaluate(() => window.__OMNIMATH_LENS_STREAM_METRICS__?.flushes || 0)).toBeGreaterThan(3);
  const steadyState = await collectMetrics();
  await testInfo.attach("phase6-stream-isolation", {
    body: JSON.stringify({ rampUp, steadyState }, null, 2),
    contentType: "application/json",
  });

  for (const metrics of [rampUp, steadyState]) {
    expect(metrics.stream.flushes).toBeGreaterThan(0);
    expect(metrics.stream.flushes).toBeLessThan(metrics.stream.chars);
    expect(metrics.mathChunkRenders).toBe(0);
    expect(metrics.semanticTreeBuilds).toBe(0);
    expect(metrics.geometryMeasurements).toBe(0);
    expect(metrics.workspaceGeometryRuns).toBe(0);
    expect(metrics.pointerMeasurements).toBe(0);
    expect(metrics.hoverCounters.pointerResolve || 0).toBe(0);
    expect(metrics.hoverCounters.pointerLayoutReadCount || 0).toBe(0);
  }
  expect(steadyState.lensCommits.idle).toBe(0);
  expect(steadyState.positionReflows).toBe(0);

  const { target, semanticId } = await phase6Target(page, "c");
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const hoverStartedAt = Date.now();
  await page.mouse.move(2, 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toHaveAttribute("data-tooltip-semantic-id", semanticId);
  const hoverVisibleMs = Date.now() - hoverStartedAt;
  await expect(conversation).toHaveAttribute("data-conversation-status", "streaming");
  await expect(conversation).toHaveAttribute("data-conversation-status", "complete", { timeout: 10_000 });

  await messageRegion.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  expect(await messageRegion.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(4);
  await testInfo.attach("phase6-dense-stream-performance", {
    body: JSON.stringify({ rampUp, steadyState, hoverVisibleMs }, null, 2),
    contentType: "application/json",
  });
  console.log("PHASE6_STREAM_PERFORMANCE", JSON.stringify({ rampUp, steadyState, hoverVisibleMs }));
});
