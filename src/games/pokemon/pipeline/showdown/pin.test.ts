import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { regulationPlan } from '../regulations.ts';
import { ROOT, WITH_NEXT } from '../test-support.ts';
import { RawDexExportSchema } from './raw.ts';
import { readRecordedExport } from './source.ts';
import { SHOWDOWN_PIN_FILE, ShowdownPinSchema, checkExport, compareUrl, dexRequest, isCi, loadShowdownPin, pinText, readExportFile } from './pin.ts';

const recorded = readRecordedExport(ROOT);
const regs = { regulations: WITH_NEXT.regulations.slice(0, 2) };
const request = dexRequest(regs, regulationPlan(regs, new Date('2026-10-09T01:15:00Z')));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ws-pin-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('the Showdown pin', () => {
  it('is a tracked file with a full commit SHA and a review date', () => {
    const pin = loadShowdownPin(ROOT);
    expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The file is written in the CLI's canonical form, so a bump PR diff is one or two lines.
    expect(readFileSync(path.join(ROOT, SHOWDOWN_PIN_FILE), 'utf8')).toBe(pinText(pin));
  });

  it('refuses branch names, short SHAs and unknown keys', () => {
    expect(ShowdownPinSchema.safeParse({ sha: 'master', reviewedOn: '2026-10-10' }).success).toBe(false);
    expect(ShowdownPinSchema.safeParse({ sha: '7332b60', reviewedOn: '2026-10-10' }).success).toBe(false);
    expect(ShowdownPinSchema.safeParse({ sha: recorded.sha, reviewedOn: '10/10/2026' }).success).toBe(false);
    expect(ShowdownPinSchema.safeParse({ sha: recorded.sha, reviewedOn: '2026-10-10', branch: 'master' }).success).toBe(false);
    expect(() => pinText({ sha: 'HEAD', reviewedOn: '2026-10-10' })).toThrow();
  });

  it('links the upstream changes a bump must read', () => {
    expect(compareUrl('a'.repeat(40), 'b'.repeat(40))).toBe(`https://github.com/smogon/pokemon-showdown/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`);
  });

  it('knows a CI runner', () => {
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCi({})).toBe(false);
  });
});

describe('export files from the isolated job', () => {
  it('accepts the export of the pinned commit for this run', () => {
    const file = path.join(tmp, 'export.json');
    writeFileSync(file, JSON.stringify(recorded));
    const raw = readExportFile(file);
    expect(RawDexExportSchema.safeParse(raw).success).toBe(true);
    expect(() => checkExport(raw, recorded.sha, request)).not.toThrow();
  });

  it('rejects another commit, other regulations and data from an unrequested regulation', () => {
    expect(() => checkExport(recorded, '1'.repeat(40), request)).toThrow(/pins 1111111/);
    expect(() => checkExport({ ...recorded, regulations: recorded.regulations.slice(1) }, recorded.sha, request)).toThrow(/covers regulations/);
    expect(() => checkExport({ ...recorded, dataRegulation: 'M-A' }, recorded.sha, request)).toThrow(/not one of M-C, M-B/);
  });

  it('rejects unreadable and malformed files with the file named', () => {
    expect(() => readExportFile(path.join(tmp, 'missing.json'))).toThrow(/cannot read the Showdown export/);
    const bad = path.join(tmp, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...recorded, species: [{ id: 'Not An Id' }] }));
    expect(() => readExportFile(bad)).toThrow(/Showdown export bad\.json/);
  });
});
