/**
 * Pokémon Showdown battle log → one anonymous game record. Pure.
 *
 * Reads team preview (`|poke|`), the open team sheets Bo3 formats force (`|showteam|`, for the
 * held items that decide Mega formes), who actually battled (`|switch|`, `|drag|`, `|replace|`
 * in order of first appearance, so the first two led) and the result (`|win|`). Player names
 * are only used inside this function to map `|win|<name>` to a side; they never leave it.
 */
import type { DexIndex } from '../ids.ts';
import { toId } from '../ids.ts';

export interface GameSide {
  /** Usage ids of the six registered Pokémon (Mega when holding its stone), team-preview order. */
  team: string[];
  /** Usage ids (Mega when holding its stone) that battled, by first appearance. */
  brought: string[];
}

export interface ParsedGame {
  sides: [GameSide, GameSide];
  /** 1 or 2; null for a tie or an unfinished log. */
  winner: 1 | 2 | null;
}

export type ParseFailure = 'no-result' | 'no-teams' | 'unknown-species';

const SIDES = ['p1', 'p2'] as const;

/** `Garchomp, L50, M` → `Garchomp`. */
function detailsSpecies(details: string): string {
  return (details.split(',')[0] ?? '').trim();
}

/** Showdown's packed team (`|showteam|`): species → held item id. */
export function packedItems(packed: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const set of packed.split(']')) {
    const f = set.split('|');
    const species = (f[1] ?? '') || (f[0] ?? '');
    if (species) out.set(toId(species), toId(f[2] ?? ''));
  }
  return out;
}

export function parseLog(log: string, dex: DexIndex): ParsedGame | ParseFailure {
  const names = new Map<string, 0 | 1>();
  const team: [string[], string[]] = [[], []];
  const items: [Map<string, string>, Map<string, string>] = [new Map(), new Map()];
  // Appearance counts per side (an Illusion disguise is taken back on |replace|).
  const seen: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  const order: [string[], string[]] = [[], []];
  const slot = new Map<string, string>();
  let winner: 1 | 2 | null = null;
  let finished = false;
  let unknown = false;

  const sideOf = (who: string): 0 | 1 | null => (who.startsWith('p1') ? 0 : who.startsWith('p2') ? 1 : null);
  const resolve = (name: string): string | null => {
    const id = dex.species(name);
    if (!id) unknown = true;
    return id;
  };
  const appear = (side: 0 | 1, species: string, delta: 1 | -1): void => {
    const n = (seen[side].get(species) ?? 0) + delta;
    seen[side].set(species, n);
    if (delta > 0 && !order[side].includes(species)) order[side].push(species);
  };

  for (const line of log.split('\n')) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (cmd === 'player') {
      const side = sideOf(parts[2] ?? '');
      const name = toId(parts[3] ?? '');
      if (side !== null && name) names.set(name, side);
    } else if (cmd === 'poke') {
      const side = sideOf(parts[2] ?? '');
      const id = resolve(detailsSpecies(parts[3] ?? ''));
      if (side !== null && id && !team[side].includes(id)) team[side].push(id);
    } else if (cmd === 'showteam') {
      const side = sideOf(parts[2] ?? '');
      if (side !== null) items[side] = packedItems(parts.slice(3).join('|'));
    } else if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const who = (parts[2] ?? '').split(':')[0] ?? '';
      const side = sideOf(who);
      const id = resolve(detailsSpecies(parts[3] ?? ''));
      if (side === null || !id) continue;
      if (cmd === 'replace') {
        const disguise = slot.get(who);
        if (disguise && disguise !== id) appear(side, disguise, -1);
      }
      slot.set(who, id);
      appear(side, id, 1);
    } else if (cmd === 'win') {
      finished = true;
      const side = names.get(toId(parts[2] ?? ''));
      winner = side === undefined ? null : side === 0 ? 1 : 2;
    } else if (cmd === 'tie') {
      finished = true;
      winner = null;
    }
  }
  if (unknown) return 'unknown-species';
  if (!finished || winner === null) return 'no-result';
  const sides = SIDES.map((_, i) => {
    const s = i as 0 | 1;
    const brought = order[s].filter((id) => (seen[s].get(id) ?? 0) > 0).map((id) => dex.usageId(id, items[s].get(id)));
    const six = team[s].map((id) => dex.usageId(id, items[s].get(id)));
    return { team: [...new Set(six)].slice(0, 6), brought: [...new Set(brought)].slice(0, 6) };
  }) as [GameSide, GameSide];
  if (sides.some((s) => s.team.length === 0 || s.brought.length === 0)) return 'no-teams';
  return { sides, winner };
}
