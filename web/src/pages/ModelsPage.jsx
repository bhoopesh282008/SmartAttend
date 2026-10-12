import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Loading, Notice, PageTitle } from '../components/ui.jsx';

const pc = (x, digits = 1) => (x == null ? '–' : `${(x * 100).toFixed(digits)}%`);
const num = (x, digits = 3) => (x == null ? '–' : Number(x).toFixed(digits));

const PROXY_MEANING = {
  token_age: 'How late in the code’s 60 seconds the scan came',
  excess_distance: 'Metres from the room beyond the GPS error (log scale)',
  gps_error: 'Reported GPS accuracy (log scale)',
  location_missing: 'Location was required but not shared',
  device_shared: 'Other students this phone marked in the last 7 days',
  new_device: 'First time this student used this phone (only once they have another)',
  scan_burst: 'Other scans from the same network in the previous 5 seconds (log scale)',
  face_distance: 'Distance to the enrolled face (a neutral value when no check was done)',
  face_missing: 'No face check was done',
};
const ATRISK_MEANING = {
  pct_so_far: 'Share of lectures held so far attended',
  pct_last3: 'Share of the last 3 lectures attended',
  trend: 'Last third of the lectures held minus the first third',
  longest_absence_streak: 'Longest run of missed lectures',
  current_absence_streak: 'Lectures missed in a row, ending now',
  late_share: 'Share of attended lectures where the scan came late',
  flags_per_10: 'Scans held for review or blocked, per 10 lectures',
  progress: 'Lectures held divided by lectures planned',
  slack_fraction: 'Classes still missable, as a share of the term (plain arithmetic)',
};

function Section({ title, children }) {
  return (
    <section className="card mb-6">
      <h2 className="border-b border-slate-200 px-5 py-3 text-lg font-semibold">{title}</h2>
      <div className="grid gap-6 p-5">{children}</div>
    </section>
  );
}

function Sub({ title, note, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {note && <p className="mt-1 text-sm text-slate-600">{note}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Table({ head, rows, className = '' }) {
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full min-w-max text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 font-medium ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, r) => (
            <tr key={r} className={row.strong ? 'bg-slate-50 font-medium' : ''}>
              {row.cells.map((cell, i) => <td key={i} className={`px-3 py-2 ${i > 0 ? 'text-right' : ''}`}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Facts({ items }) {
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4">
      {items.map(([label, value, hint]) => (
        <div key={label} className="bg-white px-4 py-3">
          <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
          <dd className="mt-1 text-2xl font-semibold">{value}</dd>
          {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
        </div>
      ))}
    </dl>
  );
}

function Bar({ value }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
        <span className="block h-full rounded-full bg-slate-700" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="w-14 text-right">{pc(value)}</span>
    </span>
  );
}

function List({ items }) {
  return <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{items.map((t) => <li key={t}>{t}</li>)}</ul>;
}

function Assumptions({ items }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">The assumptions behind the synthetic data ({items.length})</summary>
      <div className="mt-2"><List items={items} /></div>
    </details>
  );
}

const SCENARIO_WORDS = {
  honest_good_gps: 'In the room, good GPS',
  honest_poor_gps: 'In the room, poor indoor GPS',
  honest_burst: 'Lecture-start burst on shared Wi-Fi',
  honest_new_phone: 'New phone or cleared browser',
  honest_shared_phone: 'A phone really shared with a flatmate',
  honest_other: 'Other honest scans',
  relay_outside: 'QR relayed to someone far away',
  relay_nearby: 'QR relayed to someone in the building',
  second_phone_in_room: 'A friend in the room, on a second phone',
};

function ProxyCard({ m }) {
  if (!m) return <Notice tone="warn">The proxy-marking model has not been trained. Run <code>npm run train</code>.</Notice>;
  const shipped = m.benchmark.find((b) => b.model === 'logistic_regression');
  return (
    <Section title="Proxy-marking risk model">
      <p className="text-sm text-slate-700">
        Scores every accepted scan from nine signals. A score above the threshold sends the scan to the faculty review
        queue <strong>with the reasons</strong>. It never rejects anyone: only the deterministic rules (expired code,
        repeat scan, a phone that already marked someone else, a clearly-wrong position) block a scan. Version <code>{m.version}</code>.
      </p>
      <Facts
        items={[
          ['ROC-AUC', num(shipped.roc_auc), 'ranks proxy scans above honest ones'],
          ['PR-AUC', num(shipped.pr_auc), `with ${pc(m.data.proxy_prior, 0)} proxy scans`],
          ['Proxies caught', pc(m.test.recall, 0), `at ${pc(m.honest_false_review_cap, 0)} of honest scans reviewed`],
          ['Threshold', num(m.threshold, 2), 'chosen on validation data'],
        ]}
      />

      <Sub title="Benchmark" note="Same data, same alert budget (at most 3% of honest scans reviewed; threshold chosen on validation). Logistic regression ships because its score is a sum that can be explained in words; the benchmarks score higher, which is the price of the explanations.">
        <Table
          head={['Model', 'ROC-AUC', 'PR-AUC', 'Honest reviewed', 'Proxies caught', 'Precision']}
          rows={m.benchmark.map((b) => ({
            strong: b.model === 'logistic_regression',
            cells: [b.model.replaceAll('_', ' ') + (b.model === 'logistic_regression' ? ' (ships)' : ''), num(b.roc_auc), num(b.pr_auc), pc(b.false_review_rate), pc(b.recall, 0), pc(b.precision, 0)],
          }))}
        />
      </Sub>

      <Sub title="Against the rules alone" note={m.rules_only_baseline.note}>
        <Table
          head={['Method', 'Honest scans reviewed', 'Proxies caught']}
          rows={[
            { cells: ['Rules only', pc(m.rules_only_baseline.false_review_rate), pc(m.rules_only_baseline.recall, 0)] },
            { cells: ['Model, same review budget as the rules', pc(m.matched_budget.model_false_review_rate), pc(m.matched_budget.model_recall, 0)] },
            { cells: ['Model alone, at its chosen threshold', pc(m.test.false_review_rate), pc(m.test.recall, 0)] },
            { strong: true, cells: ['Rules and model together (what the server does)', pc(m.rules_and_model_together.false_review_rate), pc(m.rules_and_model_together.recall, 0)] },
          ]}
        />
        <p className="mt-2 text-sm text-slate-600">{m.rules_and_model_together.note}</p>
      </Sub>

      <Sub title="Where it works and where it does not" note="For honest scenarios the bar is the share wrongly sent to review (lower is better). For proxy scenarios it is the share caught (higher is better).">
        <Table
          head={['Scenario', 'Kind', 'Scans', 'Flagged']}
          rows={m.scenarios.map((s) => ({ cells: [SCENARIO_WORDS[s.scenario] ?? s.scenario, s.kind === 'proxy' ? 'proxy' : 'honest', s.n.toLocaleString('en-US'), <Bar key="b" value={s.flagged_rate} />] }))}
        />
      </Sub>

      <Sub title="What the model weighs" note="Logistic regression coefficients on standardised features. A positive number pushes a scan toward review.">
        <Table
          head={['Signal', 'Meaning', 'Weight']}
          rows={m.coefficients.map((c) => ({ cells: [c.feature.replaceAll('_', ' '), <span key="m" className="text-slate-600">{PROXY_MEANING[c.feature]}</span>, (c.coefficient > 0 ? '+' : '') + c.coefficient.toFixed(2)] }))}
        />
      </Sub>

      <Sub title="Limits"><List items={m.limits} /></Sub>
      <Sub title="How it was developed"><List items={m.development_notes} /></Sub>
      <Assumptions items={m.data.assumptions} />
    </Section>
  );
}

function AtRiskCard({ m }) {
  if (!m) return <Notice tone="warn">The at-risk model has not been trained. Run <code>npm run train</code>.</Notice>;
  const t = m.test;
  return (
    <Section title="At-risk attendance model">
      <p className="text-sm text-slate-700">
        Estimates, from the lectures held so far, how likely each student is to finish the term below 75% of the planned
        lectures, so a lecturer can talk to them early. It orders students for a conversation and is not a verdict.
        &ldquo;Classes you can still miss&rdquo; is exact arithmetic, not a model. Version <code>{m.version}</code>.
      </p>
      <Facts
        items={[
          ['ROC-AUC', num(t.roc_auc), 'on held-out students'],
          ['Top 15% precision', pc(t.top15.precision, 0), 'of the 15% ranked highest, finished below 75%'],
          ['AUC, still reachable', num(t.roc_auc_still_reachable), 'students who can still reach 75%'],
          ['Brier score', num(t.brier), 'lower is better'],
        ]}
      />

      <Sub title="Compared with simpler methods" note="Part of the signal is arithmetic: a student who cannot reach 75% will finish below it. The model's added value is small, and larger on the students who still can.">
        <Table
          head={['Method', 'ROC-AUC', 'AUC, still reachable', 'Top 15% precision', 'Top 15% recall']}
          rows={m.comparison.map((c, i) => ({ strong: i === 0, cells: [c.method, num(c.roc_auc), num(c.roc_auc_still_reachable), pc(c.top15.precision, 0), pc(c.top15.recall, 0)] }))}
        />
      </Sub>

      <Sub title="What the bands mean" note={`High is a probability of ${m.bands.high_from} or more, Watch ${m.bands.watch_from} or more. On the held-out synthetic students:`}>
        <Table
          head={['Band', 'Share of students', 'Finished below 75%']}
          rows={['high', 'watch', 'low'].map((b) => ({ cells: [b, pc(t.bands[b].share_of_students, 0), pc(t.bands[b].finished_below_75, 0)] }))}
        />
      </Sub>

      <Sub title="Earlier in the term is harder">
        <Table head={['Snapshot taken', 'Students', 'ROC-AUC']} rows={t.by_progress.map((r) => ({ cells: [r.snapshot, r.n.toLocaleString('en-US'), num(r.roc_auc)] }))} />
      </Sub>

      <Sub title="What the model weighs">
        <Table
          head={['Signal', 'Meaning', 'Weight']}
          rows={m.coefficients.map((c) => ({ cells: [c.feature.replaceAll('_', ' '), <span key="m" className="text-slate-600">{ATRISK_MEANING[c.feature]}</span>, (c.coefficient > 0 ? '+' : '') + c.coefficient.toFixed(2)] }))}
        />
      </Sub>

      <Sub title="No leakage"><List items={[m.data.split, m.data.leakage_control]} /></Sub>
      <Sub title="Limits"><List items={m.limits} /></Sub>
      <Assumptions items={m.data.assumptions} />
    </Section>
  );
}

export default function ModelsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/models').then((d) => alive && setData(d)).catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!data) return <Loading />;

  const statement = (data.proxy ?? data.atrisk)?.data.statement;
  return (
    <>
      <PageTitle title="Models" subtitle="What the two models do, how they were built and tested, and where they fail." />
      <div className="mb-6 grid gap-3">
        <Notice tone="warn">
          <strong>Synthetic data.</strong> {statement ?? 'No models are trained.'} Every assumption behind the invented data is written down below.
        </Notice>
        <Notice tone={data.service.available ? 'ok' : 'info'}>
          {data.service.available
            ? <>The model service is running ({Object.values(data.service.models).filter(Boolean).join(', ')}).</>
            : <>The model service is not running, so scans are checked by the rules alone and the at-risk list uses a rules-only fallback. This page still works because it reads the saved results.</>}
        </Notice>
      </div>
      <ProxyCard m={data.proxy} />
      <AtRiskCard m={data.atrisk} />
    </>
  );
}
