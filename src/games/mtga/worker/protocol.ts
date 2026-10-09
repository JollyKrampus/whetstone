/**
 * Message protocol between the MTGA pages and the analyzer Web Worker. Plain JSON-friendly
 * shapes only (structured clone), so the same types serve the worker, its client and tests.
 *
 *   page → worker   { id, type, ...request }     (WorkerRequest)
 *   worker → page   { id, ok: true, result }      (WorkerResponse, one per request)
 *                   { id, ok: false, error }
 *                   { type: 'progress', ... }     (WorkerProgress, any time, no id)
 */
import type {
  Analysis,
  CardFace,
  Color,
  Dimension,
  Intensity,
  Issue,
  Mode,
  Rarity,
  Role,
  SearchOrder,
  SimCheck,
  SimReport,
  Swap,
  ValidationIssue,
  WildcardCounts,
  WildcardReport,
} from '#vendor/grindstone/core.js';

/** Arena constructed formats grindstone validates, in display order. */
export const FORMAT_IDS = ['standard', 'pioneer', 'historic', 'timeless', 'brawl', 'standardbrawl'] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export const FORMAT_LABELS: Readonly<Record<FormatId, string>> = {
  standard: 'Standard',
  pioneer: 'Pioneer',
  historic: 'Historic',
  timeless: 'Timeless',
  brawl: 'Brawl',
  standardbrawl: 'Standard Brawl',
};

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string' && (FORMAT_IDS as readonly string[]).includes(value);
}

/** Card pool loaded in the worker: the Standard shard first, every Arena card on demand. */
export type Pool = 'standard' | 'arena';

export interface ShardUrls {
  standard: string;
  arena: string;
}

/** What the page needs to show a card (names, text, image ids); no zod, no grindstone records. */
export interface CardView {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  layout: string;
  colors: Color[];
  /** Cheapest Arena rarity (what a wildcard costs). */
  rarity: Rarity;
  power?: string;
  toughness?: string;
  faces: CardFace[];
  /** Newest Arena printing, for cards.scryfall.io images and the scryfall.com link. */
  scryfallId?: string;
  set?: string;
  cn?: string;
  legal: Partial<Record<FormatId, 'legal' | 'banned' | 'restricted'>>;
}

export interface MetaListInput {
  name?: string;
  archetype?: string;
  list: string;
  winRate?: number;
  metaShare?: number;
}

/** Meta lists to compare against and to score card quality with. */
export interface MetaSelection {
  /** Shown in the UI: "Curated Standard snapshot", "My lists". */
  label: string;
  lists: MetaListInput[];
}

export interface EntryView {
  qty: number;
  name: string;
  oracleId: string;
}

export interface LegalityView {
  format: FormatId;
  label: string;
  legal: boolean;
  mainCount: number;
  sideCount: number;
  issues: ValidationIssue[];
}

export interface PowerView {
  tier: number;
  label: string;
  score: number;
  rubric: string;
  archetype: string;
  dimensions: Dimension[];
  /** True when any dimension is low confidence (card quality without meta lists). */
  lowConfidence: boolean;
  /** The rubric's tier scale (tier, label, minimum score), lowest first. */
  scale: { tier: number; label: string; min: number }[];
}

export interface MetaCompareView {
  label: string;
  lists: number;
  closest: { name: string; archetype: string; overlapPercent: number; shareOfSuppliedListsPercent: number; winRate?: number } | null;
  ranking: { name: string; archetype: string; overlapPercent: number }[];
  missingCore: { name: string; metaQty: number; deckQty: number }[];
  unusual: { name: string; qty: number }[];
  unresolved: { list: string; issues: Issue[] }[];
}

export interface SimOptionsView {
  iterations: number;
  seed: number;
  playDraw: 'play' | 'draw';
  bo1Smoothing: boolean;
  checks: SimCheck[];
}

export interface AnalyzeRequest {
  type: 'analyze';
  text: string;
  /** null = pick the narrowest format the deck is legal in. */
  format: FormatId | null;
  /** Meta lists to use whatever the format; wins over `metaByFormat`. */
  meta: MetaSelection | null;
  /** Meta lists per format, used for the analyzed format (handy with auto-detection). */
  metaByFormat?: Partial<Record<FormatId, MetaSelection>>;
  /** Ask Scryfall's fuzzy search for names the local index does not know. */
  fuzzy?: boolean;
}

export interface AnalyzeResult {
  name: string | null;
  /** Canonical Arena export of the resolved deck (what share links and "Copy" use). */
  arenaText: string;
  commander: EntryView | null;
  companion: EntryView | null;
  main: EntryView[];
  side: EntryView[];
  counts: { main: number; side: number };
  /** Lines that could not be resolved, with "did you mean" suggestions. */
  issues: Issue[];
  format: FormatId;
  autoFormat: boolean;
  legality: LegalityView[];
  analysis: Analysis;
  power: PowerView;
  wildcards: WildcardReport;
  simulation: SimReport;
  meta: MetaCompareView | null;
  /** Every card mentioned in this result, by oracle id. */
  cards: Record<string, CardView>;
  pool: Pool;
  /** Card data date (YYYY-MM-DD); results are reproducible against it. */
  asOf: string;
}

export interface SimulateRequest {
  type: 'simulate';
  text: string;
  options: SimOptionsView;
}

export interface HandRequest {
  type: 'hand';
  text: string;
  seed: number;
}

export interface HandResult {
  seed: number;
  hand: string[];
  nextDraws: string[];
  landsInHand: number;
  keepable: boolean;
  /** Oracle ids by card name (hand and draws), for images. */
  ids: Record<string, string>;
}

export interface SuggestRequest {
  type: 'suggest';
  text: string;
  format: FormatId;
  mode: Mode;
  intensity: Intensity;
  /** Per-rarity budget; a missing rarity is unlimited. Null = no budget. */
  wildcards: Partial<WildcardCounts> | null;
  keepCards: string[];
  maxSwaps: number;
  meta: MetaSelection | null;
}

export interface SuggestView {
  swaps: Swap[];
  totalCost: WildcardCounts;
  budget: Partial<WildcardCounts> | null;
  remaining: Partial<WildcardCounts> | null;
  changes: { cards: number; limit: number; deckSize: number; intensity: Intensity };
  notes: string[];
  /** The deck with every swap applied (Arena export), ready for "Apply". */
  appliedText: string;
  cards: Record<string, CardView>;
}

export interface ApplyRequest {
  type: 'apply';
  text: string;
  /** Swaps to apply to the main deck, in order (a subset of a SuggestView). */
  swaps: { cut: string; add: string; qty: number }[];
}

export interface ApplyResult {
  /** The deck with the swaps applied (Arena export). */
  text: string;
}

export interface SearchRequest {
  type: 'search';
  query: string;
  /** null = every Arena card. */
  format: FormatId | null;
  order: SearchOrder;
  limit: number;
}

export interface SearchResult {
  total: number;
  cards: CardView[];
  pool: Pool;
  /** Set when the query could not be parsed. */
  error?: string;
}

export interface CheckListsRequest {
  type: 'checkLists';
  lists: { list: string; format: FormatId }[];
}

export interface ListCheck {
  main: number;
  side: number;
  legal: boolean;
  /** Short reason when not legal. */
  problem: string | null;
  issues: Issue[];
  colors: Color[];
}

export interface InitRequest {
  type: 'init';
  shards: ShardUrls;
  /** Scryfall snapshot id; the IndexedDB cache is keyed by it. */
  snapshot: string;
  /** Load every Arena card up front (search across all formats). */
  pool?: Pool;
}

export interface InitResult {
  pool: Pool;
  cards: number;
  snapshot: string;
  asOf: string;
  cached: boolean;
}

export type WorkerRequestBody =
  | InitRequest
  | AnalyzeRequest
  | SimulateRequest
  | HandRequest
  | SuggestRequest
  | ApplyRequest
  | SearchRequest
  | CheckListsRequest;

export type WorkerRequest = WorkerRequestBody & { id: number };

export interface ResultMap {
  init: InitResult;
  analyze: AnalyzeResult;
  simulate: SimReport;
  hand: HandResult;
  suggest: SuggestView;
  apply: ApplyResult;
  search: SearchResult;
  checkLists: ListCheck[];
}

export interface WorkerError {
  message: string;
  code?: string;
}

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: WorkerError };

export interface WorkerProgress {
  type: 'progress';
  stage: 'download' | 'cache' | 'index';
  pool: Pool;
  /** Bytes so far and total (download only; total may be unknown). */
  loaded?: number;
  total?: number;
}

export type WorkerMessage = WorkerResponse | WorkerProgress;

export function isProgress(m: WorkerMessage): m is WorkerProgress {
  return (m as WorkerProgress).type === 'progress';
}

export type { Analysis, Color, Dimension, Intensity, Issue, Mode, Rarity, Role, SearchOrder, SimCheck, SimReport, Swap, ValidationIssue, WildcardCounts, WildcardReport };
