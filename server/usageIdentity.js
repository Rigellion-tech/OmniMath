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

function decodeJwtPayload(token) {
  try {
    const payload = token?.split(".")?.[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function summarizeTokenClaims(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || typeof claims !== "object") return null;

  return {
    userId: claims.sub || null,
    sessionId: claims.sid || claims.session_id || null,
    issuer: claims.iss || null,
    authorizedParty: claims.azp || null,
    audience: claims.aud || null,
    issuedAt: claims.iat || null,
    expiresAt: claims.exp || null,
    notBefore: claims.nbf || null,
  };
}

function summarizeRequestHeaders(req) {
  const authorization = readHeader(req, "authorization");
  const [authScheme, authToken] = authorization?.split(/\s+/) || [];

  return {
    host: readHeader(req, "host") || null,
    origin: readHeader(req, "origin") || null,
    referer: readHeader(req, "referer") || null,
    forwardedHost: readHeader(req, "x-forwarded-host") || null,
    forwardedProto: readHeader(req, "x-forwarded-proto") || null,
    userAgent: readHeader(req, "user-agent") || null,
    contentType: readHeader(req, "content-type") || null,
    contentLength: readHeader(req, "content-length") || null,
    authorization: authorization
      ? {
          present: true,
          scheme: authScheme || null,
          tokenChars: authToken?.length || 0,
        }
      : { present: false },
    cookie: { present: Boolean(readHeader(req, "cookie")) },
  };
}

function getAuthRuntimeConfig() {
  return {
    hasClerkSecretKey: Boolean(process.env.CLERK_SECRET_KEY),
    hasClerkJwtKey: Boolean(process.env.CLERK_JWT_KEY),
    authorizedParties: getAuthorizedParties(),
  };
}

export function getClerkAuthRuntimeConfig() {
  return getAuthRuntimeConfig();
}

function logAuthAttempt(req, status, details = {}) {
  console.info("[omnimath:clerk-auth]", {
    status,
    method: req.method,
    path: req.url,
    headers: summarizeRequestHeaders(req),
    clerk: getAuthRuntimeConfig(),
    ...details,
  });
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
    || process.env.CLERK_SECRET_KEY
    || process.env.CLERK_JWT_KEY
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

function getProfileFromClaims(claims) {
  return {
    email: claims.email || claims.primary_email_address,
    displayName: claims.name || claims.full_name,
    imageUrl: claims.image_url || claims.picture,
  };
}

function createAuthError(message, statusCode = 401, code = "AUTH_REQUIRED") {
  return Object.assign(new Error(message), {
    statusCode,
    code,
    publicMessage: message,
  });
}

function createAuthDebug(req, status, token, error = null) {
  return {
    status,
    tokenClaims: summarizeTokenClaims(token),
    headers: summarizeRequestHeaders(req),
    clerk: getAuthRuntimeConfig(),
    error: error
      ? {
          name: error.name,
          code: error.code,
          reason: error.reason,
          message: error.message,
        }
      : null,
  };
}

async function getClerkIdentity(req, { requireValid = false } = {}) {
  const token = getBearerToken(req);
  const secretKey = process.env.CLERK_SECRET_KEY;
  const jwtKey = process.env.CLERK_JWT_KEY;
  if (!token) {
    if (requireValid) {
      logAuthAttempt(req, "missing_token", {
        tokenClaims: null,
        authRequired: true,
      });
      const error = createAuthError("Sign in is required.");
      error.authDebug = createAuthDebug(req, "missing_token", token);
      throw error;
    }
    return null;
  }
  if (!secretKey && !jwtKey) {
    if (requireValid) {
      logAuthAttempt(req, "server_not_configured", {
        tokenClaims: summarizeTokenClaims(token),
        authRequired: true,
      });
      const error = createAuthError("Authentication is not configured.", 500, "SERVER_CONFIG_ERROR");
      error.authDebug = createAuthDebug(req, "server_not_configured", token);
      throw error;
    }
    return null;
  }

  try {
    logAuthAttempt(req, "verifying", {
      tokenClaims: summarizeTokenClaims(token),
      authRequired: requireValid,
    });

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

    logAuthAttempt(req, "verified", {
      userId: claims.sub,
      sessionId: claims.sid || claims.session_id || null,
      authRequired: requireValid,
    });

    const salt = process.env.USAGE_IDENTITY_HMAC_SECRET
      || secretKey
      || jwtKey
      || DEFAULT_ANON_SALT;

    return {
      key: hashIdentity(`clerk:${claims.sub}`, salt),
      tier: getTierFromClaims(claims),
      subject: "clerk",
      clerkUserId: claims.sub,
      profile: getProfileFromClaims(claims),
    };
  } catch (error) {
    logAuthAttempt(req, "verification_failed", {
      tokenClaims: summarizeTokenClaims(token),
      authRequired: requireValid,
      error: {
        name: error.name,
        code: error.code,
        reason: error.reason,
        message: error.message,
        stack: error.stack,
      },
    });
    if (requireValid) {
      const authError = createAuthError("Your session could not be verified.", 401, "AUTH_INVALID");
      authError.authDebug = createAuthDebug(req, "verification_failed", token, error);
      throw authError;
    }
    return null;
  }
}

export async function requireClerkIdentity(req) {
  return getClerkIdentity(req, { requireValid: true });
}

export async function resolveClerkIdentity(req) {
  return getClerkIdentity(req);
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
