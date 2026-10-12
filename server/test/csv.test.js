import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileSafe, safeCell, toCsv } from '../src/csv.js';
import { canStillMiss } from '../src/queries.js';

test('cells that a spreadsheet would run as formulas are neutralised', () => {
  for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '=HYPERLINK("http://x")']) {
    assert.ok(safeCell(evil).replace(/^"/, '').startsWith("'"), evil);
  }
  assert.equal(safeCell('Aarav Sharma'), 'Aarav Sharma');
  assert.equal(safeCell(12), '12');
  assert.equal(safeCell(null), '');
});

test('commas, quotes and newlines are quoted', () => {
  assert.equal(safeCell('Khanal, Meera'), '"Khanal, Meera"');
  assert.equal(safeCell('say "hi"'), '"say ""hi"""');
  assert.equal(safeCell('a\nb'), '"a\nb"');
});

test('the file starts with a UTF-8 byte-order mark and keeps Devanagari intact', () => {
  const csv = toCsv([['नाम', 'Name'], ['आरव शर्मा', 'Aarav']]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('आरव शर्मा'));
  assert.ok(csv.includes('\r\n'));
});

test('file names are made safe', () => {
  assert.equal(fileSafe('CS301 / L3: "x"'), 'CS301-L3-x');
  assert.equal(fileSafe('///'), 'attendance');
});

test('classes you can still miss: exact arithmetic', () => {
  // 6 attended of 8 held, 40 planned: 32 left, 30 needed overall -> 6 + 32 - 30 = 8
  assert.equal(canStillMiss({ attended: 6, held: 8, planned: 40 }), 8);
  // 2 attended of 10 held, 40 planned: 2 + 30 - 30 = 2
  assert.equal(canStillMiss({ attended: 2, held: 10, planned: 40 }), 2);
  // 0 of 20 held: 0 + 20 - 30 = -10 (can no longer reach 75%)
  assert.equal(canStillMiss({ attended: 0, held: 20, planned: 40 }), -10);
  // Course over: remaining never negative
  assert.equal(canStillMiss({ attended: 30, held: 45, planned: 40 }), 0);
});
