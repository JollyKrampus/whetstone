import {
  COLORS,
  RARITIES,
  type CardFace,
  type CardRecord,
  type Color,
  type Rarity,
} from './types.js';

/*
 * Pure fold of Scryfall card objects (one JSON object per line) into one CardRecord per
 * oracle ID. Used by the MCP server's SQLite index (data/bulk.ts) and by any build step
 * (e.g. a CI job) that wants the same records without node:sqlite.
 */

/** Layouts that are never deck cards. */
const SKIP_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'planar',
  'scheme',
  'vanguard',
  'reversible_card',
]);

const RARITY_MAP: Record<string, Rarity> = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  mythic: 'mythic',
  special: 'rare',
  bonus: 'rare',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawCard = Record<string, any>;

function lowerRarity(a: Rarity | null, b: Rarity): Rarity {
  if (a === null) return b;
  return RARITIES.indexOf(b) < RARITIES.indexOf(a) ? b : a;
}

function colorsOf(list: unknown): Color[] {
  const set = new Set(Array.isArray(list) ? list : []);
  return COLORS.filter((c) => set.has(c));
}

function faceOf(f: RawCard): CardFace {
  return {
    name: f.name,
    manaCost: f.mana_cost ?? '',
    typeLine: f.type_line ?? '',
    oracleText: f.oracle_text ?? '',
    ...(f.power !== undefined ? { power: f.power, toughness: f.toughness } : {}),
  };
}

function fromPrinting(c: RawCard): CardRecord {
  const faces: CardFace[] = Array.isArray(c.card_faces) ? c.card_faces.map(faceOf) : [];
  const front = faces[0];
  const faceColors = faces.length ? colorsOf(c.card_faces.flatMap((f: RawCard) => f.colors ?? [])) : [];
  const pt =
    c.power !== undefined
      ? { power: c.power, toughness: c.toughness }
      : front?.power !== undefined
        ? { power: front.power, toughness: front.toughness }
        : {};
  return {
    oracleId: c.oracle_id,
    name: c.name,
    layout: c.layout,
    manaCost: c.mana_cost ?? front?.manaCost ?? '',
    cmc: typeof c.cmc === 'number' ? c.cmc : 0,
    typeLine: c.type_line ?? faces.map((f) => f.typeLine).join(' // '),
    oracleText: c.oracle_text ?? faces.map((f) => f.oracleText).join('\n//\n'),
    faces,
    colors: c.colors ? colorsOf(c.colors) : faceColors,
    colorIdentity: colorsOf(c.color_identity),
    producedMana: Array.isArray(c.produced_mana) ? [...c.produced_mana].sort() : [],
    keywords: Array.isArray(c.keywords) ? [...c.keywords].sort() : [],
    legalities: c.legalities ?? {},
    ...pt,
    rarity: RARITY_MAP[c.rarity] ?? 'rare',
    arenaRarity: null,
    onArena: false,
    arenaIds: [],
    releasedAt: c.released_at,
    latestReleasedAt: c.released_at,
    edhrecRank: null,
    gameChanger: Boolean(c.game_changer),
    priceUsd: null,
  };
}

/**
 * Folds every printing in a Scryfall bulk file (one JSON object per line) into one record
 * per oracle ID. Arena availability, Arena IDs and the cheapest Arena rarity are
 * aggregated across printings.
 */
export async function aggregateCards(lines: AsyncIterable<string> | Iterable<string>): Promise<CardRecord[]> {
  const byOracle = new Map<string, CardRecord>();
  const latestAny = new Map<string, string>();
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line === '[' || line === ']') continue;
    const c = JSON.parse(line) as RawCard;
    if (!c.oracle_id || SKIP_LAYOUTS.has(c.layout)) continue;
    if (c.set_type === 'memorabilia' || c.set_type === 'token') continue;

    let rec = byOracle.get(c.oracle_id);
    if (!rec) {
      rec = fromPrinting(c);
      byOracle.set(c.oracle_id, rec);
    }
    const rarity = RARITY_MAP[c.rarity] ?? 'rare';
    rec.rarity = lowerRarity(rec.rarity, rarity);
    if (c.released_at < rec.releasedAt) rec.releasedAt = c.released_at;
    if (c.released_at > (latestAny.get(c.oracle_id) ?? '')) latestAny.set(c.oracle_id, c.released_at);
    if (typeof c.edhrec_rank === 'number') {
      rec.edhrecRank = rec.edhrecRank === null ? c.edhrec_rank : Math.min(rec.edhrecRank, c.edhrec_rank);
    }
    const price = Number(c.prices?.usd ?? c.prices?.usd_foil);
    if (Number.isFinite(price) && price > 0) rec.priceUsd = rec.priceUsd === null ? price : Math.min(rec.priceUsd, price);
    const games: string[] = c.games ?? [];
    if (games.includes('arena')) {
      if (!rec.onArena || c.released_at > rec.latestReleasedAt) rec.latestReleasedAt = c.released_at;
      rec.onArena = true;
      rec.arenaRarity = lowerRarity(rec.arenaRarity, rarity);
      if (typeof c.arena_id === 'number' && !rec.arenaIds.includes(c.arena_id)) rec.arenaIds.push(c.arena_id);
    }
  }
  const out = [...byOracle.values()];
  for (const rec of out) {
    rec.arenaIds.sort((a, b) => a - b);
    if (!rec.onArena) rec.latestReleasedAt = latestAny.get(rec.oracleId) ?? rec.releasedAt;
  }
  return out.sort(byNameThenId);
}

export function byNameThenId(a: CardRecord, b: CardRecord): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0;
}
