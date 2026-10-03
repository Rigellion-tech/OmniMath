import React from "react";
import { Link } from "react-router-dom";
import { LogIn, LogOut, Loader2, UserCircle } from "lucide-react";
import { SignOutButton, UserButton, useAuth, useUser } from "@clerk/react";
import {
  CLERK_AFTER_SIGN_OUT_URL,
  CLERK_SIGN_IN_URL,
  isClerkConfigured,
  isMockAuthMode,
  useAuthToken,
} from "@/lib/auth";

const compactControlClass = "omni-rail-control flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400";

function SignedInUserControls({ compact = false }) {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const displayName = email || user?.fullName || "Signed in";

  if (compact) {
    return (
      <>
        <div
          className={`${compactControlClass} [&_.cl-userButtonAvatarBox]:h-6 [&_.cl-userButtonAvatarBox]:w-6`}
          data-tooltip="Account"
          title={displayName}
          aria-label="Account"
        >
          <UserButton signInUrl={CLERK_SIGN_IN_URL} userProfileMode="modal" />
        </div>
        <SignOutButton redirectUrl={CLERK_AFTER_SIGN_OUT_URL}>
          <button
            type="button"
            className={`${compactControlClass} hover:bg-rose-50 hover:text-rose-700`}
            data-tooltip="Sign out"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </SignOutButton>
      </>
    );
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-2 rounded-full bg-neutral-100 px-2.5 py-1.5">
        <UserButton signInUrl={CLERK_SIGN_IN_URL} userProfileMode="modal" />
        <span className="hidden max-w-[180px] truncate text-xs text-neutral-700 sm:block">
          {displayName}
        </span>
      </div>
      <SignOutButton redirectUrl={CLERK_AFTER_SIGN_OUT_URL}>
        <button
          type="button"
          className="flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-neutral-600 transition-colors hover:bg-rose-50 hover:text-rose-700"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </SignOutButton>
    </>
  );
}

function ClerkAuthControls({ compact = false }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) {
    return (
      <span
        className={compact ? compactControlClass : "flex items-center gap-2 rounded-full bg-neutral-100 px-3 py-1.5 text-xs text-neutral-500"}
        aria-label="Checking session"
        data-tooltip={compact ? "Checking session" : undefined}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-500" />
        {!compact && "Checking session"}
      </span>
    );
  }

  if (!isSignedIn) {
    return (
      <div className={compact ? "flex flex-col items-center gap-1" : "flex min-w-0 flex-wrap items-center gap-2"}>
        <Link
          to={CLERK_SIGN_IN_URL}
          className={compact ? compactControlClass : "omni-button flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold"}
          data-tooltip={compact ? "Sign in" : undefined}
          title={compact ? "Sign in" : undefined}
          aria-label={compact ? "Sign in" : undefined}
        >
          <LogIn className="h-3.5 w-3.5" />
          {!compact && "Sign in with Google"}
        </Link>
      </div>
    );
  }

  return (
    <div className={compact ? "flex flex-col items-center gap-1" : "flex min-w-0 flex-wrap items-center gap-2"}>
      <SignedInUserControls compact={compact} />
    </div>
  );
}

function MockAuthControls({ compact = false }) {
  const { user } = useAuthToken();
  const displayName = user?.primaryEmailAddress?.emailAddress || user?.fullName || "Dev User";

  if (compact) {
    return (
      <>
        <Link
          to="/account"
          className={compactControlClass}
          data-tooltip="Account"
          title={displayName}
          aria-label="Account"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-semibold text-white">
            D
          </span>
        </Link>
        <button
          type="button"
          className={`${compactControlClass} hover:bg-rose-50 hover:text-rose-700`}
          data-tooltip="Sign out"
          title="Sign out"
          aria-label="Sign out"
          onClick={() => {
            window.localStorage.removeItem("omnimath.authMode");
            window.location.assign(CLERK_AFTER_SIGN_OUT_URL);
          }}
        >
          <LogOut className="h-4 w-4" />
        </button>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-full bg-neutral-100 px-2.5 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-semibold text-white">
          D
        </span>
        <span className="hidden max-w-[180px] truncate text-xs text-neutral-700 sm:block">
          {displayName}
        </span>
      </div>
      <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-amber-700">
        Mock auth
      </span>
    </div>
  );
}

export default function AuthControls({ compact = false }) {
  if (isMockAuthMode()) return <MockAuthControls compact={compact} />;
  if (isClerkConfigured()) return <ClerkAuthControls compact={compact} />;

  if (compact) {
    return (
      <Link
        to="/account"
        className={compactControlClass}
        data-tooltip="Account"
        title="Local account"
        aria-label="Account"
      >
        <UserCircle className="h-4 w-4" />
      </Link>
    );
  }

  return (
    <span className="rounded-full bg-neutral-100 px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
      Local mode
    </span>
  );
}
