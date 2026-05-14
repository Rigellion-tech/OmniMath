import React from "react";
import { Link, NavLink } from "react-router-dom";
import { LogIn, LogOut, Loader2 } from "lucide-react";
import { SignInButton, SignOutButton, UserButton, useAuth, useUser } from "@clerk/react";
import { isClerkConfigured } from "@/lib/auth";
import { cn } from "@/lib/utils";

function navClassName({ isActive }) {
  return cn(
    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
    isActive
      ? "border-teal-300/25 bg-teal-300/10 text-teal-100"
      : "border-white/[0.08] bg-white/[0.035] text-slate-300/60 hover:text-slate-100"
  );
}

function SignedInUserControls() {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress;
  const displayName = email || user?.fullName || "Signed in";

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex">
        <NavLink to="/history" className={navClassName}>
          History
        </NavLink>
        <NavLink to="/account" className={navClassName}>
          Account
        </NavLink>
      </nav>
      <div className="flex min-w-0 items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5">
        <UserButton />
        <Link
          to="/account"
          className="hidden max-w-[180px] truncate text-xs text-slate-200/80 transition-colors hover:text-teal-100 sm:block"
        >
          {displayName}
        </Link>
      </div>
      <SignOutButton>
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
        <span className="hidden rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 text-xs text-slate-300/60 md:inline">
          Demo mode: limited daily use
        </span>
        <SignInButton mode="modal">
          <button
            type="button"
            className="omni-button flex min-h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold"
          >
            <LogIn className="h-3.5 w-3.5" />
            Sign in with Google
          </button>
        </SignInButton>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <SignedInUserControls />
    </div>
  );
}

export default function AuthControls() {
  if (isClerkConfigured()) return <ClerkAuthControls />;

  return (
    <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-3 py-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-slate-300/50">
      Demo mode
    </span>
  );
}
