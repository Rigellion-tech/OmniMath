function enabled(value) {
  return ["1", "true", "yes"].includes(String(value || "").toLowerCase());
}

// A preview deployment can opt in with the existing server switch. Production
// requires a second, explicit switch so a shared environment value cannot
// quietly turn the canary into a site-wide rollout.
export function progressiveProviderEnabled(env = process.env) {
  if (!enabled(env.OMNIMATH_PROGRESSIVE_SOLVE_ENABLED)) return false;
  if (env.VERCEL_ENV === "production") {
    return enabled(env.OMNIMATH_PROGRESSIVE_PRODUCTION_CANARY_ENABLED);
  }
  if (env.NODE_ENV === "production" && env.VERCEL_ENV !== "preview") {
    return enabled(env.OMNIMATH_PROGRESSIVE_PRODUCTION_CANARY_ENABLED);
  }
  return true;
}
