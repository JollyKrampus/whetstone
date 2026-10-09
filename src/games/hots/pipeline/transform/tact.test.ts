import { describe, expect, it } from 'vitest';
import { parseTactTable, tactBuild } from './tact.ts';

const TABLE = [
  'Region!STRING:0|BuildConfig!HEX:16|CDNConfig!HEX:16|KeyRing!HEX:16|BuildId!DEC:4|VersionsName!String:0|ProductConfig!HEX:16',
  '## seqn = 4058626',
  'cn|aa||bb|89566|2.55.3.89566|cc',
  'eu|a64c||9575|98348|2.57.0.98348|a0c5',
  'kr|a64c||9575|98348|2.57.0.98348|a0c5',
  'us|a64c||9575|98348|2.57.0.98348|a0c5',
].join('\n');

describe('parseTactTable', () => {
  it('reads region and VersionsName columns by header name', () => {
    expect(parseTactTable(TABLE)).toEqual([
      { region: 'cn', build: '2.55.3.89566' },
      { region: 'eu', build: '2.57.0.98348' },
      { region: 'kr', build: '2.57.0.98348' },
      { region: 'us', build: '2.57.0.98348' },
    ]);
  });

  it('handles CRLF line endings and skips malformed rows', () => {
    const text = TABLE.replace(/\n/g, '\r\n') + '\r\nxx|broken';
    expect(parseTactTable(text)).toHaveLength(4);
  });

  it('throws when the columns are missing', () => {
    expect(() => parseTactTable('Foo!STRING:0|Bar!DEC:4\nx|1')).toThrow(/Region\/VersionsName/);
  });
});

describe('tactBuild', () => {
  it('prefers the us row and ignores cn', () => {
    expect(tactBuild(TABLE)).toBe('2.57.0.98348');
  });

  it('falls back to the most common non-cn build, newest on ties', () => {
    const noUs = TABLE.split('\n').filter((l) => !l.startsWith('us|')).join('\n').replace('kr|a64c||9575|98348|2.57.0.98348', 'kr|a64c||9575|98304|2.57.0.98304');
    expect(tactBuild(noUs)).toBe('2.57.0.98348');
  });

  it('throws when only cn is listed', () => {
    const cnOnly = TABLE.split('\n').filter((l) => !/^(eu|kr|us)\|/.test(l)).join('\n');
    expect(() => tactBuild(cnOnly)).toThrow(/no region rows/);
  });
});
