// CSV export. Two things matter beyond quoting:
//  - a cell that starts with = + - @ (or a tab / carriage return) is read as a formula by
//    spreadsheet programs, so it is prefixed with an apostrophe;
//  - a byte-order mark tells Excel the file is UTF-8, so Devanagari names are not garbled.
const BOM = String.fromCharCode(0xfeff);

export function safeCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows) {
  return BOM + rows.map((row) => row.map(safeCell).join(',')).join('\r\n') + '\r\n';
}

// Local date-time as YYYY-MM-DD HH:mm:ss (server's time zone).
export function stamp(ms) {
  if (ms == null) return '';
  return new Date(ms).toLocaleString('sv-SE', { hour12: false });
}

export function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'attendance';
}
