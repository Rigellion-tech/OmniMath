import { isDatabaseConfigured, query } from "./db.js";
import { requireClerkIdentity, resolveClerkIdentity } from "./usageIdentity.js";

const HISTORY_LIMIT = 50;
const SESSION_LIMIT = 100;

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
  const identity = await requireClerkIdentity(req);
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
  const user = await requireCurrentUser(req, profile);
  return { user, databaseConfigured: true };
}

export async function getCurrentUserHistory(req) {
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
}

export async function getCurrentUserSessions(req) {
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
}

export async function createUserSessionForRequest(req, session) {
  const user = await requireCurrentUser(req);
  const payload = normalizeSessionPayload(session);
  const title = getSessionTitle(session);
  const result = await query(
    `
      insert into user_sessions (user_id, title, payload)
      values ($1, $2, $3)
      returning id, title, payload, created_at, updated_at
    `,
    [user.id, title, payload]
  );

  return {
    user,
    session: serializeSession(result.rows[0]),
  };
}

export async function updateUserSessionForRequest(req, sessionId, session) {
  const user = await requireCurrentUser(req);
  const payload = normalizeSessionPayload(session);
  const title = getSessionTitle(session);
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
}

export async function saveExplanationForRequest(req, { source, problem, result }) {
  if (!isDatabaseConfigured()) return null;

  const identity = await resolveClerkIdentity(req);
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
