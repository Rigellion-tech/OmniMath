import React from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { LockKeyhole, Loader2 } from "lucide-react";
import { useAuth } from "@clerk/react";
import { CLERK_SIGN_IN_URL, isClerkConfigured, isMockAuthMode } from "@/lib/auth";

function AuthRequiredPanel({ configured = true }) {
  return (
    <div className="omni-panel mx-auto mt-16 flex max-w-xl flex-col items-start gap-4 rounded-2xl p-6">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-100">
        <LockKeyhole className="h-5 w-5 text-neutral-700" />
      </div>
      <div>
        <h1 className="text-xl font-semibold text-neutral-900">Sign in required</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          This page is for your OmniMath account. Configure Clerk locally to continue.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!configured && (
          <span className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            Clerk is not configured locally.
          </span>
        )}
        <Link
          to={CLERK_SIGN_IN_URL}
          className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
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
      <div className="mx-auto mt-16 flex max-w-xl items-center gap-3 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-600">
        <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
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
