import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import App from '@/App.jsx'
import ErrorBoundary from '@/components/ErrorBoundary.jsx'
import {
  CLERK_AFTER_AUTH_URL,
  CLERK_AFTER_SIGN_OUT_URL,
  CLERK_SIGN_IN_URL,
  CLERK_SIGN_UP_URL,
  ClerkTokenBridge,
  OmniMockAuthProvider,
  OmniAuthFallbackProvider,
  getClerkPublishableKey,
  isClerkConfigured,
  isMockAuthMode,
} from '@/lib/auth'
import '@/index.css'

if (import.meta.env.DEV) {
  void import('@/lib/performanceDiagnostics').then(({ initOmniPerformanceObserver }) => {
    initOmniPerformanceObserver()
  })
}

function AuthProviderWithRouter({ children }) {
  const navigate = useNavigate()
  const publishableKey = getClerkPublishableKey()

  if (isMockAuthMode()) {
    return (
      <OmniMockAuthProvider>
        {children}
      </OmniMockAuthProvider>
    )
  }

  if (!isClerkConfigured()) {
    return (
      <OmniAuthFallbackProvider>
        {children}
      </OmniAuthFallbackProvider>
    )
  }

  return (
    <ClerkProvider
      afterSignOutUrl={CLERK_AFTER_SIGN_OUT_URL}
      publishableKey={publishableKey}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInFallbackRedirectUrl={CLERK_AFTER_AUTH_URL}
      signInUrl={CLERK_SIGN_IN_URL}
      signUpFallbackRedirectUrl={CLERK_AFTER_AUTH_URL}
      signUpUrl={CLERK_SIGN_UP_URL}
    >
      <ClerkTokenBridge>{children}</ClerkTokenBridge>
    </ClerkProvider>
  )
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  console.error('OmniMath startup error: #root element was not found.')
} else {
  try {
    ReactDOM.createRoot(rootElement).render(
      <ErrorBoundary>
        <BrowserRouter>
          <AuthProviderWithRouter>
            <App />
          </AuthProviderWithRouter>
        </BrowserRouter>
      </ErrorBoundary>
    )
  } catch (error) {
    console.error('OmniMath startup error:', error)
  }
}
