// Face check support. A face is never stored as a picture: the browser turns a photo into 128
// numbers (a "descriptor") and only those numbers leave the phone. A student's enrolled template is
// the average of three of them, encrypted at rest. A scan's descriptor is compared with the
// template and then thrown away; only the distance is kept.
//
// This is a SIGNAL, not a gate: a poor match sends a scan to faculty review, it never rejects one.
// There is no liveness check, so a photo of a face could pass; the README says so.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DESCRIPTOR_LENGTH = 128;
// With these descriptors, two photos of the same person are usually under 0.6 apart (a common
// convention for this network). The synthetic training data assumes about 0.40 for the same
// person and 0.78 for a different one; those are assumptions to be re-measured with real enrolments.
export const MATCH_THRESHOLD = 0.6;
// The three enrolment photos must look like each other, or one of them is probably not the student.
export const ENROL_MAX_SPREAD = 0.6;
export const ENROL_PHOTOS = 3;

/** Checks a descriptor and returns it as plain numbers, or throws a RangeError saying what is wrong. */
export function validateDescriptor(value) {
  if (!Array.isArray(value) || value.length !== DESCRIPTOR_LENGTH) {
    throw new RangeError(`A face descriptor is ${DESCRIPTOR_LENGTH} numbers.`);
  }
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 3) {
      throw new RangeError('A face descriptor holds numbers between -3 and 3.');
    }
  }
  return value.slice();
}

export function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

export function average(list) {
  return Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => list.reduce((s, d) => s + d[i], 0) / list.length);
}

/** The template for a set of enrolment descriptors, and how far apart the photos were. */
export function makeTemplate(descriptors) {
  const list = descriptors.map(validateDescriptor);
  const template = average(list);
  let spread = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) spread = Math.max(spread, distance(list[i], list[j]));
  }
  return { template, spread };
}

/** AES-256-GCM sealing of a template. The key lives outside the database. */
export function createFaceVault({ keyHex }) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('The face key must be 64 hex characters.');
  const key = Buffer.from(keyHex, 'hex');
  // Bound to the student, so a template copied to another account does not open.
  const aad = (userId) => Buffer.from(`smartattend-face:${userId}`);

  return {
    seal(template, userId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(userId));
      const body = Buffer.concat([cipher.update(JSON.stringify(template.map((n) => Math.round(n * 1e6) / 1e6)), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
    },
    open(sealed, userId) {
      const [version, iv, tag, body] = String(sealed).split('.');
      if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unreadable face template.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(aad(userId));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
      return validateDescriptor(JSON.parse(plain));
    },
  };
}

/** The key comes from FACE_KEY, or from a file created on first use (kept next to, not inside, the database). */
export function loadFaceKey(keyFile) {
  if (process.env.FACE_KEY) return process.env.FACE_KEY;
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  mkdirSync(dirname(keyFile), { recursive: true });
  const created = randomBytes(32).toString('hex');
  writeFileSync(keyFile, created + '\n', { mode: 0o600 });
  return created;
}

/** The student's template, or null if none is stored or it cannot be opened. */
export function loadTemplate(db, vault, userId) {
  const row = db.prepare('SELECT face_template AS sealed FROM users WHERE id = ?').get(userId);
  if (!row?.sealed) return null;
  try {
    return vault.open(row.sealed, userId);
  } catch {
    return null;
  }
}
