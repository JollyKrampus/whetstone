import { describe, expect, it } from 'vitest';
import { MECHANIC_TAGS, MechanicSchema, type Mechanic } from '../schema.ts';
import { extractMechanics } from './extract.ts';
import { SNIPPET_MAX } from './text.ts';
import type { HeroInput } from './types.ts';
import { fixtureHero, fixtureHeroInputs } from './__fixtures__/kits.ts';

const tags = (m: Mechanic[]): string[] => m.map((x) => x.tag);
const of = (slug: string): Mechanic[] => extractMechanics(fixtureHero(slug));
const evidence = (m: Mechanic[], tag: string): string[] => m.find((x) => x.tag === tag)?.evidence.map((e) => `${e.kind === 'talent' ? 't:' : ''}${e.name}`) ?? [];

/**
 * Golden tags for real 2.57 kits (__fixtures__/kits.json). Reviewed against the kit text; a
 * change here must be checked by hand (docs/THEORY.md "Extractor precision").
 */
const GOLDEN: Record<string, string[]> = {
  abathur: ['stun', 'slow', 'shield', 'heal-ally', 'reveal', 'teleport', 'aoe', 'dot', 'summons', 'waveclear', 'siege'],
  alarak: ['slow', 'silence', 'displace', 'unstoppable', 'invulnerable', 'cleanse', 'heal-self', 'dash', 'teleport', 'aoe', 'channel'],
  ana: ['stun', 'slow', 'sleep', 'cleanse', 'heal-self', 'heal-ally', 'percent-hp-damage', 'anti-heal', 'aoe', 'dot'],
  anduin: ['stun', 'root', 'invulnerable', 'cleanse', 'shield', 'heal-self', 'heal-ally', 'aoe', 'dot'],
  azmodan: ['slow', 'heal-self', 'armor-shred', 'aoe', 'summons', 'global', 'waveclear', 'siege', 'channel'],
  cho: ['stun', 'root', 'slow', 'displace', 'pull', 'invulnerable', 'stasis', 'heal-self', 'dash', 'percent-hp-damage', 'anti-heal', 'aoe', 'dot', 'channel'],
  diablo: ['stun', 'slow', 'displace', 'unstoppable', 'heal-self', 'teleport', 'armor-shred', 'aoe', 'global'],
  gall: ['stun', 'slow', 'silence', 'teleport', 'percent-hp-damage', 'poke', 'aoe', 'dot', 'waveclear', 'channel'],
  genji: ['slow', 'invulnerable', 'spell-armor', 'block', 'shield', 'heal-self', 'stealth', 'dash', 'aoe'],
  johanna: ['stun', 'slow', 'blind', 'pull', 'unstoppable', 'physical-armor', 'shield', 'heal-self', 'heal-ally', 'dash', 'aoe', 'waveclear'],
  lucio: ['stun', 'slow', 'displace', 'unstoppable', 'cleanse', 'shield', 'heal-self', 'heal-ally', 'unkillable', 'anti-heal', 'aoe', 'waveclear'],
  malthael: ['slow', 'unstoppable', 'spell-armor', 'physical-armor', 'heal-self', 'reveal', 'teleport', 'percent-hp-damage', 'anti-heal'],
  nova: ['slow', 'stealth', 'armor-shred', 'burst', 'poke', 'aoe', 'summons'],
  stitches: ['stun', 'slow', 'pull', 'unstoppable', 'shield', 'heal-self', 'teleport', 'unkillable', 'percent-hp-damage', 'anti-heal', 'armor-shred', 'aoe', 'dot', 'waveclear'],
  tracer: ['slow', 'displace', 'cleanse', 'shield', 'heal-self', 'reveal', 'dash', 'unkillable', 'percent-hp-damage', 'armor-shred', 'burst', 'aoe'],
  valla: ['stun', 'slow', 'spell-armor', 'heal-self', 'dash', 'percent-hp-damage', 'sustained-dps', 'aoe', 'waveclear', 'aa-reliant'],
  varian: ['slow', 'silence', 'taunt', 'invulnerable', 'block', 'heal-self', 'dash', 'percent-hp-damage', 'anti-heal', 'armor-shred'],
  zeratul: ['slow', 'time-stop', 'spell-armor', 'shield', 'heal-self', 'stealth', 'reveal', 'teleport', 'burst', 'aoe', 'dot'],
};

describe('extractMechanics on real 2.57 kits (golden)', () => {
  for (const [slug, expected] of Object.entries(GOLDEN)) {
    it(slug, () => {
      expect(tags(of(slug))).toEqual(expected);
    });
  }

  it('covers at least ten heroes', () => {
    expect(Object.keys(GOLDEN).length).toBeGreaterThanOrEqual(10);
  });

  it('produces schema-valid mechanics with short snippets for every fixture hero', () => {
    for (const hero of fixtureHeroInputs()) {
      for (const m of extractMechanics(hero)) {
        expect(() => MechanicSchema.parse(m), `${hero.slug}/${m.tag}`).not.toThrow();
        expect(m.evidence.length).toBeGreaterThan(0);
        expect(m.evidence.length).toBeLessThanOrEqual(4);
        for (const e of m.evidence) {
          expect(e.kind === 'ability' || e.kind === 'talent').toBe(true);
          expect(e.snippet.length, `${hero.slug}/${m.tag}: ${e.snippet}`).toBeLessThanOrEqual(SNIPPET_MAX);
        }
      }
    }
  });

  it('orders tags by the vocabulary and evidence abilities first', () => {
    for (const hero of fixtureHeroInputs()) {
      const list = extractMechanics(hero);
      const order = list.map((m) => MECHANIC_TAGS.indexOf(m.tag as (typeof MECHANIC_TAGS)[number]));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      for (const m of list) {
        const kinds = m.evidence.map((e) => e.kind);
        expect(kinds).toEqual([...kinds].sort((a, b) => (a === b ? 0 : a === 'ability' ? -1 : 1)));
      }
    }
  });

  it('is deterministic', () => {
    for (const hero of fixtureHeroInputs()) expect(JSON.stringify(extractMechanics(hero))).toBe(JSON.stringify(extractMechanics(structuredClone(hero))));
  });

  it('returns nothing for a composite (its members carry the kits)', () => {
    expect(extractMechanics(fixtureHero('chogall'))).toEqual([]);
  });
});

describe('extractMechanics precision on real kits', () => {
  it('reads the effect on enemies even when the hero is named in the clause (Discord Strike silences)', () => {
    expect(evidence(of('alarak'), 'silence')).toEqual(['Discord Strike', 't:Dissonance']);
  });

  it('reads a push of enemies as displacement (Telekinesis)', () => {
    expect(evidence(of('alarak'), 'displace')).toEqual(['Telekinesis']);
  });

  it('does not count channels that make the hero Protected or Unstoppable', () => {
    expect(evidence(of('alarak'), 'channel')).toEqual(['Deadly Charge']);
    expect(tags(of('genji'))).not.toContain('channel');
    expect(tags(of('diablo'))).not.toContain('channel');
  });

  it('keeps channels that can be interrupted', () => {
    expect(evidence(of('azmodan'), 'channel')[0]).toBe('All Shall Burn');
    expect(evidence(of('gall'), 'channel')[0]).toBe('Twisting Nether');
  });

  it('separates healing reduction from healing (Biotic Grenade does both)', () => {
    const ana = of('ana');
    expect(evidence(ana, 'anti-heal')).toEqual(['Biotic Grenade']);
    expect(evidence(ana, 'heal-ally')).toContain('Biotic Grenade');
    expect(evidence(ana, 'heal-ally')[0]).toBe('Healing Dart');
  });

  it('treats an Unstoppable granted to an ally as a cleanse, not the hero being Unstoppable', () => {
    expect(evidence(of('anduin'), 'cleanse')).toEqual(['Leap of Faith']);
    expect(tags(of('anduin'))).not.toContain('unstoppable');
  });

  it('does not call an unlimited-range shot map-wide presence', () => {
    expect(tags(of('ana'))).not.toContain('global');
    expect(tags(of('nova'))).not.toContain('global');
    expect(evidence(of('diablo'), 'global')).toEqual(['Apocalypse']);
  });

  it('does not count conditional channel bonus damage as burst', () => {
    expect(tags(of('azmodan'))).not.toContain('burst');
  });

  it('keeps a skillshot that stops at the first enemy out of area damage', () => {
    expect(evidence(of('abathur'), 'aoe')).not.toContain('Stab');
  });

  it('reads Basic Attack block from Basic Attack wording only', () => {
    expect(evidence(of('genji'), 'block')).toEqual(['t:Cyber Shield']);
    expect(evidence(of('varian'), 'block')[0]).toBe('Parry');
  });

  it('marks talent-only tags with talent evidence only', () => {
    expect(evidence(of('nova'), 'armor-shred')).toEqual(['t:Crippling Shot']);
    expect(evidence(of('stitches'), 'anti-heal')).toEqual(['t:Master Hooker']);
  });

  it('skips Heroic abilities repeated as level 10 talents', () => {
    for (const m of of('anduin')) expect(m.evidence.filter((e) => e.name === 'Holy Word: Salvation').every((e) => e.kind === 'ability')).toBe(true);
  });

  it('derives Basic Attack reliance strictly', () => {
    expect(tags(of('valla'))).toContain('aa-reliant');
    for (const slug of ['zeratul', 'genji', 'tracer', 'varian']) expect(tags(of(slug)), slug).not.toContain('aa-reliant');
  });
});

// ---- synthetic sentences ---------------------------------------------------------------

const ICON = 'img/icons/x.webp';
const NO_TALENTS: HeroInput['talents'] = { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] };

function synthetic(abilities: [string, string][], opts: { talents?: [string, string][]; name?: string; role?: HeroInput['role'] } = {}): HeroInput {
  return {
    id: 'Test',
    slug: 'testhero',
    name: opts.name ?? 'Testa',
    title: 'Test',
    role: opts.role ?? 'Ranged Assassin',
    type: 'Ranged',
    franchise: 'Classic',
    difficulty: 'Easy',
    ratings: { damage: 5, utility: 5, survivability: 5, complexity: 5 },
    aliases: [],
    portrait: ICON,
    abilities: abilities.map(([name, text], i) => ({ id: `t${i}`, name, hotkey: 'Q', kind: 'basic' as const, text, icon: ICON })),
    talents: { ...NO_TALENTS, '1': (opts.talents ?? []).map(([name, text], i) => ({ id: `tt${i}`, name, text, icon: ICON, sort: i + 1 })) },
    isNew: false,
  };
}
const synth = (text: string, more: Parameters<typeof synthetic>[1] = {}): string[] => tags(extractMechanics(synthetic([['Zap', text]], more)));

describe('extractMechanics on synthetic text', () => {
  it('ignores crowd control used as a condition', () => {
    expect(synth('Stunned enemies take 20% more damage from Zap.')).not.toContain('stun');
    expect(synth('Deal 50 damage to enemies who are Rooted or Slowed.')).not.toContain('root');
    expect(synth('While Stunned, Testa gains 30 Armor.')).not.toContain('stun');
  });

  it('ignores lists of effects and their removal by others', () => {
    expect(synth('Reduces the duration of Stuns, Roots, and Slows by 50%.')).toEqual([]);
    expect(synth('Testa cannot be Slowed.')).not.toContain('slow');
  });

  it('does not read "slower" or "slowly" as a slow', () => {
    expect(synth('Missiles travel 20% slower but deal 50 damage.')).not.toContain('slow');
  });

  it('reads healing reduction as anti-heal and not as a heal', () => {
    const t = synth('Enemy Heroes hit have their healing received reduced by 40% for 3 seconds.');
    expect(t).toContain('anti-heal');
    expect(t).not.toContain('heal-self');
    expect(t).not.toContain('heal-ally');
  });

  it('reads a heal of allies and of the hero separately', () => {
    expect(synth('Heal nearby allied Heroes for 120 Health.')).toContain('heal-ally');
    expect(synth('Testa heals for 80 Health.')).toContain('heal-self');
  });

  it('does not read breaking enemy Shields as gaining one', () => {
    expect(synth('Deals 200% bonus damage to Shields.')).not.toContain('shield');
    expect(synth('Gain a 200 point Shield for 3 seconds.')).toContain('shield');
  });

  it('does not read the hero being revealed as a reveal', () => {
    expect(synth('Testa is Revealed while channeling.')).not.toContain('reveal');
    expect(synth('Reveals enemies in the area for 4 seconds.')).toContain('reveal');
  });

  it('does not count a reference to another ability by name', () => {
    const hero = synthetic([
      ['Snow Blind', 'Throw snow, dealing 60 damage.'],
      ['Frost Lance', "Reduces Snow Blind's cooldown by 2 seconds."],
    ]);
    expect(tags(extractMechanics(hero))).not.toContain('blind');
  });

  it('skips Quest requirements but reads the reward', () => {
    const t = synth('Throw a dagger for 40 damage.', {
      talents: [['Hunter', 'Quest: Stun 20 enemy Heroes.\nReward: Zap now Roots enemies for 1 second.']],
    });
    expect(t).not.toContain('stun');
    expect(t).toContain('root');
  });

  it('marks a tag found only in a talent with talent evidence', () => {
    const m = extractMechanics(synthetic([['Zap', 'Deal 40 damage.']], { talents: [['Blinding Zap', 'Zap Blinds enemies for 2 seconds.']] }));
    expect(m.find((x) => x.tag === 'blind')?.evidence).toEqual([{ kind: 'talent', name: 'Blinding Zap', snippet: 'Zap Blinds enemies for 2 seconds.' }]);
  });

  it('cuts long evidence snippets to at most 120 characters around the match', () => {
    const long = `${'Charge up a long and winding explanation of many things that happen. '.repeat(2)}Then it Stuns enemies for 1 second and ${'keeps going with more words. '.repeat(3)}`;
    const m = extractMechanics(synthetic([['Zap', long]]));
    const snippet = m.find((x) => x.tag === 'stun')?.evidence[0]?.snippet ?? '';
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snippet).toContain('Stuns enemies');
  });
});
