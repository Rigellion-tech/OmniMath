import React from "react";
import { Link } from "react-router-dom";
import { LogIn, LogOut, Loader2 } from "lucide-react";
import { SignOutButton, UserButton, useAuth, useUser } from "@clerk/react";
import {
  CLERK_AFTER_SIGN_OUT_URL,
  CLERK_SIGN_IN_URL,
  isClerkConfigured,
  isMockAuthMode,
  useAuthToken,
} from "@/lib/auth";

function SignedInUserControls() {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const displayName = email || user?.fullName || "Signed in";

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5">
        <UserButton signInUrl={CLERK_SIGN_IN_URL} userProfileMode="modal" />
        <span className="hidden max-w-[180px] truncate text-xs text-slate-200/80 sm:block">
          {displayName}
        </span>
      </div>
      <SignOutButton redirectUrl={CLERK_AFTER_SIGN_OUT_URL}>
        <button
          type="button"
          className="flex min-h-9 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 text-xs font-semibold text-slate-200/75 transition-colors hover:border-rose-300/20 hover:bg-rose-400/10 hover:text-rose-100"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </SignOutButton>
    </>
  );
}

function ClerkAuthControls() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <span className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-xs text-slate-300/60">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-200/70" />
        Checking session
      </span>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Link
          to={CLERK_SIGN_IN_URL}
          className="omni-button flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold"
        >
          <LogIn className="h-3.5 w-3.5" />
          Sign in with Google
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <SignedInUserControls />
    </div>
  );
}

function MockAuthControls() {
  const { user } = useAuthToken();
  const displayName = user?.primaryEmailAddress?.emailAddress || user?.fullName || "Dev User";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-full border border-teal-300/[0.18] bg-teal-300/[0.075] px-2.5 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[10px] font-semibold text-slate-950">
          D
        </span>
        <span className="hidden max-w-[180px] truncate text-xs text-slate-200/80 sm:block">
          {displayName}
        </span>
      </div>
      <span className="rounded-full border border-amber-300/[0.18] bg-amber-300/[0.075] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-100/75">
        Mock auth
      </span>
    </div>
  );
}

export default function AuthControls() {
  if (isMockAuthMode()) return <MockAuthControls />;
  if (isClerkConfigured()) return <ClerkAuthControls />;

  return (
    <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/50">
      Local mode
    </span>
  );
}
