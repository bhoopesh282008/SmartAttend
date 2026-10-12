import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { createMlClient, createRiskScorer } from '../src/ml.js';

// A stand-in for the Python service, scripted per test through ml.state.
function setup(mlOptions, { dir } = {}) {
  const clock = { t: Date.UTC(2026, 9, 12, 9, 0, 0) };
  const now = () => clock.t;
  const db = openDb(':memory:');
  seedDemo(db, { now });
  const state = { flag: false, reasons: [], risk: 0.1, fail: false, atRisk: null, ...mlOptions };
  const calls = { proxy: [], atRisk: [] };
  const ml = {
    calls,
    state,
    async proxyScore(features) {
      calls.proxy.push(features);
      if (state.fail) throw new Error('down');
      return { risk: state.risk, flag: state.flag, threshold: 0.27, reasons: state.reasons, model_version: 'proxy-lr-test' };
    },
    async atRisk(payload) {
      calls.atRisk.push(payload);
      if (state.fail) throw new Error('down');
      return state.atRisk(payload);
    },
    async health() {
      return state.fail ? { available: false, models: {} } : { available: true, models: { proxy: 'proxy-lr-test' } };
    },
  };
  const app = createApp({ db, now, demo: true, ml, modelsDir: dir });
  return { app, db, clock, ml };
}

async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
  const login = async (id) => (await call('POST', '/api/auth/login', { body: { userId: id } })).data.token;
  return { call, login, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('the risk scorer', () => {
  const scan = { place: { action: 'ok', distanceM: 40, accuracyM: 12 }, base: { token_age_s: 20 }, sharedDevices: 1, newDevice: true, burst: 2 };

  test('sends the model its inputs and passes the answer back', async () => {
    const seen = [];
    const scorer = createRiskScorer({
      proxyScore: async (f) => {
        seen.push(f);
        return { risk: 0.8, flag: true, reasons: [{ code: 'device_shared', text: 'x', weight: 1.2 }], model_version: 'v1' };
      },
    });
    const out = await scorer(scan);
    assert.deepEqual(seen[0], {
      token_age_s: 20, location_status: 'ok', distance_m: 40, accuracy_m: 12,
      device_shared_count: 1, new_device_for_student: true, scan_burst_count: 2, face_distance: null,
    });
    assert.deepEqual(out, { risk: 0.8, review: true, reasons: [{ code: 'device_shared', text: 'x' }], scoredBy: 'v1' });
  });

  test('a missing position is sent as missing, and a skipped check as not_checked, never as distance zero', async () => {
    const seen = [];
    const scorer = createRiskScorer({ proxyScore: async (f) => { seen.push(f); return { risk: 0, flag: false, reasons: [], model_version: 'v' }; } });
    await scorer({ ...scan, place: { action: 'review', distanceM: null, accuracyM: null } });
    await scorer({ ...scan, place: { action: 'skipped', distanceM: null, accuracyM: null } });
    assert.equal(seen[0].location_status, 'missing');
    assert.equal(seen[0].distance_m, null);
    assert.equal(seen[1].location_status, 'not_checked');
  });

  test('when the service fails, the answer is "rules" and nothing throws', async () => {
    const out = await createRiskScorer({ proxyScore: async () => { throw new Error('boom'); } })(scan);
    assert.deepEqual(out, { risk: null, review: false, reasons: [], scoredBy: 'rules' });
  });
});

describe('the client', () => {
  test('a slow service times out instead of hanging a scan', async () => {
    const client = createMlClient({
      timeoutMs: 50,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const started = Date.now();
    await assert.rejects(client.proxyScore({}));
    assert.ok(Date.now() - started < 1000);
  });

  test('health is cached, and a failure is reported as unavailable', async () => {
    let hits = 0;
    const client = createMlClient({ fetchImpl: async () => { hits += 1; return { ok: true, json: async () => ({ models: { proxy: 'v' } }) }; } });
    assert.equal((await client.health()).available, true);
    await client.health();
    assert.equal(hits, 1);
    const down = createMlClient({ fetchImpl: async () => { throw new Error('refused'); } });
    assert.equal((await down.health()).available, false);
  });
});

describe('scans through the app with the model plugged in', () => {
  let h;
  let faculty;
  let lecture;
  before(async () => {
    h = setup({});
    h.srv = await serve(h.app);
    faculty = await h.srv.login(1);
    lecture = (await h.srv.call('POST', '/api/courses/1/sessions', { token: faculty, body: {} })).data.id;
  });
  after(() => h.srv.close());

  const code = async () => (await h.srv.call('POST', `/api/sessions/${lecture}/qr`, { token: faculty, body: { origin: 'http://localhost:5180' } })).data.token;
  const scanAs = async (id, extra = {}) =>
    h.srv.call('POST', '/api/scan', { token: await h.srv.login(id), body: { token: await code(), deviceId: `phone-of-${id}-xx`, location: null, ...extra } });
  const rowOf = async (id) => (await h.srv.call('GET', `/api/sessions/${lecture}`, { token: faculty })).data.roster.find((r) => r.studentId === id);

  test('a scan the model does not flag is present and carries its score and model version', async () => {
    h.ml.state.flag = false;
    h.ml.state.risk = 0.05;
    assert.equal((await scanAs(100)).data.outcome, 'marked');
    const row = await rowOf(100);
    assert.equal(row.status, 'present');
    assert.equal(row.risk, 0.05);
    assert.equal(row.scoredBy, 'proxy-lr-test');
  });

  test('a flagged scan goes to review with the model’s reasons, which the student is not told', async () => {
    h.ml.state.flag = true;
    h.ml.state.risk = 0.7;
    h.ml.state.reasons = [{ code: 'new_device', text: 'First time this student has used this device' }];
    const res = await scanAs(101);
    assert.equal(res.data.outcome, 'review');
    assert.equal(res.data.reasons, undefined);
    const row = await rowOf(101);
    assert.equal(row.status, 'review');
    assert.deepEqual(row.reasons.map((r) => r.code), ['new_device']);
  });

  test('a reason the rules already gave is not repeated', async () => {
    h.ml.state.reasons = [{ code: 'device_shared', text: 'dup' }, { code: 'scan_burst', text: 'burst' }];
    await scanAs(102, { deviceId: 'demo-device-100' }); // student 100's seeded phone: the rules flag device_shared
    const codes = (await rowOf(102)).reasons.map((r) => r.code);
    assert.deepEqual(codes.sort(), ['device_shared', 'scan_burst']);
  });

  test('the model is told the scan facts: a missing location, a first-ever device, other scans from the same network', async () => {
    h.ml.state.flag = false;
    h.ml.calls.proxy.length = 0;
    await scanAs(103);
    const sent = h.ml.calls.proxy.at(-1);
    assert.equal(sent.location_status, 'not_checked', 'this lecture has no location check');
    assert.equal(sent.new_device_for_student, false, 'a first-ever scan has no baseline to be new against');
    assert.ok(sent.scan_burst_count >= 1, 'earlier scans in this lecture came from the same (test) network');
    assert.equal(sent.face_distance, null);
  });

  test('with the model down, scans are decided by the rules and marked as such', async () => {
    h.ml.state.fail = true;
    const res = await scanAs(104);
    assert.equal(res.data.outcome, 'marked');
    const row = await rowOf(104);
    assert.equal(row.status, 'present');
    assert.equal(row.scoredBy, 'rules');
    assert.equal(row.risk, null);
    const detail = (await h.srv.call('GET', `/api/sessions/${lecture}`, { token: faculty })).data;
    assert.equal(detail.scoring.modelOnline, false);
    assert.ok(detail.scoring.modelScored >= 3 && detail.scoring.rulesScored >= 1);
    h.ml.state.fail = false;
  });

  test('a second phone for a student who already has one is a new device', async () => {
    h.ml.calls.proxy.length = 0;
    const other = (await h.srv.call('POST', '/api/courses/2/sessions', { token: faculty, body: {} })).data.id;
    const tokenFor = async () => (await h.srv.call('POST', `/api/sessions/${other}/qr`, { token: faculty, body: { origin: 'http://localhost:5180' } })).data.token;
    const student = await h.srv.login(100); // already scanned from phone-of-100-xx in the first lecture
    await h.srv.call('POST', '/api/scan', { token: student, body: { token: await tokenFor(), deviceId: 'a-second-phone-100', location: null } });
    assert.equal(h.ml.calls.proxy.at(-1).new_device_for_student, true);
    await h.srv.call('POST', `/api/sessions/${other}/close`, { token: faculty });
  });
});

describe('at-risk list', () => {
  let h;
  let faculty;
  before(async () => {
    h = setup({});
    h.srv = await serve(h.app);
    faculty = await h.srv.login(1);
  });
  after(() => h.srv.close());

  test('sends the model each student’s record over the CLOSED lectures only, and merges names back', async () => {
    h.ml.state.atRisk = (payload) => ({
      model_version: 'atrisk-test',
      results: payload.students.map((s, i) => ({
        id: s.id, held: s.attended.length, attended: s.attended.reduce((a, b) => a + b, 0),
        insufficient: false, risk: 1 - i / 100, band: i < 3 ? 'high' : 'low', can_still_miss: 3,
        reasons: i < 3 ? [{ code: 'low_attendance', text: 'low', weight: 1 }] : [],
      })),
    });
    const res = await h.srv.call('GET', '/api/courses/1/at-risk', { token: faculty });
    assert.equal(res.status, 200);
    assert.equal(res.data.scoredBy, 'atrisk-test');
    assert.equal(res.data.modelOnline, true);
    const sent = h.ml.calls.atRisk[0];
    assert.equal(sent.planned_lectures, 40);
    assert.equal(sent.students.length, 30);
    assert.ok(sent.students.every((s) => s.attended.length === 8 && s.late.length === 8), 'eight closed lectures were seeded');
    assert.ok(sent.students.every((s) => s.attended.every((v) => v === 0 || v === 1)));
    assert.ok(res.data.students[0].name && res.data.students[0].rollNo);
    assert.equal(res.data.students[0].band, 'high');
    assert.ok(res.data.students.some((s) => s.band === 'low'));
  });

  test('a lecture that is still open is not part of anyone’s record', async () => {
    const id = (await h.srv.call('POST', '/api/courses/1/sessions', { token: faculty, body: {} })).data.id;
    h.ml.calls.atRisk.length = 0;
    await h.srv.call('GET', '/api/courses/1/at-risk', { token: faculty });
    assert.ok(h.ml.calls.atRisk[0].students.every((s) => s.attended.length === 8));
    await h.srv.call('POST', `/api/sessions/${id}/close`, { token: faculty });
  });

  test('scans held for review or blocked are counted as flags; late scans are marked late', async () => {
    const lectureId = (await h.srv.call('GET', '/api/courses', { token: faculty })).data.find((c) => c.id === 1).lectures[0].id;
    const startedAt = h.db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(lectureId).started_at;
    // Student 100 arrived 20 minutes after the newest closed lecture began; student 101 had a blocked attempt.
    h.db.prepare('DELETE FROM scans WHERE session_id = ? AND student_id IN (100, 101)').run(lectureId);
    h.db.prepare("INSERT INTO scans (session_id, student_id, device_id, ts, method, status) VALUES (?, 100, 'd-100-xx', ?, 'qr', 'present')").run(lectureId, startedAt + 20 * 60 * 1000);
    h.db.prepare("INSERT INTO scans (session_id, student_id, ts, status, reject_code) VALUES (?, 101, ?, 'rejected', 'device_used')").run(lectureId, startedAt + 1000);
    h.ml.calls.atRisk.length = 0;
    await h.srv.call('GET', '/api/courses/1/at-risk', { token: faculty });
    const sent = h.ml.calls.atRisk[0].students;
    const s100 = sent.find((s) => s.id === 100);
    const newest = s100.attended.length - 1; // lectures are sent oldest first
    assert.equal(s100.attended[newest], 1);
    assert.equal(s100.late[newest], 1, '20 minutes after the start is late');
    const s101 = sent.find((s) => s.id === 101);
    assert.equal(s101.attended[newest], 0);
    assert.ok(s101.flags >= 1, 'a blocked attempt counts as a flag');
  });

  test('with the model down the list falls back to rules and says so', async () => {
    h.ml.state.fail = true;
    const res = await h.srv.call('GET', '/api/courses/1/at-risk', { token: faculty });
    assert.equal(res.status, 200);
    assert.equal(res.data.scoredBy, 'rules');
    assert.equal(res.data.modelOnline, false);
    assert.ok(res.data.students.every((s) => s.risk === null));
    const [first] = res.data.students;
    assert.ok(['high', 'watch'].includes(first.band) || first.band === 'low');
    assert.ok(res.data.students.some((s) => s.band === 'watch' || s.band === 'high'));
    h.ml.state.fail = false;
  });

  test('only the course’s own lecturer can read it', async () => {
    const other = await h.srv.login(2);
    assert.equal((await h.srv.call('GET', '/api/courses/1/at-risk', { token: other })).status, 403);
    assert.equal((await h.srv.call('GET', '/api/courses/1/at-risk')).status, 401);
  });
});

describe('model card', () => {
  test('is read from the files the training scripts wrote, and is there even when the service is down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'models-'));
    writeFileSync(join(dir, 'proxy_metrics.json'), JSON.stringify({ version: 'proxy-lr-x', data: { synthetic: true } }));
    const h = setup({ fail: true }, { dir });
    h.srv = await serve(h.app);
    const token = await h.srv.login(100);
    const res = await h.srv.call('GET', '/api/models', { token });
    assert.equal(res.status, 200);
    assert.equal(res.data.proxy.version, 'proxy-lr-x');
    assert.equal(res.data.atrisk, null, 'a model that was never trained has no card');
    assert.equal(res.data.service.available, false);
    assert.equal((await h.srv.call('GET', '/api/models')).status, 401);
    await h.srv.close();
  });
});
