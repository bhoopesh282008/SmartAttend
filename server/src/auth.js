import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const LOGIN_TTL_MS = 12 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readOrCreate(db, key, bytes) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (row) return row.value;
  const value = randomBytes(bytes).toString('hex');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
  return value;
}

/**
 * DEMO LOGIN: a person picks an account; there are no passwords. A real deployment would
 * sit behind the college's own sign-in (SSO or OTP). The signed login token itself is
 * the same shape either way: who, what role, until when.
 */
export function createAuth(db, now) {
  const secret = readOrCreate(db, 'auth_secret', 32);
  const ipSalt = readOrCreate(db, 'ip_salt', 16);

  const sign = (body) => createHmac('sha256', secret).update(body).digest('base64url');

  function issue(user) {
    const body = Buffer.from(JSON.stringify({ uid: user.id, role: user.role, exp: now() + LOGIN_TTL_MS })).toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function verify(token) {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(sign(body));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (typeof payload.exp !== 'number' || payload.exp < now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // Express middleware. role is optional; when given, only that role passes.
  function require(role) {
    return (req, res, next) => {
      const header = req.get('authorization') ?? '';
      const payload = verify(header.startsWith('Bearer ') ? header.slice(7) : null);
      if (!payload) return next(new HttpError(401, 'not_signed_in', 'Please sign in again.'));
      const user = db.prepare('SELECT id, role, name, roll_no AS rollNo FROM users WHERE id = ?').get(payload.uid);
      if (!user) return next(new HttpError(401, 'not_signed_in', 'Please sign in again.'));
      if (role && user.role !== role) {
        return next(new HttpError(403, 'wrong_role', `This needs a ${role} account.`));
      }
      req.user = { ...user };
      next();
    };
  }

  // The address is never stored; a salted short hash is enough to notice "same network".
  const hashIp = (ip) => createHash('sha256').update(ipSalt + String(ip ?? '')).digest('hex').slice(0, 12);

  return { issue, verify, require, hashIp };
}
