import { describe, expect, it } from 'vitest';
import { LimitedIndexSchema, LimitedRatingsSchema } from '../schema.ts';
import {
  ATTRIBUTION,
  aggregateDrafts,
  aggregateGames,
  buildLimitedIndex,
  buildRatings,
  draftDataUrl,
  gameDataUrl,
  parseCardsCsv,
  wubrg,
} from './seventeenlands.ts';

const card = (name: string) => (name.includes(',') ? `"${name}"` : name);
const cols = (name: string) => ['opening_hand_', 'drawn_', 'tutored_', 'deck_', 'sideboard_'].map((p) => card(`${p}${name}`)).join(',');
const B = 'Beta, the Second';

// Fixed columns, then 5 columns per card: opening_hand, drawn, tutored, deck, sideboard.
const GAME_CSV = [
  `expansion,event_type,draft_id,main_colors,splash_colors,won,${cols('Alpha')},${cols(B)},${cols('Plains')},user_game_win_rate_bucket`,
  'TST,PremierDraft,d1,WU,,True,1,0,0,2,0,0,1,0,1,0,2,0,0,8,0,0.5',
  'TST,PremierDraft,d1,WU,B,False,0,0,0,2,0,1,0,0,1,0,0,0,0,8,0,0.5',
  'TST,PremierDraft,d2,UW,,True,0,1,0,1,0,0,0,0,0,1,0,0,0,9,0,0.5',
  'TST,PremierDraft,d3,R,,False,0,0,1,2,0,0,0,0,1,0,0,0,0,7,0,0.5',
];

const DRAFT_CSV = [
  `draft_id,pack_number,pick_number,pick,pack_card_Alpha,${card(`pack_card_${B}`)},pool_Alpha`,
  `d1,0,0,Alpha,1,1,0`,
  `d1,0,1,${card(B)},0,1,1`,
  `d1,0,8,Gamma,0,1,1`,
  `d1,1,0,${card(B)},1,1,1`,
  `d2,0,2,Alpha,1,0,0`,
];

const CARDS_CSV = [
  'id,expansion,name,rarity,color_identity,mana_value,types,is_booster',
  '5,TST,Alpha,rare,UW,2,Creature - Bird,True',
  '1,TST,Alpha,rare,UW,2,Creature - Bird,False',
  `2,TST,${card(B)},mythic,R,3,Legendary Creature - Dwarf,True`,
  '3,TST,Plains,basic,W,0,Basic Land - Plains,True',
  '4,OTH,Gamma,special,G,1,Instant,True',
];

describe('17Lands URLs and attribution', () => {
  it('points at the public S3 datasets and carries the CC BY credit', () => {
    expect(gameDataUrl('HOB', 'PremierDraft')).toBe('https://17lands-public.s3.amazonaws.com/analysis_data/game_data/game_data_public.HOB.PremierDraft.csv.gz');
    expect(draftDataUrl('HOB', 'TradDraft')).toBe('https://17lands-public.s3.amazonaws.com/analysis_data/draft_data/draft_data_public.HOB.TradDraft.csv.gz');
    expect(ATTRIBUTION).toMatchObject({ source: '17lands', license: 'CC BY 4.0', url: 'https://www.17lands.com/public_datasets' });
  });

  it('orders colours as WUBRG', () => {
    expect(wubrg('GW')).toBe('WG');
    expect(wubrg('uw')).toBe('WU');
    expect(wubrg('')).toBe('');
    expect(wubrg('BRG')).toBe('BRG');
  });
});

describe('aggregateGames', () => {
  it('counts GP, OH, GD and GNS once per game, with wins', async () => {
    const g = await aggregateGames(GAME_CSV);
    expect(g.games).toBe(4);
    expect(g.names).toEqual(['Alpha', B, 'Plains']);
    const a = 0;
    expect([g.gp[a], g.gpW[a], g.oh[a], g.ohW[a], g.gd[a], g.gdW[a], g.gns[a], g.gnsW[a]]).toEqual([4, 2, 1, 1, 1, 1, 1, 0]);
    const b = 1;
    expect([g.gp[b], g.gpW[b], g.oh[b], g.ohW[b], g.gd[b], g.gdW[b], g.gns[b], g.gnsW[b]]).toEqual([3, 1, 1, 0, 1, 1, 1, 0]);
  });

  it('groups decks by main colours (normalized) and splash', async () => {
    const g = await aggregateGames(GAME_CSV);
    expect(Object.fromEntries(g.pairs)).toEqual({ 'WU|0': { games: 2, wins: 2 }, 'WU|1': { games: 1, wins: 0 }, 'R|0': { games: 1, wins: 0 } });
  });

  it('rejects a file without the expected columns', async () => {
    await expect(aggregateGames(['a,b,c', '1,2,3'])).rejects.toThrow(/won/);
    await expect(aggregateGames(['won,main_colors', 'True,W'])).rejects.toThrow(/card columns/);
  });
});

describe('aggregateDrafts', () => {
  it('computes ATA from picks and ALSA from the last pick each card was seen in a pack', async () => {
    const d = await aggregateDrafts(DRAFT_CSV);
    expect(d.drafts).toBe(2);
    expect(d.picks.get('Alpha')).toEqual({ n: 2, sum: 4 });
    expect(d.picks.get(B)).toEqual({ n: 2, sum: 3 });
    expect(d.lastSeen.get('Alpha')).toEqual({ n: 3, sum: 5 });
    expect(d.lastSeen.get(B)).toEqual({ n: 2, sum: 10 });
  });
});

describe('buildRatings', () => {
  it('produces schema-valid ratings with IWD in pp, basics dropped and set metadata applied', async () => {
    const games = await aggregateGames(GAME_CSV);
    const drafts = await aggregateDrafts(DRAFT_CSV);
    const cards = await parseCardsCsv(CARDS_CSV);
    expect(cards.get('TST')?.get('Alpha')?.arenaIds).toEqual([1, 5]);
    const r = buildRatings({
      set: 'TST',
      format: 'PremierDraft',
      games,
      drafts,
      cards,
      index: null,
      gameData: gameDataUrl('TST', 'PremierDraft'),
      draftData: draftDataUrl('TST', 'PremierDraft'),
      lastModified: '2026-10-01T13:17:00.000Z',
    });
    expect(() => LimitedRatingsSchema.parse(r)).not.toThrow();
    expect(r.cards.map((c) => c.name)).toEqual(['Alpha', B]);
    const alpha = r.cards[0]!;
    expect(alpha).toMatchObject({ colors: 'WU', rarity: 'rare', arenaIds: [1, 5], gp: 4, gih: 2, oh: 1, gd: 1, gns: 1, gpWr: 0.5, gihWr: 1, gnsWr: 0, iwd: 100, ata: 2, alsa: 1.67, picks: 2 });
    const beta = r.cards[1]!;
    expect(beta).toMatchObject({ colors: 'R', rarity: 'mythic', gihWr: 0.5, ohWr: 0, gdWr: 1, iwd: 50, ata: 1.5, alsa: 5 });
    expect(r.colorPairs.map((p) => `${p.colors}${p.splash ? '+' : ''}`)).toEqual(['R', 'WU', 'WU+']);
    expect(r.totals).toEqual({ games: 4, drafts: 2 });
    expect(r.dataset.draftData).toContain('draft_data_public.TST.PremierDraft');
    expect(r.attribution.license).toBe('CC BY 4.0');
  });

  it('leaves rates and pick stats null when there is no sample', async () => {
    const games = await aggregateGames([`won,main_colors,${cols('Lonely')}`, 'True,W,0,0,0,0,1']);
    const r = buildRatings({ set: 'TST', format: 'Sealed', games, drafts: null, cards: null, index: null, gameData: gameDataUrl('TST', 'Sealed'), draftData: null, lastModified: '2026-10-01T00:00:00.000Z' });
    expect(LimitedRatingsSchema.safeParse(r).success).toBe(true);
    expect(r.cards[0]).toMatchObject({ gp: 0, gpWr: null, gihWr: null, iwd: null, alsa: null, ata: null });
    expect(r.cards[0]?.picks).toBeUndefined();
    expect(r.dataset.draftData).toBeUndefined();
    expect(r.totals.drafts).toBeUndefined();
  });

  it('indexes ratings newest set first, then by format priority', () => {
    const base = (set: string, format: 'PremierDraft' | 'Sealed') =>
      buildRatings({ set, format, games: { games: 1, names: [], gp: new Int32Array(), gpW: new Int32Array(), oh: new Int32Array(), ohW: new Int32Array(), gd: new Int32Array(), gdW: new Int32Array(), gns: new Int32Array(), gnsW: new Int32Array(), pairs: new Map() }, drafts: null, cards: null, index: null, gameData: gameDataUrl(set, format), draftData: null, lastModified: '2026-01-01T00:00:00.000Z' });
    const index = buildLimitedIndex([base('OLD', 'PremierDraft'), base('NEW', 'Sealed'), base('NEW', 'PremierDraft')], ['NEW', 'OLD'], ['PremierDraft', 'TradDraft', 'Sealed']);
    expect(index.map((e) => e.file)).toEqual(['limited/NEW.PremierDraft.json', 'limited/NEW.Sealed.json', 'limited/OLD.PremierDraft.json']);
    expect(LimitedIndexSchema.safeParse(index).success).toBe(true);
  });
});
