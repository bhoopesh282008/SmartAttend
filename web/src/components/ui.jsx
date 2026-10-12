import { STATUS_LABEL } from '../lib.js';

const CHIP = {
  present: 'border-present-line bg-present-soft text-present',
  manual: 'border-manual-line bg-manual-soft text-manual',
  review: 'border-review-line bg-review-soft text-review',
  absent: 'border-slate-200 bg-slate-100 text-slate-600',
  rejected: 'border-blocked-line bg-blocked-soft text-blocked',
};

export function StatusChip({ status, label }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${CHIP[status] ?? CHIP.absent}`}>
      {label ?? STATUS_LABEL[status] ?? status}
    </span>
  );
}

const RISK_CHIP = {
  high: ['border-blocked-line bg-blocked-soft text-blocked', 'High risk'],
  watch: ['border-review-line bg-review-soft text-review', 'Watch'],
  low: ['border-present-line bg-present-soft text-present', 'Low risk'],
};

export function RiskChip({ band }) {
  const [cls, label] = RISK_CHIP[band] ?? RISK_CHIP.low;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export function Notice({ tone = 'info', children, action }) {
  const tones = {
    info: 'border-slate-200 bg-white text-slate-700',
    warn: 'border-review-line bg-review-soft text-slate-900',
    error: 'border-blocked-line bg-blocked-soft text-slate-900',
    ok: 'border-present-line bg-present-soft text-slate-900',
  };
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" aria-hidden="true" />
      {label}
    </div>
  );
}

export function PageTitle({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// Percentage with the 75% line drawn in, so "how close am I" reads without arithmetic.
export function AttendanceBar({ fraction }) {
  const width = fraction == null ? 0 : Math.round(fraction * 100);
  const low = fraction != null && fraction < 0.75;
  return (
    <div className="relative h-2 w-full rounded-full bg-slate-200" role="img" aria-label={fraction == null ? 'No lectures yet' : `${width}% attended; 75% is the line`}>
      <div className={`h-2 rounded-full ${low ? 'bg-blocked' : 'bg-present'}`} style={{ width: `${width}%` }} />
      <div className="absolute -top-1 bottom-[-4px] w-px bg-slate-900" style={{ left: '75%' }} />
    </div>
  );
}
