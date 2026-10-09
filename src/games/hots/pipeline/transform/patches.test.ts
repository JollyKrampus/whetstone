import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixtureRelease, rawText, testCurated } from '../test-helpers.ts';
import { buildHeroes } from './heroes.ts';
import { buildHeroIndex, buildMapIndex, changeDirection, dateFromTitle, hotfixDate, kindFromTitle, parseArticle, verdictOf, type ParsedPatch } from './patches.ts';

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
    expect(verdictOf([{ section: 'Base', text: 'x', dir: 'buff' }, { section: 'Base', text: 'y', dir: 'nerf' }])).toBe('mixed');
    expect(verdictOf([{ section: 'Base', text: 'x' }])).toBe('change');
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

  it('keeps short hero change lines with section, target, level and direction', () => {
    const x = recs[0]?.heroes.HXAL?.changes ?? [];
    expect(x).toEqual(
      expect.arrayContaining([
        { section: 'Abilities', target: 'Void Volley', text: 'Base damage per missile reduced from 90 to 72.', dir: 'nerf' },
        { section: 'Level 1', target: 'Anchored Core', level: '1', text: 'Radius bonus reduced from 50% to 25%.', dir: 'nerf' },
      ]),
    );
    expect(recs[0]?.heroes.HXAL?.verdict).toBe('mixed');
  });

  it('puts hero-less hotfix lines in general', () => {
    expect(recs[1]?.general.length).toBeGreaterThan(0);
    expect(Object.keys(recs[1]?.heroes ?? {})).toEqual([]);
  });

  it('records general, map and balance lines of the main notes, and the new hero', () => {
    const main = recs[2] as ParsedPatch;
    expect(main.general).toContain('Added the ability to ping your Healing Fountain cooldown.');
    expect(main.maps?.['garden-of-terror']?.[0]).toMatch(/Shambler/);
    expect(main.newHeroes).toEqual(['HXAL']);
    expect(main.heroes.HXAL).toEqual({ verdict: 'new', changes: [{ section: 'New Hero', text: "Xal'atath joins the Nexus as a Ranged Assassin.", dir: 'change' }] });
    expect(main.heroes.Alex?.changes).toEqual(expect.arrayContaining([{ section: 'Base', text: 'Health increased from 1698 to 1780.', dir: 'buff' }]));
    expect(main.heroes.Abat?.changes.find((c) => c.target === 'Survival Instincts')).toMatchObject({ section: 'Level 16', level: '16' });
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
    expect(recs2[0]?.general).toEqual(['Haunted Mines has been added to Ranked.']);
  });

  it('is deterministic', () => {
    expect(parseLive()).toEqual(recs);
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
