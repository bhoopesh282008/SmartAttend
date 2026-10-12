import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Loading, Notice, RiskChip } from './ui.jsx';
import { percent } from '../lib.js';

function MissText({ canMiss }) {
  if (canMiss < 0) return <span className="text-blocked">can no longer reach 75%</span>;
  return <span>can still miss {canMiss} and finish on 75%</span>;
}

/**
 * Early warning for a course: students the model thinks may finish below 75%, with the reasons.
 * It is a prompt for a conversation, not a verdict, and the panel says so. When the model service
 * is not running the list falls back to plain rules and says that instead.
 */
export default function AtRiskPanel({ courseId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api(`/courses/${courseId}/at-risk`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [courseId]);

  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!data) return <Loading label="Checking attendance patterns…" />;

  const flagged = data.students.filter((s) => s.band === 'high' || s.band === 'watch');
  const enough = data.held >= 4;

  return (
    <section className="card mb-6" aria-labelledby="atrisk-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <h2 id="atrisk-heading" className="text-sm font-semibold">Early warning: who may finish below 75%</h2>
          <p className="mt-1 text-xs text-slate-600">
            {enough
              ? data.modelOnline
                ? <>Estimated from the {data.held} lectures held so far by a model trained on <strong>synthetic</strong> data. A prompt to talk to the student, not a verdict. <Link to="/models" className="underline underline-offset-2">How it works</Link></>
                : <>The risk model is not running, so this is a <strong>rules-only</strong> list: students who cannot reach 75%, or who are below it now.</>
              : <>Needs at least 4 lectures held; {data.held} so far.</>}
          </p>
        </div>
        {enough && <span className="text-xs text-slate-500">{flagged.length} of {data.students.length} flagged</span>}
      </div>

      {enough && flagged.length === 0 && <p className="px-4 py-4 text-sm text-slate-600">No student is currently flagged.</p>}
      {enough && flagged.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {flagged.slice(0, 12).map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium">{s.name} <span className="font-normal text-slate-500">{s.rollNo}</span></p>
                <p className="text-sm text-slate-600">
                  Attended {s.attended} of {s.held} ({percent(s.pct)}) &middot; <MissText canMiss={s.canMiss} />
                </p>
                {s.reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">
                    {s.reasons.map((r) => <li key={r.code}>{r.text}</li>)}
                  </ul>
                )}
              </div>
              <div className="flex items-center gap-2">
                {s.risk != null && <span className="text-sm text-slate-600" title="The model's estimate that this student finishes below 75%, under its synthetic training assumptions">{Math.round(s.risk * 100)}%</span>}
                <RiskChip band={s.band} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {flagged.length > 12 && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">Showing the 12 highest of {flagged.length}.</p>}
    </section>
  );
}
