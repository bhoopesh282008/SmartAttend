// Real-browser test harness. It starts the actual server on a temporary database (and the model
// service when Python is set up), then drives a temporary Chrome (your installed Chrome, a fresh
// profile, so your own sessions are never touched).
//
// Cameras: Chrome can be given a "fake" capture device that plays a video file. That is the real
// getUserMedia -> MediaStream -> <video> path, fed by a file instead of a lens, so it tests the
// app's camera code in a real browser. The real webcam is opt-in (see real-camera.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { DEMO_PHOTOS, FACES } from './fixtures.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function waitFor(url, { timeoutMs = 40_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not come up (${last})`);
}

function buildWeb() {
  const result = spawnSync('npm run build -w web', { cwd: ROOT, shell: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`The web build failed:\n${result.stdout}\n${result.stderr}`);
}

const venvPython = () => {
  const path = join(ROOT, 'ml', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return existsSync(path) ? path : null;
};

/** The whole application on a throwaway database. */
export async function startStack({ ml = process.env.E2E_ML !== 'off', build = true, overpassUrl = null } = {}) {
  if (build) buildWeb();
  const dir = mkdtempSync(join(tmpdir(), 'smartattend-e2e-'));
  const children = [];
  const logs = [];
  const track = (child, name) => {
    child.stdout?.on('data', (d) => logs.push(`[${name}] ${d}`));
    child.stderr?.on('data', (d) => logs.push(`[${name}] ${d}`));
    children.push(child);
    return child;
  };

  let mlUrl = 'off';
  const python = ml ? venvPython() : null;
  if (python) {
    const mlPort = await freePort();
    track(spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(mlPort)], { cwd: join(ROOT, 'ml'), stdio: ['ignore', 'pipe', 'pipe'] }), 'ml');
    mlUrl = `http://127.0.0.1:${mlPort}`;
    await waitFor(`${mlUrl}/health`);
  }

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DB_PATH: join(dir, 'e2e.db'),
    FACE_KEY_FILE: join(dir, 'face.key'),
    ML_URL: mlUrl,
    WEB_DIST: join(ROOT, 'web', 'dist'),
    ...(overpassUrl ? { OVERPASS_URL: overpassUrl } : {}),
  };
  track(spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] }), 'server');
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/api/health`);
  } catch (err) {
    throw new Error(`${err.message}\n${logs.join('')}`);
  }

  async function api(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  }
  const login = async (userId) => (await api('POST', '/api/auth/login', { body: { userId } })).data.token;

  return {
    base, dir, api, login, logs, mlOn: mlUrl !== 'off',
    // Read-only look at the throwaway database, for facts the API deliberately does not expose.
    query(sql, ...params) {
      const db = new DatabaseSync(join(dir, 'e2e.db'), { readOnly: true });
      try {
        return db.prepare(sql).all(...params);
      } finally {
        db.close();
      }
    },
    async stop() {
      for (const child of children) child.kill();
      await new Promise((r) => setTimeout(r, 400));
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    },
  };
}

/** A Chrome of its own. `video` is a path to an .mjpeg file to play as the camera; without it the real devices are used. */
export function launchChrome({ video = null, headless = process.env.E2E_HEADED !== '1' } = {}) {
  const args = ['--use-fake-ui-for-media-stream']; // accept the camera prompt in THIS temporary browser only
  if (video) args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`);
  return chromium.launch({ channel: 'chrome', headless, args });
}

/** A signed-in page in its own context (its own storage, so its own device ID). */
export async function signedInPage(browser, stack, userId, { geolocation, permissions = [] } = {}) {
  const token = await stack.login(userId);
  const context = await browser.newContext({
    permissions: geolocation ? [...permissions, 'geolocation'] : permissions,
    geolocation,
    viewport: { width: 900, height: 900 },
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('smartattend.token', t);
    } catch {
      /* storage blocked */
    }
  }, token);
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  return { page, context, token, problems };
}

// ------------------------------------------------------------------- pictures for the fake camera
async function screenshotHtml(browser, html, { width, height }) {
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await page.waitForLoadState('load');
    return await page.screenshot({ type: 'jpeg', quality: 92 });
  } finally {
    await context.close();
  }
}

/** A 640 x 480 camera frame (as a JPEG) showing a QR code, SVG in, JPEG out. */
export function qrFrame(browser, svg) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return screenshotHtml(
    browser,
    `<body style="margin:0;background:#fff;display:grid;place-items:center;width:640px;height:480px"><img src="${src}" style="width:460px;height:460px"></body>`,
    { width: 640, height: 480 },
  );
}

/** A 640 x 480 camera frame showing one of the fixture faces, cropped from the library's demo photos. */
export function faceFrame(browser, key) {
  const { file, rect, mirror = false } = FACES[key];
  const [x, y, w, h] = rect;
  const photo = readFileSync(join(ROOT, DEMO_PHOTOS, file)).toString('base64');
  const scale = 480 / h;
  return screenshotHtml(
    browser,
    `<body style="margin:0;background:#777;display:grid;place-items:center;width:640px;height:480px;overflow:hidden">
       <div style="width:${w}px;height:${h}px;overflow:hidden;position:relative;transform:scale(${scale})${mirror ? ' scaleX(-1)' : ''}">
         <img src="data:image/jpeg;base64,${photo}" style="position:absolute;left:-${x}px;top:-${y}px">
       </div></body>`,
    { width: 640, height: 480 },
  );
}

/** A looping camera that shows several pictures in turn: [{ jpeg, frames }, ...] (30 frames is one second). */
export function mjpegSequence(dir, name, parts) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.mjpeg`);
  writeFileSync(path, Buffer.concat(parts.flatMap(({ jpeg, frames }) => Array.from({ length: frames }, () => jpeg))));
  return path;
}

/** Writes the frame as a short MJPEG file (frames back to back), which Chrome loops as a camera. */
export function mjpegFile(dir, name, jpeg, frames = 30) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.mjpeg`);
  writeFileSync(path, Buffer.concat(Array.from({ length: frames }, () => jpeg)));
  return path;
}

/**
 * A local stand-in for OpenStreetMap's Overpass service that answers every query with one building, so
 * the "add building outline" button can be tried in a real browser without the internet. `ring` is
 * [[lat, lng], ...]; it is returned as a closed way, the way Overpass does. `calls` records the queries.
 */
export async function startFakeOverpass(ring, { id = 4242, name = 'Block A' } = {}) {
  const { createServer: createHttpServer } = await import('node:http');
  const calls = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      calls.push(decodeURIComponent(body));
      res.setHeader('Content-Type', 'application/json');
      const geometry = [...ring, ring[0]].map(([lat, lon]) => ({ lat, lon }));
      res.end(JSON.stringify({ elements: [{ type: 'way', id, tags: { building: 'university', name }, geometry }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/interpreter`,
    calls,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
