import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, downloadCsv } from '../api.js';
import QrPanel from '../components/QrPanel.jsx';
import { Loading, Notice, StatusChip } from '../components/ui.jsx';
import { dateOf, timeOf } from '../lib.js';

function Counts({ counts }) {
  const items = [
    ['Present', counts.present + counts.manual, 'text-present'],
    ['Pending review', counts.review, 'text-review'],
    ['Absent', counts.absent, 'text-slate-700'],
    ['Blocked attempts', counts.blocked, 'text-blocked'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4" aria-live="polite">
      {items.map(([label, value, tone]) => (
        <div key={label} className="bg-white px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className={`mt-1 text-2xl font-semibold ${tone}`}>{value}<span className="text-sm font-normal text-slate-400"> / {counts.enrolled}</span></dd>
        </div>
      ))}
    </dl>
  );
}

// Says how scans in this lecture are being checked, so a stopped model is never silent.
function ScoringLine({ scoring }) {
  if (scoring.modelOnline) {
    return <p className="text-xs text-slate-500">Risk model online. {scoring.modelScored} scan{scoring.modelScored === 1 ? '' : 's'} scored{scoring.rulesScored > 0 ? `, ${scoring.rulesScored} checked by rules only` : ''}.</p>;
  }
  return (
    <Notice tone="warn">
      <strong>Risk model offline.</strong> Scans are being checked by the rules alone (code, repeats, phone and location checks) until it is back.
      {scoring.modelScored > 0 && ` ${scoring.modelScored} earlier scan${scoring.modelScored === 1 ? ' was' : 's were'} scored by the model.`}
    </Notice>
  );
}

function ReviewQueue({ rows, onDecide, busy }) {
  if (rows.length === 0) return null;
  return (
    <section className="card border-review-line" aria-labelledby="review-heading">
      <h2 id="review-heading" className="border-b border-review-line bg-review-soft px-4 py-3 text-sm font-semibold">
        Needs your decision ({rows.length})
      </h2>
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => (
          <li key={r.scanId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="font-medium">{r.name} <span className="font-normal text-slate-500">{r.rollNo}</span></p>
              <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">
                {r.reasons.map((reason) => <li key={reason.code}>{reason.text}</li>)}
              </ul>
              <p className="mt-1 text-xs text-slate-500">
                {r.risk != null
                  ? <span title="The model's score for this scan, from 0 to 1. It orders scans for review; it is not the probability that this student cheated.">Model risk score {r.risk.toFixed(2)}</span>
                  : 'Checked by rules only (no model score)'}
              </p>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => onDecide(r.scanId, 'approve')}>Approve</button>
              <button type="button" className="btn-danger btn-sm" disabled={busy} onClick={() => onDecide(r.scanId, 'reject')}>Decline</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ManualForm({ onSubmit, onCancel, busy }) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason);
      }}
    >
      <label className="sr-only" htmlFor="manual-reason">Reason for marking by hand</label>
      <input id="manual-reason" name="reason" className="field !min-h-9 !w-48" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. phone died…" autoComplete="off" autoFocus />
      <button type="submit" className="btn-primary btn-sm" disabled={busy || reason.trim().length < 3}>Mark present</button>
      <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
    </form>
  );
}

export default function LecturePage() {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [manualFor, setManualFor] = useState(null);
  const [exported, setExported] = useState(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api(`/sessions/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    load();
    // The list follows the lecture live; it pauses while the tab is hidden.
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 2000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api('/meta').then(setMeta).catch(() => setMeta({ lan: [] }));
  }, []);

  async function run(action) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  const decide = (scanId, decision) => run(() => api(`/scans/${scanId}`, { method: 'PATCH', body: { decision } }));
  const markByHand = (studentId, reason) =>
    run(async () => {
      await api(`/sessions/${id}/manual`, { method: 'POST', body: { studentId, reason } });
      setManualFor(null);
    });

  async function exportCsv() {
    setActionError(null);
    try {
      setExported(await downloadCsv(`/sessions/${id}/export.csv`));
    } catch (err) {
      setActionError(err);
    }
  }

  if (error && !detail) {
    return <Notice tone="error" action={<Link to="/faculty" className="btn-secondary btn-sm">Back to courses</Link>}>{error.message}</Notice>;
  }
  if (!detail || !meta) return <Loading />;

  const { session, counts, roster, attempts, scoring } = detail;
  const pending = roster.filter((r) => r.status === 'review');
  const blockedStillAbsent = new Set(roster.filter((r) => r.status === 'absent').map((r) => r.studentId));

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-slate-600">
            <Link to="/faculty" className="underline underline-offset-2">Courses</Link> / {session.courseCode} {session.courseName}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Lecture {session.lectureNo}{session.title && session.title !== `Lecture ${session.lectureNo}` ? `: ${session.title}` : ''}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {dateOf(session.startedAt)}, started {timeOf(session.startedAt)}
            {session.radiusM != null ? ` · location check on (${Math.round(session.radiusM)} m)` : ' · location check off'}
            {session.faceRequired ? ` · face check on${session.faceLiveness ? ' (with a head turn)' : ''}` : ''}
            {session.closedAt == null && session.autoCloseAt ? ` · closes by itself at ${timeOf(session.autoCloseAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/faculty/courses/${session.courseId}/register`} className="btn-secondary">Class register</Link>
          <button type="button" className="btn-secondary" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>
      {exported && <div className="mb-4"><Notice tone="ok">{exported} downloaded.</Notice></div>}
      {actionError && <div className="mb-4"><Notice tone="error">{actionError.message}</Notice></div>}
      {error && <div className="mb-4"><Notice tone="warn">Connection problem; the list may be out of date. Retrying&hellip;</Notice></div>}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(320px,460px)_1fr]">
        <QrPanel lecture={session} meta={meta} onChanged={load} />

        <div className="grid gap-4">
          <Counts counts={counts} />
          <ScoringLine scoring={scoring} />
          <ReviewQueue rows={pending} onDecide={decide} busy={busy} />

          <section className="card" aria-labelledby="roster-heading">
            <h2 id="roster-heading" className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">Attendance list &middot; {counts.enrolled} enrolled</h2>
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Roll no</th>
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {roster.map((r) => (
                    <tr key={r.studentId}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">{r.rollNo}</td>
                      <td className="px-4 py-2 font-medium">{r.name}{r.note && <span className="block text-xs font-normal text-slate-500">{r.note}</span>}</td>
                      <td className="px-4 py-2"><StatusChip status={r.status} /></td>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                        {timeOf(r.ts)}
                        {r.late && <span className="ml-2 rounded-full border border-review-line bg-review-soft px-2 py-0.5 text-xs font-medium text-review" title="Scanned more than 10 minutes after the lecture began">Late</span>}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {r.status === 'absent' && (
                          manualFor === r.studentId
                            ? <ManualForm busy={busy} onCancel={() => setManualFor(null)} onSubmit={(reason) => markByHand(r.studentId, reason)} />
                            : <button type="button" className="btn-secondary btn-sm" onClick={() => setManualFor(r.studentId)}>Mark by hand</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {attempts.length > 0 && (
            <section className="card border-blocked-line" aria-labelledby="blocked-heading">
              <h2 id="blocked-heading" className="border-b border-blocked-line bg-blocked-soft px-4 py-3 text-sm font-semibold">
                Blocked attempts ({attempts.length})
              </h2>
              <ul className="divide-y divide-slate-100">
                {attempts.map((a) => (
                  <li key={a.id} className="px-4 py-3 text-sm">
                    <p>
                      <span className="font-medium">{a.name}</span> <span className="text-slate-500">{a.rollNo}</span>
                      <span className="text-slate-500"> &middot; {timeOf(a.ts)}</span>
                      {a.decidedBy != null && <span className="ml-2"><StatusChip status="rejected" label="Declined by you" /></span>}
                    </p>
                    <p className="text-slate-600">{a.reasons[0]?.text ?? 'Blocked'}</p>
                    {blockedStillAbsent.has(a.studentId) && a.decidedBy == null && (
                      <p className="mt-1 text-xs text-slate-500">If this was a mistake (for example two friends sharing one phone), mark them by hand in the list above.</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
