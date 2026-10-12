import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Scanner from '../components/Scanner.jsx';
import { PageTitle } from '../components/ui.jsx';
import { tokenFromText } from '../lib.js';

export default function ScanPage() {
  const navigate = useNavigate();
  const [pasted, setPasted] = useState('');
  const [problem, setProblem] = useState(null);
  const [digits, setDigits] = useState('');
  const [digitsProblem, setDigitsProblem] = useState(null);

  const go = useCallback((token) => navigate(`/s/${token}`), [navigate]);

  function submit(event) {
    event.preventDefault();
    const token = tokenFromText(pasted);
    if (!token) {
      setProblem('That does not look like a SmartAttend link or code.');
      return;
    }
    go(token);
  }

  function submitDigits(event) {
    event.preventDefault();
    const only = digits.replace(/\D/g, '');
    if (only.length !== 6) {
      setDigitsProblem('The code is 6 digits, shown under the QR code on your lecturer’s screen.');
      return;
    }
    navigate(`/c/${only}`);
  }

  return (
    <div className="mx-auto max-w-md">
      <PageTitle title="Scan the code" subtitle="Use the QR code on your lecturer's screen. It changes every minute." />
      <Scanner onToken={go} />

      <form onSubmit={submitDigits} className="mt-8 border-t border-slate-200 pt-5">
        <label className="label" htmlFor="digits">Can&rsquo;t scan it? Type the 6 digits under the QR code</label>
        <div className="flex gap-2">
          <input
            id="digits"
            name="digits"
            className="field font-mono text-lg tracking-widest"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="482 913"
            value={digits}
            onChange={(e) => { setDigits(e.target.value); setDigitsProblem(null); }}
          />
          <button type="submit" className="btn-primary shrink-0" disabled={digits.replace(/\D/g, '').length < 6}>Mark me present</button>
        </div>
        {digitsProblem && <p className="mt-2 text-sm text-blocked" role="alert">{digitsProblem}</p>}
      </form>

      <form onSubmit={submit} className="mt-6">
        <label className="label" htmlFor="link">Or paste the link</label>
        <div className="flex gap-2">
          <input id="link" name="link" className="field" value={pasted} onChange={(e) => { setPasted(e.target.value); setProblem(null); }} placeholder="https://…/s/…" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn-secondary shrink-0" disabled={!pasted.trim()}>Use</button>
        </div>
        {problem && <p className="mt-2 text-sm text-blocked" role="alert">{problem}</p>}
      </form>
    </div>
  );
}
