import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PageShell from '@/components/layout/PageShell';
import { OmniAuthProvider } from '@/lib/auth';
import Account from './pages/Account';
import History from './pages/History';
import PageNotFound from './pages/PageNotFound';
import Home from './pages/Home';

function App() {
  return (
    <OmniAuthProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Home />} />
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
      </Router>
    </OmniAuthProvider>
  );
}

export default App
