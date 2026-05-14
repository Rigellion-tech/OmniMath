import fs from "node:fs/promises";
import path from "node:path";
import { resolveUsageIdentity } from "./usageIdentity.js";

const USAGE_LIMITS = {
  explanation: {
    anonymous: 3,
    free: 10,
    pro: 100,
  },
  image: {
    anonymous: 1,
    free: 3,
    pro: 25,
  },
};

const KIND_LABELS = {
  explanation: "explanation",
  image: "image upload",
};

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function getLocalStorePath() {
  return process.env.USAGE_LOCAL_STORE_PATH
    || path.join(process.cwd(), ".data", "usage-limits.json");
}

function getUsageDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getResetDate(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  ));
}

function getSecondsUntilReset(resetDate) {
  return Math.max(60, Math.ceil((resetDate.getTime() - Date.now()) / 1000));
}

function getUsageKey({ dateKey, kind, identity }) {
  return `usage:${dateKey}:${kind}:${identity.key}`;
}

function getKvConfig() {
  const url = process.env.USAGE_KV_REST_API_URL
    || process.env.KV_REST_API_URL
    || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.USAGE_KV_REST_API_TOKEN
    || process.env.KV_REST_API_TOKEN
    || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function incrementKvUsage(key, ttlSeconds) {
  const config = getKvConfig();
  if (!config) return null;

  let response;
  try {
    response = await fetch(`${config.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, ttlSeconds],
      ]),
    });
  } catch (error) {
    throw Object.assign(new Error(`Usage store request failed: ${error.message}`), {
      statusCode: 503,
      code: "USAGE_STORE_UNAVAILABLE",
      publicMessage: "Usage tracking is temporarily unavailable.",
    });
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok || !Array.isArray(body) || body.some((item) => item?.error)) {
    throw Object.assign(new Error("Usage store rejected the quota update."), {
      statusCode: 503,
      code: "USAGE_STORE_UNAVAILABLE",
      publicMessage: "Usage tracking is temporarily unavailable.",
    });
  }

  return Number(body[0].result || 0);
}

async function readLocalStore() {
  const localStorePath = getLocalStorePath();
  try {
    const text = await fs.readFile(localStorePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeLocalStore(data) {
  const localStorePath = getLocalStorePath();
  await fs.mkdir(path.dirname(localStorePath), { recursive: true });
  await fs.writeFile(localStorePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function incrementLocalUsage(key, dateKey) {
  if (isProductionRuntime()) {
    throw Object.assign(new Error("A Redis REST usage store is required in production."), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "Usage tracking is not configured.",
    });
  }

  const data = await readLocalStore();
  for (const storedKey of Object.keys(data)) {
    if (!storedKey.startsWith(`usage:${dateKey}:`)) {
      delete data[storedKey];
    }
  }

  const count = Number(data[key]?.count || 0) + 1;
  data[key] = {
    count,
    updatedAt: new Date().toISOString(),
  };

  await writeLocalStore(data);
  return count;
}

async function incrementUsage(key, ttlSeconds, dateKey) {
  const kvCount = await incrementKvUsage(key, ttlSeconds);
  if (kvCount !== null) return kvCount;
  return incrementLocalUsage(key, dateKey);
}

function createUsagePayload({ count, identity, kind, limit, resetDate }) {
  return {
    kind,
    tier: identity.tier,
    subject: identity.subject,
    limit,
    used: Math.min(count, limit),
    remaining: Math.max(0, limit - count),
    resetsAt: resetDate.toISOString(),
    retryAfterSeconds: getSecondsUntilReset(resetDate),
  };
}

function createLimitError(usage) {
  const label = KIND_LABELS[usage.kind] || "request";
  return Object.assign(
    new Error(`Daily ${label} limit reached.`),
    {
      statusCode: 429,
      code: "USAGE_LIMIT_EXCEEDED",
      publicMessage: `You've reached your daily ${label} limit (${usage.limit}/day). Your limit resets tomorrow.`,
      usage,
    }
  );
}

export function createUsageHeaders(usage, { includeRetryAfter = false } = {}) {
  if (!usage) return {};

  const headers = {
    "X-Usage-Kind": usage.kind,
    "X-Usage-Tier": usage.tier,
    "X-Usage-Limit": String(usage.limit),
    "X-Usage-Remaining": String(usage.remaining),
    "X-Usage-Reset": usage.resetsAt,
  };

  if (includeRetryAfter) {
    headers["Retry-After"] = String(usage.retryAfterSeconds);
  }

  return headers;
}

export async function checkAndIncrementUsage({ req, kind }) {
  const limits = USAGE_LIMITS[kind];
  if (!limits) {
    throw Object.assign(new Error(`Unknown usage kind: ${kind}`), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "Usage tracking is misconfigured.",
    });
  }

  const identity = await resolveUsageIdentity(req);
  const limit = limits[identity.tier] ?? limits.anonymous;
  const dateKey = getUsageDate();
  const resetDate = getResetDate();
  const key = getUsageKey({ dateKey, kind, identity });
  const count = await incrementUsage(key, getSecondsUntilReset(resetDate) + 3600, dateKey);
  const usage = createUsagePayload({ count, identity, kind, limit, resetDate });

  if (count > limit) {
    throw createLimitError(usage);
  }

  return usage;
}
