import { describe, expect, it } from 'vitest';
import { HeroSchema, TALENT_TIERS } from '../../schema.ts';
import { FIXTURE_NOW, fixtureRelease, testCurated } from '../test-helpers.ts';
import { buildHeroes, dedupeAliases, flexRole, iconPath, portraitPath, tierOf, webpName, type HeroInput } from './heroes.ts';
import { readRelease } from './release.ts';

const built = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW });
const byId = new Map(built.heroes.map((h) => [h.id, h]));

describe('readRelease', () => {
  it('reads the build, heroes, maps and strings of a trimmed release', () => {
    const r = fixtureRelease('2.57.0.98348');
    expect(r.build).toBe('2.57.0.98348');
    expect(Object.keys(r.heroes).sort()).toEqual(['Abathur', 'Alexstrasza', 'Cho', 'Gall', 'Xalatath']);
    expect(Object.keys(r.maps)).toContain('Cursed Hollow');
    expect(Object.keys(r.localizedHeroNames).sort()).toEqual(['kokr', 'ruru']);
  });

  it('rejects an archive without herodata', () => {
    expect(() => readRelease({})).toThrow(/herodata/);
  });
});

describe('buildHeroes', () => {
  it('emits every hero plus the composite, sorted by slug, without issues', () => {
    expect(built.heroes.map((h) => h.slug)).toEqual(['abathur', 'alexstrasza', 'cho', 'chogall', 'gall', 'xalatath']);
    expect(built.issues).toEqual([]);
  });

  it('produces records that satisfy HeroSchema once mechanics are added', () => {
    for (const h of built.heroes) {
      const r = HeroSchema.safeParse({ ...h, mechanics: [] });
      expect(r.success, `${h.slug}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true);
    }
  });

  it('uses attributeIds, roles, franchise and ratings from heroes-data2', () => {
    const x = byId.get('HXAL') as HeroInput;
    expect(x).toMatchObject({ slug: 'xalatath', name: "Xal'atath", title: 'The Harbinger of the Void', role: 'Ranged Assassin', type: 'Ranged', franchise: 'Warcraft', difficulty: 'Medium', releaseDate: '2026-09-28', isNew: true, hdpId: 'Xalatath' });
    expect(byId.get('Abat')).toMatchObject({ role: 'Support', franchise: 'StarCraft', type: 'Melee', isNew: false });
  });

  it('renders ability text as plain text with hotkeys, cooldowns and costs', () => {
    const x = byId.get('HXAL') as HeroInput;
    const q = x.abilities.find((a) => a.hotkey === 'Q');
    expect(q).toMatchObject({ name: 'Shadow Mark', kind: 'basic', cooldown: 7, cost: '45 Mana' });
    expect(q?.text).toMatch(/\(\+4% per level\)/);
    expect(q?.text).not.toMatch(/[<>~]/);
    expect(x.abilities.map((a) => a.hotkey).slice(0, 3)).toEqual(['Q', 'W', 'E']);
    expect(x.abilities.some((a) => a.kind === 'trait' && a.hotkey === 'D')).toBe(true);
    expect(x.abilities.filter((a) => a.kind === 'heroic').every((a) => a.hotkey === 'R')).toBe(true);
  });

  it('includes secondary-unit abilities (Abathur Symbiote) without duplicates', () => {
    const a = byId.get('Abat') as HeroInput;
    const ids = a.abilities.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.abilities.some((x) => x.name === 'Symbiote')).toBe(true);
  });

  it('fills all seven talent tiers in sort order with icons', () => {
    const x = byId.get('HXAL') as HeroInput;
    for (const tier of TALENT_TIERS) {
      expect(x.talents[tier].length, `tier ${tier}`).toBeGreaterThan(0);
      expect(x.talents[tier].map((t) => t.sort)).toEqual(x.talents[tier].map((_, i) => i + 1));
      for (const t of x.talents[tier]) expect(t.icon).toMatch(/^img\/icons\/.+\.webp$/);
    }
  });

  it('links Cho and Gall to the composite chogall', () => {
    const c = byId.get('chogall') as HeroInput;
    expect(c.members).toEqual(['CCho', 'Gall']);
    expect(byId.get('CCho')?.memberOf).toBe('chogall');
    expect(byId.get('Gall')?.memberOf).toBe('chogall');
    expect(c.abilities).toEqual([]);
    expect(c.roleAlt).toBeDefined();
    expect(c.aliases).toContain("cho'gall");
  });

  it('merges curated, localized and searchText aliases', () => {
    const x = byId.get('HXAL') as HeroInput;
    expect(x.aliases).toEqual(expect.arrayContaining(['xal', "xal'atath", 'zalatath']));
    // Localized names from the kokr/ruru fixtures.
    expect(x.aliases.some((a) => /[가-힣]/.test(a))).toBe(true);
    expect(x.aliases.some((a) => /[а-я]/.test(a))).toBe(true);
    expect(x.aliases).not.toContain('xalatath');
  });

  it('lists every referenced image once with its heroes-images folder', () => {
    const outs = built.images.map((i) => i.out);
    expect(new Set(outs).size).toBe(outs.length);
    const x = byId.get('HXAL') as HeroInput;
    expect(outs).toContain(x.portrait);
    expect(outs).toContain(x.draftPortrait);
    expect(built.images.find((i) => i.out === x.portrait)?.folder).toBe('heroportraits');
    expect(built.images.find((i) => i.out === x.abilities[0]?.icon)?.folder).toBe('abilitytalents');
  });

  it('models base stats for the diff', () => {
    expect(built.models.Alex?.stats.Health).toBeGreaterThan(1000);
    expect(built.models.Alex?.stats['Basic Attack Damage']).toBeGreaterThan(0);
    expect(tierOf(built.models.HXAL as NonNullable<(typeof built.models)['HXAL']>, (byId.get('HXAL') as HeroInput).talents['20'][0]?.id ?? '')).toBe('20');
  });
});

describe('helpers', () => {
  it('maps file names to WebP paths', () => {
    expect(webpName('storm_ui_icon_X.PNG')).toBe('storm_ui_icon_x.webp');
    expect(iconPath('a/b/icon.png')).toBe('img/icons/icon.webp');
    expect(portraitPath('p.png')).toBe('img/heroes/p.webp');
  });

  it('gives Multiclass warriors (Varian) the other frontline role', () => {
    expect(flexRole('Bruiser', ['Warrior', 'Multiclass'])).toBe('Tank');
    expect(flexRole('Tank', ['Warrior', 'Multiclass'])).toBe('Bruiser');
    expect(flexRole('Healer', ['Support'])).toBeUndefined();
  });

  it('drops generated aliases two heroes share but keeps curated ones', () => {
    const base: Omit<HeroInput, 'id' | 'slug' | 'name' | 'aliases'> = {
      title: 't',
      role: 'Tank',
      type: 'Melee',
      franchise: 'Warcraft',
      difficulty: 'Easy',
      ratings: { damage: 1, utility: 1, survivability: 1, complexity: 1 },
      portrait: 'img/heroes/x.webp',
      abilities: [],
      talents: { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] },
      isNew: false,
    };
    const heroes: HeroInput[] = [
      { ...base, id: 'Xul0', slug: 'xul', name: 'Xul', aliases: ['zul', 'necro'] },
      { ...base, id: 'ZulJ', slug: 'zuljin', name: "Zul'jin", aliases: ['zul', 'xul'] },
    ];
    dedupeAliases(heroes, { heroes: { zuljin: ['zul'] }, maps: {} });
    expect(heroes[0]?.aliases).toEqual(['necro']);
    expect(heroes[1]?.aliases).toEqual(['zul']);
  });
});
