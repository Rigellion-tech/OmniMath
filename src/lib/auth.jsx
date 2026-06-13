import React, { createContext, useContext } from "react";
import { useAuth } from "@clerk/react";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const authMode = import.meta.env.VITE_AUTH_MODE;
const disableAuth = import.meta.env.VITE_DISABLE_AUTH === "true";
const RUNTIME_MOCK_AUTH_KEY = "omnimath.authMode";

export const MOCK_USER = {
  id: "dev-user",
  primaryEmailAddress: { emailAddress: "dev@omnimath.local" },
  fullName: "Dev User",
  username: "dev-user",
  imageUrl: "",
};

const AuthTokenContext = createContext({
  getToken: async () => null,
  isLoaded: true,
  isSignedIn: false,
  isMock: false,
  user: null,
});

export const CLERK_SIGN_IN_URL = "/sign-in";
export const CLERK_SIGN_UP_URL = "/sign-up";
export const CLERK_AFTER_SIGN_OUT_URL = "/sign-in";
export const CLERK_AFTER_AUTH_URL = "/";

export function ClerkTokenBridge({ children }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return (
    <AuthTokenContext.Provider value={{ getToken, isLoaded, isSignedIn, isMock: false, user: null }}>
      {children}
    </AuthTokenContext.Provider>
  );
}

export function isMockAuthMode() {
  if (authMode === "mock" || disableAuth) return true;
  if (!import.meta.env.DEV || typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  if (params.get("mockAuth") === "1") {
    window.localStorage.setItem(RUNTIME_MOCK_AUTH_KEY, "mock");
    return true;
  }

  return window.localStorage.getItem(RUNTIME_MOCK_AUTH_KEY) === "mock";
}

export function isClerkConfigured() {
  return !isMockAuthMode() && Boolean(publishableKey);
}

export function getClerkPublishableKey() {
  return publishableKey;
}

export function OmniAuthFallbackProvider({ children }) {
  return (
    <AuthTokenContext.Provider
      value={{ getToken: async () => null, isLoaded: true, isSignedIn: false, isMock: false, user: null }}
    >
      {children}
    </AuthTokenContext.Provider>
  );
}

export function OmniMockAuthProvider({ children }) {
  return (
    <AuthTokenContext.Provider
      value={{
        getToken: async () => null,
        isLoaded: true,
        isSignedIn: true,
        isMock: true,
        user: MOCK_USER,
      }}
    >
      {children}
    </AuthTokenContext.Provider>
  );
}

export function useAuthToken() {
  return useContext(AuthTokenContext);
}
