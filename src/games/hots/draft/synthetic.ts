/**
 * Seeded synthetic draft shards for regression tests of the scorer (test helper; no Node APIs).
 *
 * The committed fixture cast has one Healer and 13 heroes, too few to show how the scorer behaves
 * late in a full-roster draft. This builds a shard with a live-like role mix and theory edges
 * drawn from the live 2.57 score distribution (counters ≈ 60 % of directed pairs, synergies
 * ≈ 60 % of pairs, scores 55–94), optionally tilted so every Healer has extra-strong synergies:
 * the case where unnormalised sums used to stack a second Healer onto finished teams.
 */
import type { DraftShard, HeroRole } from '../schema.ts';
import { SHARD_SCHEMA } from './data.ts';

export interface SyntheticOptions {
  seed?: number;
  /** Heroes per role (default: a live-like mix of 40). */
  roles?: Partial<Record<HeroRole, number>>;
  /** Score points added to every synergy edge that involves a Healer (default 0). */
  healerSynergyBonus?: number;
  /** Chance that a directed counter edge / an undirected synergy edge exists (default 0.6 each). */
  density?: number;
}

const DEFAULT_ROLES: Readonly<Record<HeroRole, number>> = {
  Tank: 6,
  Bruiser: 7,
  Healer: 7,
  Support: 4,
  'Ranged Assassin': 11,
  'Melee Assassin': 5,
};

/** Score buckets of live theory edges (lower bound, weight), 2.57. */
const SCORE_BUCKETS: readonly (readonly [number, number])[] = [
  [55, 33],
  [60, 22],
  [65, 22],
  [70, 10],
  [75, 7],
  [80, 3],
  [85, 2],
  [90, 1],
];

function lcg(seed: number): () => number {
  let s = (Math.abs(Math.floor(seed)) % 2147483647) + 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return s / 2147483647;
  };
}

/** A shard with `roles` heroes (names "Tank 1", …), two maps and theory edges, decodable by decodeShard. */
export function syntheticShard(opts: SyntheticOptions = {}): DraftShard {
  const rnd = lcg(opts.seed ?? 1);
  const density = opts.density ?? 0.6;
  const mix = { ...DEFAULT_ROLES, ...opts.roles };
  const heroes: { id: string; slug: string; name: string; role: HeroRole; tags: string[] }[] = [];
  let supports = 0;
  for (const [role, count] of Object.entries(mix) as [HeroRole, number][]) {
    for (let i = 1; i <= count; i++) {
      // The first two Supports carry the curated substitute slugs, the rest do not stand in.
      const slug = role === 'Support' && supports < 2 ? ['zarya', 'medivh'][supports++]! : `${role.toLowerCase().replace(/ /g, '')}${i}`;
      const tags = ['aoe'];
      if (rnd() < 0.55) tags.push('waveclear');
      if (rnd() < 0.7) tags.push('stun');
      heroes.push({ id: `S${heroes.length.toString().padStart(3, '0')}`, slug, name: `${role} ${i}`, role, tags: tags.sort() });
    }
  }
  const score = (bonus = 0): number => {
    const total = SCORE_BUCKETS.reduce((s, [, w]) => s + w, 0);
    let x = rnd() * total;
    for (const [lo, w] of SCORE_BUCKETS) {
      if (x < w) return Math.min(99, lo + Math.floor(rnd() * 5) + bonus);
      x -= w;
    }
    return 55 + bonus;
  };
  const reasons = ['{a} has a mechanical edge over {b} in this synthetic data.', '{a} and {b} combine well in this synthetic data.', '{a} suits {m} in this synthetic data.'];
  const counters = { a: [] as number[], b: [] as number[], score: [] as number[], r: [] as number[][] };
  const synergies = { a: [] as number[], b: [] as number[], score: [] as number[], r: [] as number[][] };
  const H = heroes.length;
  for (let a = 0; a < H; a++) {
    for (let b = 0; b < H; b++) {
      if (a === b) continue;
      if (rnd() < density) {
        counters.a.push(a);
        counters.b.push(b);
        counters.score.push(score());
        counters.r.push([0]);
      }
      if (b > a && rnd() < density) {
        const healer = heroes[a]!.role === 'Healer' || heroes[b]!.role === 'Healer';
        synergies.a.push(a);
        synergies.b.push(b);
        synergies.score.push(score(healer ? (opts.healerSynergyBonus ?? 0) : 0));
        synergies.r.push([1]);
      }
    }
  }
  const mapFit = { hero: [] as number[], map: [] as number[], score: [] as number[], r: [] as number[][] };
  for (let h = 0; h < H; h++) {
    for (let m = 0; m < 2; m++) {
      if (rnd() < 0.3) {
        mapFit.hero.push(h);
        mapFit.map.push(m);
        mapFit.score.push(score());
        mapFit.r.push([2]);
      }
    }
  }
  return {
    schema: SHARD_SCHEMA,
    build: '2.57.0.1',
    major: '2.57',
    rulesVersion: 'synthetic',
    heroes: {
      id: heroes.map((h) => h.id),
      slug: heroes.map((h) => h.slug),
      name: heroes.map((h) => h.name),
      role: heroes.map((h) => h.role),
      roleAlt: heroes.map(() => null),
      type: heroes.map((h) => (h.role === 'Ranged Assassin' || h.role === 'Healer' || h.role === 'Support' ? 'Ranged' : 'Melee')),
      portrait: heroes.map((h) => `img/heroes/${h.slug}.webp`),
      slots: heroes.map(() => 1 as const),
      members: heroes.map(() => null),
      isNew: heroes.map(() => false),
      tags: heroes.map((h) => h.tags) as DraftShard['heroes']['tags'],
    },
    maps: { id: ['map-one', 'map-two'], name: ['Map One', 'Map Two'], kind: ['standard', 'standard'], ranked: [true, true] },
    reasons,
    theory: { counters, synergies, mapFit },
  };
}
