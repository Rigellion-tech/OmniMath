import crypto from "node:crypto";

const cache = new Map();
const MAX_ENTRIES = 300;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function createExplanationCacheKey({
  userId,
  problem,
  reference = "",
  depth = "intermediate",
  type = "text",
  imageHash = "",
}) {
  const source = stableStringify({
    userId,
    problem: String(problem || "").trim().toLowerCase(),
    reference,
    depth,
    type,
    imageHash,
  });

  return crypto.createHash("sha256").update(source).digest("hex");
}

export function createImageHash(file) {
  if (!file?.buffer) return "";
  return crypto.createHash("sha256").update(file.buffer).digest("hex");
}

export function getCachedExplanation(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return structuredClone(hit);
}

export function setCachedExplanation(key, value) {
  cache.set(key, structuredClone(value));
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}
