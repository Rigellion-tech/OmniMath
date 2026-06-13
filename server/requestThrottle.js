const buckets = new Map();

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  const forwarded = readHeader(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return readHeader(req, "x-real-ip")
    || req.socket?.remoteAddress
    || req.connection?.remoteAddress
    || "unknown";
}

function getWindows() {
  return [
    {
      name: "minute",
      ms: 60 * 1000,
      limit: readPositiveInteger("AI_RATE_LIMIT_PER_MINUTE", 10),
    },
    {
      name: "hour",
      ms: 60 * 60 * 1000,
      limit: readPositiveInteger("AI_RATE_LIMIT_PER_HOUR", 100),
    },
  ];
}

function consumeBucket({ key, limit, windowMs, windowName }) {
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw Object.assign(new Error("Too many requests."), {
      statusCode: 429,
      code: "RATE_LIMITED",
      publicMessage: `Too many AI requests this ${windowName}. Please pause and try again.`,
      retryAfterSeconds,
    });
  }
}

export function throttleRequest(req, identity, scope = "ai") {
  const subjects = [
    { label: "user", value: identity?.clerkUserId || identity?.key },
    { label: "ip", value: getClientIp(req) },
  ].filter((subject) => subject.value);

  for (const subject of subjects) {
    for (const window of getWindows()) {
      consumeBucket({
        key: `${scope}:${subject.label}:${subject.value}:${window.name}`,
        limit: window.limit,
        windowMs: window.ms,
        windowName: window.name,
      });
    }
  }
}
