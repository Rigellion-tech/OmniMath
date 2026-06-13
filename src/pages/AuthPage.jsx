import React from "react";
import { SignIn, SignUp, useAuth } from "@clerk/react";
import { AlertTriangle, BrainCircuit, Loader2 } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import {
  CLERK_AFTER_AUTH_URL,
  CLERK_SIGN_IN_URL,
  CLERK_SIGN_UP_URL,
  isClerkConfigured,
  isMockAuthMode,
} from "@/lib/auth";

const clerkAppearance = {
  variables: {
    colorPrimary: "#5eead4",
    colorBackground: "#08151b",
    colorText: "#e6fbff",
    colorTextSecondary: "rgba(203, 213, 225, 0.72)",
    colorInputBackground: "rgba(255, 255, 255, 0.045)",
    colorInputText: "#e6fbff",
    borderRadius: "0.9rem",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    cardBox: "shadow-none",
    card: "border border-white/[0.08] bg-[#07141a]",
    headerTitle: "text-cyan-50",
    headerSubtitle: "text-slate-300/70",
    socialButtonsBlockButton: "border-white/[0.1] bg-white/[0.04] text-slate-100",
    formButtonPrimary: "bg-teal-300 text-slate-950 hover:bg-teal-200",
    footerActionLink: "text-teal-200 hover:text-teal-100",
  },
};

function AuthFrame({ children, eyebrow, title }) {
  return (
    <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
      <header className="border-b border-white/[0.06] bg-[#061116]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-teal-300/20 bg-teal-300/10 shadow-[0_12px_32px_rgba(0,0,0,0.28)]">
              <BrainCircuit className="h-5 w-5 text-teal-200" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-xl font-semibold tracking-normal text-cyan-50">
                OmniMath
              </h1>
              <p className="mt-0.5 truncate text-sm text-slate-300/60">
                Guided math explanations with inspectable steps.
              </p>
            </div>
          </Link>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-73px)] max-w-[1500px] items-center justify-center px-5 py-10">
        <section className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_auto]">
          <div className="max-w-xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-teal-200/70">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal text-cyan-50 sm:text-4xl">
              {title}
            </h1>
            <p className="mt-4 text-sm leading-6 text-slate-300/65">
              Save explanations, keep your history private, and continue your math work from any session.
            </p>
          </div>
          <div className="flex justify-center">{children}</div>
        </section>
      </main>
    </div>
  );
}

function AuthLoading() {
  return (
    <AuthFrame eyebrow="Authentication" title="Checking your session">
      <div className="flex min-w-[280px] items-center gap-3 rounded-2xl border border-teal-300/15 bg-teal-300/[0.06] p-4 text-sm text-teal-50/75">
        <Loader2 className="h-4 w-4 animate-spin text-teal-200" />
        Loading secure sign-in...
      </div>
    </AuthFrame>
  );
}

function AuthUnavailable() {
  return (
    <AuthFrame eyebrow="Setup required" title="Clerk is not configured">
      <div className="max-w-sm rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5 text-sm leading-6 text-amber-100/80">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Set VITE_CLERK_PUBLISHABLE_KEY and restart the dev server to enable sign-in.</span>
        </div>
      </div>
    </AuthFrame>
  );
}

function ClerkAuthPage({ mode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <AuthLoading />;
  if (isSignedIn) return <Navigate to={CLERK_AFTER_AUTH_URL} replace />;

  const isSignUp = mode === "sign-up";

  return (
    <AuthFrame
      eyebrow={isSignUp ? "Create account" : "Welcome back"}
      title={isSignUp ? "Start learning with OmniMath" : "Sign in to OmniMath"}
    >
      {isSignUp ? (
        <SignUp
          appearance={clerkAppearance}
          fallbackRedirectUrl={CLERK_AFTER_AUTH_URL}
          forceRedirectUrl={CLERK_AFTER_AUTH_URL}
          path={CLERK_SIGN_UP_URL}
          routing="path"
          signInUrl={CLERK_SIGN_IN_URL}
        />
      ) : (
        <SignIn
          appearance={clerkAppearance}
          fallbackRedirectUrl={CLERK_AFTER_AUTH_URL}
          forceRedirectUrl={CLERK_AFTER_AUTH_URL}
          path={CLERK_SIGN_IN_URL}
          routing="path"
          signUpUrl={CLERK_SIGN_UP_URL}
        />
      )}
    </AuthFrame>
  );
}

export default function AuthPage({ mode = "sign-in" }) {
  if (isMockAuthMode()) return <Navigate to={CLERK_AFTER_AUTH_URL} replace />;
  if (!isClerkConfigured()) return <AuthUnavailable />;

  return <ClerkAuthPage mode={mode} />;
}
