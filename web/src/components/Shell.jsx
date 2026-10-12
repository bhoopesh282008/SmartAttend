import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Loading } from './ui.jsx';

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-slate-900" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="h-4 w-4" fill="#fff"><path d="M6 6h8v8H6zM18 6h8v8h-8zM6 18h8v8H6zM18 18h3v3h-3zM23 23h3v3h-3zM18 23h3v3h-3zM23 18h3v3h-3z" /></svg>
      </span>
      SmartAttend
    </Link>
  );
}

export default function Shell() {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    document.title = 'SmartAttend';
  }, []);

  if (user === undefined) return <div className="mx-auto max-w-5xl px-4"><Loading /></div>;
  if (user === null) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  async function resetDemo() {
    if (!window.confirm('Reset the demo class to its starting point? Lectures and marks made since will be removed.')) return;
    setResetting(true);
    try {
      await api('/demo/reset', { method: 'POST' });
      window.location.assign('/faculty');
    } catch {
      setResetting(false);
    }
  }

  const home = user.role === 'faculty' ? '/faculty' : '/student';
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Brand />
          <span className="rounded-full border border-review-line bg-review-soft px-2.5 py-0.5 text-xs font-medium text-review" title="The class, names and past lectures are invented for this demonstration.">
            Demo data
          </span>
          <nav className="flex items-center gap-1 text-sm" aria-label="Main">
            <NavLink to={home} end className={({ isActive }) => `rounded-md px-3 py-2 ${isActive ? 'bg-slate-100 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>
              {user.role === 'faculty' ? 'Courses' : 'My courses'}
            </NavLink>
            {user.role === 'student' && (
              <>
                <NavLink to="/scan" className={({ isActive }) => `rounded-md px-3 py-2 ${isActive ? 'bg-slate-100 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>
                  Scan
                </NavLink>
                <NavLink to="/face" className={({ isActive }) => `rounded-md px-3 py-2 ${isActive ? 'bg-slate-100 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>
                  Face check
                </NavLink>
              </>
            )}
            <NavLink to="/models" className={({ isActive }) => `rounded-md px-3 py-2 ${isActive ? 'bg-slate-100 font-medium' : 'text-slate-600 hover:bg-slate-100'}`}>
              Models
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              <span className="font-medium text-slate-900">{user.name}</span>
              <span className="ml-2 text-xs uppercase tracking-wide text-slate-500">{user.role}</span>
            </span>
            {user.role === 'faculty' && (
              <button type="button" className="btn-secondary btn-sm" onClick={resetDemo} disabled={resetting}>
                Reset demo
              </button>
            )}
            <button type="button" className="btn-secondary btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
