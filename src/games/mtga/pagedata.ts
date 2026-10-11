/**
 * Build-time (Node-only) view data for the MTGA pages: staged shard URLs, curated snapshots in
 * the shape islands take, Limited rows with image ids, set names. Pages call these in their
 * frontmatter and pass plain props to islands; islands never import this module.
 */
import { stagedUrl } from '../../lib/stagemap.ts';
import { formatSlug } from './lib/limited.ts';
import type { LimitedRow } from './lib/limited.ts';
import type { CuratedSnapshotView } from './lib/metaLists.ts';
import { getCardShard, getLimitedIndex, getMeta, getMetaSnapshots, getSets } from './load.ts';
import type { LimitedFormat, LimitedRatings, MtgSet } from './schema.ts';
import type { ShardUrls } from './worker/protocol.ts';

/** Base-prefixed URLs of the two staged card shards. */
export function shardUrls(): ShardUrls {
  return { standard: stagedUrl('mtga', '_cards.standard'), arena: stagedUrl('mtga', '_cards.arena') };
}

/** Curated snapshots as islands take them (no zod types, optional keys omitted). */
export function curatedViews(): CuratedSnapshotView[] {
  return getMetaSnapshots().map((s) => ({
    format: s.format,
    ...(s.date ? { date: s.date } : {}),
    ...(s.source ? { source: s.source } : {}),
    ...(s.example ? { example: true as const } : {}),
    decks: s.decks.map((d) => ({
      list: d.list,
      ...(d.name ? { name: d.name } : {}),
      ...(d.archetype ? { archetype: d.archetype } : {}),
      ...(d.metaShare !== undefined ? { metaShare: d.metaShare } : {}),
      ...(d.winRate !== undefined ? { winRate: d.winRate } : {}),
      ...(d.sourceUrl ? { sourceUrl: d.sourceUrl } : {}),
      ...(d.date ? { date: d.date } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
      ...(d.example || s.example ? { example: true as const } : {}),
    })),
  }));
}

/** A deck to try on the analyzer: the first curated Standard deck (an example deck would do too). */
export function sampleDeck(): { name: string; text: string } | null {
  const snaps = curatedViews();
  const snap = snaps.find((s) => s.format === 'standard') ?? snaps[0];
  const deck = snap?.decks[0];
  if (!deck) return null;
  const name = deck.name ?? deck.archetype ?? 'Sample deck';
  return { name, text: deck.list.startsWith('About') ? deck.list : `About\nName ${name}\n\n${deck.list}` };
}

let imageIds: Map<string, { scryfallId: string; set?: string; cn?: string }> | null = null;

/** oracleId → newest Arena printing, for card images on pages that have no card shard. */
function printingByOracle(): Map<string, { scryfallId: string; set?: string; cn?: string }> {
  if (imageIds) return imageIds;
  imageIds = new Map();
  for (const c of getCardShard('arena').cards) {
    if (c.scryfallId) imageIds.set(c.oracleId, { scryfallId: c.scryfallId, ...(c.set ? { set: c.set } : {}), ...(c.cn ? { cn: c.cn } : {}) });
  }
  return imageIds;
}

/** Table rows for a ratings file, with image ids where the card index has the card. */
export function limitedRows(r: LimitedRatings): LimitedRow[] {
  const prints = printingByOracle();
  return r.cards.map((c) => {
    const p = c.oracleId ? prints.get(c.oracleId) : undefined;
    return {
      name: c.name,
      colors: c.colors,
      rarity: c.rarity,
      gih: c.gih,
      gp: c.gp,
      gpWr: c.gpWr,
      gihWr: c.gihWr,
      ohWr: c.ohWr,
      gdWr: c.gdWr,
      gnsWr: c.gnsWr,
      iwd: c.iwd,
      alsa: c.alsa,
      ata: c.ata,
      ...(p ? { scryfallId: p.scryfallId, ...(p.set ? { set: p.set } : {}), ...(p.cn ? { cn: p.cn } : {}) } : {}),
    };
  });
}

/** Set name by code (falls back to the code). */
export function setName(code: string): string {
  return getSets().find((s) => s.code === code.toUpperCase())?.name ?? code.toUpperCase();
}

export function setByCode(code: string): MtgSet | undefined {
  return getSets().find((s) => s.code === code.toUpperCase());
}

/** Default (first listed) format of a set's ratings: Premier Draft when present. */
const FORMAT_RANK: readonly LimitedFormat[] = ['PremierDraft', 'TradDraft', 'QuickDraft', 'Sealed', 'TradSealed', 'PickTwoDraft', 'PickTwoTradDraft'];

export interface LimitedSetSummary {
  code: string;
  name: string;
  releasedAt: string | null;
  formats: { format: LimitedFormat; games: number; lastModified: string; synthetic: boolean; slug: string | null }[];
}

/** Sets with ratings, in index order (newest first), formats in a stable order. */
export function limitedSets(): LimitedSetSummary[] {
  const out: LimitedSetSummary[] = [];
  for (const e of getLimitedIndex()) {
    let s = out.find((x) => x.code === e.set);
    if (!s) {
      const set = setByCode(e.set);
      s = { code: e.set, name: set?.name ?? e.set, releasedAt: set?.releasedAt ?? null, formats: [] };
      out.push(s);
    }
    s.formats.push({ format: e.format, games: e.games, lastModified: e.lastModified, synthetic: e.synthetic === true, slug: null });
  }
  for (const s of out) {
    s.formats.sort((a, b) => FORMAT_RANK.indexOf(a.format) - FORMAT_RANK.indexOf(b.format));
    // The first format lives at /limited/<set>/, the others at /limited/<set>/<slug>/.
    s.formats.forEach((f, i) => (f.slug = i === 0 ? null : formatSlug(f.format)));
  }
  return out;
}

/** Card-data facts for overview and about pages. */
export function cardFacts() {
  const meta = getMeta();
  const sets = getSets();
  const latest = sets.find((s) => s.code === meta.extra.latestSet) ?? null;
  return {
    snapshot: meta.extra.snapshot,
    grindstone: meta.extra.grindstone,
    cards: meta.counts.cards ?? 0,
    standardCards: meta.counts.standardCards ?? 0,
    latest,
    standardSets: meta.extra.standardSets.map((code) => ({ code, name: sets.find((s) => s.code === code)?.name ?? code })),
    metaFormats: meta.extra.metaFormats,
  };
}
