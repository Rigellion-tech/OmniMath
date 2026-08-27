import React from 'react'
import ReactDOM from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { BrowserRouter, useNavigate } from 'react-router-dom'
import App from '@/App.jsx'
import ErrorBoundary from '@/components/ErrorBoundary.jsx'
import { recordOmniDiagnostic } from '@/lib/performanceDiagnostics'
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

const debugPerformance = import.meta.env.DEV && (
  import.meta.env.VITE_DEBUG_MATH_HOVER_PERF === 'true'
  || import.meta.env.VITE_DEBUG_MATH_HOVER_PERF === '1'
  || import.meta.env.VITE_DEBUG_MATH_HOVER === 'true'
  || import.meta.env.VITE_DEBUG_MATH_HOVER === '1'
)

function OmniPerformanceBoundary({ children }) {
  if (!debugPerformance) return children
  return (
    <React.Profiler
      id="OmniMath"
      onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        recordOmniDiagnostic('react.commit', {
          id,
          phase,
          actualDuration: Math.round(actualDuration * 100) / 100,
          baseDuration: Math.round(baseDuration * 100) / 100,
          startTime: Math.round(startTime * 100) / 100,
          commitTime: Math.round(commitTime * 100) / 100,
        })
      }}
    >
      {children}
    </React.Profiler>
  )
}

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
        <OmniPerformanceBoundary>
          <BrowserRouter>
            <AuthProviderWithRouter>
              <App />
            </AuthProviderWithRouter>
          </BrowserRouter>
        </OmniPerformanceBoundary>
      </ErrorBoundary>
    )
  } catch (error) {
    console.error('OmniMath startup error:', error)
  }
}
