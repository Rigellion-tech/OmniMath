import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787/api/explain-image";
const DEFAULT_IMAGE_PATH = "tests/fixtures/image-problem.png";

const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function usage() {
  console.error([
    "Usage:",
    "  node scripts/test-explain-image.mjs <image-path> [endpoint]",
    "",
    "Environment:",
    "  OMNIMATH_TEST_AUTH_TOKEN  Clerk bearer token for local authenticated endpoints",
    "",
    "Example:",
    "  node scripts/test-explain-image.mjs tests/fixtures/image-problem.png http://127.0.0.1:8787/api/explain-image",
  ].join("\n"));
}

const imagePath = process.argv[2] || DEFAULT_IMAGE_PATH;
const endpoint = process.argv[3] || process.env.OMNIMATH_TEST_ENDPOINT || DEFAULT_ENDPOINT;
const absoluteImagePath = path.resolve(imagePath);
const extension = path.extname(absoluteImagePath).toLowerCase();
const mimeType = MIME_BY_EXTENSION.get(extension);

if (!mimeType) {
  usage();
  throw new Error(`Unsupported image extension: ${extension || "(none)"}`);
}

const imageBytes = await readFile(absoluteImagePath);
const form = new FormData();
form.append("prompt", "Please solve and explain the math problem shown in this image.");
form.append("file", new Blob([imageBytes], { type: mimeType }), path.basename(absoluteImagePath));

const headers = {};
if (process.env.OMNIMATH_TEST_AUTH_TOKEN) {
  headers.Authorization = `Bearer ${process.env.OMNIMATH_TEST_AUTH_TOKEN}`;
}

const response = await fetch(endpoint, {
  method: "POST",
  headers,
  body: form,
});

const contentType = response.headers.get("content-type") || "";
const body = contentType.includes("application/json")
  ? await response.json()
  : await response.text();

console.log(`status: ${response.status}`);

if (!response.ok) {
  console.log("response:");
  console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  process.exitCode = 1;
} else {
  console.log(`extractedProblemText: ${body.extractedProblemText || ""}`);
  console.log(`extractedProblemLatex: ${body.extractedProblemLatex || body.expression || ""}`);
  console.log(`firstStepEquationLatex: ${body.steps?.[0]?.math || body.steps?.[0]?.lines?.[0]?.latex || ""}`);
  console.log(`finalAnswerLatex: ${body.finalAnswerLatex || body.finalAnswer || ""}`);
  console.log(`runtimeSource: ${body.runtime?.source || ""}`);
}
