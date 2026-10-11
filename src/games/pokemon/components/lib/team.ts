/**
 * The team model shared by the builder, the calc and the team-preview assistant. A set is what a
 * team sheet lists: base species (Megas are reached through their stone), item, ability, nature,
 * Stat Points and up to four moves. Everything is ids (Showdown toIDs) so it survives renames.
 */
import type { Nature } from '../../schema.ts';
import { NATURES } from './vocab.ts';
import { checkSp, type SpTuple } from './stats.ts';

export const TEAM_SIZE = 6;
export const MOVES_PER_SET = 4;

export interface PokemonSet {
  /** Base species id (the Mega forme comes from the held stone). */
  species: string;
  nickname?: string;
  item?: string;
  ability?: string;
  nature: Nature;
  sp: SpTuple;
  /** Up to four move ids, in sheet order. */
  moves: string[];
}

export type Team = PokemonSet[];

export function emptySp(): SpTuple {
  return [0, 0, 0, 0, 0, 0];
}

export function newSet(species: string): PokemonSet {
  return { species, nature: 'Serious', sp: emptySp(), moves: [] };
}

export function isNature(value: unknown): value is Nature {
  return typeof value === 'string' && (NATURES as readonly string[]).includes(value);
}

const ID_RE = /^[a-z0-9]{1,40}$/;

/** Defensive check for sets read back from storage or a link (never throws). */
export function sanitizeSet(raw: unknown): PokemonSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.species !== 'string' || !ID_RE.test(r.species)) return null;
  const set: PokemonSet = {
    species: r.species,
    nature: isNature(r.nature) ? r.nature : 'Serious',
    sp: emptySp(),
    moves: [],
  };
  if (typeof r.nickname === 'string' && r.nickname.trim() && r.nickname.length <= 18) set.nickname = r.nickname.trim();
  if (typeof r.item === 'string' && ID_RE.test(r.item)) set.item = r.item;
  if (typeof r.ability === 'string' && ID_RE.test(r.ability)) set.ability = r.ability;
  if (Array.isArray(r.sp) && r.sp.length === 6 && r.sp.every((v) => Number.isInteger(v))) {
    const sp = r.sp as number[];
    if (checkSp(sp).ok) set.sp = [sp[0]!, sp[1]!, sp[2]!, sp[3]!, sp[4]!, sp[5]!];
  }
  if (Array.isArray(r.moves)) {
    set.moves = r.moves.filter((m): m is string => typeof m === 'string' && ID_RE.test(m)).slice(0, MOVES_PER_SET);
  }
  return set;
}

export function sanitizeTeam(raw: unknown): Team {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeSet)
    .filter((s): s is PokemonSet => s !== null)
    .slice(0, TEAM_SIZE);
}

// ---- compact text form (share links) ---------------------------------------------------------

/**
 * One line per set, fields separated by '|': species|item|ability|nature index|sp dot list|moves
 * comma list|nickname. Ids are already [a-z0-9], so no escaping is needed except for nicknames.
 */
export function packTeam(team: Team): string {
  return team
    .map((s) =>
      [
        s.species,
        s.item ?? '',
        s.ability ?? '',
        String(Math.max(0, (NATURES as readonly string[]).indexOf(s.nature))),
        s.sp.join('.'),
        s.moves.join(','),
        s.nickname ? encodeURIComponent(s.nickname).replace(/~/g, '%7E') : '',
      ]
        .join('|')
        .replace(/\|+$/, ''),
    )
    .join('~');
}

export function unpackTeam(text: string): Team {
  if (!text) return [];
  // Never look past the sixth set: a link or stored value may carry any number of separators.
  const out: unknown[] = text.split('~', TEAM_SIZE).map((line) => {
    const [species, item, ability, nature, sp, moves, nick] = line.split('|', 7);
    let nickname: string | undefined;
    try {
      nickname = nick ? decodeURIComponent(nick) : undefined;
    } catch {
      nickname = undefined;
    }
    const natureName = NATURES[Number(nature)];
    return {
      species,
      ...(item ? { item } : {}),
      ...(ability ? { ability } : {}),
      nature: natureName ?? 'Serious',
      sp: sp ? sp.split('.').map(Number) : emptySp(),
      moves: moves ? moves.split(',', MOVES_PER_SET * 2).filter(Boolean) : [],
      ...(nickname ? { nickname } : {}),
    };
  });
  return sanitizeTeam(out);
}
