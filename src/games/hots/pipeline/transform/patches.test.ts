import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixtureRelease, rawText, testCurated } from '../test-helpers.ts';
import { buildHeroes } from './heroes.ts';
import { buildHeroIndex, buildMapIndex, changeDirection, dateFromTitle, hotfixDate, kindFromTitle, migrateLegacyPatches, parseArticle, verdictOf, type ParsedPatch } from './patches.ts';
import { PatchesFileSchema } from '../../schema.ts';
import { longestSharedRun, VERBATIM_LIMIT } from './summary.ts';

const heroes = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes;
const heroIndex = buildHeroIndex(heroes);
const heroInfo = new Map(heroes.map((h) => [h.id, { name: h.name, role: h.role }]));
const mapIndex = buildMapIndex([{ id: 'garden-of-terror', name: 'Garden of Terror' }, { id: 'volskaya-foundry', name: 'Volskaya Foundry' }], {});
const URL = 'https://news.blizzard.com/en-us/article/24303007/heroes-of-the-storm-live-patch-notes-september-28-2026';

function parseLive(unmatched?: Set<string>): ParsedPatch[] {
  return parseArticle(
    rawText('blizzard-news/article-24303007.txt'),
    { url: URL, title: 'Heroes of the Storm Live Patch Notes - September 28, 2026', published: '2026-09-28T19:35:00Z' },
    { heroes: heroIndex, maps: mapIndex, heroInfo, ...(unmatched ? { unmatched } : {}) },
  );
}

describe('title helpers', () => {
  it('classifies article kinds from titles', () => {
    expect(kindFromTitle('Heroes of the Storm Live Patch Notes - September 28, 2026')).toBe('patch');
    expect(kindFromTitle('Heroes of the Storm PTR Patch Notes - September 14, 2026')).toBe('ptr');
    expect(kindFromTitle('Heroes of the Storm Balance Patch Notes — December 12, 2025')).toBe('balance');
    expect(kindFromTitle('Xal’atath has joined Heroes of the Storm!')).toBeNull();
  });

  it('reads dates from titles and hotfix headings', () => {
    expect(dateFromTitle('Live Patch Notes - September 8, 2026')).toBe('2026-09-08');
    expect(dateFromTitle('Balance Patch Notes — December 12, 2025')).toBe('2025-12-12');
    expect(hotfixDate('Hotfix - 10/5/2026')).toBe('2026-10-05');
    expect(hotfixDate('Hotfix – 9/29/2026')).toBe('2026-09-29');
  });
});

describe('changeDirection', () => {
  it.each([
    ['Health increased from 1698 to 1780.', 'buff'],
    ['Cooldown increased from 60 to 75 seconds.', 'nerf'],
    ['Mana cost reduced from 50 to 40.', 'buff'],
    ['Base damage per missile reduced from 90 to 72.', 'nerf'],
    ['Shield reduced from 70% of healing to 50%.', 'nerf'],
    ['Mythic Reward requirement reduced from 40 extra hits without dying to 30.', 'buff'],
    ['Damage bonus increased to 100%, up from 70%.', 'buff'],
    ['Now prevented and interrupted by Immobilize.', 'change'],
    ['REWORK: Now summons a Void Portal.', 'rework'],
  ] as const)('%s → %s', (text, dir) => {
    expect(changeDirection(text)).toBe(dir);
  });

  it('verdicts summarise a hero block', () => {
    expect(verdictOf([{ section: 'Base', kind: 'changed', text: 'x', dir: 'buff' }, { section: 'Base', kind: 'changed', text: 'y', dir: 'nerf' }])).toBe('mixed');
    expect(verdictOf([{ section: 'Base', kind: 'changed', text: 'x' }])).toBe('change');
  });
});

describe('parseArticle on the recorded 2026-09-28 live notes', () => {
  const unmatched = new Set<string>();
  const recs = parseLive(unmatched);

  it('splits the article into its hotfix sections and the main record', () => {
    expect(recs.map((r) => [r.kind, r.date])).toEqual([
      ['hotfix', '2026-10-05'],
      ['hotfix', '2026-09-29'],
      ['patch', '2026-09-28'],
    ]);
    expect(new Set(recs.map((r) => r.contentHash)).size).toBe(3);
  });

  it('summarises hero changes as structured facts with section, target, level and direction', () => {
    const x = recs[0]?.heroes.HXAL?.changes ?? [];
    expect(x).toEqual(
      expect.arrayContaining([
        { section: 'Abilities', target: 'Void Volley', kind: 'numeric', stat: 'Base damage per missile', old: 90, new: 72, dir: 'nerf', text: 'Base damage per missile 90 → 72' },
        { section: 'Level 1', target: 'Anchored Core', level: '1', kind: 'numeric', stat: 'Radius bonus', old: 50, new: 25, unit: '%', dir: 'nerf', text: 'Radius bonus 50% → 25%' },
        { section: 'Level 7', target: 'Silence of the Lamb', level: '7', kind: 'numeric', stat: 'Silence duration', old: 1, new: 1.5, unit: 's', dir: 'buff', text: 'Silence duration 1 s → 1.5 s' },
        { section: 'Abilities', target: 'Void Eruption', kind: 'numeric', stat: 'Uncharged damage', by: -20, unit: '%', dir: 'nerf', text: 'Uncharged damage −20%' },
        // A line without numbers keeps only its kind and a template, never its wording.
        { section: 'Level 20', target: 'Rift Invasion', level: '20', kind: 'changed', dir: 'change', text: "Effect changed (see Blizzard's notes)" },
      ]),
    );
    expect(recs[0]?.heroes.HXAL?.verdict).toBe('mixed');
  });

  it('keeps hero-less hotfix lines as general category counts', () => {
    expect(recs[1]?.general).toEqual(['Bug fixes: 3 changes', 'Interface and audio: 1 change']);
    expect(Object.keys(recs[1]?.heroes ?? {})).toEqual([]);
  });

  it('records general, map and balance lines of the main notes, and the new hero', () => {
    const main = recs[2] as ParsedPatch;
    expect(main.notes).toBe('summary');
    expect(main.general).toEqual(['Interface and audio: 2 changes']);
    expect(main.maps?.['garden-of-terror']).toEqual(["1 change (see Blizzard's notes)"]);
    expect(main.newHeroes).toEqual(['HXAL']);
    expect(main.heroes.HXAL).toEqual({ verdict: 'new', changes: [{ section: 'New Hero', kind: 'added', text: "Xal'atath joins the Nexus as a Ranged Assassin.", dir: 'change' }] });
    expect(main.heroes.Alex?.changes).toEqual(expect.arrayContaining([{ section: 'Base', kind: 'numeric', stat: 'Health', old: 1698, new: 1780, dir: 'buff', text: 'Health 1698 → 1780' }]));
    expect(main.heroes.Abat?.changes.find((c) => c.target === 'Survival Instincts')).toMatchObject({ section: 'Level 16', level: '16', kind: 'changed' });
  });

  it('skips bug fixes and never attributes an unknown hero block to the previous hero', () => {
    const main = recs[2] as ParsedPatch;
    expect(JSON.stringify(main)).not.toMatch(/Unrivaled Strength|Fixed an issue/);
    expect(unmatched).toEqual(new Set(['Garrosh']));
  });

  it('leaves shop announcements out of the general lines', () => {
    const recs2 = parseArticle(
      '<section class="blog"><a name="General"></a><h2>General</h2><ul><li>New Skin: Ruby Lucio</li><li>Haunted Mines has been added to Ranked.</li></ul></section>',
      { url: URL, title: 'Heroes of the Storm Live Patch Notes - July 20, 2026', published: '2026-07-20T17:00:00Z' },
      { heroes: heroIndex, maps: mapIndex, heroInfo },
    );
    expect(recs2[0]?.general).toEqual(['Modes and matchmaking: 1 change']);
  });

  it('is deterministic', () => {
    expect(parseLive()).toEqual(recs);
  });
});

/** Every string a record stores except its citation (title and URL of the article). */
function storedTexts(p: ParsedPatch): string[] {
  return [
    ...p.general,
    ...Object.values(p.maps ?? {}).flat(),
    ...Object.values(p.heroes).flatMap((h) => h.changes.flatMap((c) => [c.section, c.target ?? '', c.stat ?? '', c.text])),
  ].filter(Boolean);
}

describe('no Blizzard sentences are stored', () => {
  const articles = [
    ['blizzard-news/article-24303007.txt', 'Heroes of the Storm Live Patch Notes - September 28, 2026'],
    ['blizzard-news/article-24306095.txt', 'Heroes of the Storm PTR Patch Notes - September 14, 2026'],
  ] as const;

  it.each(articles)('%s: no stored text repeats 8 consecutive words of the article', (file, title) => {
    const html = rawText(file);
    // The article as a reader sees it: tags dropped, entities decoded, whitespace collapsed.
    const source = html.replace(/<[^>]*>/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const copied: string[] = [];
    const parsed = parseArticle(html, { url: URL, title, published: '2026-09-28T19:35:00Z' }, { heroes: heroIndex, maps: mapIndex, heroInfo, onCopied: (t) => copied.push(t) });
    const texts = parsed.flatMap(storedTexts);
    expect(texts.length).toBeGreaterThan(10);
    const worst = Math.max(...texts.map((t) => longestSharedRun(t, source)));
    expect(worst).toBeLessThan(VERBATIM_LIMIT);
    expect(copied).toEqual([]);
  });

  it('never uses a sentence-long list label as a change target', () => {
    const label = 'Abathur can now plant a very long sentence of nine words';
    const html = `<section class="blog"><a name="Balance"></a><h2>Balance Update</h2><h4>Abathur</h4><ul><li><strong>${label}</strong><ul><li>Damage increased from 10 to 12.</li></ul></li></ul></section>`;
    const [rec] = parseArticle(html, { url: URL, title: 'Live Patch Notes - October 1, 2026', published: '2026-10-01T00:00:00Z' }, { heroes: heroIndex, maps: mapIndex, heroInfo });
    expect(rec?.heroes.Abat?.changes).toEqual([{ section: 'Changes', kind: 'numeric', stat: 'Damage', old: 10, new: 12, dir: 'buff', text: 'Damage 10 → 12' }]);
  });

  it('replaces any stored text that repeats the article anyway (last guard)', () => {
    // Our own new-hero line happens to match the article word for word here.
    const html = `<section class="blog"><h2>New Hero: Xal'atath</h2><p>Xal'atath joins the Nexus as a Ranged Assassin today.</p></section>`;
    const copied: string[] = [];
    const [rec] = parseArticle(html, { url: URL, title: 'Live Patch Notes - October 1, 2026', published: '2026-10-01T00:00:00Z' }, { heroes: heroIndex, maps: mapIndex, heroInfo, onCopied: (t) => copied.push(t) });
    expect(copied).toEqual(["Xal'atath joins the Nexus as a Ranged Assassin."]);
    expect(rec?.heroes.HXAL?.changes).toEqual([{ section: 'New Hero', kind: 'added', dir: 'change', text: "New effect (see Blizzard's notes)" }]);
  });
});

describe('migrateLegacyPatches', () => {
  const legacy = [
    {
      id: '2026-09-28-patch',
      version: '2.57',
      date: '2026-09-28',
      title: 'Live',
      url: URL,
      kind: 'patch',
      contentHash: '0123456789abcdef',
      general: ['Updated Homescreen and Startup Music.', 'Haunted Mines has been added to Ranked.'],
      maps: { 'garden-of-terror': ['Shambler Health and damage now begin 25% below their previous values.'] },
      heroes: {
        Abat: { verdict: 'nerf', changes: [{ section: 'Level 13', target: 'Bombard Strain', level: '13', text: 'Health decay reduction lowered from 50% to 40% (game data: reduction 50% → 40%).', dir: 'nerf' }] },
        HXAL: { verdict: 'new', changes: [{ section: 'New Hero', text: "Xal'atath joins the Nexus as a Ranged Assassin.", dir: 'change' }] },
        Mura: { verdict: 'buff', changes: [{ section: 'Game data', target: 'Storm Bolt', text: 'Cooldown 10 → 8.', dir: 'buff' }] },
        Gall: { verdict: 'change', changes: [{ section: 'Abilities', target: 'Runic Blast', text: 'Now prevented and interrupted by Immobilize.', dir: 'change' }] },
      },
    },
  ];

  it('re-summarises records written before the summaries, keeping numbers and our own lines', () => {
    const out = PatchesFileSchema.parse(migrateLegacyPatches(legacy));
    const p = out[0];
    expect(p?.notes).toBe('summary');
    expect(p?.general).toEqual(['Modes and matchmaking: 1 change', 'Interface and audio: 1 change']);
    expect(p?.maps).toEqual({ 'garden-of-terror': ["1 change (see Blizzard's notes)"] });
    expect(p?.heroes.Abat?.changes).toEqual([{ section: 'Level 13', target: 'Bombard Strain', level: '13', kind: 'numeric', stat: 'Health decay reduction', old: 50, new: 40, unit: '%', dir: 'nerf', text: 'Health decay reduction 50% → 40%' }]);
    expect(p?.heroes.HXAL).toEqual({ verdict: 'new', changes: [{ section: 'New Hero', kind: 'added', text: "Xal'atath joins the Nexus as a Ranged Assassin.", dir: 'change' }] });
    expect(p?.heroes.Mura?.changes).toEqual([{ section: 'Game data', target: 'Storm Bolt', kind: 'numeric', stat: 'Cooldown', old: 10, new: 8, dir: 'buff', text: 'Cooldown 10 → 8' }]);
    expect(p?.heroes.Gall?.changes).toEqual([{ section: 'Abilities', target: 'Runic Blast', kind: 'changed', dir: 'change', text: "Effect changed (see Blizzard's notes)" }]);
    expect(JSON.stringify(out)).not.toMatch(/Homescreen|Shambler|Immobilize|lowered from/);
    // New records pass through unchanged.
    expect(migrateLegacyPatches(out)).toEqual(out);
  });

  it('lets the schema read an old file without showing its sentences (site fallback)', () => {
    const p = PatchesFileSchema.parse(legacy)[0];
    expect(p?.general).toEqual(['General: 2 changes']);
    expect(p?.heroes.Gall?.changes[0]?.text).toBe("Effect changed (see Blizzard's notes)");
    expect(p?.heroes.HXAL?.changes[0]?.text).toBe("Xal'atath joins the Nexus as a Ranged Assassin.");
    expect(JSON.stringify(p)).not.toMatch(/Homescreen|Shambler|Immobilize|lowered from/);
  });
});

describe('buildHeroIndex', () => {
  it('maps names, slugs and aliases to member ids, and the composite to both members', () => {
    expect(heroIndex.get('xalatath')).toEqual(['HXAL']);
    expect(heroIndex.get('chogall')).toEqual(['CCho', 'Gall']);
    expect(heroIndex.get('cho')).toEqual(['CCho']);
    expect(heroIndex.get('abby')).toEqual(['Abat']);
  });
});
