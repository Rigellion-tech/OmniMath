import { isDatabaseConfigured, query } from "./db.js";
import { requireClerkIdentity, resolveClerkIdentity } from "./usageIdentity.js";

const HISTORY_LIMIT = 50;
const SESSION_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isProductionRuntime() {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function isMissingUserSchemaError(error) {
  const message = String(error?.message || error?.cause?.message || "");
  return error?.pgCode === "42P01"
    || error?.cause?.code === "42P01"
    || /relation\s+"?(app_users|user_explanations|user_sessions)"?\s+does not exist/i.test(message);
}

function canUseDevUserDataFallback(error) {
  return !isProductionRuntime() && (error?.code === "DATABASE_UNAVAILABLE" || isMissingUserSchemaError(error));
}

function logDevUserDataFallback(operation, error) {
  console.warn("[omnimath:user-data-fallback]", {
    operation,
    reason: "missing local user data schema",
    code: error?.pgCode || error?.cause?.code || error?.code,
    message: error?.message,
  });
}

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeProfile(profile = {}, identity = {}) {
  const identityProfile = identity.profile || {};

  return {
    email: cleanString(profile.email) || cleanString(identityProfile.email),
    displayName: cleanString(profile.displayName) || cleanString(identityProfile.displayName),
    imageUrl: cleanString(profile.imageUrl) || cleanString(identityProfile.imageUrl),
  };
}

function serializeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    clerkUserId: row.clerk_user_id,
    email: row.email,
    displayName: row.display_name,
    imageUrl: row.image_url,
    tier: row.tier,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function serializeExplanation(row) {
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    originalProblem: row.original_problem,
    expression: row.expression,
    finalAnswer: row.final_answer,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

function serializeSession(row) {
  const payload = row.payload || {};

  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    demoKey: typeof payload.demoKey === "string" ? payload.demoKey : null,
    problems: Array.isArray(payload.problems) ? payload.problems : [],
    problem: payload.problem || (Array.isArray(payload.problems) ? payload.problems[payload.problems.length - 1] : null),
    steps: Array.isArray(payload.steps) ? payload.steps : payload.problem?.steps || [],
    pinnedWindows: Array.isArray(payload.pinnedWindows) ? payload.pinnedWindows : [],
  };
}

function normalizeSessionPayload(session = {}) {
  const problem = session.problem || null;
  const problems = Array.isArray(session.problems)
    ? session.problems
    : problem
      ? [problem]
      : [];

  return {
    messages: Array.isArray(session.messages) ? session.messages : [],
    demoKey: typeof session.demoKey === "string" ? session.demoKey : null,
    problems,
    problem,
    steps: Array.isArray(session.steps) ? session.steps : problem?.steps || [],
    pinnedWindows: Array.isArray(session.pinnedWindows) ? session.pinnedWindows : [],
  };
}

function getSessionTitle(session = {}) {
  const fromTitle = cleanString(session.title);
  if (fromTitle) return fromTitle.slice(0, 120);

  const firstMessage = cleanString(session.messages?.find?.((item) => item?.role === "user")?.text);
  if (firstMessage) return firstMessage.slice(0, 80);

  const problem = session.problem || session.problems?.[0];
  return cleanString(problem?.title)
    || cleanString(problem?.originalProblem)
    || cleanString(problem?.expression)
    || "New math session";
}

async function requireCurrentUser(req, profile = {}) {
  let identity;
  try {
    identity = await requireClerkIdentity(req);
  } catch (error) {
    if (!isProductionRuntime()) {
      console.warn("[omnimath:user-data-fallback]", {
        operation: "auth",
        reason: "using local dev user identity",
        code: error.code,
        message: error.message,
      });
      identity = {
        key: "local-dev-user-data",
        tier: "local",
        subject: "local-dev",
        clerkUserId: "local-dev-user-data",
        profile: {},
      };
    } else {
      throw error;
    }
  }
  return upsertUserRecord(identity, profile);
}

export async function upsertUserRecord(identity, profile = {}) {
  if (!identity?.clerkUserId) return null;

  const normalized = normalizeProfile(profile, identity);
  const result = await query(
    `
      insert into app_users (
        clerk_user_id,
        email,
        display_name,
        image_url,
        tier,
        last_seen_at
      )
      values ($1, $2, $3, $4, $5, now())
      on conflict (clerk_user_id) do update set
        email = coalesce(excluded.email, app_users.email),
        display_name = coalesce(excluded.display_name, app_users.display_name),
        image_url = coalesce(excluded.image_url, app_users.image_url),
        tier = excluded.tier,
        last_seen_at = now(),
        updated_at = now()
      returning *
    `,
    [
      identity.clerkUserId,
      normalized.email,
      normalized.displayName,
      normalized.imageUrl,
      identity.tier === "pro" ? "pro" : "free",
    ]
  );

  return serializeUser(result.rows[0]);
}

export async function getCurrentUserData(req, profile = {}) {
  try {
    const user = await requireCurrentUser(req, profile);
    return { user, databaseConfigured: true };
  } catch (error) {
    if (canUseDevUserDataFallback(error)) {
      logDevUserDataFallback("current-user", error);
      return { user: null, databaseConfigured: false, fallback: "missing_local_schema" };
    }
    throw error;
  }
}

export async function getCurrentUserHistory(req) {
  try {
    const user = await requireCurrentUser(req);
    const result = await query(
      `
        select id, source, title, original_problem, expression, final_answer, payload, created_at
        from user_explanations
        where user_id = $1
        order by created_at desc
        limit $2
      `,
      [user.id, HISTORY_LIMIT]
    );

    return {
      user,
      items: result.rows.map(serializeExplanation),
    };
  } catch (error) {
    if (canUseDevUserDataFallback(error)) {
      logDevUserDataFallback("history", error);
      return { user: null, items: [], databaseConfigured: false, fallback: "missing_local_schema" };
    }
    throw error;
  }
}

export async function getCurrentUserSessions(req) {
  try {
    const user = await requireCurrentUser(req);
    const result = await query(
      `
        select id, title, payload, created_at, updated_at
        from user_sessions
        where user_id = $1
        order by updated_at desc
        limit $2
      `,
      [user.id, SESSION_LIMIT]
    );

    return {
      user,
      sessions: result.rows.map(serializeSession),
    };
  } catch (error) {
    if (canUseDevUserDataFallback(error)) {
      logDevUserDataFallback("sessions:list", error);
      return { user: null, sessions: [], databaseConfigured: false, fallback: "missing_local_schema" };
    }
    throw error;
  }
}

export async function createUserSessionForRequest(req, session) {
  const payload = normalizeSessionPayload(session);
  const title = getSessionTitle(session);
  const clientSessionId = typeof session.id === "string" && UUID_RE.test(session.id)
    ? session.id
    : null;
  try {
    const user = await requireCurrentUser(req);
    const result = clientSessionId
      ? await query(
        `
          insert into user_sessions (id, user_id, title, payload)
          values ($1, $2, $3, $4)
          on conflict (id) do update set
            title = excluded.title,
            payload = excluded.payload,
            updated_at = now()
          where user_sessions.user_id = excluded.user_id
          returning id, title, payload, created_at, updated_at
        `,
        [clientSessionId, user.id, title, payload]
      )
      : await query(
        `
          insert into user_sessions (user_id, title, payload)
          values ($1, $2, $3)
          returning id, title, payload, created_at, updated_at
        `,
        [user.id, title, payload]
      );

    if (result.rows.length === 0) {
      throw Object.assign(new Error("Session id is already in use."), {
        statusCode: 409,
        code: "SESSION_ID_CONFLICT",
        publicMessage: "That session could not be saved.",
      });
    }

    return {
      user,
      session: serializeSession(result.rows[0]),
    };
  } catch (error) {
    if (canUseDevUserDataFallback(error)) {
      logDevUserDataFallback("sessions:create", error);
      const now = new Date().toISOString();
      return {
        user: null,
        databaseConfigured: false,
        fallback: "missing_local_schema",
        session: {
          id: clientSessionId || session.id || `local-${Date.now()}`,
          title,
          createdAt: now,
          updatedAt: now,
          ...serializeSession({ id: clientSessionId || session.id || `local-${Date.now()}`, title, payload, created_at: now, updated_at: now }),
        },
      };
    }
    throw error;
  }
}

export async function updateUserSessionForRequest(req, sessionId, session) {
  const payload = normalizeSessionPayload(session);
  const title = getSessionTitle(session);
  try {
    const user = await requireCurrentUser(req);
    const result = await query(
      `
        update user_sessions
        set title = $3,
          payload = $4,
          updated_at = now()
        where id = $2
          and user_id = $1
        returning id, title, payload, created_at, updated_at
      `,
      [user.id, sessionId, title, payload]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error("Session not found."), {
        statusCode: 404,
        code: "NOT_FOUND",
        publicMessage: "That session could not be found.",
      });
    }

    return {
      user,
      session: serializeSession(result.rows[0]),
    };
  } catch (error) {
    if (canUseDevUserDataFallback(error)) {
      logDevUserDataFallback("sessions:update", error);
      const now = new Date().toISOString();
      return {
        user: null,
        databaseConfigured: false,
        fallback: "missing_local_schema",
        session: serializeSession({ id: sessionId, title, payload, created_at: session.createdAt || now, updated_at: now }),
      };
    }
    throw error;
  }
}

export async function saveExplanationForRequest(req, { source, problem, result, identity: verifiedIdentity = null }) {
  if (!isDatabaseConfigured()) return null;

  const identity = verifiedIdentity?.clerkUserId ? verifiedIdentity : await resolveClerkIdentity(req);
  if (!identity?.clerkUserId) return null;

  const user = await upsertUserRecord(identity);
  const saved = await query(
    `
      insert into user_explanations (
        user_id,
        source,
        title,
        original_problem,
        expression,
        final_answer,
        payload
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      returning id, created_at
    `,
    [
      user.id,
      source,
      result.title || null,
      result.originalProblem || problem || result.expression || null,
      result.expression || null,
      result.finalAnswer || null,
      result,
    ]
  );

  return {
    id: saved.rows[0].id,
    createdAt: saved.rows[0].created_at,
  };
}
