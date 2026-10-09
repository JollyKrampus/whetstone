/**
 * Minimal RFC 4180 CSV reading for 17Lands' public datasets: one record per line (no embedded
 * newlines; card names may contain commas and are then quoted). The hot path, `scanFields`,
 * walks a line without allocating an array, because game-data rows have over a thousand
 * columns and there are hundreds of thousands of rows.
 */

/** Called for every field: `quoted` holds the unescaped value of a quoted field, else null (read line.slice(start, end)). */
export type FieldVisitor = (col: number, start: number, end: number, quoted: string | null) => void;

/** Visit each field of one CSV line. Returns the number of fields. */
export function scanFields(line: string, visit: FieldVisitor): number {
  const n = line.length;
  let col = 0;
  let i = 0;
  for (;;) {
    if (i < n && line.charCodeAt(i) === 34 /* " */) {
      let value = '';
      let j = i + 1;
      for (;;) {
        const close = line.indexOf('"', j);
        if (close === -1) {
          // Unterminated quote: take the rest of the line as the value.
          value += line.slice(j);
          j = n;
          break;
        }
        value += line.slice(j, close);
        if (line.charCodeAt(close + 1) === 34) {
          value += '"';
          j = close + 2;
          continue;
        }
        j = close + 1;
        break;
      }
      visit(col, i, j, value);
      const comma = line.indexOf(',', j);
      col++;
      if (comma === -1) return col;
      i = comma + 1;
      if (i === n) {
        visit(col, n, n, null);
        return col + 1;
      }
      continue;
    }
    const comma = line.indexOf(',', i);
    const end = comma === -1 ? n : comma;
    visit(col, i, end, null);
    col++;
    if (comma === -1) return col;
    i = comma + 1;
    if (i === n) {
      visit(col, n, n, null);
      return col + 1;
    }
  }
}

/** All fields of one CSV line as strings. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  scanFields(line, (_col, start, end, quoted) => {
    out.push(quoted ?? line.slice(start, end));
  });
  return out;
}

/** Non-negative integer in line[start, end); 0 for an empty field, NaN for anything else. */
export function intAt(line: string, start: number, end: number): number {
  if (start === end) return 0;
  let v = 0;
  for (let i = start; i < end; i++) {
    const d = line.charCodeAt(i) - 48;
    if (d < 0 || d > 9) {
      // Rare forms such as "1.0" or "-1".
      const n = Number(line.slice(start, end));
      return Number.isFinite(n) ? n : Number.NaN;
    }
    v = v * 10 + d;
  }
  return v;
}

/** True for 17Lands' boolean spellings ("True", "true", "1"). */
export function truthyAt(line: string, start: number, end: number): boolean {
  if (start === end) return false;
  const c = line.charCodeAt(start);
  return c === 84 /* T */ || c === 116 /* t */ || (c === 49 /* 1 */ && end - start === 1);
}

/** Rows of a CSV as objects keyed by header (small files only, e.g. 17Lands cards.csv). */
export async function readCsvObjects(lines: AsyncIterable<string> | Iterable<string>): Promise<Record<string, string>[]> {
  let header: string[] | null = null;
  const rows: Record<string, string>[] = [];
  for await (const line of lines) {
    if (line === '') continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields.map((h) => h.trim());
      continue;
    }
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = fields[i] ?? '';
    });
    rows.push(row);
  }
  return rows;
}
