import { z } from 'zod';

type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic';
declare const RARITIES: Rarity[];
type Color = 'W' | 'U' | 'B' | 'R' | 'G';
declare const COLORS: Color[];
interface CardFace {
    name: string;
    manaCost: string;
    typeLine: string;
    oracleText: string;
    power?: string;
    toughness?: string;
}
/** One gameplay card (one Scryfall oracle ID), aggregated over all its printings. */
interface CardRecord {
    oracleId: string;
    name: string;
    layout: string;
    manaCost: string;
    cmc: number;
    typeLine: string;
    oracleText: string;
    faces: CardFace[];
    colors: Color[];
    colorIdentity: Color[];
    producedMana: string[];
    keywords: string[];
    legalities: Record<string, string>;
    power?: string;
    toughness?: string;
    /** Lowest rarity among all printings. */
    rarity: Rarity;
    /** Lowest rarity among Arena printings (what a wildcard costs), or null if not on Arena. */
    arenaRarity: Rarity | null;
    onArena: boolean;
    arenaIds: number[];
    /** Earliest printing date (YYYY-MM-DD). */
    releasedAt: string;
    /** Latest printing date; Arena printings only when the card is on Arena. */
    latestReleasedAt: string;
    edhrecRank: number | null;
    gameChanger: boolean;
}
interface IndexMeta {
    /** Scryfall bulk `updated_at` the index was built from: the data snapshot ID. */
    snapshot: string;
    builtAt: string;
    source: string;
    cardCount: number;
}

/** Thrown for problems the caller can fix (bad input, unknown format). No MCP dependency. */
declare class ToolError extends Error {
    readonly details?: unknown | undefined;
    constructor(message: string, details?: unknown | undefined);
}

/** Case-, accent-, quote- and split-separator-insensitive name key. */
declare function normalizeName(name: string): string;
declare function levenshtein(a: string, b: string, limit?: number): number;
declare class CardIndex {
    readonly records: CardRecord[];
    readonly meta: IndexMeta;
    readonly byOracle: Map<string, CardRecord>;
    private readonly byName;
    constructor(records: CardRecord[], meta: IndexMeta);
    private claim;
    lookup(name: string): CardRecord | undefined;
    /** Up to `n` closest card names, for "did you mean" hints. */
    suggest(name: string, n?: number): string[];
}
declare function frontTypeLine(c: CardRecord): string;
declare function isLand(c: CardRecord): boolean;
/** Modal double-faced spell whose back face is a land. */
declare function isMdfcLand(c: CardRecord): boolean;
declare function isBasicLand(c: CardRecord): boolean;
declare function isCreature(c: CardRecord): boolean;
/** Copy limit printed on the card ("any number" → Infinity, "up to seven" → 7), else null. */
declare function printedCopyLimit(c: CardRecord): number | null;
/** Mana cost used to cast the card from hand: the front face, or the first half of a split card. */
declare function castingCost(c: CardRecord): string;
/** Mana value of the front face / first half (MDFCs and adventures are cast as the front). */
declare function castingMv(c: CardRecord): number;
declare function manaValueOf(cost: string): number;
interface Pips {
    /** Hard colored pips per color (phyrexian and hybrid excluded). */
    hard: Record<Color, number>;
    /** Hybrid pips, each listed with the colors that can pay it. */
    hybrid: Color[][];
}
declare function pipsOf(cost: string): Pips;
/** Rarity a wildcard would cost: the lowest Arena rarity, else the lowest overall. */
declare function wildcardRarity(c: CardRecord): Rarity;
/** Strips reminder text so role regexes don't match explanations of keywords. */
declare function rulesText(c: CardRecord): string;
declare function summarize(c: CardRecord): {
    name: string;
    manaCost: string;
    mv: number;
    type: string;
    colorIdentity: string;
    rarity: Rarity;
    onArena: boolean;
    text: string;
};
/** The data snapshot date (YYYY-MM-DD), used instead of "today" so results are reproducible. */
declare function asOfDate(index: {
    meta: IndexMeta;
}): string;

/**
 * Folds every printing in a Scryfall bulk file (one JSON object per line) into one record
 * per oracle ID. Arena availability, Arena IDs and the cheapest Arena rarity are
 * aggregated across printings.
 */
declare function aggregateCards(lines: AsyncIterable<string> | Iterable<string>): Promise<CardRecord[]>;
declare function byNameThenId(a: CardRecord, b: CardRecord): number;

/** Arena export → raw (unresolved) deck. Never throws on a bad line. */
type Section = 'commander' | 'companion' | 'main' | 'side';
interface RawEntry {
    qty: number;
    name: string;
    set?: string;
    collectorNumber?: string;
    section: Section;
    line: number;
}
interface Issue {
    code: string;
    reason: string;
    line?: number;
    text?: string;
    suggestions?: string[];
}
interface RawDeck {
    name?: string;
    entries: RawEntry[];
    issues: Issue[];
}
declare function parseArenaText(text: string): RawDeck;

interface Entry {
    qty: number;
    name: string;
    oracleId: string;
    set?: string;
    collectorNumber?: string;
}
/** The public, JSON-serializable deck shape returned by parse_decklist. */
interface Deck {
    name?: string;
    format?: string;
    commander?: Entry;
    companion?: Entry;
    main: Entry[];
    side: Entry[];
    unresolved: Issue[];
}
interface ResolvedEntry extends Entry {
    card: CardRecord;
}
/** A deck with each entry's card record attached, for analysis. */
interface ResolvedDeck {
    name?: string;
    format?: string;
    commander?: ResolvedEntry;
    companion?: ResolvedEntry;
    main: ResolvedEntry[];
    side: ResolvedEntry[];
    unresolved: Issue[];
}
/** Optional network fallback: returns an oracle ID for a misspelled name, or undefined. */
type FuzzyLookup = (name: string) => Promise<string | undefined>;
declare function resolveDeck(raw: RawDeck, index: CardIndex, fuzzy?: FuzzyLookup, knownIds?: Map<RawEntry, string>): Promise<ResolvedDeck>;
declare function parseAndResolve(text: string, index: CardIndex, fuzzy?: FuzzyLookup): Promise<ResolvedDeck>;
/** Strips card records for JSON output. */
declare function toPublicDeck(d: ResolvedDeck): Deck;
/** Rebuilds a raw deck from a Deck object (e.g. one returned by parse_decklist). */
declare function rawFromDeck(d: {
    name?: string;
    commander?: {
        qty?: number;
        name: string;
        oracleId?: string;
    };
    companion?: {
        qty?: number;
        name: string;
        oracleId?: string;
    };
    main: {
        qty: number;
        name: string;
        oracleId?: string;
    }[];
    side?: {
        qty: number;
        name: string;
        oracleId?: string;
    }[];
}): {
    raw: RawDeck;
    ids: Map<RawEntry, string>;
};
/** Every entry with its zone, commander first. */
declare function allEntries(d: ResolvedDeck): {
    zone: 'commander' | 'companion' | 'main' | 'side';
    e: ResolvedEntry;
}[];
/** Main deck plus commander: the cards you play with. */
declare function playEntries(d: ResolvedDeck): ResolvedEntry[];
declare function countCards(entries: {
    qty: number;
}[]): number;

interface FormatRules {
    id: string;
    label: string;
    /** Key in Scryfall's `legalities` object. */
    legalityKey: string;
    /** Minimum main-deck size (commander included for Brawl). */
    minDeck: number;
    /** Exact deck size, when the format requires one. */
    exactDeck?: number;
    maxCopies: number;
    maxSideboard: number;
    commander: boolean;
}
/**
 * Arena constructed formats. Alchemy is intentionally unsupported. Arena's Explorer
 * format became Pioneer, and Scryfall no longer has an `explorer` key, so `explorer` is
 * kept only as an alias.
 */
declare const FORMATS: Record<string, FormatRules>;
declare const FORMAT_NAMES: string[];
declare function getFormat(name: string): FormatRules;

interface ValidationIssue {
    severity: 'error' | 'warning';
    code: string;
    message: string;
    card?: string;
}
interface ValidationResult {
    legal: boolean;
    format: string;
    mainCount: number;
    sideCount: number;
    issues: ValidationIssue[];
}
declare function canBeCommander(c: CardRecord): boolean;
declare function validateDeck(deck: ResolvedDeck, fmt: FormatRules): ValidationResult;

type Role = 'removal' | 'counterspell' | 'sweeper' | 'card_draw' | 'ramp' | 'tutor' | 'threat' | 'protection' | 'lifegain';
declare const ROLES: Role[];
declare const INTERACTION_ROLES: Role[];
interface Rule$1 {
    role: Role;
    id: string;
    /** Matched against lowercased rules text with reminder text removed. */
    pattern?: RegExp;
    test?: (c: CardRecord) => boolean;
}
/**
 * Oracle-text heuristics for card roles. Each match is reported with its rule ID so users
 * can audit (and dispute) a tag. Order doesn't matter; a card can have several roles.
 */
declare const RULES: Rule$1[];
interface RoleTag {
    role: Role;
    rule: string;
}
declare function tagRoles(c: CardRecord): RoleTag[];
declare function hasRole(c: CardRecord, role: Role): boolean;
declare function isInteraction(c: CardRecord): boolean;

declare const tiers: z.ZodArray<z.ZodObject<{
    tier: z.ZodNumber;
    label: z.ZodString;
    min: z.ZodNumber;
}, z.core.$strip>>;
declare const karsten: z.ZodObject<{
    deckSize: z.ZodNumber;
    table: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodNumber>>;
}, z.core.$strip>;
declare const constructedRubricSchema: z.ZodObject<{
    name: z.ZodString;
    tiers: z.ZodArray<z.ZodObject<{
        tier: z.ZodNumber;
        label: z.ZodString;
        min: z.ZodNumber;
    }, z.core.$strip>>;
    weights: z.ZodObject<{
        manaBase: z.ZodNumber;
        speed: z.ZodNumber;
        interaction: z.ZodNumber;
        cardQuality: z.ZodNumber;
        consistency: z.ZodNumber;
    }, z.core.$strip>;
    karsten: z.ZodObject<{
        deckSize: z.ZodNumber;
        table: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodNumber>>;
    }, z.core.$strip>;
    archetypes: z.ZodObject<{
        aggro: z.ZodObject<{
            avgMv: z.ZodNumber;
            lowDropShare: z.ZodNumber;
            lands: z.ZodNumber;
            interaction: z.ZodNumber;
            maxTopEnd: z.ZodNumber;
        }, z.core.$strip>;
        midrange: z.ZodObject<{
            avgMv: z.ZodNumber;
            lowDropShare: z.ZodNumber;
            lands: z.ZodNumber;
            interaction: z.ZodNumber;
            maxTopEnd: z.ZodNumber;
        }, z.core.$strip>;
        control: z.ZodObject<{
            avgMv: z.ZodNumber;
            lowDropShare: z.ZodNumber;
            lands: z.ZodNumber;
            interaction: z.ZodNumber;
            maxTopEnd: z.ZodNumber;
        }, z.core.$strip>;
        ramp: z.ZodObject<{
            avgMv: z.ZodNumber;
            lowDropShare: z.ZodNumber;
            lands: z.ZodNumber;
            interaction: z.ZodNumber;
            maxTopEnd: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    inference: z.ZodObject<{
        ramp: z.ZodObject<{
            minRamp: z.ZodNumber;
        }, z.core.$strip>;
        control: z.ZodObject<{
            minInteraction: z.ZodNumber;
            maxCreatures: z.ZodNumber;
        }, z.core.$strip>;
        aggro: z.ZodObject<{
            maxAvgMv: z.ZodNumber;
            minCreatures: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    manaBase: z.ZodObject<{
        coverageWeight: z.ZodNumber;
        landCountWeight: z.ZodNumber;
        tappedWeight: z.ZodNumber;
        shortfallPenalty: z.ZodNumber;
        landTolerance: z.ZodNumber;
        pointsPerLandOff: z.ZodNumber;
        freeTappedLands: z.ZodNumber;
        pointsPerTappedLand: z.ZodNumber;
    }, z.core.$strip>;
    speed: z.ZodObject<{
        avgMvWeight: z.ZodNumber;
        lowDropWeight: z.ZodNumber;
        topEndWeight: z.ZodNumber;
        pointsPerMvOver: z.ZodNumber;
        pointsPerExtraTopEnd: z.ZodNumber;
    }, z.core.$strip>;
    interaction: z.ZodObject<{
        volumeWeight: z.ZodNumber;
        cheapWeight: z.ZodNumber;
        cheapMaxMv: z.ZodNumber;
    }, z.core.$strip>;
    cardQuality: z.ZodObject<{
        meta: z.ZodObject<{
            inMetaBase: z.ZodNumber;
            inMetaRateBonus: z.ZodNumber;
        }, z.core.$strip>;
        heuristic: z.ZodObject<{
            popularityWeight: z.ZodNumber;
            rarityWeight: z.ZodNumber;
            recencyWeight: z.ZodNumber;
            popularityBest: z.ZodNumber;
            popularityWorst: z.ZodNumber;
            recencyFullYears: z.ZodNumber;
            recencyZeroYears: z.ZodNumber;
            rarityValue: z.ZodObject<{
                common: z.ZodNumber;
                uncommon: z.ZodNumber;
                rare: z.ZodNumber;
                mythic: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    consistency: z.ZodObject<{
        simulationWeight: z.ZodNumber;
        structureWeight: z.ZodNumber;
        keepableTarget: z.ZodNumber;
        landDropTarget: z.ZodNumber;
        colorTarget: z.ZodNumber;
        fourOfTarget: z.ZodNumber;
        freeSingletons: z.ZodNumber;
        pointsPerSingleton: z.ZodNumber;
        simulationIterations: z.ZodNumber;
        simulationSeed: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
declare const brawlRubricSchema: z.ZodObject<{
    name: z.ZodString;
    tiers: z.ZodArray<z.ZodObject<{
        tier: z.ZodNumber;
        label: z.ZodString;
        min: z.ZodNumber;
    }, z.core.$strip>>;
    weights: z.ZodObject<{
        manaBase: z.ZodNumber;
        commanderSynergy: z.ZodNumber;
        ramp: z.ZodNumber;
        cardDraw: z.ZodNumber;
        interaction: z.ZodNumber;
        cardQuality: z.ZodNumber;
    }, z.core.$strip>;
    karsten: z.ZodObject<{
        deckSize: z.ZodNumber;
        table: z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodNumber>>;
    }, z.core.$strip>;
    targetsPer100: z.ZodObject<{
        lands: z.ZodNumber;
        ramp: z.ZodNumber;
        cardDraw: z.ZodNumber;
        interaction: z.ZodNumber;
    }, z.core.$strip>;
    manaBase: z.ZodObject<{
        coverageWeight: z.ZodNumber;
        landCountWeight: z.ZodNumber;
        tappedWeight: z.ZodNumber;
        shortfallPenalty: z.ZodNumber;
        landTolerance: z.ZodNumber;
        pointsPerLandOff: z.ZodNumber;
        freeTappedLands: z.ZodNumber;
        pointsPerTappedLand: z.ZodNumber;
    }, z.core.$strip>;
    interaction: z.ZodObject<{
        volumeWeight: z.ZodNumber;
        cheapWeight: z.ZodNumber;
        cheapMaxMv: z.ZodNumber;
    }, z.core.$strip>;
    commanderSynergy: z.ZodObject<{
        targetShare: z.ZodNumber;
        targetRecommendedShare: z.ZodNumber;
        themes: z.ZodRecord<z.ZodString, z.ZodString>;
    }, z.core.$strip>;
    cardQuality: z.ZodObject<{
        meta: z.ZodObject<{
            inMetaBase: z.ZodNumber;
            inMetaRateBonus: z.ZodNumber;
        }, z.core.$strip>;
        heuristic: z.ZodObject<{
            popularityWeight: z.ZodNumber;
            rarityWeight: z.ZodNumber;
            recencyWeight: z.ZodNumber;
            popularityBest: z.ZodNumber;
            popularityWorst: z.ZodNumber;
            recencyFullYears: z.ZodNumber;
            recencyZeroYears: z.ZodNumber;
            rarityValue: z.ZodObject<{
                common: z.ZodNumber;
                uncommon: z.ZodNumber;
                rare: z.ZodNumber;
                mythic: z.ZodNumber;
            }, z.core.$strip>;
        }, z.core.$strip>;
    }, z.core.$strip>;
}, z.core.$strip>;
type ConstructedRubric = z.infer<typeof constructedRubricSchema>;
type BrawlRubric = z.infer<typeof brawlRubricSchema>;
type KarstenTable = z.infer<typeof karsten>;
type Archetype = keyof ConstructedRubric['archetypes'];
/**
 * Where rubric JSON comes from. The defaults are the package's own rubric/ files, bundled
 * at build time, so this module needs no file system. The MCP server swaps in a source
 * that prefers <config dir>/rubric/ overrides (see data/rubricFiles.ts); a browser app can
 * pass rubric objects it loaded itself.
 */
interface RubricSource {
    /** A stable key for caching (e.g. the file path the JSON came from). */
    constructed(): {
        key: string;
        json: unknown;
    };
    brawl(): {
        key: string;
        json: unknown;
    };
}
declare const bundledRubrics: RubricSource;
declare function setRubricSource(next: RubricSource): void;
declare const constructedRubric: () => {
    name: string;
    tiers: {
        tier: number;
        label: string;
        min: number;
    }[];
    weights: {
        manaBase: number;
        speed: number;
        interaction: number;
        cardQuality: number;
        consistency: number;
    };
    karsten: {
        deckSize: number;
        table: Record<string, Record<string, number>>;
    };
    archetypes: {
        aggro: {
            avgMv: number;
            lowDropShare: number;
            lands: number;
            interaction: number;
            maxTopEnd: number;
        };
        midrange: {
            avgMv: number;
            lowDropShare: number;
            lands: number;
            interaction: number;
            maxTopEnd: number;
        };
        control: {
            avgMv: number;
            lowDropShare: number;
            lands: number;
            interaction: number;
            maxTopEnd: number;
        };
        ramp: {
            avgMv: number;
            lowDropShare: number;
            lands: number;
            interaction: number;
            maxTopEnd: number;
        };
    };
    inference: {
        ramp: {
            minRamp: number;
        };
        control: {
            minInteraction: number;
            maxCreatures: number;
        };
        aggro: {
            maxAvgMv: number;
            minCreatures: number;
        };
    };
    manaBase: {
        coverageWeight: number;
        landCountWeight: number;
        tappedWeight: number;
        shortfallPenalty: number;
        landTolerance: number;
        pointsPerLandOff: number;
        freeTappedLands: number;
        pointsPerTappedLand: number;
    };
    speed: {
        avgMvWeight: number;
        lowDropWeight: number;
        topEndWeight: number;
        pointsPerMvOver: number;
        pointsPerExtraTopEnd: number;
    };
    interaction: {
        volumeWeight: number;
        cheapWeight: number;
        cheapMaxMv: number;
    };
    cardQuality: {
        meta: {
            inMetaBase: number;
            inMetaRateBonus: number;
        };
        heuristic: {
            popularityWeight: number;
            rarityWeight: number;
            recencyWeight: number;
            popularityBest: number;
            popularityWorst: number;
            recencyFullYears: number;
            recencyZeroYears: number;
            rarityValue: {
                common: number;
                uncommon: number;
                rare: number;
                mythic: number;
            };
        };
    };
    consistency: {
        simulationWeight: number;
        structureWeight: number;
        keepableTarget: number;
        landDropTarget: number;
        colorTarget: number;
        fourOfTarget: number;
        freeSingletons: number;
        pointsPerSingleton: number;
        simulationIterations: number;
        simulationSeed: number;
    };
};
declare const brawlRubric: () => {
    name: string;
    tiers: {
        tier: number;
        label: string;
        min: number;
    }[];
    weights: {
        manaBase: number;
        commanderSynergy: number;
        ramp: number;
        cardDraw: number;
        interaction: number;
        cardQuality: number;
    };
    karsten: {
        deckSize: number;
        table: Record<string, Record<string, number>>;
    };
    targetsPer100: {
        lands: number;
        ramp: number;
        cardDraw: number;
        interaction: number;
    };
    manaBase: {
        coverageWeight: number;
        landCountWeight: number;
        tappedWeight: number;
        shortfallPenalty: number;
        landTolerance: number;
        pointsPerLandOff: number;
        freeTappedLands: number;
        pointsPerTappedLand: number;
    };
    interaction: {
        volumeWeight: number;
        cheapWeight: number;
        cheapMaxMv: number;
    };
    commanderSynergy: {
        targetShare: number;
        targetRecommendedShare: number;
        themes: Record<string, string>;
    };
    cardQuality: {
        meta: {
            inMetaBase: number;
            inMetaRateBonus: number;
        };
        heuristic: {
            popularityWeight: number;
            rarityWeight: number;
            recencyWeight: number;
            popularityBest: number;
            popularityWorst: number;
            recencyFullYears: number;
            recencyZeroYears: number;
            rarityValue: {
                common: number;
                uncommon: number;
                rare: number;
                mythic: number;
            };
        };
    };
};
/** Sources needed for `pips` colored pips at mana value `mv`, scaled to the deck size. */
declare function karstenSources(table: KarstenTable, pips: number, mv: number, deckSize: number): number;
declare function tierFor(score: number, t: z.infer<typeof tiers>): {
    tier: number;
    label: string;
    min: number;
};

declare const CURVE_BUCKETS: readonly ["0", "1", "2", "3", "4", "5", "6", "7+"];
interface ColorRequirement {
    color: Color;
    pips: number;
    mv: number;
    cards: string[];
    copies: number;
    sourcesNeeded: number;
    sources: number;
    ok: boolean;
}
interface Analysis {
    format: string;
    deckSize: number;
    archetype: Archetype | 'brawl';
    curve: Record<(typeof CURVE_BUCKETS)[number], number>;
    averageManaValue: number;
    landCount: number;
    mdfcLandCount: number;
    nonlandCount: number;
    types: Record<string, number>;
    colors: {
        deckColors: Color[];
        pips: Record<Color, number>;
        sources: Record<Color, number>;
        requirements: ColorRequirement[];
        shortfalls: ColorRequirement[];
    };
    tappedLands: {
        unconditional: number;
        conditional: number;
        cards: {
            name: string;
            qty: number;
            kind: string;
        }[];
    };
    roles: {
        counts: Record<Role, number>;
        cards: {
            name: string;
            qty: number;
            mv: number;
            roles: {
                role: Role;
                rule: string;
            }[];
        }[];
    };
    interaction: {
        total: number;
        cheap: number;
        cheapMaxMv: number;
    };
}
/** Colors a land can make for this deck (fetches count for the basic types the deck runs). */
declare function landColors(c: CardRecord, basicColors: Set<Color>): Color[];
declare function tappedKind(c: CardRecord): 'unconditional' | 'conditional' | null;
declare function inferArchetype(a: {
    averageManaValue: number;
    creatures: number;
    interaction: number;
    ramp: number;
    deckSize: number;
}): Archetype;
declare function analyzeDeck(deck: ResolvedDeck, fmt: FormatRules): Analysis;
declare function round(n: number, digits?: number): number;
declare function entriesWithRole(entries: ResolvedEntry[], role: Role): ResolvedEntry[];

declare function rng(seed: number): () => number;
interface SimCard {
    name: string;
    land: boolean;
    /** Lands: colors produced. */
    produces: Color[];
    mv: number;
    pips: Record<Color, number>;
    roles: Role[];
}
declare function buildLibrary(deck: ResolvedDeck): SimCard[];
/** Can these lands pay the colored pips (each land pays one pip)? Bipartite matching. */
declare function canPay(pips: Record<Color, number>, lands: SimCard[]): boolean;
declare function isKeepable(hand: SimCard[]): boolean;
interface SimCheck {
    card?: string;
    role?: Role;
    byTurn: number;
}
interface SimOptions {
    iterations?: number;
    seed?: number;
    playDraw?: 'play' | 'draw';
    bo1Smoothing?: boolean;
    checks?: SimCheck[];
}
/** Number of candidate opening hands the Bo1 smoother is modeled as choosing between. */
declare const BO1_SMOOTHING_CANDIDATES = 2;
interface SimReport {
    iterations: number;
    seed: number;
    playDraw: 'play' | 'draw';
    bo1Smoothing: boolean;
    librarySize: number;
    lands: number;
    keepable7: number;
    mulliganRate: number;
    keptAt: {
        '7': number;
        '6': number;
        '5': number;
    };
    landDrops: {
        turn2: number;
        turn3: number;
        turn4: number;
        turn5: number;
    };
    colors: {
        card: string;
        mv: number;
        turn: number;
        probability: number;
    }[];
    colorAvailability: number;
    checks: {
        card?: string;
        role?: Role;
        byTurn: number;
        probability: number;
    }[];
    /** Lands in the first 7 (after smoothing, before mulligans): simulated vs exact hypergeometric (unsmoothed). */
    openingLands: {
        lands: number;
        simulated: number;
        exact: number;
    }[];
    notes: string[];
}
declare function simulateHands(deck: ResolvedDeck, opts?: SimOptions): SimReport;
/** P(exactly k successes in n draws from N cards containing K successes). */
declare function hypergeometric(N: number, K: number, n: number, k: number): number;
interface SampleHand {
    seed: number;
    hand: string[];
    nextDraws: string[];
    landsInHand: number;
    keepable: boolean;
}
declare function dealSampleHand(deck: ResolvedDeck, seed: number): SampleHand;

/** One meta decklist as supplied by the client or a local snapshot. */
interface MetaListInput {
    name?: string;
    archetype?: string;
    /** Arena export text. */
    list: string;
    winRate?: number;
    /** Share of the metagame, 0-1 (or 0-100, normalized). */
    metaShare?: number;
}
interface MetaList {
    name: string;
    archetype: string;
    winRate?: number;
    /** Normalized weight; all lists sum to 1. */
    weight: number;
    deck: ResolvedDeck;
    /** Main-deck copies by oracle ID (commander included). */
    main: Map<string, number>;
}
interface MetaContext {
    lists: MetaList[];
    /** Weighted play rate per oracle ID: summed weight of the lists that run it. */
    playRate: Map<string, number>;
    maxNonlandRate: number;
    unresolved: {
        list: string;
        issues: ResolvedDeck['unresolved'];
    }[];
}
declare function buildMeta(inputs: MetaListInput[], index: CardIndex, fuzzy?: FuzzyLookup): Promise<MetaContext>;
declare const snapshotSchema: z.ZodObject<{
    format: z.ZodString;
    date: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
    decks: z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        archetype: z.ZodOptional<z.ZodString>;
        metaShare: z.ZodOptional<z.ZodNumber>;
        winRate: z.ZodOptional<z.ZodNumber>;
        list: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
type MetaSnapshot = z.infer<typeof snapshotSchema>;
/** Validates a parsed snapshot JSON (pure; file reading lives in data/snapshots.ts). */
declare function parseSnapshot(json: unknown, where?: string): MetaSnapshot;
/** Shared nonland copies over the larger nonland count: 1 means the same spells. */
declare function overlap(a: Map<string, {
    qty: number;
}>, b: Map<string, {
    qty: number;
}>): number;
declare function compareToMeta(deck: ResolvedDeck, meta: MetaContext): {
    closest: {
        shareOfSuppliedListsPercent: number;
        winRate?: number | undefined;
        name: string;
        archetype: string;
        overlapPercent: number;
    };
    ranking: {
        name: string;
        archetype: string;
        overlapPercent: number;
    }[];
    missingCore: {
        name: string;
        metaQty: number;
        deckQty: number;
    }[];
    unusual: {
        name: string;
        qty: number;
    }[];
} | null;

interface Recommendation {
    name: string;
    oracleId: string;
    /** Order in the pasted text, from 0. */
    rank: number;
    /** Share of decks running it, 0-1, when the paste says so. */
    inclusion?: number;
    /** EDHREC-style synergy, -1 to 1, when the paste says so. */
    synergy?: number;
}
interface RecommendationList {
    commander?: string;
    source: string;
    cards: Map<string, Recommendation>;
    ignoredLines: number;
}
declare function parseRecommendations(text: string, index: CardIndex, opts?: {
    commander?: string;
    source?: string;
}): RecommendationList;
/**
 * 0 when the card isn't on the list; otherwise 0.6-1, from inclusion and synergy when the
 * paste had them, else from its position in the list.
 */
declare function recommendationScore(recs: RecommendationList, card: CardRecord): number;
declare function describeRecommendation(recs: RecommendationList, card: CardRecord): string | null;
/** How the pasted list lines up with the deck, for reporting. */
declare function recommendationSummary(recs: RecommendationList, deck: ResolvedDeck, index: CardIndex, legalityKey: string): {
    source: string;
    cardsRecognized: number;
    linesIgnored: number;
    alreadyInDeck: number;
    notOnArenaOrNotLegal: number;
    notes: string[];
};

interface Dimension {
    name: string;
    score: number;
    weight: number;
    confidence: 'normal' | 'low';
    reasons: string[];
}
interface PowerRating {
    tier: number;
    label: string;
    score: number;
    rubric: string;
    archetype: string;
    dimensions: Dimension[];
}
/** Summary of simulate_hands used by the consistency dimension. */
interface ConsistencySignals {
    keepable7: number;
    landDropsOnCurve: number;
    /** Turn through which `landDropsOnCurve` was measured. */
    landDropTurn: number;
    colorAvailability: number;
}
interface RateOptions {
    meta?: MetaContext;
    /** Date the card data was taken (YYYY-MM-DD); recency is measured from here, not "now". */
    asOf: string;
    /** Pasted commander recommendations (Brawl). */
    recommendations?: RecommendationList;
    simulation?: ConsistencySignals;
}
declare function ratePower(deck: ResolvedDeck, fmt: FormatRules, opts: RateOptions): PowerRating;
/** 0-1 estimate of a card's strength from EDHREC popularity (log scale), rarity and age. */
declare function heuristicQuality(card: CardRecord, h: ConstructedRubric['cardQuality']['heuristic'], asOf: string): number;

type WildcardCounts = Record<Rarity, number>;
declare const zeroWildcards: () => WildcardCounts;
/** Arena's collection tops out at 4 copies, which also covers "any number" cards. */
declare const ARENA_MAX_COPIES = 4;
interface WildcardReport {
    byRarity: WildcardCounts;
    total: number;
    cards: {
        name: string;
        qty: number;
        rarity: Rarity;
    }[];
    unavailable: string[];
    notes: string[];
}
/**
 * Wildcards needed to craft the deck from nothing: copies across main, sideboard, commander
 * and companion (capped at 4 per card), each at its cheapest Arena rarity. Basic lands are free.
 */
declare function wildcardCost(deck: ResolvedDeck): WildcardReport;

interface CommanderThemes {
    commander: string;
    /** Rubric theme names the commander's text cares about (tokens, sacrifice, …). */
    themes: string[];
    /** Creature types the commander's text names that the deck plays (Goblin, Elf, …). */
    tribes: string[];
    /** The themes and tribes this card supports; empty when it supports none. */
    matches(card: CardRecord): string[];
}
/**
 * What the commander builds around, read from its rules text: the rubric's theme regexes
 * plus any creature type it names. Null when there's no commander or no clear theme.
 */
declare function commanderThemes(deck: ResolvedDeck, themeRegexes: Record<string, string>): CommanderThemes | null;

type Mode = 'casual' | 'competitive';
type Intensity = 'light' | 'normal' | 'heavy';
/**
 * Keeps the deck recognizable: at most `percent` of its cards change, and cuts come only
 * from the weakest `cutPool` share of its nonland cards.
 */
declare const INTENSITY: Record<Intensity, {
    percent: number;
    cutPool: number;
}>;
interface SuggestOptions {
    mode: Mode;
    /** Per-rarity budget; a rarity left out is unlimited. Omit entirely for no budget. */
    wildcards?: Partial<WildcardCounts>;
    maxSwaps?: number;
    /** How much of the deck may change: light (~7%), normal (~15%, default), heavy (~30%). */
    intensity?: Intensity;
    /** Overrides the intensity's cap on changed cards, as a percent of the deck. */
    maxChangePercent?: number;
    keepCards?: string[];
    /** Pasted commander recommendations (e.g. from EDHREC); adds lean toward them. */
    recommendations?: RecommendationList;
    meta?: MetaContext;
    asOf: string;
}
interface Swap {
    cut: string;
    add: string;
    qty: number;
    reason: string;
    wildcardCost: Partial<WildcardCounts>;
}
interface SuggestResult {
    mode: Mode;
    swaps: Swap[];
    totalCost: WildcardCounts;
    budget: Partial<WildcardCounts> | null;
    remaining: Partial<WildcardCounts> | null;
    /** Cards changed versus the cap that keeps the deck recognizable. */
    changes: {
        cards: number;
        limit: number;
        deckSize: number;
        intensity: Intensity;
    };
    /** In Brawl, what every added card had to support. */
    commanderThemes: {
        commander: string;
        themes: string[];
        tribes: string[];
    } | null;
    notes: string[];
}
declare function suggestUpgrades(deck: ResolvedDeck, fmt: FormatRules, index: CardIndex, opts: SuggestOptions): SuggestResult;
/** Can it damage a player directly? */
declare function hasReach(c: CardRecord): boolean;
/**
 * Colors an add may use: the commander's identity in Brawl; otherwise colors that are a
 * real part of the deck (at least 15% of colored spell copies, or 8+ land sources), so a
 * two-card splash doesn't open up a whole new color.
 */
declare function deckIdentity(deck: ResolvedDeck, sources: Record<Color, number>): Set<Color>;

type Pred = (c: CardRecord) => boolean;
declare function compileQuery(query: string): Pred;
type SearchOrder = 'name' | 'mv' | 'edhrec' | 'released';
declare function searchCards(index: CardIndex, query: string, opts?: {
    format?: string;
    limit?: number;
    order?: SearchOrder;
}): {
    total: number;
    cards: CardRecord[];
};

interface Rule {
    number: string;
    text: string;
    examples: string[];
}
interface RulesDoc {
    effective?: string;
    source: string;
    rules: Rule[];
    byNumber: Map<string, Rule>;
    glossary: Map<string, {
        term: string;
        definition: string;
    }>;
}
declare function findRulesTxtUrl(html: string): string | null;
declare function parseRules(text: string, source: string): RulesDoc;
/** A rule plus its subrules (e.g. 702.19 → 702.19a, 702.19b…); a section (702) lists its rules. */
declare function lookupNumber(doc: RulesDoc, number: string, limit?: number): Rule[];
declare function searchRules(doc: RulesDoc, query: string, limit?: number): {
    glossary: {
        term: string;
        definition: string;
    } | null;
    rules: Rule[];
};

export { ARENA_MAX_COPIES, type Analysis, type Archetype, BO1_SMOOTHING_CANDIDATES, type BrawlRubric, COLORS, CURVE_BUCKETS, type CardFace, CardIndex, type CardRecord, type Color, type ColorRequirement, type CommanderThemes, type ConsistencySignals, type ConstructedRubric, type Deck, type Dimension, type Entry, FORMATS, FORMAT_NAMES, type FormatRules, type FuzzyLookup, INTENSITY, INTERACTION_ROLES, type IndexMeta, type Intensity, type Issue, type KarstenTable, type MetaContext, type MetaList, type MetaListInput, type MetaSnapshot, type Mode, type Pips, type PowerRating, RARITIES, ROLES, RULES, type Rarity, type RateOptions, type RawDeck, type RawEntry, type Recommendation, type RecommendationList, type ResolvedDeck, type ResolvedEntry, type Role, type RoleTag, type RubricSource, type Rule, type RulesDoc, type SampleHand, type SearchOrder, type Section, type SimCard, type SimCheck, type SimOptions, type SimReport, type SuggestOptions, type SuggestResult, type Swap, ToolError, type ValidationIssue, type ValidationResult, type WildcardCounts, type WildcardReport, aggregateCards, allEntries, analyzeDeck, asOfDate, brawlRubric, brawlRubricSchema, buildLibrary, buildMeta, bundledRubrics, byNameThenId, canBeCommander, canPay, castingCost, castingMv, commanderThemes, compareToMeta, compileQuery, constructedRubric, constructedRubricSchema, countCards, dealSampleHand, deckIdentity, describeRecommendation, entriesWithRole, findRulesTxtUrl, frontTypeLine, getFormat, hasReach, hasRole, heuristicQuality, hypergeometric, inferArchetype, isBasicLand, isCreature, isInteraction, isKeepable, isLand, isMdfcLand, karstenSources, landColors, levenshtein, lookupNumber, manaValueOf, normalizeName, overlap, parseAndResolve, parseArenaText, parseRecommendations, parseRules, parseSnapshot, pipsOf, playEntries, printedCopyLimit, ratePower, rawFromDeck, recommendationScore, recommendationSummary, resolveDeck, rng, round, rulesText, searchCards, searchRules, setRubricSource, simulateHands, snapshotSchema, suggestUpgrades, summarize, tagRoles, tappedKind, tierFor, toPublicDeck, validateDeck, wildcardCost, wildcardRarity, zeroWildcards };
