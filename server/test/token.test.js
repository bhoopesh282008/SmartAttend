import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSignature, checkWindow, GRACE_MS, parseToken, signToken, TOKEN_TTL_MS,
} from '../src/token.js';

const SECRET = 'a'.repeat(48);
const ISSUED = 1_800_000_000_000;

test('a signed token parses and verifies', () => {
  const parsed = parseToken(signToken(SECRET, 7, ISSUED));
  assert.equal(parsed.sessionId, 7);
  assert.equal(parsed.issuedAt, ISSUED);
  assert.ok(checkSignature(SECRET, parsed));
});

test('valid at 0 s and at exactly 60 s, expired at 63 s', () => {
  const parsed = parseToken(signToken(SECRET, 7, ISSUED));
  assert.ok(checkWindow(parsed, ISSUED).ok);
  assert.ok(checkWindow(parsed, ISSUED + TOKEN_TTL_MS).ok);
  assert.ok(checkWindow(parsed, ISSUED + TOKEN_TTL_MS + GRACE_MS).ok, 'network grace');
  const late = checkWindow(parsed, ISSUED + 63_000);
  assert.equal(late.ok, false);
  assert.equal(late.code, 'expired');
});

test('a code from the future is refused', () => {
  const parsed = parseToken(signToken(SECRET, 7, ISSUED));
  assert.equal(checkWindow(parsed, ISSUED - 1).ok, false);
});

test('a tampered signature fails', () => {
  const token = signToken(SECRET, 7, ISSUED);
  const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  assert.equal(checkSignature(SECRET, parseToken(flipped)), false);
});

test('exactly one string is valid per signature: changing only the unused padding bits fails', () => {
  // The last of the 22 characters carries 4 real bits and 2 unused ones. Try every character
  // and confirm that only the original verifies, whatever the original ends with.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let issued = ISSUED; issued < ISSUED + 40; issued += 1) {
    const token = signToken(SECRET, 7, issued);
    const valid = [...alphabet].filter((c) => checkSignature(SECRET, parseToken(token.slice(0, -1) + c)));
    assert.deepEqual(valid, [token.slice(-1)], `only the real last character verifies (issued ${issued})`);
  }
});

test('changing the lecture number or the time invalidates the signature', () => {
  const [, issued, sig] = signToken(SECRET, 7, ISSUED).split('.');
  assert.equal(checkSignature(SECRET, parseToken(`8.${issued}.${sig}`)), false);
  assert.equal(checkSignature(SECRET, parseToken(`7.${ISSUED + 30_000}.${sig}`)), false);
});

test('another lecture’s secret does not verify', () => {
  const parsed = parseToken(signToken(SECRET, 7, ISSUED));
  assert.equal(checkSignature('b'.repeat(48), parsed), false);
});

test('garbage is not a token', () => {
  for (const junk of [null, undefined, 42, '', 'abc', '1.2.3', `7.${ISSUED}.short`, `7.${ISSUED}.${'!'.repeat(22)}`]) {
    assert.equal(parseToken(junk), null, String(junk));
  }
});
