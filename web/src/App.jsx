import { useMemo } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import LoginPage from './pages/LoginPage.jsx';
import FacultyHome from './pages/FacultyHome.jsx';
import LecturePage from './pages/LecturePage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import StudentHome from './pages/StudentHome.jsx';
import ScanPage from './pages/ScanPage.jsx';
import ScanResultPage from './pages/ScanResultPage.jsx';
import ModelsPage from './pages/ModelsPage.jsx';
import FacePage from './pages/FacePage.jsx';
import { Notice } from './components/ui.jsx';

function Home() {
  const { user } = useAuth();
  return <Navigate to={user.role === 'faculty' ? '/faculty' : '/student'} replace />;
}

// A page for one role only; the other role is sent to their own home.
function Only({ role, children }) {
  const { user } = useAuth();
  if (user.role !== role) return <Navigate to="/" replace />;
  return children;
}

// A different code is a different scan: keyed on it, so that going from one scan link to another (back /
// forward, a pasted link) starts afresh instead of showing the previous result. The credential object is
// built once per code so the page's effect does not run again on every render.
function ScanRoute() {
  const { token } = useParams();
  const credential = useMemo(() => ({ token }), [token]);
  return <ScanResultPage key={token} credential={credential} />;
}

// The same page, reached by typing the 6 digits instead of scanning.
function CodeRoute() {
  const { code } = useParams();
  const credential = useMemo(() => ({ code }), [code]);
  return <ScanResultPage key={code} credential={credential} />;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md py-16">
      <Notice>That page does not exist.</Notice>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="faculty" element={<Only role="faculty"><FacultyHome /></Only>} />
        <Route path="faculty/lectures/:id" element={<Only role="faculty"><LecturePage /></Only>} />
        <Route path="faculty/courses/:id/register" element={<Only role="faculty"><RegisterPage /></Only>} />
        <Route path="student" element={<Only role="student"><StudentHome /></Only>} />
        <Route path="scan" element={<Only role="student"><ScanPage /></Only>} />
        <Route path="s/:token" element={<Only role="student"><ScanRoute /></Only>} />
        <Route path="c/:code" element={<Only role="student"><CodeRoute /></Only>} />
        <Route path="face" element={<Only role="student"><FacePage /></Only>} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
