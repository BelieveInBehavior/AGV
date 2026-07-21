import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login';
import HomePage from './pages/home';
import ProjectPage from './pages/project';
import SettingsPage from './pages/settings';
import { getToken, isDevAutoLoginEnabled, tryDevAutoLogin } from './services/auth';

export default function App() {
  const [authReady, setAuthReady] = useState(() => Boolean(getToken()) || !isDevAutoLoginEnabled());

  useEffect(() => {
    if (authReady) return;
    let cancelled = false;
    void tryDevAutoLogin().finally(() => {
      if (!cancelled) setAuthReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  if (!authReady) {
    return (
      <main className="login-page">
        <section className="login-card">
          <p>开发模式自动登录中…</p>
        </section>
      </main>
    );
  }

  const isLoggedIn = Boolean(getToken());

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
