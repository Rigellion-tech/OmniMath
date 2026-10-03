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
    colorPrimary: "#171717",
    colorBackground: "#ffffff",
    colorText: "#171717",
    colorTextSecondary: "#666666",
    colorInputBackground: "#ffffff",
    colorInputText: "#171717",
    borderRadius: "0.9rem",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  elements: {
    cardBox: "shadow-none",
    card: "border border-neutral-200 bg-white",
    headerTitle: "text-neutral-900",
    headerSubtitle: "text-neutral-600",
    socialButtonsBlockButton: "border-neutral-200 bg-neutral-50 text-neutral-800",
    formButtonPrimary: "bg-neutral-900 text-white hover:bg-neutral-800",
    footerActionLink: "text-neutral-700 hover:text-neutral-900",
  },
};

function AuthFrame({ children, eyebrow, title }) {
  return (
    <div className="omni-shell min-h-screen w-full overflow-x-hidden text-foreground">
      <header className="border-b border-neutral-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4">
          <Link to="/" className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50">
              <BrainCircuit className="h-5 w-5 text-neutral-700" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-xl font-semibold tracking-normal text-neutral-900">
                OmniMath
              </h1>
              <p className="mt-0.5 truncate text-sm text-neutral-500">
                Guided math explanations with inspectable steps.
              </p>
            </div>
          </Link>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-73px)] max-w-[1500px] items-center justify-center px-5 py-10">
        <section className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,0.85fr)_auto]">
          <div className="max-w-xl">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              {eyebrow}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-normal text-neutral-900 sm:text-4xl">
              {title}
            </h1>
            <p className="mt-4 text-sm leading-6 text-neutral-600">
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
      <div className="flex min-w-[280px] items-center gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600">
        <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
        Loading secure sign-in...
      </div>
    </AuthFrame>
  );
}

function AuthUnavailable() {
  return (
    <AuthFrame eyebrow="Setup required" title="Clerk is not configured">
      <div className="max-w-sm rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800">
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
