/**
 * Display vocabulary for the HotS pages: human labels for mechanics tags, map tags, patch change
 * directions, verdicts and patch kinds, plus small pure helpers to order and count them.
 * Browser-safe: type-only imports from schema.ts, so islands never pull zod into their bundle.
 *
 * The records are keyed by the schema's own unions, so adding a tag or a direction to schema.ts
 * fails `tsc` here until it has a label.
 */
import type { Tone } from '../../../components/types.ts';
import type { Ability, GameMap, HeroTag, MapTag, Patch } from '../schema.ts';

export type ChangeDir = NonNullable<Patch['heroes'][string]['changes'][number]['dir']>;
export type Verdict = NonNullable<Patch['heroes'][string]['verdict']>;
export type PatchKind = Patch['kind'];
export type MapKind = GameMap['kind'];

export type TagGroup = 'control' | 'defense' | 'damage' | 'trait';

export const TAG_GROUP_LABEL: Readonly<Record<TagGroup, string>> = {
  control: 'Crowd control',
  defense: 'Defense and mobility',
  damage: 'Damage and macro',
  trait: 'Play-style traits',
};

const TAGS: Readonly<Record<HeroTag, { label: string; group: TagGroup }>> = {
  stun: { label: 'Stun', group: 'control' },
  root: { label: 'Root', group: 'control' },
  slow: { label: 'Slow', group: 'control' },
  silence: { label: 'Silence', group: 'control' },
  blind: { label: 'Blind', group: 'control' },
  polymorph: { label: 'Polymorph', group: 'control' },
  sleep: { label: 'Sleep', group: 'control' },
  taunt: { label: 'Taunt', group: 'control' },
  fear: { label: 'Fear', group: 'control' },
  displace: { label: 'Displacement', group: 'control' },
  pull: { label: 'Pull', group: 'control' },
  'time-stop': { label: 'Time Stop', group: 'control' },
  unstoppable: { label: 'Unstoppable', group: 'defense' },
  invulnerable: { label: 'Invulnerable', group: 'defense' },
  stasis: { label: 'Stasis', group: 'defense' },
  untargetable: { label: 'Untargetable', group: 'defense' },
  cleanse: { label: 'Cleanse', group: 'defense' },
  'spell-armor': { label: 'Spell Armor', group: 'defense' },
  'physical-armor': { label: 'Physical Armor', group: 'defense' },
  block: { label: 'Block', group: 'defense' },
  shield: { label: 'Shields', group: 'defense' },
  'heal-self': { label: 'Self-healing', group: 'defense' },
  'heal-ally': { label: 'Ally healing', group: 'defense' },
  stealth: { label: 'Stealth', group: 'defense' },
  reveal: { label: 'Reveal', group: 'defense' },
  dash: { label: 'Dash', group: 'defense' },
  teleport: { label: 'Teleport', group: 'defense' },
  unkillable: { label: 'Unkillable', group: 'defense' },
  'percent-hp-damage': { label: '% Health damage', group: 'damage' },
  'anti-heal': { label: 'Anti-heal', group: 'damage' },
  'armor-shred': { label: 'Armor shred', group: 'damage' },
  burst: { label: 'Burst', group: 'damage' },
  'sustained-dps': { label: 'Sustained damage', group: 'damage' },
  poke: { label: 'Poke', group: 'damage' },
  aoe: { label: 'Area damage', group: 'damage' },
  dot: { label: 'Damage over time', group: 'damage' },
  summons: { label: 'Summons', group: 'damage' },
  global: { label: 'Global presence', group: 'damage' },
  waveclear: { label: 'Waveclear', group: 'damage' },
  siege: { label: 'Siege', group: 'damage' },
  channel: { label: 'Channeled abilities', group: 'damage' },
  'aa-reliant': { label: 'Basic-attack reliant', group: 'damage' },
  'mana-hungry': { label: 'Mana hungry', group: 'damage' },
  immobile: { label: 'Immobile', group: 'trait' },
  dive: { label: 'Dive', group: 'trait' },
  'split-push': { label: 'Split push', group: 'trait' },
  'vulnerable-body': { label: 'Vulnerable body', group: 'trait' },
  frontline: { label: 'Frontline', group: 'trait' },
  peel: { label: 'Peel', group: 'trait' },
  engage: { label: 'Engage', group: 'trait' },
  save: { label: 'Save', group: 'trait' },
};

const GROUP_ORDER: readonly TagGroup[] = ['control', 'defense', 'damage', 'trait'];

export function tagLabel(tag: HeroTag): string {
  return TAGS[tag].label;
}

export function tagGroup(tag: HeroTag): TagGroup {
  return TAGS[tag].group;
}

/** Tags grouped for display (crowd control, defense, damage, traits), alphabetical inside a group. */
export function groupTags<T extends { tag: HeroTag }>(items: readonly T[]): { group: TagGroup; label: string; items: T[] }[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: TAG_GROUP_LABEL[group],
    items: items.filter((i) => TAGS[i.tag].group === group).sort((a, b) => cmp(TAGS[a.tag].label, TAGS[b.tag].label)),
  })).filter((g) => g.items.length > 0);
}

const MAP_TAGS: Readonly<Record<MapTag, string>> = {
  large: 'Large map',
  small: 'Small map',
  'three-lane': 'Three lanes',
  'two-lane': 'Two lanes',
  'single-lane': 'Single lane',
  'channel-objective': 'Channel objective',
  'pve-objective': 'PvE objective',
  teamfight: 'Team fights',
  'structure-objective': 'Structure objective',
  'long-rotations': 'Long rotations',
  'escort-objective': 'Escort objective',
  'push-objective': 'Pushing objective',
};

export function mapTagLabel(tag: MapTag): string {
  return MAP_TAGS[tag];
}

export const MAP_KIND_LABEL: Readonly<Record<MapKind, string>> = {
  standard: 'Standard',
  aram: 'ARAM',
  brawl: 'Brawl',
};

export interface DirSpec {
  label: string;
  /** Glyph shown next to the label (decorative: the label always carries the meaning). */
  icon: string;
  tone: Tone;
}

export const DIR: Readonly<Record<ChangeDir, DirSpec>> = {
  buff: { label: 'Buff', icon: '▲', tone: 'positive' },
  nerf: { label: 'Nerf', icon: '▼', tone: 'negative' },
  change: { label: 'Change', icon: '◆', tone: 'neutral' },
  rework: { label: 'Rework', icon: '↻', tone: 'warning' },
};

export const VERDICT: Readonly<Record<Verdict, { label: string; tone: Tone }>> = {
  buff: { label: 'Buffed', tone: 'positive' },
  nerf: { label: 'Nerfed', tone: 'negative' },
  mixed: { label: 'Mixed', tone: 'neutral' },
  rework: { label: 'Reworked', tone: 'warning' },
  new: { label: 'New hero', tone: 'accent' },
  change: { label: 'Changed', tone: 'neutral' },
};

export const PATCH_KIND: Readonly<Record<PatchKind, { label: string; tone: Tone }>> = {
  patch: { label: 'Patch', tone: 'accent' },
  balance: { label: 'Balance update', tone: 'info' },
  hotfix: { label: 'Hotfix', tone: 'warning' },
  ptr: { label: 'PTR', tone: 'neutral' },
};

export type DirCounts = Record<ChangeDir, number>;

export function emptyCounts(): DirCounts {
  return { buff: 0, nerf: 0, change: 0, rework: 0 };
}

/** How many change lines point each way; lines without a direction count as plain changes. */
export function countDirs(changes: readonly { dir?: ChangeDir | undefined }[], into: DirCounts = emptyCounts()): DirCounts {
  for (const c of changes) into[c.dir ?? 'change'] += 1;
  return into;
}

/** "2 buffs, 1 nerf" (directions with zero lines are left out; empty string when none). */
export function describeCounts(counts: DirCounts): string {
  const words: Record<ChangeDir, [string, string]> = {
    buff: ['buff', 'buffs'],
    nerf: ['nerf', 'nerfs'],
    rework: ['rework', 'reworks'],
    change: ['other change', 'other changes'],
  };
  return (['buff', 'nerf', 'rework', 'change'] as const)
    .filter((d) => counts[d] > 0)
    .map((d) => `${counts[d]} ${words[d][counts[d] === 1 ? 0 : 1]}`)
    .join(', ');
}

/** Overall direction of a set of changes, for one-word summaries. */
export function netVerdict(counts: DirCounts): Verdict {
  if (counts.rework > 0) return 'rework';
  if (counts.buff > 0 && counts.nerf > 0) return 'mixed';
  if (counts.buff > 0) return 'buff';
  if (counts.nerf > 0) return 'nerf';
  return 'change';
}

const ABILITY_KIND_ORDER: Readonly<Record<Ability['kind'], number>> = { trait: 0, basic: 1, heroic: 2, active: 3, mount: 4 };
const HOTKEY_ORDER = 'DQWERZ123456789';

export const ABILITY_KIND_LABEL: Readonly<Record<Ability['kind'], string>> = {
  trait: 'Trait',
  basic: 'Ability',
  heroic: 'Heroic',
  active: 'Active',
  mount: 'Mount',
};

/** Trait first, then Q W E, heroics, actives and the mount; stable by hotkey then name. */
export function sortAbilities<T extends Pick<Ability, 'kind' | 'hotkey' | 'name'>>(abilities: readonly T[]): T[] {
  const key = (h: string) => (h === '' ? 99 : HOTKEY_ORDER.indexOf(h));
  return [...abilities].sort(
    (a, b) => ABILITY_KIND_ORDER[a.kind] - ABILITY_KIND_ORDER[b.kind] || key(a.hotkey) - key(b.hotkey) || cmp(a.name, b.name),
  );
}

/** Ratings in heroes-data2 run 0–10. */
export const RATING_MAX = 10;

export const RATING_LABEL = {
  damage: 'Damage',
  utility: 'Utility',
  survivability: 'Survivability',
  complexity: 'Complexity',
} as const;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MINOR_WORDS = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'at', 'to']);

/**
 * Readable title for a kebab-case slug the data has no name for (e.g. a map that patch notes
 * mention but maps.json no longer lists): 'garden-of-terror' -> 'Garden of Terror'.
 */
export function slugTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w, i) => (i > 0 && MINOR_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
