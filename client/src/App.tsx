import { Navigate, Route, Routes } from 'react-router-dom';
import LoginPage from './pages/login';
import HomePage from './pages/home';
import ProjectPage from './pages/project';
import SettingsPage from './pages/settings';
import { getToken } from './services/auth';

export default function App() {
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
