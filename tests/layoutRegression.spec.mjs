import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { annotateMathExplanation } from "../src/lib/mathAnnotator.js";
import { createLocalRuleExplanation } from "../server/localRules.js";

const ARTIFACT_DIR = "test-artifacts/layout-regression";
const ZOOM_LEVELS = [
  { label: "100", value: 1 },
  { label: "90", value: 0.9 },
  { label: "75", value: 0.75 },
  { label: "50", value: 0.5 },
];

const STOKES_PROBLEM = [
  "Use Stokes' theorem for the portion of the paraboloid z=9-x^2-y^2 above z=0,",
  "oriented upward, with boundary C.",
  "F(x,y,z)=\\langle yz^2+e^{x^2}\\sin(y),x^3z+\\ln(1+z^2),xy^2+z\\cos(xy)\\rangle.",
  "Evaluate \\iint_S(\\nabla\\times F)\\cdot n\\,dS.",
].join(" ");

const LOW_CONFIDENCE_OCR_TEXT = [
  "Let C be the boundary of the surface where z >= 0.",
  "x^2/4 + y^2/9 <= 1.",
  "The vector field includes e^{x^2}, e^{-z^2}, theta, and 2pi.",
].join(" ");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
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

function createReadableMathPng() {
  const width = 1000;
  const height = 760;
  const channels = 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height, 255);

  for (let y = 0; y < height; y += 1) {
    raw[y * (rowLength + 1)] = 0;
  }

  const drawRect = (x, y, w, h) => {
    for (let row = y; row < y + h; row += 1) {
      if (row < 0 || row >= height) continue;
      const rowStart = row * (rowLength + 1) + 1;
      for (let col = x; col < x + w; col += 1) {
        if (col < 0 || col >= width) continue;
        const offset = rowStart + col * channels;
        raw[offset] = 10;
        raw[offset + 1] = 18;
        raw[offset + 2] = 20;
      }
    }
  };

  for (let line = 0; line < 8; line += 1) {
    const y = 90 + line * 72;
    drawRect(150, y, 680 - line * 18, 18);
    drawRect(150, y + 30, 430 + line * 20, 12);
  }
  drawRect(420, 85, 130, 230);
  drawRect(700, 200, 95, 260);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createStokesApiResponse() {
  const local = createLocalRuleExplanation(STOKES_PROBLEM, { source: "text" });
  const annotated = annotateMathExplanation(local);
  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright fixture",
    demoMode: true,
  };
}

function createLazyExplanationResponse() {
  return {
    title: "Selected math",
    short: "This selected expression is part of the Stokes theorem setup.",
    medium: "The selected term is rendered in a contained hover card for layout regression coverage.",
    deep: "This deterministic response avoids external API dependencies while exercising the same hover UI.",
    relatedConcepts: [],
  };
}

async function installApiFixtures(page) {
  await page.route("**/api/explain", async (route) => {
    const requestBody = route.request().postDataJSON();
    expect(requestBody.problem).toContain("Stokes");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createStokesApiResponse()),
    });
  });

  await page.route("**/api/explain-token", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });

  await page.route("**/api/explain-pin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLazyExplanationResponse()),
    });
  });
}

async function applyBrowserZoom(page, zoom) {
  await page.evaluate((zoomValue) => {
    document.documentElement.style.zoom = String(zoomValue);
    document.body.dataset.layoutRegressionZoom = String(zoomValue);
    window.dispatchEvent(new Event("resize"));
  }, zoom);
  await page.waitForTimeout(250);
}

async function assertLayoutIntegrity(page, { checkHover = false } = {}) {
  const errors = await page.evaluate(({ checkHover }) => {
    const failures = [];
    const intersects = (left, right) => !(
      left.right <= right.left
      || left.left >= right.right
      || left.bottom <= right.top
      || left.top >= right.bottom
    );
    const viewportWidth = document.documentElement.clientWidth;
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const zoomValue = Number(document.body.dataset.layoutRegressionZoom || "1") || 1;
    const visualPageWidth = pageWidth * zoomValue;
    const tolerance = 2;

    if (visualPageWidth > viewportWidth + tolerance) {
      failures.push(`page width ${visualPageWidth} exceeds viewport ${viewportWidth} at zoom ${zoomValue}`);
    }

    const errorNodes = document.querySelectorAll(".katex-error, merror, [data-math-fallback='true']");
    if (errorNodes.length > 0) {
      failures.push(`${errorNodes.length} KaTeX error/fallback node(s) found`);
    }

    const internalTextPattern = /KaTeX parse error|Expected EOF|Undefined control sequence|stack trace|could not be rendered/i;
    if (internalTextPattern.test(document.body.innerText || "")) {
      failures.push("user-facing text contains KaTeX/internal fallback content");
    }

    const main = document.querySelector("main");
    const mainRect = main?.getBoundingClientRect();
    const topPreview = document.querySelector(".omni-problem-preview");
    const topRect = topPreview?.getBoundingClientRect();
    if (!mainRect || !topRect) {
      failures.push("missing main content or top equation preview");
    } else if (topRect.left < mainRect.left - tolerance || topRect.right > mainRect.right + tolerance) {
      failures.push(`top equation preview escapes content column (${topRect.left}, ${topRect.right}) vs (${mainRect.left}, ${mainRect.right})`);
    }

    for (const container of document.querySelectorAll(".omni-problem-preview, .omni-math-block, .omni-solution-line")) {
      const rect = container.getBoundingClientRect();
      const parentRect = container.parentElement?.getBoundingClientRect();
      if (!parentRect || rect.width === 0 || rect.height === 0) continue;
      if (rect.left < parentRect.left - tolerance || rect.right > parentRect.right + tolerance) {
        failures.push(`equation container exceeds parent width: ${container.className}`);
      }
    }

    for (const line of document.querySelectorAll(".omni-solution-line")) {
      const rect = line.getBoundingClientRect();
      if (rect.width <= 0 || rect.height < 14) {
        failures.push(`solution line is not readable: ${line.textContent?.slice(0, 80) || line.className}`);
      }
    }

    for (const math of document.querySelectorAll(".katex")) {
      const rect = math.getBoundingClientRect();
      const style = getComputedStyle(math);
      if (style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
      const container = math.closest(".omni-problem-preview, .omni-math-block, .omni-solution-line, .omni-floating-window");
      const containerRect = container?.getBoundingClientRect();
      const containerStyle = container ? getComputedStyle(container) : null;
      if (containerRect && containerStyle?.overflowY === "hidden" && rect.bottom > containerRect.bottom + tolerance) {
        failures.push(`math appears vertically clipped: ${math.textContent?.slice(0, 80) || "katex"}`);
      }
    }

    if (checkHover) {
      const target = document.querySelector("[data-layout-hover-target='true']");
      const targetRect = target?.getBoundingClientRect();
      const windows = [...document.querySelectorAll(".omni-floating-window, .omni-quick-tooltip")]
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);

      if (windows.length === 0) {
        failures.push("hover did not open a tooltip/window");
      }

      if (targetRect) {
        for (const { rect } of windows) {
          if (intersects(targetRect, rect)) {
            failures.push(`hover tooltip overlaps selected math target: target=${JSON.stringify({
              left: targetRect.left,
              right: targetRect.right,
              top: targetRect.top,
              bottom: targetRect.bottom,
            })} tooltip=${JSON.stringify({
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            })}`);
          }
        }
      }

      for (let i = 0; i < windows.length; i += 1) {
        for (let j = i + 1; j < windows.length; j += 1) {
          if (intersects(windows[i].rect, windows[j].rect)) {
            failures.push("floating tooltip/window bounding boxes overlap");
          }
        }
      }
    }

    return failures;
  }, { checkHover });

  expect(errors).toEqual([]);
}

test("Stokes theorem solution stays contained and renderable at browser zoom levels", async ({ page }) => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await installApiFixtures(page);

  const browserConsoleErrors = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error"
      && /KaTeX parse error|Expected EOF|Undefined control sequence|\[omnimath:math-render-error\]/i.test(text)
    ) {
      browserConsoleErrors.push(text);
    }
  });

  await page.goto("/?mockAuth=1");
  await page.getByPlaceholder(/Type a calculus problem/i).fill(STOKES_PROBLEM);
  await page.getByRole("button", { name: /Explain/i }).click();

  await expect(page.getByText("Stokes' theorem setup")).toBeVisible();
  await expect(page.locator(".omni-solution-line").first()).toBeVisible();

  for (const zoom of ZOOM_LEVELS) {
    await applyBrowserZoom(page, zoom.value);
    await page.evaluate(() => window.scrollTo(0, 0));
    await assertLayoutIntegrity(page);

    const hoverTarget = page.locator("[data-explainable='true']").first();
    await expect(hoverTarget).toBeVisible();
    await hoverTarget.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
    await hoverTarget.hover();
    await page.waitForTimeout(800);
    await assertLayoutIntegrity(page, { checkHover: true });

    await page.screenshot({
      path: `${ARTIFACT_DIR}/stokes-zoom-${zoom.label}.png`,
      fullPage: true,
    });

    await page.mouse.move(4, 4);
    await hoverTarget.evaluate((node) => node.removeAttribute("data-layout-hover-target"));
  }

  expect(browserConsoleErrors).toEqual([]);
});

test("low-confidence image review can continue with canonical extracted text", async ({ page }) => {
  await installApiFixtures(page);

  let solveRequestBody = null;
  await page.route("**/api/extract-image-problem", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        extractedProblemText: LOW_CONFIDENCE_OCR_TEXT,
        rawExtractedText: LOW_CONFIDENCE_OCR_TEXT,
        rawOcrText: LOW_CONFIDENCE_OCR_TEXT,
        cleanedPlainText: LOW_CONFIDENCE_OCR_TEXT,
        extractedProblemLatex: "\\frac{e^{x^2}}{",
        confidence: 50,
        mathIntegrityScore: 50,
        confidenceTier: "low",
        ocrConfidence: 92,
        issues: [
          {
            type: "low_math_confidence",
            severity: "high",
            critical: true,
            message: "Review required before solving.",
          },
        ],
        extractionValidation: {
          status: "danger",
          tier: "low",
          critical: true,
          confidence: 50,
          mathIntegrityScore: 50,
          ocrConfidence: 92,
          issues: [
            {
              type: "low_math_confidence",
              severity: "high",
              critical: true,
              message: "Review required before solving.",
            },
          ],
        },
        displaySegments: [
          {
            type: "math",
            text: "e^{x^2}",
            latex: "\\frac{e^{x^2}}{",
            renderIssue: "KaTeX parse error",
          },
        ],
        usage: { kind: "image", remaining: 998, limit: 999 },
      }),
    });
  });

  await page.route("**/api/solve-extracted-problem", async (route) => {
    solveRequestBody = route.request().postDataJSON();
    expect(solveRequestBody.problem).toBe(LOW_CONFIDENCE_OCR_TEXT);
    expect(solveRequestBody.problemLatex || "").toBe("");
    expect(solveRequestBody.problem).not.toContain("\\frac{e^{x^2}}{");
    expect(solveRequestBody.extraction.normalizedText).toBe(LOW_CONFIDENCE_OCR_TEXT);
    expect(solveRequestBody.extraction.previewMath?.[0]?.renderIssue).toBe("KaTeX parse error");

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createStokesApiResponse()),
    });
  });

  await page.goto("/?mockAuth=1");
  await page.locator("input[type='file']").setInputFiles({
    name: "readable-math.png",
    mimeType: "image/png",
    buffer: createReadableMathPng(),
  });

  await expect(page.getByRole("button", { name: /Analyze with AI/i })).toBeEnabled();
  await page.getByRole("button", { name: /Analyze with AI/i }).click();

  await expect(page.getByText(/Review the extracted text/i)).toBeVisible();
  await expect(page.getByText(/Math 50% · low/i)).toBeVisible();
  const continueButton = page.getByRole("button", { name: /Continue with reviewed text/i });
  await expect(continueButton).toBeVisible();
  await expect(continueButton).toBeEnabled();

  await continueButton.click();
  await expect(page.getByText(/Explanation ready/i)).toBeVisible();
  expect(solveRequestBody).not.toBeNull();
});
