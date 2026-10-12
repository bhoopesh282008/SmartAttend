import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { candidateOrigins, isLocalHost, timeOf } from '../lib.js';
import { Notice } from './ui.jsx';

const TTL_MS = 60_000;
// The next code is fetched this long before the shown one runs out, so the screen never goes blank.
const RENEW_AHEAD_MS = 5_000;

/**
 * Shows the lecture's QR code. Each code is valid for 60 seconds from the moment the server
 * generated it. The countdown runs from the SERVER's clock (offset measured when the code
 * arrives), so a faculty laptop with a wrong clock still shows the right time left.
 */
export default function QrPanel({ lecture, meta, onChanged }) {
  const open = lecture.closedAt == null;
  const origins = useMemo(() => candidateOrigins(meta?.lan), [meta]);
  const [origin, setOrigin] = useState(origins[0]);
  const [autoRenew, setAutoRenew] = useState(lecture.autoRenew);
  const [code, setCode] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const generating = useRef(false);

  // The list of reachable addresses arrives after the first render.
  useEffect(() => {
    setOrigin((current) => (origins.includes(current) ? current : origins[0]));
  }, [origins]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const generate = useCallback(async () => {
    if (generating.current) return;
    generating.current = true;
    try {
      const sent = Date.now();
      const res = await api(`/sessions/${lecture.id}/qr`, { method: 'POST', body: { origin } });
      const received = Date.now();
      // Assume the server stamped the reply halfway through the round trip.
      setCode({ ...res, offset: res.serverNow - (sent + received) / 2 });
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      generating.current = false;
    }
  }, [lecture.id, origin]);

  // A different address means a different link inside the code: drop the old one.
  useEffect(() => {
    setCode(null);
  }, [origin]);

  const remaining = code ? code.expiresAt - (now + code.offset) : 0;
  const expired = code != null && remaining <= 0;
  const needsRenew = open && autoRenew && (code == null || remaining <= RENEW_AHEAD_MS);
  const retryBucket = Math.floor(now / 3000);

  useEffect(() => {
    if (needsRenew) generate();
  }, [needsRenew, retryBucket, generate]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(code.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the link is still shown below */
    }
  }

  async function closeLecture() {
    if (!window.confirm('Close this lecture? Students will no longer be able to mark attendance.')) return;
    try {
      await api(`/sessions/${lecture.id}/close`, { method: 'POST' });
      setCode(null);
      await onChanged();
    } catch (err) {
      setError(err);
    }
  }

  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const fraction = Math.max(0, Math.min(1, remaining / TTL_MS));
  const localOnly = origin && isLocalHost(new URL(origin).hostname);
  const plainHttpForPhones = origin && !localOnly && new URL(origin).protocol === 'http:';

  if (!open) {
    return (
      <div className="card p-5">
        <h2 className="text-lg font-semibold">Lecture closed</h2>
        <p className="mt-1 text-sm text-slate-600">Closed at {timeOf(lecture.closedAt)}. Students can no longer scan. You can still mark someone by hand from the list.</p>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Attendance code</h2>
        <span className="text-sm text-slate-600" aria-live="polite">
          {code && !expired ? `Expires in ${seconds} s` : expired ? 'Expired' : 'Generating…'}
        </span>
      </div>

      <div className="relative mx-auto mt-4 max-w-[420px]">
        <div className={`qr-box rounded-lg border border-slate-200 bg-white p-1 ${!code || expired ? 'opacity-20' : ''}`}>
          {code ? (
            <img alt="QR code for marking attendance in this lecture" className="w-full" src={`data:image/svg+xml;utf8,${encodeURIComponent(code.svg)}`} />
          ) : (
            <div className="aspect-square w-full" />
          )}
        </div>
        {(expired || (!code && !autoRenew)) && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center">
              <p className="mb-3 text-lg font-semibold">{expired ? 'This code has expired' : 'No code yet'}</p>
              <button type="button" className="btn-primary" onClick={generate}>Generate QR</button>
            </div>
          </div>
        )}
      </div>

      {code && !expired && (
        <p className="mt-4 text-center text-sm text-slate-600">
          Can&rsquo;t scan it? Students can type this code instead
          <span
            className="mt-1 block font-mono text-4xl font-semibold tracking-[0.18em] text-slate-900"
            aria-label={`Six digit code: ${code.shortCode.split('').join(' ')}`}
            data-testid="short-code"
          >
            {code.shortCode.slice(0, 3)} {code.shortCode.slice(3)}
          </span>
        </p>
      )}

      <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`${seconds} seconds left on this code`}>
        <div className={`h-full rounded-full ${fraction < 0.25 ? 'bg-blocked' : 'bg-slate-900'}`} style={{ width: `${fraction * 100}%`, transition: 'width 250ms linear' }} />
      </div>

      {error && <div className="mt-4"><Notice tone="error">{error.message}</Notice></div>}

      <div className="mt-5 grid gap-4 border-t border-slate-200 pt-4 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-4 w-4" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} />
          <span><strong>Auto-renew</strong> <span className="text-slate-600">a new code appears as the old one runs out</span></span>
        </label>

        <div>
          <label className="label" htmlFor="origin">Students open this address</label>
          <select id="origin" name="origin" className="field" value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {origins.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {localOnly && (
            <p className="mt-2 text-review">
              This address only works on this computer. For phones, open this page using your computer&rsquo;s Wi-Fi address instead.
            </p>
          )}
          {plainHttpForPhones && (
            <p className="mt-2 text-review">
              This address is plain http. Phones only allow the camera and their position over https, so students here can type the
              6-digit code but not scan. To fix that, run <code className="font-mono text-xs">npm run dev:https</code> or host the app over https.
            </p>
          )}
        </div>

        {code && (
          <div className="flex flex-wrap items-center gap-2 text-slate-600">
            <span className="break-all font-mono text-xs">{code.url.slice(0, 48)}&hellip;</span>
            <button type="button" className="btn-secondary btn-sm" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
          </div>
        )}

        <div>
          <button type="button" className="btn-danger" onClick={closeLecture}>Close lecture</button>
        </div>
      </div>
    </div>
  );
}
