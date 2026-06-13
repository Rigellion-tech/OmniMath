import React from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { LockKeyhole, Loader2 } from "lucide-react";
import { useAuth } from "@clerk/react";
import { CLERK_SIGN_IN_URL, isClerkConfigured, isMockAuthMode } from "@/lib/auth";

function AuthRequiredPanel({ configured = true }) {
  return (
    <div className="omni-panel mx-auto mt-16 flex max-w-xl flex-col items-start gap-4 rounded-2xl p-6">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10">
        <LockKeyhole className="h-5 w-5 text-teal-200" />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-cyan-50">Sign in required</h1>
        <p className="mt-2 text-sm leading-6 text-slate-300/65">
          This page is for your OmniMath account. Configure Clerk locally to continue.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!configured && (
          <span className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-2 text-sm text-amber-100/80">
            Clerk is not configured locally.
          </span>
        )}
        <Link
          to={CLERK_SIGN_IN_URL}
          className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-2 text-sm font-medium text-slate-200/70 transition-colors hover:text-slate-100"
        >
          Go to sign in
        </Link>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children }) {
  if (isMockAuthMode()) {
    return <>{children}</>;
  }

  if (!isClerkConfigured()) {
    return <AuthRequiredPanel configured={false} />;
  }

  return <ClerkProtectedRoute>{children}</ClerkProtectedRoute>;
}

function ClerkProtectedRoute({ children }) {
  const { isLoaded, isSignedIn } = useAuth();
  const location = useLocation();

  if (!isLoaded) {
    return (
      <div className="mx-auto mt-16 flex max-w-xl items-center gap-3 rounded-2xl border border-teal-300/15 bg-teal-300/[0.06] p-4 text-sm text-teal-50/75">
        <Loader2 className="h-4 w-4 animate-spin text-teal-200" />
        Checking your session...
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to={CLERK_SIGN_IN_URL} replace state={{ from: location }} />;
  }

  return (
    <>{children}</>
  );
}
