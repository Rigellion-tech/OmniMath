import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageShell from '@/components/layout/PageShell';
import { SettingsProvider } from '@/lib/settings';
import Account from './pages/Account';
import AuthPage from './pages/AuthPage';
import History from './pages/History';
import PageNotFound from './pages/PageNotFound';
import Home from './pages/Home';

function App() {
  return (
    <SettingsProvider>
      <Routes>
        <Route
          path="/"
          element={(
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          )}
        />
        <Route path="/sign-in/*" element={<AuthPage mode="sign-in" />} />
        <Route path="/sign-up/*" element={<AuthPage mode="sign-up" />} />
        <Route
          path="/account"
          element={(
            <PageShell>
              <ProtectedRoute>
                <Account />
              </ProtectedRoute>
            </PageShell>
          )}
        />
        <Route
          path="/history"
          element={(
            <PageShell>
              <ProtectedRoute>
                <History />
              </ProtectedRoute>
            </PageShell>
          )}
        />
        <Route path="*" element={<PageNotFound />} />
      </Routes>
    </SettingsProvider>
  );
}

export default App
