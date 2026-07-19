import fs from "node:fs/promises";
import path from "node:path";
import { resolveUsageIdentity } from "./usageIdentity.js";

const MICROS_PER_USD = 1000000;
const DEFAULT_FREE_DAILY_USER_LIMIT = 25;
const DEFAULT_LOGGED_IN_DAILY_USER_LIMIT = 100;
const DEFAULT_FREE_MONTHLY_USER_LIMIT = 750;
const DEFAULT_LOGGED_IN_MONTHLY_USER_LIMIT = 3000;
const DEFAULT_DAILY_TOKEN_LIMIT = 100000;
const DEFAULT_MONTHLY_TOKEN_LIMIT = 2000000;
const DEFAULT_DAILY_SPEND_LIMIT_USD = 2;
const DEFAULT_MONTHLY_SPEND_LIMIT_USD = 50;
const METRICS = ["requests", "tokens", "costMicros"];
const GLOBAL_USAGE_IDENTITY = {
  key: "global",
  tier: "global",
  subject: "global",
};

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function logUsageDev(event, details = {}) {
  if (isProductionRuntime()) return;
  console.info("[omnimath:usage]", { event, ...details });
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function dollarsToMicros(value) {
  return Math.ceil(value * MICROS_PER_USD);
}

function microsToDollars(value) {
  return Number((Math.max(0, Number(value) || 0) / MICROS_PER_USD).toFixed(6));
}

function getRequestLimits(identity = {}) {
  const dailyAiLimit = readPositiveInteger("DAILY_AI_LIMIT", null);
  const monthlyAiLimit = readPositiveInteger("MONTHLY_AI_LIMIT", null);

  if (identity.tier === "free") {
    return {
      daily: dailyAiLimit || readPositiveInteger("FREE_DAILY_USER_LIMIT", DEFAULT_FREE_DAILY_USER_LIMIT),
      monthly: monthlyAiLimit || readPositiveInteger("FREE_MONTHLY_USER_LIMIT", DEFAULT_FREE_MONTHLY_USER_LIMIT),
    };
  }

  return {
    daily: dailyAiLimit || readPositiveInteger(
      "LOGGED_IN_DAILY_USER_LIMIT",
      readPositiveInteger("DAILY_USER_LIMIT", DEFAULT_LOGGED_IN_DAILY_USER_LIMIT)
    ),
    monthly: monthlyAiLimit || readPositiveInteger(
      "LOGGED_IN_MONTHLY_USER_LIMIT",
      readPositiveInteger("MONTHLY_USER_LIMIT", DEFAULT_LOGGED_IN_MONTHLY_USER_LIMIT)
    ),
  };
}

function getConfiguredLimits(identity = {}) {
  return {
    requests: getRequestLimits(identity),
    tokens: {
      daily: readPositiveInteger("DAILY_TOKEN_LIMIT", DEFAULT_DAILY_TOKEN_LIMIT),
      monthly: readPositiveInteger("MONTHLY_TOKEN_LIMIT", DEFAULT_MONTHLY_TOKEN_LIMIT),
    },
    spendMicros: {
      daily: dollarsToMicros(readPositiveNumber("DAILY_SPEND_LIMIT_USD", DEFAULT_DAILY_SPEND_LIMIT_USD)),
      monthly: dollarsToMicros(readPositiveNumber("MONTHLY_SPEND_LIMIT_USD", DEFAULT_MONTHLY_SPEND_LIMIT_USD)),
    },
  };
}

function getLocalStorePath() {
  return process.env.USAGE_LOCAL_STORE_PATH
    || path.join(process.cwd(), ".data", "usage-limits.json");
}

function getUsageDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getUsageMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getDailyResetDate(date = new Date()) {
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

function getMonthlyResetDate(date = new Date()) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    1,
    0,
    0,
    0,
    0
  ));
}

function getSecondsUntilReset(resetDate) {
  return Math.max(60, Math.ceil((resetDate.getTime() - Date.now()) / 1000));
}

function getUsageKey({ period, periodKey, metric, identity }) {
  return `usage:${period}:${periodKey}:${metric}:${identity.key}`;
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

async function runKvPipeline(commands) {
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
      body: JSON.stringify(commands),
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

  return body;
}

async function addKvUsage(key, amount, ttlSeconds) {
  const command = amount >= 0 ? "INCRBY" : "DECRBY";
  const body = await runKvPipeline([
    [command, key, Math.abs(amount)],
    ["EXPIRE", key, ttlSeconds],
  ]);

  return body ? Math.max(0, Number(body[0].result || 0)) : null;
}

async function readKvUsage(key) {
  const config = getKvConfig();
  if (!config) return null;

  let response;
  try {
    response = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`Usage store request failed: ${error.message}`), {
      statusCode: 503,
      code: "USAGE_STORE_UNAVAILABLE",
      publicMessage: "Usage tracking is temporarily unavailable.",
    });
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw Object.assign(new Error("Usage store rejected the quota lookup."), {
      statusCode: 503,
      code: "USAGE_STORE_UNAVAILABLE",
      publicMessage: "Usage tracking is temporarily unavailable.",
    });
  }

  return Math.max(0, Number(body?.result || 0));
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

function pruneLocalStore(data, currentPeriodPrefixes) {
  for (const storedKey of Object.keys(data)) {
    if (!currentPeriodPrefixes.some((periodKey) => storedKey.startsWith(periodKey))) {
      delete data[storedKey];
    }
  }
}

async function addLocalUsage(key, amount, currentPeriodPrefixes) {
  if (isProductionRuntime()) {
    throw Object.assign(new Error("A Redis REST usage store is required in production."), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "Usage tracking is not configured.",
    });
  }

  const data = await readLocalStore();
  pruneLocalStore(data, currentPeriodPrefixes);

  const count = Math.max(0, Number(data[key]?.count || 0) + amount);
  data[key] = {
    count,
    updatedAt: new Date().toISOString(),
  };

  await writeLocalStore(data);
  return count;
}

async function addUsage(key, amount, ttlSeconds, currentPeriodPrefixes) {
  if (amount === 0) return readUsage(key);

  const kvCount = await addKvUsage(key, amount, ttlSeconds);
  if (kvCount !== null) {
    logUsageDev("write", { source: "kv", key, amount, count: kvCount });
    return kvCount;
  }
  logUsageDev("write", { source: "local-file", key, amount });
  return addLocalUsage(key, amount, currentPeriodPrefixes);
}

async function readUsage(key) {
  const kvCount = await readKvUsage(key);
  if (kvCount !== null) {
    logUsageDev("read", { source: "kv", key, count: kvCount });
    return kvCount;
  }
  if (isProductionRuntime()) {
    throw Object.assign(new Error("A Redis REST usage store is required in production."), {
      statusCode: 500,
      code: "SERVER_CONFIG_ERROR",
      publicMessage: "Usage tracking is not configured.",
    });
  }
  const data = await readLocalStore();
  const count = Math.max(0, Number(data[key]?.count || 0));
  logUsageDev("read", { source: "local-file", key, count });
  return count;
}

function createPeriodPayload({ count, limit, resetDate }) {
  return {
    limit,
    used: Math.min(count, limit),
    remaining: Math.max(0, limit - count),
    resetsAt: resetDate.toISOString(),
    retryAfterSeconds: getSecondsUntilReset(resetDate),
  };
}

function createSpendPeriodPayload({ count, limit, resetDate }) {
  const base = createPeriodPayload({ count, limit, resetDate });
  return {
    ...base,
    limitUsd: microsToDollars(limit),
    usedUsd: microsToDollars(count),
    remainingUsd: microsToDollars(Math.max(0, limit - count)),
  };
}

function createMetricPayload({ count, monthlyCount, limits, dailyResetDate, monthlyResetDate }) {
  return {
    daily: createPeriodPayload({
      count,
      limit: limits.daily,
      resetDate: dailyResetDate,
    }),
    monthly: createPeriodPayload({
      count: monthlyCount,
      limit: limits.monthly,
      resetDate: monthlyResetDate,
    }),
  };
}

function createSpendMetricPayload({ count, monthlyCount, limits, dailyResetDate, monthlyResetDate }) {
  return {
    daily: createSpendPeriodPayload({
      count,
      limit: limits.daily,
      resetDate: dailyResetDate,
    }),
    monthly: createSpendPeriodPayload({
      count: monthlyCount,
      limit: limits.monthly,
      resetDate: monthlyResetDate,
    }),
  };
}

function createUsagePayload({
  identity,
  kind = "ai",
  requestCounts,
  tokenCounts,
  globalTokenCounts = null,
  globalCostCounts = null,
  limits,
  dailyResetDate,
  monthlyResetDate,
}) {
  const requests = createMetricPayload({
    count: requestCounts.daily,
    monthlyCount: requestCounts.monthly,
    limits: limits.requests,
    dailyResetDate,
    monthlyResetDate,
  });
  const tokens = createMetricPayload({
    count: tokenCounts.daily,
    monthlyCount: tokenCounts.monthly,
    limits: limits.tokens,
    dailyResetDate,
    monthlyResetDate,
  });
  const globalTokens = globalTokenCounts
    ? createMetricPayload({
        count: globalTokenCounts.daily,
        monthlyCount: globalTokenCounts.monthly,
        limits: limits.tokens,
        dailyResetDate,
        monthlyResetDate,
      })
    : null;
  const globalSpend = globalCostCounts
    ? createSpendMetricPayload({
        count: globalCostCounts.daily,
        monthlyCount: globalCostCounts.monthly,
        limits: limits.spendMicros,
        dailyResetDate,
        monthlyResetDate,
      })
    : null;

  return {
    kind,
    aggregateKind: "ai",
    tier: identity.tier,
    subject: identity.subject,
    period: "daily",
    ...requests.daily,
    daily: requests.daily,
    monthly: requests.monthly,
    requests,
    tokens,
    globalTokens,
    globalSpend,
  };
}

function createLimitError(usage, metric, period = "daily") {
  const periodUsage = usage[metric]?.[period] || usage[period];
  const resetText = period === "monthly" ? "next month" : "tomorrow";
  const label = metric === "tokens" || metric === "globalTokens" ? "token" : "request";
  const scope = metric === "globalTokens" ? "global " : "";

  return Object.assign(
    new Error(`${period === "monthly" ? "Monthly" : "Daily"} AI ${scope}${label} limit reached.`),
    {
      statusCode: 429,
      code: "USAGE_LIMIT_EXCEEDED",
      publicMessage: `You've reached the ${period} AI ${scope}${label} limit (${periodUsage.limit}/${period}). Your limit resets ${resetText}.`,
      usage,
      retryAfterSeconds: periodUsage.retryAfterSeconds,
    }
  );
}

function createSpendLimitError(usage, period = "daily") {
  const periodUsage = usage.globalSpend?.[period];
  const resetText = period === "monthly" ? "next month" : "tomorrow";

  return Object.assign(
    new Error(`${period === "monthly" ? "Monthly" : "Daily"} AI spend limit reached.`),
    {
      statusCode: 429,
      code: "SPEND_LIMIT_EXCEEDED",
      publicMessage: `AI is paused because the projected ${period} spend would exceed $${periodUsage.limitUsd.toFixed(2)}. The budget resets ${resetText}.`,
      usage,
      retryAfterSeconds: periodUsage.retryAfterSeconds,
    }
  );
}

function getUsageLogUserId(identity = {}) {
  return identity.clerkUserId || identity.userId || identity.subject || identity.key || "unknown";
}

function logUsageBlock({
  identity,
  requestCounts,
  tokenCounts,
  limits,
  exceeded,
  estimatedTokens = 0,
  estimatedCostMicros = 0,
}) {
  console.warn("[usage-limits] Request blocked", {
    userId: getUsageLogUserId(identity),
    tier: identity.tier || "unknown",
    dailyAiUsage: `${requestCounts.daily}/${limits.requests.daily}`,
    dailyTokenUsage: `${tokenCounts.daily}/${limits.tokens.daily}`,
    monthlyAiUsage: `${requestCounts.monthly}/${limits.requests.monthly}`,
    monthlyTokenUsage: `${tokenCounts.monthly}/${limits.tokens.monthly}`,
    estimatedTokens,
    estimatedCostMicros,
    exceeded,
  });
}

function getPeriodState(identity, date = new Date()) {
  const dateKey = getUsageDate(date);
  const monthKey = getUsageMonth(date);
  const dailyResetDate = getDailyResetDate(date);
  const monthlyResetDate = getMonthlyResetDate(date);
  const currentPeriodPrefixes = [`usage:daily:${dateKey}:`, `usage:monthly:${monthKey}:`];
  const keys = {};

  for (const metric of METRICS) {
    keys[metric] = {
      daily: getUsageKey({ period: "daily", periodKey: dateKey, metric, identity }),
      monthly: getUsageKey({ period: "monthly", periodKey: monthKey, metric, identity }),
    };
  }

  return {
    keys,
    dailyResetDate,
    monthlyResetDate,
    currentPeriodPrefixes,
  };
}

async function readCounts(keys) {
  return {
    daily: await readUsage(keys.daily),
    monthly: await readUsage(keys.monthly),
  };
}

async function createCurrentUsage(identity, kind = "ai") {
  const limits = getConfiguredLimits(identity);
  const state = getPeriodState(identity);
  const globalState = getPeriodState(GLOBAL_USAGE_IDENTITY);
  const requestCounts = await readCounts(state.keys.requests);
  const tokenCounts = await readCounts(state.keys.tokens);
  const globalTokenCounts = await readCounts(globalState.keys.tokens);
  const globalCostCounts = await readCounts(globalState.keys.costMicros);

  return createUsagePayload({
    identity,
    kind,
    requestCounts,
    tokenCounts,
    globalTokenCounts,
    globalCostCounts,
    limits,
    dailyResetDate: state.dailyResetDate,
    monthlyResetDate: state.monthlyResetDate,
  });
}

export function createUsageHeaders(usage, { includeRetryAfter = false } = {}) {
  if (!usage) return {};

  const headers = {
    "X-Usage-Kind": usage.kind,
    "X-Usage-Tier": usage.tier,
    "X-Usage-Limit": String(usage.daily?.limit ?? usage.limit),
    "X-Usage-Remaining": String(usage.daily?.remaining ?? usage.remaining),
    "X-Usage-Reset": usage.daily?.resetsAt ?? usage.resetsAt,
    "X-Usage-Monthly-Limit": String(usage.monthly?.limit ?? ""),
    "X-Usage-Monthly-Remaining": String(usage.monthly?.remaining ?? ""),
    "X-Token-Usage-Limit": String(usage.tokens?.daily?.limit ?? ""),
    "X-Token-Usage-Remaining": String(usage.tokens?.daily?.remaining ?? ""),
    "X-Token-Usage-Monthly-Limit": String(usage.tokens?.monthly?.limit ?? ""),
    "X-Token-Usage-Monthly-Remaining": String(usage.tokens?.monthly?.remaining ?? ""),
    "X-Global-Token-Usage-Limit": String(usage.globalTokens?.daily?.limit ?? ""),
    "X-Global-Token-Usage-Remaining": String(usage.globalTokens?.daily?.remaining ?? ""),
    "X-Global-Token-Usage-Monthly-Limit": String(usage.globalTokens?.monthly?.limit ?? ""),
    "X-Global-Token-Usage-Monthly-Remaining": String(usage.globalTokens?.monthly?.remaining ?? ""),
    "X-Global-Spend-Limit-Usd": String(usage.globalSpend?.daily?.limitUsd ?? ""),
    "X-Global-Spend-Remaining-Usd": String(usage.globalSpend?.daily?.remainingUsd ?? ""),
    "X-Global-Spend-Monthly-Limit-Usd": String(usage.globalSpend?.monthly?.limitUsd ?? ""),
    "X-Global-Spend-Monthly-Remaining-Usd": String(usage.globalSpend?.monthly?.remainingUsd ?? ""),
  };

  if (includeRetryAfter) {
    headers["Retry-After"] = String(usage.retryAfterSeconds);
  }

  return headers;
}

export async function checkAndReserveUsage({
  req,
  identity,
  kind,
  estimatedTokens = 0,
  estimatedCostMicros = 0,
}) {
  const usageIdentity = identity || await resolveUsageIdentity(req);
  if (!usageIdentity?.clerkUserId) {
    throw Object.assign(new Error("Sign in is required."), {
      statusCode: 401,
      code: "AUTH_REQUIRED",
      publicMessage: "Sign in is required.",
    });
  }

  const normalizedEstimatedCostMicros = Math.max(0, Math.ceil(Number(estimatedCostMicros) || 0));
  const limits = getConfiguredLimits(usageIdentity);
  const state = getPeriodState(usageIdentity);
  const globalState = getPeriodState(GLOBAL_USAGE_IDENTITY);
  const requestCounts = await readCounts(state.keys.requests);
  const tokenCounts = await readCounts(state.keys.tokens);
  const globalTokenCounts = await readCounts(globalState.keys.tokens);
  const globalCostCounts = await readCounts(globalState.keys.costMicros);
  const currentUsage = createUsagePayload({
    identity: usageIdentity,
    kind,
    requestCounts,
    tokenCounts,
    globalTokenCounts,
    globalCostCounts,
    limits,
    dailyResetDate: state.dailyResetDate,
    monthlyResetDate: state.monthlyResetDate,
  });

  if (requestCounts.daily >= limits.requests.daily) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "daily_ai_usage",
        period: "daily",
        used: requestCounts.daily,
        limit: limits.requests.daily,
      },
    });
    throw createLimitError(currentUsage, "requests", "daily");
  }
  if (requestCounts.monthly >= limits.requests.monthly) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "monthly_ai_usage",
        period: "monthly",
        used: requestCounts.monthly,
        limit: limits.requests.monthly,
      },
    });
    throw createLimitError(currentUsage, "requests", "monthly");
  }
  if (tokenCounts.daily + estimatedTokens > limits.tokens.daily) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "daily_token_usage",
        period: "daily",
        used: tokenCounts.daily,
        projected: tokenCounts.daily + estimatedTokens,
        limit: limits.tokens.daily,
      },
    });
    throw createLimitError(currentUsage, "tokens", "daily");
  }
  if (tokenCounts.monthly + estimatedTokens > limits.tokens.monthly) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "monthly_token_usage",
        period: "monthly",
        used: tokenCounts.monthly,
        projected: tokenCounts.monthly + estimatedTokens,
        limit: limits.tokens.monthly,
      },
    });
    throw createLimitError(currentUsage, "tokens", "monthly");
  }
  if (globalTokenCounts.daily + estimatedTokens > limits.tokens.daily) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "global_daily_token_usage",
        period: "daily",
        used: globalTokenCounts.daily,
        projected: globalTokenCounts.daily + estimatedTokens,
        limit: limits.tokens.daily,
      },
    });
    throw createLimitError(currentUsage, "globalTokens", "daily");
  }
  if (globalTokenCounts.monthly + estimatedTokens > limits.tokens.monthly) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "global_monthly_token_usage",
        period: "monthly",
        used: globalTokenCounts.monthly,
        projected: globalTokenCounts.monthly + estimatedTokens,
        limit: limits.tokens.monthly,
      },
    });
    throw createLimitError(currentUsage, "globalTokens", "monthly");
  }
  if (globalCostCounts.daily + normalizedEstimatedCostMicros > limits.spendMicros.daily) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "global_daily_spend",
        period: "daily",
        used: globalCostCounts.daily,
        projected: globalCostCounts.daily + normalizedEstimatedCostMicros,
        limit: limits.spendMicros.daily,
      },
    });
    throw createSpendLimitError(currentUsage, "daily");
  }
  if (globalCostCounts.monthly + normalizedEstimatedCostMicros > limits.spendMicros.monthly) {
    logUsageBlock({
      identity: usageIdentity,
      requestCounts,
      tokenCounts,
      limits,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      exceeded: {
        metric: "global_monthly_spend",
        period: "monthly",
        used: globalCostCounts.monthly,
        projected: globalCostCounts.monthly + normalizedEstimatedCostMicros,
        limit: limits.spendMicros.monthly,
      },
    });
    throw createSpendLimitError(currentUsage, "monthly");
  }

  logUsageDev("allowed", {
    kind,
    subject: usageIdentity.subject,
    tier: usageIdentity.tier,
    dailyRequests: `${requestCounts.daily}/${limits.requests.daily}`,
    monthlyRequests: `${requestCounts.monthly}/${limits.requests.monthly}`,
    estimatedTokens,
    estimatedCostMicros: normalizedEstimatedCostMicros,
  });

  const dailyTtl = getSecondsUntilReset(state.dailyResetDate) + 3600;
  const monthlyTtl = getSecondsUntilReset(state.monthlyResetDate) + 3600;

  const nextRequestDaily = await addUsage(
    state.keys.requests.daily,
    1,
    dailyTtl,
    state.currentPeriodPrefixes
  );
  const nextRequestMonthly = await addUsage(
    state.keys.requests.monthly,
    1,
    monthlyTtl,
    state.currentPeriodPrefixes
  );
  const nextTokenDaily = await addUsage(
    state.keys.tokens.daily,
    estimatedTokens,
    dailyTtl,
    state.currentPeriodPrefixes
  );
  const nextTokenMonthly = await addUsage(
    state.keys.tokens.monthly,
    estimatedTokens,
    monthlyTtl,
    state.currentPeriodPrefixes
  );
  const nextGlobalTokenDaily = await addUsage(
    globalState.keys.tokens.daily,
    estimatedTokens,
    dailyTtl,
    state.currentPeriodPrefixes
  );
  const nextGlobalTokenMonthly = await addUsage(
    globalState.keys.tokens.monthly,
    estimatedTokens,
    monthlyTtl,
    state.currentPeriodPrefixes
  );
  const nextGlobalCostDaily = await addUsage(
    globalState.keys.costMicros.daily,
    normalizedEstimatedCostMicros,
    dailyTtl,
    state.currentPeriodPrefixes
  );
  const nextGlobalCostMonthly = await addUsage(
    globalState.keys.costMicros.monthly,
    normalizedEstimatedCostMicros,
    monthlyTtl,
    state.currentPeriodPrefixes
  );

  const usage = createUsagePayload({
    identity: usageIdentity,
    kind,
    requestCounts: {
      daily: nextRequestDaily,
      monthly: nextRequestMonthly,
    },
    tokenCounts: {
      daily: nextTokenDaily,
      monthly: nextTokenMonthly,
    },
    globalTokenCounts: {
      daily: nextGlobalTokenDaily,
      monthly: nextGlobalTokenMonthly,
    },
    globalCostCounts: {
      daily: nextGlobalCostDaily,
      monthly: nextGlobalCostMonthly,
    },
    limits,
    dailyResetDate: state.dailyResetDate,
    monthlyResetDate: state.monthlyResetDate,
  });

  return {
    usage,
    reservation: {
      identity: usageIdentity,
      kind,
      estimatedTokens,
      estimatedCostMicros: normalizedEstimatedCostMicros,
      keys: state.keys,
      globalKeys: globalState.keys,
      dailyTtl,
      monthlyTtl,
      currentPeriodPrefixes: state.currentPeriodPrefixes,
    },
  };
}

export async function settleTokenUsage(reservation, actualTokens = 0, actualCostMicros = 0, {
  actualInputTokens = 0,
  actualOutputTokens = 0,
  providerCalls = 1,
  settlementReason = "success",
} = {}) {
  if (!reservation) return null;

  const normalizedActualTokens = Math.max(0, Math.ceil(Number(actualTokens) || 0));
  const normalizedActualCostMicros = Math.max(0, Math.ceil(Number(actualCostMicros) || 0));
  const normalizedProviderCalls = Math.max(0, Math.ceil(Number(providerCalls) || 0));
  const requestDelta = normalizedProviderCalls - 1;
  const tokenDelta = normalizedActualTokens - reservation.estimatedTokens;
  const costDelta = normalizedActualCostMicros - reservation.estimatedCostMicros;
  if (requestDelta !== 0) {
    await addUsage(
      reservation.keys.requests.daily,
      requestDelta,
      reservation.dailyTtl,
      reservation.currentPeriodPrefixes
    );
    await addUsage(
      reservation.keys.requests.monthly,
      requestDelta,
      reservation.monthlyTtl,
      reservation.currentPeriodPrefixes
    );
  }
  if (tokenDelta !== 0) {
    await addUsage(
      reservation.keys.tokens.daily,
      tokenDelta,
      reservation.dailyTtl,
      reservation.currentPeriodPrefixes
    );
    await addUsage(
      reservation.keys.tokens.monthly,
      tokenDelta,
      reservation.monthlyTtl,
      reservation.currentPeriodPrefixes
    );
    await addUsage(
      reservation.globalKeys.tokens.daily,
      tokenDelta,
      reservation.dailyTtl,
      reservation.currentPeriodPrefixes
    );
    await addUsage(
      reservation.globalKeys.tokens.monthly,
      tokenDelta,
      reservation.monthlyTtl,
      reservation.currentPeriodPrefixes
    );
  }
  if (costDelta !== 0) {
    await addUsage(
      reservation.globalKeys.costMicros.daily,
      costDelta,
      reservation.dailyTtl,
      reservation.currentPeriodPrefixes
    );
    await addUsage(
      reservation.globalKeys.costMicros.monthly,
      costDelta,
      reservation.monthlyTtl,
      reservation.currentPeriodPrefixes
    );
  }

  const usage = await createCurrentUsage(reservation.identity, reservation.kind);
  usage.settlement = {
    reservedTokens: reservation.estimatedTokens,
    actualInputTokens: Math.max(0, Math.ceil(Number(actualInputTokens) || 0)),
    actualOutputTokens: Math.max(0, Math.ceil(Number(actualOutputTokens) || 0)),
    actualTotalTokens: normalizedActualTokens,
    estimatedTokens: reservation.estimatedTokens,
    providerCalls: normalizedProviderCalls,
    settledTokens: normalizedActualTokens,
    releasedTokens: Math.max(0, reservation.estimatedTokens - normalizedActualTokens),
    reservedCostMicros: reservation.estimatedCostMicros,
    actualCostMicros: normalizedActualCostMicros,
    settlementReason,
  };
  return usage;
}

export async function releaseTokenReservation(reservation, {
  providerCalls = 1,
  settlementReason = "released",
} = {}) {
  if (!reservation) return null;
  return settleTokenUsage(reservation, 0, 0, { providerCalls, settlementReason });
}

export async function getUsageSnapshot({ req, identity } = {}) {
  const usageIdentity = identity || await resolveUsageIdentity(req);
  if (!usageIdentity?.clerkUserId) {
    throw Object.assign(new Error("Sign in is required."), {
      statusCode: 401,
      code: "AUTH_REQUIRED",
      publicMessage: "Sign in is required.",
    });
  }

  const ai = await createCurrentUsage(usageIdentity, "ai");
  return {
    usage: {
      ai,
      explanation: { ...ai, kind: "explanation" },
      image: { ...ai, kind: "image" },
    },
  };
}
