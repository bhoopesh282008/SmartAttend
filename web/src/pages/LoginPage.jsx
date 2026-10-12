import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Loading, Notice } from '../components/ui.jsx';

export default function LoginPage() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  useEffect(() => {
    let alive = true;
    api('/auth/users')
      .then((rows) => alive && setAccounts(rows))
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
  }, []);

  if (user) return <Navigate to={safeNext ?? '/'} replace />;

  async function choose(account) {
    setBusy(account.id);
    setError(null);
    try {
      await signIn(account.id);
      navigate(safeNext ?? '/', { replace: true });
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  const faculty = accounts?.filter((a) => a.role === 'faculty') ?? [];
  const students = accounts?.filter((a) => a.role === 'student') ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">SmartAttend</h1>
      <p className="mt-2 max-w-xl text-slate-600">
        Attendance by a QR code that expires in 60 seconds, with checks that stop a friend marking you present.
      </p>

      <div className="mt-6">
        <Notice tone="warn">
          <strong>Demo sign-in.</strong> Pick an account below. There are no passwords, and every name, roll number and past
          lecture is invented. A real deployment would sit behind the college&rsquo;s own sign-in.
        </Notice>
      </div>

      {error && <div className="mt-4"><Notice tone="error">{error.message}</Notice></div>}
      {!accounts && !error && <Loading />}

      {accounts && (
        <>
          <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Faculty</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {faculty.map((a) => (
              <button key={a.id} type="button" className="card flex min-h-14 items-center justify-between px-4 py-3 text-left hover:border-slate-400" onClick={() => choose(a)} disabled={busy !== null}>
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-slate-500">{busy === a.id ? 'Signing in…' : 'Faculty'}</span>
              </button>
            ))}
          </div>

          <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Students</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {students.map((a) => (
              <button key={a.id} type="button" className="card flex min-h-12 flex-col items-start px-3 py-2 text-left hover:border-slate-400" onClick={() => choose(a)} disabled={busy !== null}>
                <span className="text-sm font-medium">{a.name}</span>
                <span className="text-xs text-slate-500">{busy === a.id ? 'Signing in…' : a.rollNo}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
