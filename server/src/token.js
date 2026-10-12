import { createHmac, timingSafeEqual } from 'node:crypto';

// A QR code is valid for exactly 60 seconds from the moment it is generated (issuedAt is
// inside the signed token), plus a short grace for network delay. The server clock is the
// only clock that counts, so a student's phone clock does not matter.
export const TOKEN_TTL_MS = 60_000;
export const GRACE_MS = 2_000;

const SIG_BYTES = 16;

function mac(secret, sessionId, issuedAt) {
  return createHmac('sha256', secret)
    .update(`${sessionId}|${issuedAt}`)
    .digest()
    .subarray(0, SIG_BYTES);
}

export function signToken(secret, sessionId, issuedAt) {
  return `${sessionId}.${issuedAt}.${mac(secret, sessionId, issuedAt).toString('base64url')}`;
}

// Splits a token into its parts without trusting any of them yet.
export function parseToken(token) {
  if (typeof token !== 'string') return null;
  const match = /^(\d{1,12})\.(\d{10,16})\.([A-Za-z0-9_-]{22})$/.exec(token);
  if (!match) return null;
  return { sessionId: Number(match[1]), issuedAt: Number(match[2]), sig: match[3] };
}

export function checkSignature(secret, parsed) {
  const expected = mac(secret, parsed.sessionId, parsed.issuedAt);
  const given = Buffer.from(parsed.sig, 'base64url');
  // The last base64 character carries two unused bits, which the decoder ignores. Requiring the
  // text to equal its own re-encoding means exactly one string is valid for each signature.
  if (given.toString('base64url') !== parsed.sig) return false;
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Window check only; call checkSignature first.
export function checkWindow(parsed, now) {
  const ageMs = now - parsed.issuedAt;
  if (ageMs < 0) return { ok: false, code: 'bad_token', ageMs };
  if (ageMs > TOKEN_TTL_MS + GRACE_MS) return { ok: false, code: 'expired', ageMs };
  return { ok: true, ageMs };
}
