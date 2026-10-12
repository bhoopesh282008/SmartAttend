import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import FaceCamera from '../components/FaceCamera.jsx';
import { Loading, Notice } from '../components/ui.jsx';
import { loadFaceEngine } from '../faceEngine.js';
import { getDeviceId, getLocation, timeOf } from '../lib.js';
import { instruction, pickDirection } from '../liveness.js';

const LOOKS = {
  marked: { tone: 'border-present-line bg-present-soft', title: 'Marked present', mark: '✓', markCls: 'bg-present text-white' },
  already: { tone: 'border-present-line bg-present-soft', title: 'Already marked', mark: '✓', markCls: 'bg-present text-white' },
  review: { tone: 'border-review-line bg-review-soft', title: 'Recorded, waiting for your lecturer', mark: '!', markCls: 'bg-review text-white' },
  rejected: { tone: 'border-blocked-line bg-blocked-soft', title: 'Not marked', mark: '×', markCls: 'bg-blocked text-white' },
};

const LOCATION_NOTE = {
  denied: 'Location was not shared. If your lecturer checks that you are in the room, they will need to confirm this scan.',
  timeout: 'Your phone took too long to find its position. If your lecturer checks that you are in the room, they will need to confirm this scan.',
  unavailable: 'Your phone could not work out its position. If your lecturer checks that you are in the room, they will need to confirm this scan.',
  unsupported: 'This browser cannot share a position. If your lecturer checks that you are in the room, they will need to confirm this scan.',
};

/**
 * Where a scan ends up, whether the student scanned the QR with the in-app scanner, opened the link
 * with the phone's own camera app, or typed the 6 digits. `credential` is { token } or { code }.
 * First it asks the server what this lecture will want, so the phone only asks for what is needed: a
 * position if the room is checked, a face (and a head turn, if asked) if the lecturer wants one. Then it
 * sends the scan and shows exactly what happened.
 */
export default function ScanResultPage({ credential }) {
  const [phase, setPhase] = useState('preview'); // preview | locating | face | sending | done | error
  const [preview, setPreview] = useState(null);
  const [locationReason, setLocationReason] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const location = useRef(null);
  const token = useRef(null);
  const started = useRef(false);

  const send = useCallback(async (faceDescriptor) => {
    setPhase('sending');
    try {
      const body = { token: token.current, deviceId: getDeviceId(), location: location.current, ...(faceDescriptor ? { faceDescriptor } : {}) };
      setResult(await api('/scan', { method: 'POST', body }));
      setPhase('done');
    } catch (err) {
      setError(err);
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    // React runs effects twice in development; the scan must be sent once.
    if (started.current) return;
    started.current = true;
    (async () => {
      let info;
      try {
        info = await api('/scan/preview', { method: 'POST', body: credential });
      } catch (err) {
        setError(err);
        setPhase('error');
        return;
      }
      if (!info.valid) {
        setResult({ outcome: 'rejected', code: info.code, message: info.message });
        setPhase('done');
        return;
      }
      token.current = info.token;
      setPreview(info);
      if (info.faceLiveness) setChallenge(pickDirection());
      if (info.faceRequired && info.faceEnrolled) loadFaceEngine().catch(() => {}); // warm up while the position is read
      if (info.locationChecked) {
        setPhase('locating');
        const found = await getLocation();
        location.current = found.location;
        setLocationReason(found.reason);
      }
      if (info.faceRequired) {
        setPhase('face');
        return;
      }
      await send(null);
    })();
  }, [credential, send]);

  if (phase === 'preview' || phase === 'locating' || phase === 'sending') {
    return (
      <div className="mx-auto max-w-md">
        <Loading label={{ preview: 'Checking the code…', locating: 'Checking your position…', sending: 'Sending your scan…' }[phase]} />
        {phase === 'locating' && (
          <p className="text-sm text-slate-600">
            Your lecturer checks that you are in the room, so your phone may ask to share its position. Only the distance
            from the classroom is kept, not where you are.
          </p>
        )}
      </div>
    );
  }

  if (phase === 'face') {
    return (
      <div className="mx-auto max-w-md">
        <h1 className="text-xl font-semibold">Face check</h1>
        <p className="mb-4 mt-1 text-sm text-slate-600">
          {preview.lecture.courseCode} lecture {preview.lecture.lectureNo}: your lecturer asks for a face check. Your phone turns the photo
          into numbers and sends only those, never the picture. The code has a limited time, so be quick.
          {preview.faceEnrolled && challenge && ` You will be asked to turn your head: ${instruction(challenge).toLowerCase()}`}
        </p>
        {preview.faceEnrolled ? (
          <FaceCamera
            onCapture={(descriptor) => send(descriptor)}
            challenge={challenge}
            label={challenge ? 'Start the face check' : 'Take photo and send'}
          />
        ) : (
          <Notice tone="warn" action={<Link to="/face" className="btn-secondary btn-sm">Enrol my face</Link>}>
            You have not enrolled your face yet. You can still send your scan, and your lecturer will confirm it.
          </Notice>
        )}
        <div className="mt-5 flex justify-center">
          <button type="button" className="btn-secondary" onClick={() => send(null)}>
            {preview.faceEnrolled ? 'Skip the face check' : 'Send without a face check'}
          </button>
        </div>
        <p className="mt-2 text-center text-xs text-slate-500">Without it, your lecturer will confirm your scan themselves.</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="mx-auto max-w-md">
        <div className="card border-blocked-line bg-blocked-soft p-6" role="alert">
          <h1 className="text-xl font-semibold">Could not send your scan</h1>
          <p className="mt-2 text-sm">{error.message}</p>
          <div className="mt-5 flex gap-2">
            <Link to="/scan" className="btn-primary">Scan again</Link>
            <Link to="/student" className="btn-secondary">My courses</Link>
          </div>
        </div>
      </div>
    );
  }

  // A repeat scan of one that is still waiting for the lecturer should look like waiting, not like success.
  const look = result.outcome === 'already' && result.status === 'review'
    ? { ...LOOKS.review, title: 'Already recorded, waiting for your lecturer' }
    : LOOKS[result.outcome] ?? LOOKS.rejected;
  const retryable = ['expired', 'bad_token', 'bad_code'].includes(result.code);
  return (
    <div className="mx-auto max-w-md">
      <div className={`card p-6 ${look.tone}`} role="status" aria-live="polite">
        <div className="flex items-center gap-4">
          <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-2xl font-semibold ${look.markCls}`} aria-hidden="true">{look.mark}</span>
          <div>
            <h1 className="text-xl font-semibold">{look.title}</h1>
            {result.markedAt && <p className="text-sm text-slate-700">at {timeOf(result.markedAt)}</p>}
          </div>
        </div>
        <p className="mt-4 text-sm">{result.message}</p>
        {result.outcome === 'review' && locationReason && LOCATION_NOTE[locationReason] && (
          <p className="mt-3 text-sm text-slate-700">{LOCATION_NOTE[locationReason]}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {retryable && <Link to="/scan" className="btn-primary">Scan again</Link>}
          <Link to="/student" className={retryable ? 'btn-secondary' : 'btn-primary'}>My courses</Link>
        </div>
      </div>
    </div>
  );
}
