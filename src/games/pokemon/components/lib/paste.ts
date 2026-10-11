/**
 * Showdown paste import/export with Champions Stat Points.
 *
 * Showdown's Champions formats keep the familiar `EVs:` line but fill it with Stat Points
 * ("EVs: 2 HP / 32 Atk / 32 Spe"). Older pastes from Scarlet/Violet carry real EVs. The rule is
 * decided for each set on its own: a set's line is read as EVs when one stat is above 32 or the
 * set totals more than 130 (stats.ts looksLikeEvs), which no Stat Point spread comes close to,
 * and is then converted with the HOME rule (see stats.ts evToSp). Anything else stays Stat
 * Points, so one mistyped set (say 4/32/32 = 68) is reported as over the 66-point budget instead
 * of turning the other sets of the paste into tiny EV conversions.
 * Export always writes Stat Points in the `EVs:` line, which is what Showdown's Champions
 * formats import.
 */
import type { Nature } from '../../schema.ts';
import { NATURES } from './vocab.ts';
import { toId, type DexIndex } from './dex.ts';
import { STAT_IDS, STAT_LABEL, SP_MAX_TOTAL, checkSp, evToSp, looksLikeEvs, spTotal, type SpTuple, type StatId } from './stats.ts';
import { MOVES_PER_SET, TEAM_SIZE, emptySp, isNature, type PokemonSet, type Team } from './team.ts';

export type PasteIssueLevel = 'error' | 'warning' | 'info';

export interface PasteIssue {
  level: PasteIssueLevel;
  /** 0-based set index, when the issue belongs to one set. */
  slot?: number;
  message: string;
}

export interface PasteResult {
  team: Team;
  issues: PasteIssue[];
  /** True when at least one set's `EVs:` line held EVs and was converted to Stat Points. */
  convertedFromEvs: boolean;
}

const STAT_ALIASES: Readonly<Record<string, StatId>> = {
  hp: 'hp',
  atk: 'atk',
  attack: 'atk',
  def: 'def',
  defense: 'def',
  spa: 'spa',
  spatk: 'spa',
  spattack: 'spa',
  spd: 'spd',
  spdef: 'spd',
  spdefense: 'spd',
  spe: 'spe',
  speed: 'spe',
};

interface RawSet {
  line: number;
  species: string;
  nickname?: string;
  item?: string;
  ability?: string;
  nature?: string;
  evs: number[] | null;
  moves: string[];
  ignored: string[];
}

/** "Nick (Species) (M) @ Item" → parts. Gender markers and a trailing item are optional. */
export function parseHeader(line: string): { species: string; nickname?: string; item?: string } {
  let text = line.trim();
  let item: string | undefined;
  const at = text.lastIndexOf(' @ ');
  if (at >= 0) {
    item = text.slice(at + 3).trim() || undefined;
    text = text.slice(0, at).trim();
  } else if (text.endsWith('@')) {
    text = text.slice(0, -1).trim();
  }
  text = text.replace(/\s*\((?:M|F)\)\s*$/, '').trim();
  const nick = /^(.*\S)\s*\(([^()]+)\)$/.exec(text);
  const out: { species: string; nickname?: string; item?: string } = nick ? { species: nick[2]!.trim(), nickname: nick[1]!.trim() } : { species: text };
  if (item) out.item = item;
  return out;
}

function parseStatLine(body: string): number[] {
  const values = [0, 0, 0, 0, 0, 0];
  for (const part of body.split('/')) {
    const m = /^\s*(\d+)\s+([A-Za-z. ]+?)\s*$/.exec(part);
    if (!m) continue;
    const stat = STAT_ALIASES[toId(m[2])];
    if (!stat) continue;
    values[STAT_IDS.indexOf(stat)] = Number(m[1]);
  }
  return values;
}

function splitSets(text: string): { line: number; lines: string[] }[] {
  const blocks: { line: number; lines: string[] }[] = [];
  let current: { line: number; lines: string[] } | null = null;
  text.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || /^===.*===$/.test(line)) {
      current = null;
      return;
    }
    if (!current) {
      current = { line: i + 1, lines: [] };
      blocks.push(current);
    }
    current.lines.push(line);
  });
  return blocks;
}

function readRaw(block: { line: number; lines: string[] }): RawSet {
  const [head = '', ...rest] = block.lines;
  const header = parseHeader(head);
  const raw: RawSet = { line: block.line, species: header.species, evs: null, moves: [], ignored: [] };
  if (header.nickname) raw.nickname = header.nickname;
  if (header.item) raw.item = header.item;
  for (const line of rest) {
    if (/^[-~]\s*/.test(line)) {
      raw.moves.push(line.replace(/^[-~]\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim());
      continue;
    }
    const nature = /^([A-Za-z]+)\s+Nature$/i.exec(line);
    if (nature) {
      raw.nature = nature[1]!;
      continue;
    }
    const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (!kv) {
      raw.ignored.push(line);
      continue;
    }
    const key = toId(kv[1]);
    const value = kv[2]!.trim();
    if (key === 'ability') raw.ability = value;
    else if (key === 'evs') raw.evs = parseStatLine(value);
    else if (key === 'level' && value !== '50') raw.ignored.push(`Level ${value} (every Pokémon is level 50)`);
    else if (key === 'ivs' && value.split('/').some((p) => /^\s*\d+/.test(p) && Number.parseInt(p, 10) !== 31)) {
      raw.ignored.push('IVs (fixed at 31 in Champions)');
    } else if (key === 'teratype') raw.ignored.push('Tera Type (no Terastallization in Champions)');
    else if (key !== 'level' && key !== 'ivs' && key !== 'shiny' && key !== 'happiness' && key !== 'gender') raw.ignored.push(line);
  }
  return raw;
}

function titleNature(text: string | undefined): Nature | undefined {
  if (!text) return undefined;
  const t = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  return isNature(t) ? t : undefined;
}

/** Parse a Showdown paste (one or many sets) against the dex. Never throws. */
export function parsePaste(text: string, dex: DexIndex): PasteResult {
  const issues: PasteIssue[] = [];
  const raws = splitSets(text ?? '').map(readRaw).filter((r) => r.species !== '');
  if (raws.length === 0) {
    return { team: [], issues: [{ level: 'error', message: 'No Pokémon found. Paste a Showdown team export.' }], convertedFromEvs: false };
  }
  if (raws.length > TEAM_SIZE) {
    issues.push({ level: 'warning', message: `The paste has ${raws.length} Pokémon; only the first ${TEAM_SIZE} were imported.` });
  }
  const used = raws.slice(0, TEAM_SIZE);
  // EVs or Stat Points, decided per set (see the header comment).
  const asEvs = used.map((r) => r.evs !== null && looksLikeEvs(r.evs));
  const convertedFromEvs = asEvs.some(Boolean);
  const withLine = used.filter((r) => r.evs !== null).length;
  const mixed = convertedFromEvs && asEvs.filter(Boolean).length < withLine;
  if (convertedFromEvs) {
    issues.push({
      level: 'info',
      message: mixed
        ? 'Some EVs lines hold EVs (a stat above 32 or more than 130 in a set) and were converted to Stat Points (4 EVs buy the first point, then 8 per point, max 32); the others were read as Stat Points.'
        : 'The EVs lines hold EVs, so they were converted to Stat Points (4 EVs buy the first point, then 8 per point, max 32).',
    });
  }

  const team: Team = [];
  used.forEach((raw, index) => {
    const slot = team.length;
    const at = (level: PasteIssueLevel, message: string) => issues.push({ level, slot, message });
    const id = toId(raw.species);
    const found = dex.speciesById(id);
    if (!found) {
      issues.push({ level: 'error', message: `Line ${raw.line}: unknown Pokémon "${raw.species}", skipped.` });
      return;
    }
    const set: PokemonSet = { species: found.id, nature: 'Serious', sp: emptySp(), moves: [] };
    if (raw.nickname && raw.nickname !== found.name) set.nickname = raw.nickname.slice(0, 18);

    if (raw.item) {
      const item = dex.item(toId(raw.item));
      if (item) set.item = item.id;
      else at('warning', `${found.name}: unknown item "${raw.item}" was dropped.`);
    }

    // A Mega forme written as the species: register the base species with its stone.
    if (found.megaOf) {
      const base = dex.speciesById(found.megaOf);
      if (base) {
        set.species = base.id;
        if (!set.item && found.requiredItem) set.item = found.requiredItem;
        at('info', `${found.name} is registered as ${base.name} holding ${dex.itemName(found.requiredItem ?? set.item ?? '')}.`);
      }
    }
    const species = dex.speciesById(set.species) ?? found;

    if (raw.ability) {
      const ability = dex.ability(toId(raw.ability));
      if (ability) set.ability = ability.id;
      else at('warning', `${species.name}: unknown ability "${raw.ability}" was dropped.`);
    } else if (species.abilities.length === 1) {
      set.ability = species.abilities[0]!;
    }

    const nature = titleNature(raw.nature);
    if (nature) set.nature = nature;
    else if (raw.nature) at('warning', `${species.name}: unknown nature "${raw.nature}", using Serious.`);

    if (raw.evs) {
      const fromEvs = asEvs[index] === true;
      const sp = (fromEvs ? raw.evs.map(evToSp) : raw.evs) as SpTuple;
      if (mixed) at('info', fromEvs ? `${species.name}: EVs converted to Stat Points.` : `${species.name}: EVs line read as Stat Points.`);
      const check = checkSp(sp);
      if (check.ok) set.sp = sp;
      else {
        set.sp = sp.map((v) => Math.min(32, Math.max(0, Math.trunc(v)))) as SpTuple;
        if (spTotal(set.sp) > SP_MAX_TOTAL) at('error', `${species.name}: ${spTotal(set.sp)} Stat Points, more than the ${SP_MAX_TOTAL} allowed.`);
        else at('warning', `${species.name}: Stat Points were capped at 32 per stat.`);
      }
    }

    const seen = new Set<string>();
    for (const name of raw.moves) {
      const move = dex.move(toId(name));
      if (!move) {
        at('warning', `${species.name}: unknown move "${name}" was dropped.`);
        continue;
      }
      if (seen.has(move.id)) continue;
      seen.add(move.id);
      set.moves.push(move.id);
    }
    if (set.moves.length > MOVES_PER_SET) {
      at('warning', `${species.name}: more than ${MOVES_PER_SET} moves; kept the first ${MOVES_PER_SET}.`);
      set.moves = set.moves.slice(0, MOVES_PER_SET);
    }
    for (const note of raw.ignored) at('info', `${species.name}: ignored ${note}.`);
    team.push(set);
  });
  return { team, issues, convertedFromEvs };
}

/** "32 HP / 32 Atk / 2 SpD" (zero stats omitted), or '' for an empty spread. */
export function spLine(sp: readonly number[]): string {
  return STAT_IDS.map((id, i) => ({ id, v: sp[i] ?? 0 }))
    .filter((x) => x.v > 0)
    .map((x) => `${x.v} ${STAT_LABEL[x.id]}`)
    .join(' / ');
}

/** One set as Showdown text with Stat Points in the `EVs:` line. */
export function exportSet(set: PokemonSet, dex: DexIndex): string {
  const name = dex.speciesName(set.species);
  const head = set.nickname ? `${set.nickname} (${name})` : name;
  const lines = [set.item ? `${head} @ ${dex.itemName(set.item)}` : head];
  if (set.ability) lines.push(`Ability: ${dex.abilityName(set.ability)}`);
  lines.push('Level: 50');
  const evs = spLine(set.sp);
  if (evs) lines.push(`EVs: ${evs}`);
  lines.push(`${set.nature} Nature`);
  for (const m of set.moves) lines.push(`- ${dex.moveName(m)}`);
  return lines.join('\n');
}

export function exportTeam(team: Team, dex: DexIndex): string {
  return team.map((s) => exportSet(s, dex)).join('\n\n') + (team.length ? '\n' : '');
}

/** Every nature name, for selects. */
export const NATURE_NAMES: readonly Nature[] = NATURES;
