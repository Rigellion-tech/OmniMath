import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
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
