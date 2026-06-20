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

const LONG_VECTOR_FIELD_LATEX = "\\mathbf{F}(x,y,z)=\\langle y^2z+e^{x^2}\\sin(yz), x^3+\\ln(1+z^2)+\\frac{\\cos(xy)}{1+x^2+y^2}, xye^{-z^2}+\\arctan(x-y)\\rangle";

const LONG_STOKES_PROBLEM = [
  "Use Stokes' theorem for the upward oriented paraboloid cap.",
  LONG_VECTOR_FIELD_LATEX,
  "Evaluate \\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS.",
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

function createLongLatexApiResponse() {
  const annotated = annotateMathExplanation({
    title: "Stokes theorem long vector field",
    problem: LONG_STOKES_PROBLEM,
    expression: `\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS\\quad\\text{where}\\quad ${LONG_VECTOR_FIELD_LATEX}`,
    extractedProblemText: LONG_STOKES_PROBLEM,
    extractedProblemLatex: LONG_VECTOR_FIELD_LATEX,
    steps: [
      {
        id: "long-step-1",
        label: "Apply Stokes' theorem",
        math: `\\iint_S(\\nabla\\times\\mathbf{F})\\cdot\\mathbf{n}\\,dS=\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}\\quad\\text{where}\\quad ${LONG_VECTOR_FIELD_LATEX}`,
        summary: "Apply Stokes' theorem to replace the surface integral with a boundary line integral.",
      },
      {
        id: "long-step-2",
        label: "Use the boundary circle",
        math: "\\mathbf{r}(t)=\\langle 3\\cos t,3\\sin t,0\\rangle,\\quad 0\\le t\\le 2\\pi,\\quad d\\mathbf{r}=\\langle -3\\sin t,3\\cos t,0\\rangle\\,dt",
        summary: "Parametrize the circular boundary in the plane z=0.",
      },
      {
        id: "long-step-3",
        label: "Substitute parametric variables into the integrand",
        math: "x^3+\\frac{\\cos(xy)}{1+x^2+y^2}+\\arctan(x-y)=8\\cos^3\\theta+\\frac{\\cos(6\\cos\\theta\\sin\\theta)}{1+4\\cos^2\\theta+9\\sin^2\\theta}+\\arctan(2\\cos\\theta-3\\sin\\theta)",
        summary: "Substitute the parametric variables into each dense term while keeping token anchors inspectable.",
      },
      {
        id: "long-step-4",
        label: "Final answer",
        math: "\\oint_C\\mathbf{F}\\cdot d\\mathbf{r}=\\int_0^{2\\pi}\\left(81\\cos^3(t)\\sin(t)-27\\sin^3(t)+\\frac{3\\cos(9\\sin(t)\\cos(t))}{1+9\\cos^2(t)+9\\sin^2(t)}\\right)\\,dt",
        summary: "This integral form is the final answer for the boundary evaluation.",
      },
    ],
    finalAnswerLatex: "\\int_0^{2\\pi}\\left(81\\cos^3(t)\\sin(t)-27\\sin^3(t)+\\frac{3\\cos(9\\sin(t)\\cos(t))}{10}\\right)\\,dt",
  });

  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright long latex fixture",
    demoMode: true,
  };
}

function createHierarchicalTokenApiResponse() {
  const annotated = annotateMathExplanation({
    title: "Hierarchical token targets",
    problem: "Inspect algebra and vector-calculus tokens.",
    expression: "3x+45=67",
    steps: [
      {
        id: "hierarchy-step-1",
        label: "Algebra target",
        math: "3x + 45 = 67",
        summary: "Keep the equation, term, coefficient, variable, and constants inspectable.",
      },
      {
        id: "hierarchy-step-2",
        label: "Vector calculus target",
        math: "∬_S (∇ × F) · n dS = 18π",
        summary: "Keep the surface integral and its nested vector-calculus pieces inspectable.",
      },
      {
        id: "hierarchy-step-3",
        label: "Cosine power integral",
        math: "\\int_0^{2\\pi} \\cos^4\\theta\\,d\\theta = \\frac{3\\pi}{4}",
        summary: "Integral of cos^4 over [0, 2π].",
      },
    ],
    finalAnswerLatex: "18\\pi",
  });

  return {
    ...annotated,
    usage: {
      kind: "explanation",
      tier: "test",
      remaining: 999,
      limit: 999,
    },
    saved: false,
    source: "playwright hierarchy fixture",
    demoMode: true,
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

async function installLongLatexApiFixtures(page) {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createLongLatexApiResponse()),
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

async function installHierarchicalTokenApiFixtures(page, { lazyRequests = [] } = {}) {
  await page.route("**/api/explain", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(createHierarchicalTokenApiResponse()),
    });
  });

  await page.route("**/api/explain-token", async (route) => {
    lazyRequests.push({ endpoint: "hover", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: route.request().postDataJSON()?.selectedLatex === "\\frac{3\\pi}{4}" ? "3π/4 value" : "Parent expression",
        explanation: route.request().postDataJSON()?.selectedLatex === "\\frac{3\\pi}{4}"
          ? "The value 3π/4 is the evaluated result of the integral, separate from the integral setup."
          : "Parent expression was selected.",
      }),
    });
  });

  await page.route("**/api/explain-pin", async (route) => {
    lazyRequests.push({ endpoint: "pin", body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: route.request().postDataJSON()?.selectedLatex === "\\frac{3\\pi}{4}" ? "3π/4 value" : "Parent expression",
        explanation: route.request().postDataJSON()?.selectedLatex === "\\frac{3\\pi}{4}"
          ? "The value 3π/4 is the evaluated result of the integral, separate from the integral setup."
          : "Parent expression was selected.",
      }),
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
      left.right <= right.left + tolerance
      || left.left >= right.right - tolerance
      || left.bottom <= right.top + tolerance
      || left.top >= right.bottom - tolerance
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
    const topPreview = document.querySelector(".omni-problem-summary-card, .omni-problem-preview");
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

test("hierarchical math tokens expose nested hover, pin, drag, tooltip, and KaTeX targets", async ({ page }) => {
  await installHierarchicalTokenApiFixtures(page);
  await page.goto("/?mockAuth=1");
  await page.getByPlaceholder(/Type a calculus problem/i).fill("Inspect 3x + 45 = 67 and a Stokes surface integral.");
  await page.getByRole("button", { name: /Explain/i }).click();

  await expect(page.getByRole("button", { name: /Algebra target/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Vector calculus target/i })).toBeVisible();

  for (const latex of ["3x", "3", "x", "45", "67", "S", "\\\\nabla", "F", "n", "dS", "18\\\\pi"]) {
    await expect(page.locator(`[data-inspectable='math-subtoken'][data-token-latex='${latex}']`).first()).toBeVisible();
  }

  const xToken = page.locator("[data-inspectable='math-subtoken'][data-token-latex='x']").first();
  await xToken.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
  const xTokenBox = await xToken.boundingBox();
  expect(xTokenBox).not.toBeNull();
  await page.mouse.move(xTokenBox.x + xTokenBox.width / 2, xTokenBox.y + xTokenBox.height / 2);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await assertLayoutIntegrity(page, { checkHover: true });
  await xToken.evaluate((node) => node.removeAttribute("data-layout-hover-target"));

  const nablaBox = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\nabla']").first().boundingBox();
  expect(nablaBox).not.toBeNull();
  await page.mouse.click(nablaBox.x + nablaBox.width / 2, nablaBox.y + nablaBox.height / 2, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();

  const start = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='3']").first().boundingBox();
  const end = await page.locator("[data-inspectable='math-subtoken'][data-token-latex='67']").first().boundingBox();
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);

  await assertLayoutIntegrity(page);

  await page.reload();
  await page.getByPlaceholder(/Type a calculus problem/i).fill("Reload hierarchy fixture.");
  await page.getByRole("button", { name: /Explain/i }).click();
  await expect(page.locator("[data-inspectable='math-subtoken'][data-token-latex='dS']").first()).toBeVisible();
  await expect(page.locator(".omni-solution-flow .katex")).not.toHaveCount(0);
  await assertLayoutIntegrity(page);
});

test("fraction result hit-testing prefers the fraction child over the integral parent", async ({ page }) => {
  const lazyRequests = [];
  await installHierarchicalTokenApiFixtures(page, { lazyRequests });
  await page.goto("/?mockAuth=1");
  await page.getByPlaceholder(/Type a calculus problem/i).fill("Evaluate the cosine power integral.");
  await page.getByRole("button", { name: /Explain/i }).click();

  await expect(page.getByRole("button", { name: /Cosine power integral/i })).toBeVisible();
  const fraction = page.locator("[data-inspectable='math-subtoken'][data-token-latex='\\\\frac{3\\\\pi}{4}']").first();
  await expect(fraction).toBeVisible();

  await fraction.scrollIntoViewIfNeeded();
  const fractionBox = await fraction.boundingBox();
  expect(fractionBox).not.toBeNull();
  const hitX = fractionBox.x + fractionBox.width / 2;
  const hitY = fractionBox.y + fractionBox.height / 2;
  await page.mouse.move(hitX, hitY);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe("\\frac{3\\pi}{4}");
  await expect(page.locator(".omni-quick-tooltip")).not.toContainText("Integral of cos4 over");

  const hoverSemanticTarget = async (locator, expectedLatex) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => lazyRequests.filter((request) => request.endpoint === "hover").at(-1)?.body?.selectedLatex).toBe(expectedLatex);
  };

  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='numerator'][data-token-latex='3\\\\pi']").first(),
    "3\\pi"
  );
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='denominator'][data-token-latex='4']").first(),
    "4"
  );
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-role='exponent'][data-token-latex='4']").first(),
    "4"
  );
  await hoverSemanticTarget(
    page.locator("[data-inspectable='math-subtoken'][data-token-latex='d\\\\theta']").first(),
    "d\\theta"
  );

  await page.mouse.click(hitX, hitY, { button: "right" });
  await expect(page.locator(".omni-floating-window")).toBeVisible();
  await expect.poll(() => lazyRequests.find((request) => request.endpoint === "pin")?.body?.selectedLatex).toBe("\\frac{3\\pi}{4}");
  await expect(page.locator(".omni-floating-window")).toContainText("value");
  await expect(page.locator(".omni-floating-window")).not.toContainText("Integral of cos4 over");
});

test("long vector-field equations scroll inside math containers without page overflow", async ({ page }) => {
  await installLongLatexApiFixtures(page);
  await page.setViewportSize({ width: 1680, height: 1050 });

  await page.goto("/?mockAuth=1");
  await page.getByPlaceholder(/Type a calculus problem/i).fill(LONG_STOKES_PROBLEM);
  await page.getByRole("button", { name: /Explain/i }).click();

  await expect(page.getByRole("button", { name: /Apply Stokes['’] theorem/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Final answer/i })).toBeVisible();
  await expect(page.locator(".step-card")).toHaveCount(4);
  const summaryCard = page.locator(".omni-problem-summary-card");
  await expect(summaryCard).toBeVisible();
  await expect(summaryCard).toContainText(/Stokes/i);
  await expect(summaryCard).not.toContainText(/y\^2z\+e\^\{x\^2\}\\sin\(yz\)/);

  const collapsedPreview = await summaryCard.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      katexCount: node.querySelectorAll(".katex").length,
      text: node.textContent || "",
    };
  });
  expect(collapsedPreview.height).toBeLessThan(240);
  expect(collapsedPreview.katexCount).toBe(0);

  await page.getByRole("button", { name: /View full problem/i }).click();
  await expect(summaryCard).toContainText(/Full problem text/i);
  await expect(summaryCard).toContainText(/Math preview/i);
  await expect(summaryCard).toContainText(/y\^2z\+e\^\{x\^2\}\\sin\(yz\)/);

  const layout = await page.evaluate(() => {
    const tolerance = 2;
    const pageOverflow = document.documentElement.scrollWidth - window.innerWidth;
    const boardRect = document.querySelector(".solution-board")?.getBoundingClientRect();
    const flowRect = document.querySelector(".omni-solution-flow")?.getBoundingClientRect();
    const mathFontSizes = [...document.querySelectorAll(".omni-solution-flow .omni-equation-line, .omni-solution-flow .omni-math-block")]
      .map((node) => Number.parseFloat(getComputedStyle(node).fontSize))
      .filter(Number.isFinite);
    const stepRects = [...document.querySelectorAll(".step-card")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent?.slice(0, 80) || "",
        width: rect.width,
        height: rect.height,
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
      };
    });
    const finalAnswer = document.querySelector(".final-answer-step[data-final-answer='true']");
    const finalAnswerRect = finalAnswer?.getBoundingClientRect();
    const finalAnswerStyle = finalAnswer ? getComputedStyle(finalAnswer) : null;
    const nestedVerticalScrollbars = [...document.querySelectorAll(".solution-board *")]
      .filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 12;
      })
      .map((node) => ({
        className: node.className || node.tagName,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
    const mathShells = [...document.querySelectorAll(".math-render-shell-block, .omni-math-block")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        escapesViewport: rect.left < -tolerance || rect.right > window.innerWidth + tolerance,
      };
    });

    return {
      pageOverflow,
      boardWidth: boardRect?.width || 0,
      flowWidth: flowRect?.width || 0,
      minMathFontSize: Math.min(...mathFontSizes),
      stepRects,
      finalAnswer: finalAnswer ? {
        visible: finalAnswerRect.width > 0 && finalAnswerRect.height > 0,
        boxShadow: finalAnswerStyle.boxShadow,
        background: finalAnswerStyle.backgroundImage || finalAnswerStyle.backgroundColor,
      } : null,
      nestedVerticalScrollbars,
      mathShells,
      hasInternalMathScroll: mathShells.some((shell) => shell.scrollWidth > shell.clientWidth + tolerance),
      summaryCard: (() => {
        const node = document.querySelector(".omni-problem-summary-card");
        const rect = node?.getBoundingClientRect();
        return node ? {
          width: rect.width,
          height: rect.height,
          escapesViewport: rect.left < -tolerance || rect.right > window.innerWidth + tolerance,
        } : null;
      })(),
    };
  });

  expect(layout.pageOverflow).toBeLessThanOrEqual(2);
  expect(layout.boardWidth).toBeGreaterThanOrEqual(1260);
  expect(layout.flowWidth).toBeGreaterThanOrEqual(1180);
  expect(layout.minMathFontSize).toBeGreaterThanOrEqual(20);
  expect(layout.stepRects.every((rect) => rect.width > 0 && rect.height >= 104 && rect.height <= 420)).toBe(true);
  expect(layout.finalAnswer?.visible).toBe(true);
  expect(`${layout.finalAnswer?.boxShadow || ""} ${layout.finalAnswer?.background || ""}`).toMatch(/emerald|rgba|linear-gradient/i);
  expect(layout.summaryCard?.width).toBeGreaterThanOrEqual(1000);
  expect(layout.summaryCard?.height).toBeGreaterThan(240);
  expect(layout.summaryCard?.escapesViewport).toBe(false);
  expect(layout.nestedVerticalScrollbars).toEqual([]);
  expect(layout.mathShells.every((shell) => shell.width > 0 && shell.height > 0 && !shell.escapesViewport)).toBe(true);
  expect(layout.hasInternalMathScroll).toBe(true);

  await expect(page.locator(".omni-solution-flow .math-token-defer-subtokens .math-interaction-layer")).toHaveCount(0);
  const xCubedToken = page.locator(".omni-solution-flow [data-inspectable='math-subtoken'][data-token-latex='x^3']").first();
  await expect(xCubedToken).toBeVisible();
  const cosineToken = page.locator(".omni-solution-flow [data-inspectable='math-subtoken'][data-token-latex='\\\\cos(xy)']").first();
  const arctanToken = page.locator(".omni-solution-flow [data-inspectable='math-subtoken'][data-token-latex='\\\\arctan(x-y)']").first();
  await expect(cosineToken).toBeVisible();
  await expect(arctanToken).toBeVisible();
  const tokenTarget = await xCubedToken.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const stepRect = node.closest(".step-card")?.getBoundingClientRect();
    return {
      inspectable: node.getAttribute("data-inspectable"),
      width: rect.width,
      stepWidth: stepRect?.width || 0,
    };
  });
  expect(tokenTarget.inspectable).toBe("math-subtoken");
  expect(tokenTarget.width).toBeGreaterThan(0);
  expect(tokenTarget.width).toBeLessThan(tokenTarget.stepWidth / 3);
  const moveToToken = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };

  await moveToToken(xCubedToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await moveToToken(cosineToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();
  await moveToToken(arctanToken);
  await expect(page.locator(".omni-quick-tooltip")).toBeVisible();

  const xBox = await xCubedToken.boundingBox();
  const cosBox = await cosineToken.boundingBox();
  expect(xBox).not.toBeNull();
  expect(cosBox).not.toBeNull();
  await page.mouse.move(xBox.x + xBox.width / 2, xBox.y + xBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cosBox.x + cosBox.width / 2, cosBox.y + cosBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".omni-solution-flow .omni-token-selected")).not.toHaveCount(0);

  const xCubedBoxForPin = await xCubedToken.boundingBox();
  expect(xCubedBoxForPin).not.toBeNull();
  await page.mouse.click(
    xCubedBoxForPin.x + xCubedBoxForPin.width / 2,
    xCubedBoxForPin.y + xCubedBoxForPin.height / 2,
    { button: "right" }
  );
  await expect(page.locator(".omni-floating-window")).toBeVisible();

  const hoverTarget = page.locator("[data-explainable='true']").first();
  await expect(hoverTarget).toBeVisible();
  await hoverTarget.evaluate((node) => node.setAttribute("data-layout-hover-target", "true"));
  await hoverTarget.focus();
  await expect(hoverTarget).toBeFocused();
  await hoverTarget.click();

  await assertLayoutIntegrity(page);
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
