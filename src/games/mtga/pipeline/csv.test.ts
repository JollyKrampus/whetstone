import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { intAt, parseCsvLine, readCsvObjects, scanFields, truthyAt } from './csv.ts';
import { gunzipLines, isGzip, splitLines, textLines } from './lines.ts';

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('parseCsvLine', () => {
  it('splits plain and quoted fields, keeping commas and doubled quotes inside quotes', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvLine('"Bilbo Baggins, Burglar",2,"say ""hi"""')).toEqual(['Bilbo Baggins, Burglar', '2', 'say "hi"']);
    expect(parseCsvLine('x,"",y')).toEqual(['x', '', 'y']);
  });

  it('keeps empty leading, middle and trailing fields', () => {
    expect(parseCsvLine(',a,,b,')).toEqual(['', 'a', '', 'b', '']);
    expect(parseCsvLine('"q",')).toEqual(['q', '']);
    expect(parseCsvLine('')).toEqual(['']);
  });

  it('takes the rest of the line for an unterminated quote', () => {
    expect(parseCsvLine('a,"open, ended')).toEqual(['a', 'open, ended']);
  });
});

describe('scanFields', () => {
  it('reports column numbers and slice bounds without allocating values for unquoted fields', () => {
    const seen: [number, string][] = [];
    const line = 'HOB,"A, B",0,12';
    const n = scanFields(line, (col, start, end, quoted) => seen.push([col, quoted ?? line.slice(start, end)]));
    expect(n).toBe(4);
    expect(seen).toEqual([
      [0, 'HOB'],
      [1, 'A, B'],
      [2, '0'],
      [3, '12'],
    ]);
  });
});

describe('number and boolean cells', () => {
  it('parses non-negative integers fast and other numbers safely', () => {
    expect(intAt('x,123,y', 2, 5)).toBe(123);
    expect(intAt('', 0, 0)).toBe(0);
    expect(intAt('1.5', 0, 3)).toBe(1.5);
    expect(intAt('abc', 0, 3)).toBeNaN();
  });

  it("reads 17Lands' True/False and 1/0", () => {
    for (const t of ['True', 'true', '1']) expect(truthyAt(t, 0, t.length)).toBe(true);
    for (const f of ['False', 'false', '0', '', '10']) expect(truthyAt(f, 0, f.length)).toBe(false);
  });
});

describe('line readers', () => {
  it('splits lines across chunk boundaries, CRLF and multi-byte characters', async () => {
    const bytes = new TextEncoder().encode('one\r\ntwo\nÓin the Brave\nlast');
    const chunks = [bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9, 15), bytes.slice(15)];
    expect(await collect(splitLines(chunks))).toEqual(['one', 'two', 'Óin the Brave', 'last']);
    expect(await collect(splitLines(['a\n', '\n', 'b\r']))).toEqual(['a', '', 'b']);
  });

  it('streams gzip and plain buffers alike', async () => {
    const text = 'h1,h2\n1,2\n3,4\n';
    const gz = gzipSync(text);
    expect(isGzip(gz)).toBe(true);
    expect(await collect(gunzipLines(gz))).toEqual(['h1,h2', '1,2', '3,4']);
    expect(await collect(textLines(new TextEncoder().encode(text)))).toEqual(['h1,h2', '1,2', '3,4']);
    // Concatenated gzip members are one stream.
    const two = Buffer.concat([gzipSync('a\n'), gzipSync('b\n')]);
    expect(await collect(gunzipLines(two))).toEqual(['a', 'b']);
  });

  it('throws on a corrupt gzip instead of returning a partial file', async () => {
    const gz = gzipSync('x'.repeat(10_000));
    const broken = gz.slice(0, gz.byteLength - 20);
    await expect(collect(gunzipLines(broken))).rejects.toThrow();
  });

  it('reads small CSVs into objects', async () => {
    const rows = await readCsvObjects(['id,name', '1,"Fire, Ice"', '', '2,Shock']);
    expect(rows).toEqual([
      { id: '1', name: 'Fire, Ice' },
      { id: '2', name: 'Shock' },
    ]);
  });
});
