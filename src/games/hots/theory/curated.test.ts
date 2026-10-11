import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import {
  CuratedError,
  HeroCuratedFileSchema,
  checkCuratedAgainstHeroes,
  compareMajor,
  loadCurated,
  mergePairs,
  mergeTraits,
  nameKey,
  normalizeCondition,
  readCurated,
  type PairInput,
} from './curated.ts';
import { fixtureHeroInputs } from './__fixtures__/kits.ts';
import { validateCurated } from './validate.ts';

const ROOT = repoRoot();
const SAMPLES = path.join(ROOT, 'src', 'games', 'hots', 'theory', '__fixtures__', 'curated');
const GLOBAL_FILES = ['traits.yaml', 'rules.yaml', 'counters.yaml', 'synergies.yaml', 'maps.yaml', 'aliases.yaml'];

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temporary repo root: the real global curated files plus the sample per-hero files, with
 * `extra` mapping heroes/<name> → a file from __fixtures__/curated/invalid/ (or raw text).
 */
function makeRoot(extra: Record<string, { invalid: string } | { text: string }> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whetstone-curated-'));
  temps.push(root);
  const dir = path.join(root, 'curated', 'hots');
  fs.mkdirSync(path.join(dir, 'heroes'), { recursive: true });
  for (const f of GLOBAL_FILES) fs.copyFileSync(path.join(ROOT, 'curated', 'hots', f), path.join(dir, f));
  for (const f of fs.readdirSync(path.join(SAMPLES, 'heroes'))) fs.copyFileSync(path.join(SAMPLES, 'heroes', f), path.join(dir, 'heroes', f));
  for (const [name, src] of Object.entries(extra)) {
    const target = path.join(dir, 'heroes', name);
    if ('invalid' in src) fs.copyFileSync(path.join(SAMPLES, 'invalid', src.invalid), target);
    else fs.writeFileSync(target, src.text);
  }
  return root;
}

const pair = (p: Partial<PairInput> & Pick<PairInput, 'a' | 'b'>): PairInput => ({
  why: 'A sample reason that is long enough.',
  evidence: [],
  conditions: [],
  confidence: 'low',
  reviewedFor: '2.57',
  source: 'heroes/x.yaml',
  ...p,
});

describe('per-hero file schema', () => {
  it('accepts the documented format with defaults for empty lists', () => {
    const f = HeroCuratedFileSchema.parse({ hero: 'valla', reviewedFor: '2.57' });
    expect(f).toEqual({ hero: 'valla', reviewedFor: '2.57', traits: [], counters: [], synergies: [] });
  });

  it('accepts conditions as one line or a list and leaves reviewedFor optional', () => {
    const base = { a: 'valla', b: 'abathur', why: 'A long enough reason here.', evidence: ['Hatred'], confidence: 'low' };
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [{ ...base, conditions: 'one' }] }).success).toBe(true);
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [{ ...base, conditions: ['one', 'two'] }] }).success).toBe(true);
  });

  it('rejects conditions that spell out "Only when", "Requires" or "Needs" (the page adds the words)', () => {
    const base = { a: 'valla', b: 'abathur', why: 'A long enough reason here.', evidence: ['Hatred'], confidence: 'low' };
    for (const conditions of ['Only when Valla takes Strafe', 'Requires Strafe at level 10.', ['needs Strafe']]) {
      expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [{ ...base, conditions }] }).success, String(conditions)).toBe(false);
    }
  });

  it('rejects unknown keys, duplicate pairs and self pairs', () => {
    const base = { a: 'valla', b: 'abathur', why: 'A long enough reason here.', evidence: ['Hatred'], confidence: 'low' };
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', extra: 1 }).success).toBe(false);
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [{ ...base, votes: 3 }] }).success).toBe(false);
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [base, base] }).success).toBe(false);
    expect(HeroCuratedFileSchema.safeParse({ hero: 'valla', reviewedFor: '2.57', counters: [{ ...base, b: 'valla' }] }).success).toBe(false);
  });
});

describe('mergePairs', () => {
  it('merges one edge per pair: max confidence, evidence union, two distinct reasons, newest review', () => {
    const { pairs, warnings } = mergePairs(
      [
        pair({ a: 'zeratul', b: 'abathur', why: 'First reason, long enough.', evidence: ['Cleave'], confidence: 'high', reviewedFor: '2.56', source: 'heroes/zeratul.yaml' }),
        pair({ a: 'zeratul', b: 'abathur', why: 'Second reason, long enough.', evidence: ['Cleave', 'Blink'], confidence: 'high', source: 'heroes/abathur.yaml' }),
        pair({ a: 'zeratul', b: 'abathur', why: 'Third reason, long enough.', conditions: ['late game'], confidence: 'high', source: 'heroes/abathur.yaml' }),
        pair({ a: 'zeratul', b: 'abathur', why: 'First reason, long enough.', conditions: ['Zeratul takes Cleave'], confidence: 'high', source: 'counters.yaml' }),
      ],
      'counters',
    );
    expect(warnings).toEqual([]);
    expect(pairs).toEqual([
      {
        a: 'zeratul',
        b: 'abathur',
        why: ['First reason, long enough.', 'Second reason, long enough.'],
        // Each shown line keeps the conditions of the files that wrote it; the third line is not shown.
        whyConditions: [['Zeratul takes Cleave'], []],
        evidence: ['Cleave', 'Blink'],
        conditions: ['late game', 'Zeratul takes Cleave'],
        confidence: 'high',
        weight: 0.6,
        reviewedFor: '2.57',
        sources: ['counters.yaml', 'heroes/abathur.yaml', 'heroes/zeratul.yaml'],
      },
    ]);
  });

  it('uses an explicit weight over the confidence weight and warns when files disagree', () => {
    const one = mergePairs([pair({ a: 'x', b: 'y', weight: 0.3, confidence: 'high' })], 'counters');
    expect(one.pairs[0]?.weight).toBe(0.3);
    const two = mergePairs([pair({ a: 'x', b: 'y', weight: 0.3 }), pair({ a: 'x', b: 'y', weight: 0.5, source: 'heroes/y.yaml' })], 'counters');
    expect(two.pairs[0]?.weight).toBe(0.3);
    expect(two.warnings.map((w) => w.message)).toEqual([expect.stringContaining('different weights')]);
  });

  it('takes the highest confidence and warns when files disagree on it', () => {
    const { pairs, warnings } = mergePairs(
      [pair({ a: 'anubarak', b: 'jaina', confidence: 'medium', source: 'heroes/anubarak.yaml' }), pair({ a: 'anubarak', b: 'jaina', why: 'Another reason, long enough.', confidence: 'high', source: 'heroes/jaina.yaml' })],
      'counters',
    );
    expect(pairs[0]?.confidence).toBe('high');
    expect(warnings).toEqual([
      { file: 'heroes/anubarak.yaml', message: 'counters anubarak/jaina: files set different confidence (medium in heroes/anubarak.yaml, high in heroes/jaina.yaml); using high' },
    ]);
  });

  it('drops a trailing full stop from conditions, which read after "Only when"', () => {
    expect(normalizeCondition('  Blaze takes Nanomachine Coating (level 7). ')).toBe('Blaze takes Nanomachine Coating (level 7)');
  });

  it('defaults to the confidence weight (.2 / .4 / .6)', () => {
    const { pairs } = mergePairs(
      [pair({ a: 'a', b: 'b', confidence: 'low' }), pair({ a: 'a', b: 'c', confidence: 'medium' }), pair({ a: 'a', b: 'd', confidence: 'high' })],
      'counters',
    );
    expect(pairs.map((p) => p.weight)).toEqual([0.2, 0.4, 0.6]);
  });

  it('keeps both directions of a contradicting counter and warns', () => {
    const { pairs, warnings } = mergePairs([pair({ a: 'nova', b: 'zeratul' }), pair({ a: 'zeratul', b: 'nova' })], 'counters');
    expect(pairs.map((p) => `${p.a}>${p.b}`)).toEqual(['nova>zeratul', 'zeratul>nova']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/contradiction: nova counters zeratul and zeratul counters nova/);
  });

  it('stores synergies with a < b and merges both spellings', () => {
    const { pairs, warnings } = mergePairs([pair({ a: 'valla', b: 'abathur' }), pair({ a: 'abathur', b: 'valla', why: 'Another reason, long enough.' })], 'synergies');
    expect(warnings).toEqual([]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'abathur', b: 'valla' });
    expect(pairs[0]?.why).toHaveLength(2);
  });

  it('sorts output by (a, b) regardless of input order', () => {
    const input = [pair({ a: 'c', b: 'a' }), pair({ a: 'a', b: 'c' }), pair({ a: 'b', b: 'a' })];
    const forward = mergePairs(input, 'counters').pairs.map((p) => `${p.a}>${p.b}`);
    const backward = mergePairs([...input].reverse(), 'counters').pairs.map((p) => `${p.a}>${p.b}`);
    expect(forward).toEqual(['a>c', 'b>a', 'c>a']);
    expect(backward).toEqual(forward);
  });
});

describe('mergeTraits', () => {
  it('drops duplicates with a warning and warns about add + remove of one tag', () => {
    const { traits, warnings } = mergeTraits([
      { slug: 'nova', tag: 'poke', why: 'one', op: 'add', source: 'traits.yaml' },
      { slug: 'nova', tag: 'poke', why: 'two', op: 'add', source: 'heroes/nova.yaml' },
      { slug: 'nova', tag: 'poke', why: 'three', op: 'remove', source: 'heroes/nova.yaml' },
      { slug: 'abathur', tag: 'global', why: 'four', op: 'add', source: 'heroes/abathur.yaml' },
    ]);
    expect(Object.keys(traits)).toEqual(['abathur', 'nova']);
    expect(traits.nova?.map((t) => `${t.op}:${t.why}`)).toEqual(['add:one', 'remove:three']);
    expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('already set in traits.yaml'), expect.stringContaining('both added and removed')]);
  });
});

describe('loadCurated', () => {
  it('reads global and per-hero files, merging pairs that appear in two hero files', () => {
    const bundle = loadCurated(makeRoot());
    expect(bundle.files).toEqual(['heroes/abathur.yaml', 'heroes/chogall.yaml', 'heroes/illidan.yaml', 'heroes/malthael.yaml', 'heroes/nova.yaml', 'heroes/zeratul.yaml']);
    const zeratulAbathur = bundle.counters.find((p) => p.a === 'zeratul' && p.b === 'abathur');
    expect(zeratulAbathur).toMatchObject({
      confidence: 'high',
      weight: 0.6,
      evidence: ['Permanent Cloak', 'Cleave', 'Singularity Spike'],
      sources: ['heroes/abathur.yaml', 'heroes/zeratul.yaml'],
    });
    expect(zeratulAbathur?.why).toHaveLength(2);
    const zeratulNova = bundle.counters.find((p) => p.a === 'zeratul' && p.b === 'nova');
    expect(zeratulNova).toMatchObject({ weight: 0.3, confidence: 'low', conditions: ['Nova was hit in the last 3 seconds', 'Zeratul has Vorpal Blade ready'], reviewedFor: '2.56' });
    expect(bundle.synergies).toEqual([expect.objectContaining({ a: 'abathur', b: 'illidan', conditions: ['Illidan dives first.'] })]);
    expect(bundle.traits.nova?.map((t) => `${t.op}:${t.tag}:${t.source}`)).toEqual(['add:immobile:heroes/nova.yaml', 'remove:poke:heroes/nova.yaml']);
    expect(bundle.rules.counters.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.maps.maps)).toContain('cursed-hollow');
    expect(bundle.aliases.chogall).toContain("cho'gall");
    expect(bundle.warnings).toEqual([expect.stringMatching(/^curated\/hots\/heroes\/nova\.yaml: contradiction: nova counters zeratul/)]);
  });

  it('is deterministic', () => {
    const root = makeRoot();
    expect(JSON.stringify(loadCurated(root))).toBe(JSON.stringify(loadCurated(root)));
  });

  const cases: [string, string, string, RegExp][] = [
    ['unknown hero slug', 'unknown-slug.yaml', 'valla.yaml', /heroes\/valla\.yaml: pair valla\/notahero: unknown hero slug "notahero"/],
    ['unknown tag', 'unknown-tag.yaml', 'valla.yaml', /heroes\/valla\.yaml: traits\.0\.tag: /],
    ['pair without the file hero', 'wrong-hero.yaml', 'valla.yaml', /heroes\/valla\.yaml: counters\.0: pair zeratul\/abathur does not involve this file's hero "valla"/],
    ['synergy order', 'wrong-hero.yaml', 'valla.yaml', /heroes\/valla\.yaml: synergies\.0: synergies are stored with a < b/],
    ['missing evidence', 'no-evidence.yaml', 'valla.yaml', /heroes\/valla\.yaml: counters\.0\.evidence: name at least one ability or talent/],
    ['YAML syntax', 'syntax.yaml', 'valla.yaml', /heroes\/valla\.yaml: YAML syntax error/],
    ['file named after another hero', 'unknown-tag.yaml', 'jaina.yaml', /heroes\/jaina\.yaml: (?:traits\.0\.tag|hero is "valla")/],
  ];
  for (const [what, invalid, name, message] of cases) {
    it(`throws with the file path on ${what}`, () => {
      const root = makeRoot({ [name]: { invalid } });
      expect(() => loadCurated(root)).toThrow(CuratedError);
      expect(() => loadCurated(root)).toThrow(message);
    });
  }

  it('reports a hero/file-name mismatch on an otherwise valid file', () => {
    const root = makeRoot({ 'aba.yaml': { text: fs.readFileSync(path.join(SAMPLES, 'heroes', 'abathur.yaml'), 'utf8') } });
    const { bundle, errors } = readCurated(root);
    expect(bundle).toBeNull();
    expect(errors).toEqual([{ file: 'heroes/aba.yaml', message: 'hero is "abathur" but the file is named aba.yaml; name the file abathur.yaml' }]);
  });

  it('collects every error instead of stopping at the first', () => {
    const root = makeRoot({ 'valla.yaml': { invalid: 'wrong-hero.yaml' }, 'jaina.yaml': { text: 'hero: jaina\nreviewedFor: "2.57"\ntraits:\n  - tag: nope\n    why: "a long enough reason"\n' } });
    const { errors } = readCurated(root);
    expect(errors.map((e) => e.file)).toEqual(['heroes/jaina.yaml', 'heroes/valla.yaml', 'heroes/valla.yaml']);
  });

  it('checks slugs against an explicit roster when one is given', () => {
    const root = makeRoot();
    expect(() => loadCurated(root, { knownSlugs: ['abathur', 'zeratul', 'nova', 'chogall', 'illidan', 'malthael'] })).not.toThrow();
    expect(() => loadCurated(root, { knownSlugs: ['abathur', 'zeratul', 'nova', 'chogall'] })).toThrow(/unknown hero slug "illidan"/);
  });

  it('fails clearly when the curated directory is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whetstone-empty-'));
    temps.push(root);
    expect(() => loadCurated(root)).toThrow(/curated\/hots\/rules\.yaml: cannot read file/);
  });
});

describe('the repository curated files', () => {
  it('load without errors', () => {
    const { bundle, errors } = readCurated(ROOT);
    expect(errors.map((e) => `${e.file}: ${e.message}`)).toEqual([]);
    expect(bundle?.files.length).toBeGreaterThan(0);
    expect(bundle?.rules.counters.length).toBeGreaterThanOrEqual(20);
    expect(bundle?.rules.counters.length).toBeLessThanOrEqual(30);
    expect((bundle?.rules.counters.length ?? 0) + (bundle?.rules.synergies.length ?? 0)).toBeLessThanOrEqual(35);
  });

  it('keep every map-fit rule pointing at a map tag some map has', () => {
    const bundle = loadCurated(ROOT);
    const used = new Set(Object.values(bundle.maps.maps).flatMap((m) => m.tags));
    for (const rule of bundle.maps.fit) expect(rule.map.some((t) => used.has(t)), rule.id).toBe(true);
  });

  it('keep the documented rule ids', () => {
    const bundle = loadCurated(ROOT);
    const ids = new Set([...bundle.rules.counters, ...bundle.rules.synergies].map((r) => r.id));
    for (const id of [
      'blind-vs-auto-attackers',
      'block-vs-auto-attackers',
      'anti-heal-vs-sustain',
      'percent-damage-vs-frontline',
      'reveal-vs-stealth',
      'interrupt-vs-channel',
      'lockdown-vs-divers',
      'cleanse-vs-heavy-cc',
      'spell-armor-vs-burst-mages',
      'dive-vs-immobile',
      'area-damage-vs-summons',
      'untouchable-vs-burst',
      'armor-shred-vs-armor',
      'global-vs-split-push',
      'cc-sets-up-burst',
      'grouping-feeds-area-damage',
      'healer-backs-dive-bruiser',
      'save-backs-diver',
      'global-pairs-with-split-push',
      'peel-protects-immobile-carry',
      'cleanse-frees-carry',
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });
});

describe('checkCuratedAgainstHeroes', () => {
  it('accepts evidence names regardless of case, apostrophe style and punctuation', () => {
    expect(nameKey('Dragon’s Breath')).toBe(nameKey("dragon's breath"));
    expect(nameKey('No Mercy!')).toBe(nameKey('No Mercy'));
    expect(nameKey('The Bigger They Are...')).toBe(nameKey('The Bigger They Are'));
  });

  it('flags heroes missing from the data and evidence neither kit has; members count for the composite', () => {
    const bundle = loadCurated(makeRoot());
    const issues = checkCuratedAgainstHeroes(bundle, fixtureHeroInputs());
    const messages = issues.map((i) => i.message);
    // illidan has no fixture kit; every other sample pair names real abilities.
    expect(messages).toEqual(['synergies abathur/illidan: illidan not in the current hero data', 'traits: "illidan" is not a hero in the current data']);
  });

  it('reports evidence that is not in either kit', () => {
    const root = makeRoot({
      'valla.yaml': {
        text: 'hero: valla\nreviewedFor: "2.57"\ncounters:\n  - a: valla\n    b: abathur\n    why: "A long enough sample reason."\n    evidence: ["Hatred", "Made Up Talent"]\n    confidence: low\n',
      },
    });
    const issues = checkCuratedAgainstHeroes(loadCurated(root), fixtureHeroInputs());
    expect(issues).toContainEqual({ file: 'heroes/valla.yaml', message: 'counters valla/abathur: evidence not found in either kit: Made Up Talent' });
  });
});

describe('validateCurated (CLI core)', () => {
  it('summarises a valid tree and returns errors for an invalid one', () => {
    const ok = validateCurated(makeRoot(), null);
    expect(ok.errors).toEqual([]);
    expect(ok.summary).toMatch(/^6 hero files, \d+ heroes with traits, 4 counter pairs, 1 synergy pairs/);
    const bad = validateCurated(makeRoot({ 'valla.yaml': { invalid: 'unknown-tag.yaml' } }), null);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.summary).toBe('curated files could not be loaded');
  });

  it('adds roster and evidence checks when heroes are given', () => {
    const res = validateCurated(makeRoot(), fixtureHeroInputs());
    expect(res.errors.map((e) => e.message)).toEqual([expect.stringContaining('unknown hero slug "illidan"')]);
  });
});

describe('compareMajor', () => {
  it('compares numerically', () => {
    expect(compareMajor('2.10', '2.9')).toBeGreaterThan(0);
    expect(compareMajor('2.57', '2.57')).toBe(0);
    expect(compareMajor('2.56', '2.57')).toBeLessThan(0);
  });
});
