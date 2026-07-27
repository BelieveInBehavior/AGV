import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login';
import HomePage from './pages/home';
import ProjectPage from './pages/project';
import SettingsPage from './pages/settings';
import { isDevAutoLoginEnabled, tryDevAutoLogin, validateStoredSession } from './services/auth';

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let loggedIn = await validateStoredSession();
      if (!loggedIn && isDevAutoLoginEnabled()) {
        loggedIn = await tryDevAutoLogin();
      }
      if (!cancelled) {
        setIsLoggedIn(loggedIn);
        setAuthReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!authReady) {
    return (
      <main className="login-page">
        <section className="login-card">
          <p>开发模式自动登录中…</p>
        </section>
      </main>
    );
  }
  if (!isLoggedIn) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/project/:projectId" element={<ProjectPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
