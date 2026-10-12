// Runs a command with the project's Python (ml/.venv) from inside ml/, on Windows or elsewhere.
//
//   node scripts/py.mjs train_proxy.py
//   node scripts/py.mjs -m pytest -q
//   node scripts/py.mjs --optional -m uvicorn app:app --host 127.0.0.1 --port 8001
//
// With --optional, a missing environment is a notice and a clean exit instead of a failure, so
// `npm run dev` still starts the server and web app when Python has not been set up.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ml = join(dirname(fileURLToPath(import.meta.url)), '..', 'ml');
const python = process.platform === 'win32' ? join(ml, '.venv', 'Scripts', 'python.exe') : join(ml, '.venv', 'bin', 'python');

const args = process.argv.slice(2);
const optional = args[0] === '--optional';
if (optional) args.shift();

if (!existsSync(python)) {
  const message = 'No Python environment at ml/.venv. The risk models are off and scans are checked by rules only. To turn them on, see "Risk models" in the README.';
  if (optional) {
    console.log(`[ml] ${message}`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const child = spawn(python, args, { cwd: ml, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
