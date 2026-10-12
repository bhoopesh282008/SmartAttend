import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import FaceCamera from '../components/FaceCamera.jsx';
import { Loading, Notice, PageTitle } from '../components/ui.jsx';
import { dateOf, timeOf } from '../lib.js';

const PHOTOS = 3;
const PROMPTS = ['Look straight at the camera.', 'Tilt your head slightly to the left.', 'Tilt your head slightly to the right.'];

/**
 * Enrolment for the optional face check: three photos, turned into numbers on this phone. Only the
 * numbers are sent, and they can be deleted from this page at any time.
 */
export default function FacePage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [taken, setTaken] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api('/me/face'));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function addPhoto(descriptor) {
    const next = [...taken, descriptor];
    setTaken(next);
    if (next.length < PHOTOS) return;
    setBusy(true);
    setError(null);
    try {
      await api('/me/face', { method: 'POST', body: { descriptors: next } });
      setDone(true);
      setEnrolling(false);
      setTaken([]);
      await load();
    } catch (err) {
      setError(err);
      setTaken([]); // start the three photos again
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete your face data? Lecturers who ask for a face check will then have to confirm your scans themselves.')) return;
    try {
      await api('/me/face', { method: 'DELETE' });
      setDone(false);
      await load();
    } catch (err) {
      setError(err);
    }
  }

  if (!status && !error) return <Loading />;

  return (
    <div className="mx-auto max-w-xl">
      <PageTitle title="Face check" subtitle="Optional. Used only when a lecturer switches it on for a lecture." />
      {error && <div className="mb-4"><Notice tone="error">{error.message}</Notice></div>}
      {done && <div className="mb-4"><Notice tone="ok">Your face is enrolled.</Notice></div>}

      {!enrolling && (
        <section className="card p-5">
          {status?.enrolled ? (
            <>
              <h2 className="text-lg font-semibold">Enrolled</h2>
              <p className="mt-1 text-sm text-slate-600">Saved on {dateOf(status.enrolledAt)} at {timeOf(status.enrolledAt)}.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => { setEnrolling(true); setDone(false); }}>Enrol again</button>
                <button type="button" className="btn-danger" onClick={remove}>Delete my face data</button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Not enrolled</h2>
              <p className="mt-1 text-sm text-slate-600">Enrol once and any lecture that asks for a face check can compare against it.</p>
            </>
          )}
        </section>
      )}

      {!enrolling && !status?.enrolled && (
        <section className="card mt-4 p-5">
          <h2 className="text-sm font-semibold">What this does, and does not do</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            <li><strong>No photo is kept or sent.</strong> Your phone turns each photo into a list of 128 numbers and sends only those, which are stored encrypted.</li>
            <li>It is checked only in lectures where your lecturer asks for it. A poor match goes to the lecturer to confirm; <strong>it never rejects you by itself.</strong></li>
            <li>It cannot tell a live face from a photograph of one, so it is a prompt for a person to look, not proof.</li>
            <li>You can delete your data here at any time.</li>
          </ul>
          <label className="mt-4 flex min-h-11 items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I understand, and I agree to enrol my face for this check.</span>
          </label>
          <button type="button" className="btn-primary mt-3" disabled={!agreed} onClick={() => setEnrolling(true)}>Start</button>
        </section>
      )}

      {enrolling && (
        <section className="card p-5">
          <h2 className="text-lg font-semibold">Photo {Math.min(taken.length + 1, PHOTOS)} of {PHOTOS}</h2>
          <p className="mb-4 mt-1 text-sm text-slate-600">{PROMPTS[Math.min(taken.length, PHOTOS - 1)]} Only you, in good light.</p>
          <FaceCamera onCapture={addPhoto} busy={busy} label={`Take photo ${Math.min(taken.length + 1, PHOTOS)}`} />
          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-slate-600" aria-live="polite">{taken.length} of {PHOTOS} taken</span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setEnrolling(false); setTaken([]); }}>Cancel</button>
          </div>
        </section>
      )}

      <p className="mt-6 text-sm text-slate-500"><Link to="/student" className="underline underline-offset-2">Back to my courses</Link></p>
    </div>
  );
}
