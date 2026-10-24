/** CSV helpers for contacts. Pure functions, no I/O. */

export const CSV_COLUMNS = ['name', 'email', 'phone', 'company', 'tags', 'notes', 'source', 'createdAt'] as const;

/** Spreadsheet apps execute cells that start with = + - @ (CSV injection): neutralise them. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','));
  // BOM so Excel opens UTF-8 (accents) correctly
  return '\uFEFF' + lines.join('\r\n');
}

export const normalizeEmail = (v?: string) => (v || '').trim().toLowerCase();
export const normalizePhone = (v?: string) => (v || '').replace(/\D/g, '');
export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
