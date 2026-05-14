import React, { createContext, useContext } from "react";
import { ClerkProvider, useAuth } from "@clerk/react";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const AuthTokenContext = createContext({
  getToken: async () => null,
  isLoaded: true,
  isSignedIn: false,
});

function ClerkTokenBridge({ children }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return (
    <AuthTokenContext.Provider value={{ getToken, isLoaded, isSignedIn }}>
      {children}
    </AuthTokenContext.Provider>
  );
}

export function isClerkConfigured() {
  return Boolean(publishableKey);
}

export function OmniAuthProvider({ children }) {
  if (!publishableKey) {
    return (
      <AuthTokenContext.Provider
        value={{ getToken: async () => null, isLoaded: true, isSignedIn: false }}
      >
        {children}
      </AuthTokenContext.Provider>
    );
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkTokenBridge>{children}</ClerkTokenBridge>
    </ClerkProvider>
  );
}

export function useAuthToken() {
  return useContext(AuthTokenContext);
}
