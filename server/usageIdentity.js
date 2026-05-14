import crypto from "node:crypto";
import { verifyToken } from "@clerk/backend";

const SIGNED_TIERS = new Set(["free", "pro"]);
const DEFAULT_ANON_SALT = "omnimath-local-usage-salt";

function readHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getBearerToken(req) {
  const authorization = readHeader(req, "authorization");
  if (!authorization) return null;

  const [type, token] = authorization.split(/\s+/);
  return type?.toLowerCase() === "bearer" && token ? token : null;
}

function hmac(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashIdentity(value, salt) {
  return crypto.createHmac("sha256", salt).update(value).digest("hex");
}

function getClientIp(req) {
  const forwarded = readHeader(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();

  return readHeader(req, "x-real-ip")
    || req.socket?.remoteAddress
    || req.connection?.remoteAddress
    || "unknown";
}

function getAnonymousIdentity(req) {
  const salt = process.env.USAGE_IDENTITY_HMAC_SECRET
    || process.env.OPENAI_API_KEY
    || DEFAULT_ANON_SALT;
  const userAgent = readHeader(req, "user-agent") || "unknown";
  const fingerprint = `anonymous:${getClientIp(req)}:${userAgent}`;

  return {
    key: hashIdentity(fingerprint, salt),
    tier: "anonymous",
    subject: "anonymous",
  };
}

function getAuthorizedParties() {
  return (process.env.CLERK_AUTHORIZED_PARTIES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readClaim(claims, path) {
  return path
    .split(".")
    .reduce((current, key) => (
      current && typeof current === "object" ? current[key] : undefined
    ), claims);
}

function getTierFromClaims(claims) {
  const tierClaim = process.env.CLERK_TIER_CLAIM || "omnimath_tier";
  const candidates = [
    readClaim(claims, tierClaim),
    claims.omnimath_tier,
    claims.tier,
    claims.plan,
  ];
  const tier = candidates
    .find((value) => typeof value === "string")
    ?.toLowerCase();

  return tier === "pro" ? "pro" : "free";
}

async function getClerkIdentity(req) {
  const token = getBearerToken(req);
  const secretKey = process.env.CLERK_SECRET_KEY;
  const jwtKey = process.env.CLERK_JWT_KEY;
  if (!token || (!secretKey && !jwtKey)) return null;

  try {
    const options = {
      secretKey,
      jwtKey,
    };
    const authorizedParties = getAuthorizedParties();
    if (authorizedParties.length > 0) {
      options.authorizedParties = authorizedParties;
    }

    const claims = await verifyToken(token, options);
    if (!claims?.sub) return null;

    const salt = process.env.USAGE_IDENTITY_HMAC_SECRET
      || secretKey
      || jwtKey
      || DEFAULT_ANON_SALT;

    return {
      key: hashIdentity(`clerk:${claims.sub}`, salt),
      tier: getTierFromClaims(claims),
      subject: "clerk",
      clerkUserId: claims.sub,
    };
  } catch {
    return null;
  }
}

export async function resolveUsageIdentity(req) {
  const clerkIdentity = await getClerkIdentity(req);
  if (clerkIdentity) return clerkIdentity;

  const secret = process.env.USAGE_IDENTITY_HMAC_SECRET;
  const userId = readHeader(req, "x-omnimath-user-id");
  const tier = readHeader(req, "x-omnimath-user-tier");
  const signature = readHeader(req, "x-omnimath-user-signature");

  if (secret && userId && tier && signature && SIGNED_TIERS.has(tier)) {
    const expected = hmac(`${userId}:${tier}`, secret);
    if (safeEqual(signature, expected)) {
      return {
        key: hashIdentity(`user:${userId}`, secret),
        tier,
        subject: "signed_header",
      };
    }
  }

  return getAnonymousIdentity(req);
}
