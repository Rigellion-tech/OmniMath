const DEFAULT_DEPLOYMENT_HEADROOM_MS = 5_000;
const MIN_DEPLOYMENT_HEADROOM_MS = 5_000;

// Keep this map in sync with the canonical-solve entries in vercel.json.
// A focused configuration test prevents the deployment and runtime views from
// drifting apart without requiring vercel.json to be bundled with a function.
export const VERCEL_SOLVE_MAX_DURATION_MS = Object.freeze({
  "/api/explain": 300_000,
  "/api/explain-image": 300_000,
  "/api/solve-extracted-problem": 300_000,
});

function configError(message) {
  return Object.assign(new Error(message), {
    statusCode: 500,
    code: "SERVER_CONFIG_ERROR",
    publicMessage: "The solve runtime is not configured correctly.",
  });
}

function optionalPositiveInteger(name) {
  const raw = process.env[name];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw configError(`${name} must be a positive number of milliseconds.`);
  }
  return Math.max(1, Math.round(parsed));
}

function deploymentHeadroomMs() {
  const configured = optionalPositiveInteger("OMNIMATH_SOLVE_INFRA_HEADROOM_MS");
  return Math.max(MIN_DEPLOYMENT_HEADROOM_MS, configured || DEFAULT_DEPLOYMENT_HEADROOM_MS);
}

function runtimeStartedAtMs(value, now) {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? parsed
    : now;
}

export function resolveSolveRuntime({
  endpoint = "/api/explain",
  runtimeStartedAt = null,
  now = Date.now(),
} = {}) {
  const selectedAtMs = Number(now);
  const startedAtMs = runtimeStartedAtMs(runtimeStartedAt, selectedAtMs);
  const elapsedPreSolveWorkMs = Math.max(0, selectedAtMs - startedAtMs);
  const deploymentHeadroom = deploymentHeadroomMs();
  const configuredCeilingMs = optionalPositiveInteger("OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS");
  const isVercel = process.env.VERCEL === "1";
  const isProduction = process.env.NODE_ENV === "production";

  let deploymentMaxDurationMs = null;
  let runtimeLimitSource = null;
  if (isVercel) {
    deploymentMaxDurationMs = VERCEL_SOLVE_MAX_DURATION_MS[endpoint] || null;
    if (!deploymentMaxDurationMs) {
      throw configError(`No Vercel solve duration is registered for ${endpoint}.`);
    }
    runtimeLimitSource = "vercel.json";
  } else if (isProduction && configuredCeilingMs === null) {
    throw configError(
      "OMNIMATH_SOLVE_RUNTIME_MAX_DURATION_MS is required for non-Vercel production runtimes.",
    );
  }

  const effectiveRuntimeCeilingMs = deploymentMaxDurationMs === null
    ? configuredCeilingMs
    : configuredCeilingMs === null
      ? deploymentMaxDurationMs
      : Math.min(deploymentMaxDurationMs, configuredCeilingMs);
  if (configuredCeilingMs !== null
    && (deploymentMaxDurationMs === null || configuredCeilingMs < deploymentMaxDurationMs)) {
    runtimeLimitSource = "environment";
  }

  const runtimeAvailableBudgetMs = effectiveRuntimeCeilingMs === null
    ? null
    : Math.max(0, effectiveRuntimeCeilingMs - elapsedPreSolveWorkMs - deploymentHeadroom);
  const deploymentDeadlineAt = effectiveRuntimeCeilingMs === null
    ? null
    : startedAtMs + effectiveRuntimeCeilingMs;
  const latestCanonicalDeadlineAt = deploymentDeadlineAt === null
    ? null
    : deploymentDeadlineAt - deploymentHeadroom;

  return Object.freeze({
    endpoint,
    runtimeEnvironment: isVercel ? "vercel" : isProduction ? "production" : "local",
    runtimeLimitSource,
    selectedAtMs,
    runtimeStartedAtMs: startedAtMs,
    elapsedPreSolveWorkMs,
    deploymentMaxDurationMs,
    configuredRuntimeCeilingMs: configuredCeilingMs,
    effectiveRuntimeCeilingMs,
    deploymentHeadroomMs: deploymentHeadroom,
    runtimeAvailableBudgetMs,
    deploymentDeadlineAt,
    latestCanonicalDeadlineAt,
  });
}

export const SOLVE_RUNTIME_DEFAULTS = Object.freeze({
  deploymentHeadroomMs: DEFAULT_DEPLOYMENT_HEADROOM_MS,
  minimumDeploymentHeadroomMs: MIN_DEPLOYMENT_HEADROOM_MS,
});
