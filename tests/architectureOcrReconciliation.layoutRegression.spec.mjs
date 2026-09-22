import "./helpers/noExternalNetwork.mjs";

import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

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

function readableImage() {
  const width = 1000;
  const height = 760;
  const channels = 3;
  const rowLength = width * channels;
  const raw = Buffer.alloc((rowLength + 1) * height, 255);
  for (let y = 0; y < height; y += 1) raw[y * (rowLength + 1)] = 0;
  for (let line = 0; line < 9; line += 1) {
    const startY = 70 + line * 70;
    for (let y = startY; y < startY + 18; y += 1) {
      const rowStart = y * (rowLength + 1) + 1;
      for (let x = 130; x < 820 - line * 12; x += 1) {
        const offset = rowStart + x * channels;
        raw[offset] = 8;
        raw[offset + 1] = 16;
        raw[offset + 2] = 20;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("one reviewed OCR click emits one solve; a second explicit click gets a second ID", async ({ page }) => {
  const problem = "Solve x + 7 = 9.";
  const solveBodies = [];
  await page.route("**/api/extract-image-problem", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      extractedProblemText: problem,
      rawExtractedText: problem,
      rawOcrText: problem,
      extractedProblemLatex: "x+7=9",
      confidence: 64,
      mathIntegrityScore: 64,
      confidenceTier: "medium",
      ocrConfidence: 95,
      issues: [
        { type: "ocr_text_cleanup_review", severity: "medium", critical: false },
        { type: "text_latex_mismatch", severity: "medium", critical: false },
      ],
      extractionValidation: {
        status: "warning",
        tier: "medium",
        critical: false,
        confidence: 64,
        mathIntegrityScore: 64,
        ocrConfidence: 95,
        issues: [
          { type: "ocr_text_cleanup_review", severity: "medium", critical: false },
          { type: "text_latex_mismatch", severity: "medium", critical: false },
        ],
        metrics: { differenceRatio: 0.649 },
      },
      ocrSolveDecision: {
        solveDecision: "direct",
        reviewRequired: true,
        allowed: false,
        reason: "ocr-structural-review-required",
      },
      imageSource: { imageHash: "server-byte-hash" },
      usage: { kind: "image", remaining: 998, limit: 999 },
    }),
  }));
  await page.route("**/api/solve-extracted-problem", async (route) => {
    const body = route.request().postDataJSON();
    solveBodies.push(body);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AI_SERVICE_UNAVAILABLE",
        message: "AI service timed out or connection dropped. Try again.",
        requestId: body.debugRequestId,
      }),
    });
  });

  await page.goto("/?mockAuth=1");
  await page.locator("input[type='file']").setInputFiles({
    name: "review-state.png",
    mimeType: "image/png",
    buffer: readableImage(),
  });
  await expect(page.getByRole("button", { name: /Analyze with AI/i })).toBeEnabled();
  await page.getByRole("button", { name: /Analyze with AI/i }).click();

  const continueButton = page.getByRole("button", { name: /Continue with reviewed text/i });
  await expect(continueButton).toBeEnabled();
  await expect(page.getByText(/Review highlighted parts before solving/i)).toBeVisible();
  await expect(page.getByText(/reviewed extraction/i)).toHaveCount(0);
  await continueButton.click();
  await expect(page.getByText("AI service timed out or connection dropped. Try again.", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Automated check flagged review", { exact: true })).toBeVisible();
  await expect(page.getByText(/From image OCR · reviewed extraction/i)).toBeVisible();
  expect(solveBodies).toHaveLength(1);
  expect(solveBodies[0].solveDecision).toBe("confirmed");
  expect(solveBodies[0].reviewAction).toEqual({
    kind: "confirmed_unchanged",
    canonicalInputHash: solveBodies[0].canonicalProblem.hash,
  });
  expect(solveBodies[0].problemInput.sourceMetadata.extraction.imageSource.imageHash).toBe("server-byte-hash");

  await page.waitForTimeout(250);
  expect(solveBodies).toHaveLength(1);

  await page.getByRole("button", { name: /Retry solve/i }).click();
  await expect.poll(() => solveBodies.length).toBe(2);
  expect(solveBodies[1].debugRequestId).not.toBe(solveBodies[0].debugRequestId);
  expect(solveBodies[1].reviewAction).toEqual(solveBodies[0].reviewAction);
  expect(solveBodies[1].problemInput.sourceMetadata.extraction.imageSource.imageHash).toBe("server-byte-hash");
});
