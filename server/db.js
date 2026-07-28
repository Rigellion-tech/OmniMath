import pg from "pg";

const { Pool } = pg;

let pool;

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

function shouldUseSsl(connectionString) {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.DATABASE_SSL === "true") return true;

  return !/localhost|127\.0\.0\.1/i.test(connectionString);
}

export function isDatabaseConfigured() {
  return Boolean(getConnectionString());
}

function getPool() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw Object.assign(new Error("DATABASE_URL is not configured."), {
      statusCode: 503,
      code: "DATABASE_UNAVAILABLE",
      publicMessage: "User data storage is not configured.",
    });
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX || 3),
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

export async function query(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (error) {
    if (error.statusCode) throw error;
    throw Object.assign(new Error(`Database query failed: ${error.message}`), {
      statusCode: 503,
      code: "DATABASE_UNAVAILABLE",
      publicMessage: "User data storage is temporarily unavailable.",
      cause: error,
      pgCode: error.code,
      relation: error.table || error.relation,
    });
  }
}
