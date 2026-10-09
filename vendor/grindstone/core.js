// src/core/types.ts
var RARITIES = ["common", "uncommon", "rare", "mythic"];
var COLORS = ["W", "U", "B", "R", "G"];

// src/core/errors.ts
var ToolError = class extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
  details;
};

// src/core/cards.ts
function normalizeName(name) {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s*\/{1,3}\s*/g, " // ").replace(/\s+/g, " ").trim().toLowerCase();
}
function levenshtein(a, b, limit = Infinity) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}
var CardIndex = class {
  constructor(records, meta) {
    this.records = records;
    this.meta = meta;
    const faceNames = [];
    for (const r of records) {
      this.byOracle.set(r.oracleId, r);
      this.claim(normalizeName(r.name), r);
      for (const f of r.faces) faceNames.push([normalizeName(f.name), r]);
    }
    for (const [key, r] of faceNames) {
      if (!this.byName.has(key)) this.byName.set(key, r);
    }
  }
  records;
  meta;
  byOracle = /* @__PURE__ */ new Map();
  byName = /* @__PURE__ */ new Map();
  claim(key, r) {
    const prev = this.byName.get(key);
    if (!prev || rank(r) < rank(prev)) this.byName.set(key, r);
  }
  lookup(name) {
    return this.byName.get(normalizeName(name));
  }
  /** Up to `n` closest card names, for "did you mean" hints. */
  suggest(name, n = 3) {
    const key = normalizeName(name);
    const limit = Math.max(2, Math.floor(key.length / 4));
    const scored = [];
    for (const r of this.records) {
      if (!r.onArena) continue;
      const d = levenshtein(key, normalizeName(r.name), limit);
      if (d <= limit) scored.push([d, r.name]);
    }
    scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    return [...new Set(scored.map((s) => s[1]))].slice(0, n);
  }
};
function rank(r) {
  const legalSomewhere = Object.values(r.legalities).some((v) => v !== "not_legal");
  return (r.onArena ? 0 : 2) + (legalSomewhere ? 0 : 1);
}
function frontTypeLine(c) {
  return c.faces[0]?.typeLine ?? c.typeLine;
}
function isLand(c) {
  return /\bLand\b/.test(frontTypeLine(c));
}
function isMdfcLand(c) {
  return c.layout === "modal_dfc" && !isLand(c) && /\bLand\b/.test(c.faces[1]?.typeLine ?? "");
}
function isBasicLand(c) {
  return /\bBasic\b/.test(c.typeLine) && /\bLand\b/.test(c.typeLine);
}
function isCreature(c) {
  return /\bCreature\b/.test(frontTypeLine(c));
}
function printedCopyLimit(c) {
  if (/A deck can have any number of cards named/i.test(c.oracleText)) return Infinity;
  const m = /A deck can have up to (\w+) cards named/i.exec(c.oracleText);
  if (m) {
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    return words[m[1].toLowerCase()] ?? Number(m[1]);
  }
  return null;
}
function castingCost(c) {
  const cost = c.faces[0]?.manaCost || c.manaCost;
  return cost.split(" // ")[0] ?? "";
}
function castingMv(c) {
  if (c.faces.length < 2 || c.layout === "transform" || c.layout === "flip" || c.layout === "meld") return c.cmc;
  return manaValueOf(castingCost(c));
}
function manaValueOf(cost) {
  let mv = 0;
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = m[1];
    if (/^\d+$/.test(s)) mv += Number(s);
    else if (s === "X" || s === "Y" || s === "Z") continue;
    else if (/^2\//.test(s)) mv += 2;
    else mv += 1;
  }
  return mv;
}
function pipsOf(cost) {
  const hard = Object.fromEntries(COLORS.map((c) => [c, 0]));
  const hybrid = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const parts = m[1].split("/");
    if (parts.includes("P")) continue;
    const colors = parts.filter((p) => COLORS.includes(p));
    if (colors.length === 1 && parts.length === 1) hard[colors[0]]++;
    else if (colors.length === 1 && parts[0] === "2") hard[colors[0]]++;
    else if (colors.length > 1) hybrid.push(colors);
  }
  return { hard, hybrid };
}
function wildcardRarity(c) {
  return c.arenaRarity ?? c.rarity;
}
function rulesText(c) {
  return c.oracleText.replace(/\([^)]*\)/g, "").toLowerCase();
}
function summarize(c) {
  return {
    name: c.name,
    manaCost: c.manaCost,
    mv: c.cmc,
    type: c.typeLine,
    colorIdentity: c.colorIdentity.join(""),
    rarity: wildcardRarity(c),
    onArena: c.onArena,
    text: c.oracleText
  };
}
function asOfDate(index) {
  for (const candidate of [index.meta.snapshot, index.meta.builtAt]) {
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return "2026-01-01";
}

// src/core/aggregate.ts
var SKIP_LAYOUTS = /* @__PURE__ */ new Set([
  "token",
  "double_faced_token",
  "emblem",
  "art_series",
  "planar",
  "scheme",
  "vanguard",
  "reversible_card"
]);
var RARITY_MAP = {
  common: "common",
  uncommon: "uncommon",
  rare: "rare",
  mythic: "mythic",
  special: "rare",
  bonus: "rare"
};
function lowerRarity(a, b) {
  if (a === null) return b;
  return RARITIES.indexOf(b) < RARITIES.indexOf(a) ? b : a;
}
function colorsOf(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return COLORS.filter((c) => set.has(c));
}
function faceOf(f) {
  return {
    name: f.name,
    manaCost: f.mana_cost ?? "",
    typeLine: f.type_line ?? "",
    oracleText: f.oracle_text ?? "",
    ...f.power !== void 0 ? { power: f.power, toughness: f.toughness } : {}
  };
}
function fromPrinting(c) {
  const faces = Array.isArray(c.card_faces) ? c.card_faces.map(faceOf) : [];
  const front = faces[0];
  const faceColors = faces.length ? colorsOf(c.card_faces.flatMap((f) => f.colors ?? [])) : [];
  const pt = c.power !== void 0 ? { power: c.power, toughness: c.toughness } : front?.power !== void 0 ? { power: front.power, toughness: front.toughness } : {};
  return {
    oracleId: c.oracle_id,
    name: c.name,
    layout: c.layout,
    manaCost: c.mana_cost ?? front?.manaCost ?? "",
    cmc: typeof c.cmc === "number" ? c.cmc : 0,
    typeLine: c.type_line ?? faces.map((f) => f.typeLine).join(" // "),
    oracleText: c.oracle_text ?? faces.map((f) => f.oracleText).join("\n//\n"),
    faces,
    colors: c.colors ? colorsOf(c.colors) : faceColors,
    colorIdentity: colorsOf(c.color_identity),
    producedMana: Array.isArray(c.produced_mana) ? [...c.produced_mana].sort() : [],
    keywords: Array.isArray(c.keywords) ? [...c.keywords].sort() : [],
    legalities: c.legalities ?? {},
    ...pt,
    rarity: RARITY_MAP[c.rarity] ?? "rare",
    arenaRarity: null,
    onArena: false,
    arenaIds: [],
    releasedAt: c.released_at,
    latestReleasedAt: c.released_at,
    edhrecRank: null,
    gameChanger: Boolean(c.game_changer)
  };
}
async function aggregateCards(lines) {
  const byOracle = /* @__PURE__ */ new Map();
  const latestAny = /* @__PURE__ */ new Map();
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/, "");
    if (!line || line === "[" || line === "]") continue;
    const c = JSON.parse(line);
    if (!c.oracle_id || SKIP_LAYOUTS.has(c.layout)) continue;
    if (c.set_type === "memorabilia" || c.set_type === "token") continue;
    let rec = byOracle.get(c.oracle_id);
    if (!rec) {
      rec = fromPrinting(c);
      byOracle.set(c.oracle_id, rec);
    }
    const rarity = RARITY_MAP[c.rarity] ?? "rare";
    rec.rarity = lowerRarity(rec.rarity, rarity);
    if (c.released_at < rec.releasedAt) rec.releasedAt = c.released_at;
    if (c.released_at > (latestAny.get(c.oracle_id) ?? "")) latestAny.set(c.oracle_id, c.released_at);
    if (typeof c.edhrec_rank === "number") {
      rec.edhrecRank = rec.edhrecRank === null ? c.edhrec_rank : Math.min(rec.edhrecRank, c.edhrec_rank);
    }
    const games = c.games ?? [];
    if (games.includes("arena")) {
      if (!rec.onArena || c.released_at > rec.latestReleasedAt) rec.latestReleasedAt = c.released_at;
      rec.onArena = true;
      rec.arenaRarity = lowerRarity(rec.arenaRarity, rarity);
      if (typeof c.arena_id === "number" && !rec.arenaIds.includes(c.arena_id)) rec.arenaIds.push(c.arena_id);
    }
  }
  const out = [...byOracle.values()];
  for (const rec of out) {
    rec.arenaIds.sort((a, b) => a - b);
    if (!rec.onArena) rec.latestReleasedAt = latestAny.get(rec.oracleId) ?? rec.releasedAt;
  }
  return out.sort(byNameThenId);
}
function byNameThenId(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0;
}

// src/core/parse.ts
var HEADERS = {
  commander: "commander",
  companion: "companion",
  deck: "main",
  main: "main",
  mainboard: "main",
  sideboard: "side",
  side: "side",
  about: "about",
  maybeboard: "ignore"
};
var CARD_LINE = /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9_]{2,8})\)(?:\s+(\S+))?)?(?:\s+\*[A-Z]+\*)?\s*$/i;
function parseArenaText(text) {
  const deck = { entries: [], issues: [] };
  let section = "main";
  let mainHasCards = false;
  let blankAfterMain = false;
  let switchedOnBlank = false;
  const body = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line) {
      if (section === "main" && mainHasCards) blankAfterMain = true;
      return;
    }
    if (line.startsWith("//") || line.startsWith("#")) return;
    const header = HEADERS[line.replace(/:$/, "").trim().toLowerCase()];
    if (header) {
      section = header;
      blankAfterMain = false;
      return;
    }
    if (section === "about") {
      const m2 = /^name\s+(.+)$/i.exec(line);
      if (m2) deck.name = m2[1].trim();
      return;
    }
    if (section === "ignore") return;
    if (section === "main" && blankAfterMain && !switchedOnBlank && !headerFollows(lines, i, "sideboard")) {
      section = "side";
      switchedOnBlank = true;
    }
    blankAfterMain = false;
    const m = CARD_LINE.exec(line);
    if (!m) {
      deck.issues.push({ code: "unparsed_line", reason: 'Expected "<qty> <card name> [(SET) number]".', line: lineNo, text: line });
      return;
    }
    const qty = Number(m[1]);
    if (qty < 1) {
      deck.issues.push({ code: "bad_quantity", reason: "Quantity must be at least 1.", line: lineNo, text: line });
      return;
    }
    deck.entries.push({
      qty,
      name: m[2].trim(),
      ...m[3] ? { set: m[3].toUpperCase() } : {},
      ...m[4] ? { collectorNumber: m[4] } : {},
      section,
      line: lineNo
    });
    if (section === "main") mainHasCards = true;
  });
  return deck;
}
function headerFollows(lines, from, header) {
  for (let j = from; j < lines.length; j++) {
    if (lines[j].trim().replace(/:$/, "").toLowerCase() === header) return true;
  }
  return false;
}

// src/core/deck.ts
async function resolveDeck(raw, index, fuzzy, knownIds) {
  const deck = { main: [], side: [], unresolved: [...raw.issues] };
  if (raw.name) deck.name = raw.name;
  const zones = { commander: [], companion: [], main: deck.main, side: deck.side };
  for (const e of raw.entries) {
    const known = knownIds?.get(e);
    const card = known && index.byOracle.get(known) || await resolveName(e, index, fuzzy, deck.unresolved);
    if (!card) continue;
    const zone = zones[e.section];
    const existing = zone.find((x) => x.oracleId === card.oracleId);
    if (existing) {
      existing.qty += e.qty;
      continue;
    }
    zone.push({
      qty: e.qty,
      name: card.name,
      oracleId: card.oracleId,
      ...e.set ? { set: e.set } : {},
      ...e.collectorNumber ? { collectorNumber: e.collectorNumber } : {},
      card
    });
  }
  const [commander, ...extraCommanders] = zones.commander;
  if (commander) deck.commander = { ...commander, qty: 1 };
  for (const c of extraCommanders) {
    deck.unresolved.push({ code: "extra_commander", reason: "Only one commander is supported.", text: c.name });
  }
  const [companion, ...extraCompanions] = zones.companion;
  if (companion) deck.companion = { ...companion, qty: 1 };
  for (const c of extraCompanions) {
    deck.unresolved.push({ code: "extra_companion", reason: "A deck can have only one companion.", text: c.name });
  }
  return deck;
}
async function resolveName(e, index, fuzzy, issues) {
  const where = { line: e.line, text: `${e.qty} ${e.name}` };
  if (/^A-\S/.test(e.name)) {
    issues.push({ code: "alchemy_card", reason: "Alchemy rebalanced (A-) cards are not supported.", ...where });
    return void 0;
  }
  const hit = index.lookup(e.name);
  if (hit) return hit;
  if (fuzzy) {
    const id = await fuzzy(e.name).catch(() => void 0);
    const card = id ? index.byOracle.get(id) : void 0;
    if (card) return card;
  }
  const suggestions = index.suggest(e.name);
  issues.push({
    code: "unknown_card",
    reason: "No card with this name.",
    ...where,
    ...suggestions.length ? { suggestions } : {}
  });
  return void 0;
}
async function parseAndResolve(text, index, fuzzy) {
  return resolveDeck(parseArenaText(text), index, fuzzy);
}
function toPublicDeck(d) {
  const strip = ({ card: _card, ...e }) => e;
  return {
    ...d.name ? { name: d.name } : {},
    ...d.format ? { format: d.format } : {},
    ...d.commander ? { commander: strip(d.commander) } : {},
    ...d.companion ? { companion: strip(d.companion) } : {},
    main: d.main.map(strip),
    side: d.side.map(strip),
    unresolved: d.unresolved
  };
}
function rawFromDeck(d) {
  const raw = { entries: [], issues: [] };
  if (d.name) raw.name = d.name;
  const ids = /* @__PURE__ */ new Map();
  const add = (e, section) => {
    const entry = { qty: e.qty ?? 1, name: e.name, section, line: 0 };
    raw.entries.push(entry);
    if (e.oracleId) ids.set(entry, e.oracleId);
  };
  if (d.commander) add(d.commander, "commander");
  if (d.companion) add(d.companion, "companion");
  d.main.forEach((e) => add(e, "main"));
  (d.side ?? []).forEach((e) => add(e, "side"));
  return { raw, ids };
}
function allEntries(d) {
  return [
    ...d.commander ? [{ zone: "commander", e: d.commander }] : [],
    ...d.companion ? [{ zone: "companion", e: d.companion }] : [],
    ...d.main.map((e) => ({ zone: "main", e })),
    ...d.side.map((e) => ({ zone: "side", e }))
  ];
}
function playEntries(d) {
  return [...d.commander ? [d.commander] : [], ...d.main];
}
function countCards(entries) {
  return entries.reduce((n, e) => n + e.qty, 0);
}

// src/core/formats.ts
var FORMATS = {
  standard: {
    id: "standard",
    label: "Standard",
    legalityKey: "standard",
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false
  },
  pioneer: {
    id: "pioneer",
    label: "Pioneer",
    legalityKey: "pioneer",
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false
  },
  historic: {
    id: "historic",
    label: "Historic",
    legalityKey: "historic",
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false
  },
  timeless: {
    id: "timeless",
    label: "Timeless",
    legalityKey: "timeless",
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false
  },
  brawl: {
    id: "brawl",
    label: "Brawl",
    legalityKey: "brawl",
    minDeck: 100,
    exactDeck: 100,
    maxCopies: 1,
    maxSideboard: 0,
    commander: true
  },
  standardbrawl: {
    id: "standardbrawl",
    label: "Standard Brawl",
    legalityKey: "standardbrawl",
    minDeck: 60,
    exactDeck: 60,
    maxCopies: 1,
    maxSideboard: 0,
    commander: true
  }
};
var ALIASES = {
  explorer: "pioneer",
  "standard brawl": "standardbrawl",
  "standard-brawl": "standardbrawl",
  "historic brawl": "brawl",
  historicbrawl: "brawl"
};
var FORMAT_NAMES = [...Object.keys(FORMATS), ...Object.keys(ALIASES)];
function getFormat(name) {
  const key = name.trim().toLowerCase();
  if (key === "alchemy") {
    throw new ToolError("unsupported_format", { format: name, reason: "Alchemy is not supported." });
  }
  const f = FORMATS[ALIASES[key] ?? key];
  if (!f) throw new ToolError("unknown_format", { format: name, supported: Object.keys(FORMATS) });
  return f;
}

// src/core/validate.ts
function canBeCommander(c) {
  const t = frontTypeLine(c);
  return /\bLegendary\b/.test(t) && /\b(Creature|Planeswalker)\b/.test(t) || /can be your commander/i.test(c.oracleText);
}
function validateDeck(deck, fmt) {
  const issues = [];
  const err = (code, message, card) => issues.push({ severity: "error", code, message, ...card ? { card } : {} });
  const warn = (code, message, card) => issues.push({ severity: "warning", code, message, ...card ? { card } : {} });
  for (const u of deck.unresolved) {
    err("unresolved", `Could not resolve "${u.text ?? ""}": ${u.reason}`);
  }
  const mainCount = countCards(playEntries(deck));
  const sideCount = countCards(deck.side);
  if (fmt.exactDeck !== void 0 && mainCount !== fmt.exactDeck) {
    err("deck_size", `${fmt.label} decks must have exactly ${fmt.exactDeck} cards including the commander; this one has ${mainCount}.`);
  } else if (mainCount < fmt.minDeck) {
    err("deck_size", `${fmt.label} decks need at least ${fmt.minDeck} cards; this one has ${mainCount}.`);
  }
  if (fmt.maxSideboard === 0 && sideCount > 0) {
    warn("sideboard_ignored", `${fmt.label} has no sideboard; ${sideCount} sideboard card(s) are ignored.`);
  } else if (sideCount > fmt.maxSideboard) {
    err("sideboard_size", `Sideboards are limited to ${fmt.maxSideboard} cards; this one has ${sideCount}.`);
  }
  if (fmt.commander) {
    const cmd = deck.commander;
    if (!cmd) {
      err("no_commander", `${fmt.label} decks need a commander (a "Commander" section in the export).`);
    } else {
      if (!canBeCommander(cmd.card)) err("bad_commander", `${cmd.name} can't be a commander.`, cmd.name);
      const identity = new Set(cmd.card.colorIdentity);
      for (const e of deck.main) {
        const outside = e.card.colorIdentity.filter((c) => !identity.has(c));
        if (outside.length) {
          err("color_identity", `${e.name} has ${outside.join("")} in its color identity, outside ${cmd.name}'s.`, e.name);
        }
      }
    }
  } else if (deck.commander) {
    warn("commander_ignored", `${fmt.label} doesn't use a commander; ${deck.commander.name} is counted in the main deck.`);
  }
  if (deck.companion && !fmt.commander && !deck.side.some((e) => e.oracleId === deck.companion.oracleId)) {
    warn("companion_not_in_sideboard", `On Arena the companion also sits in the sideboard; add ${deck.companion.name} there.`);
  }
  const totals = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  for (const { zone, e } of allEntries(deck)) {
    if (zone === "companion") {
      if (!seen.has(e.oracleId)) checkCard(e.card);
      seen.add(e.oracleId);
      continue;
    }
    if (zone === "side" && fmt.maxSideboard === 0) continue;
    const t = totals.get(e.oracleId) ?? { qty: 0, card: e.card };
    t.qty += e.qty;
    totals.set(e.oracleId, t);
    if (!seen.has(e.oracleId)) checkCard(e.card);
    seen.add(e.oracleId);
  }
  function checkCard(card) {
    const status = card.legalities[fmt.legalityKey] ?? "not_legal";
    if (status === "banned") err("banned", `${card.name} is banned in ${fmt.label}.`, card.name);
    else if (status === "not_legal") err("not_legal", `${card.name} is not legal in ${fmt.label}.`, card.name);
    if (!card.onArena) err("not_on_arena", `${card.name} is not available on MTG Arena.`, card.name);
  }
  for (const { qty, card } of totals.values()) {
    const printed = printedCopyLimit(card);
    const restricted = card.legalities[fmt.legalityKey] === "restricted";
    const limit = restricted ? 1 : isBasicLand(card) ? Infinity : printed ?? fmt.maxCopies;
    if (qty > limit) {
      const why = restricted ? "restricted" : fmt.maxCopies === 1 && printed === null ? "singleton" : `limit ${limit}`;
      err("too_many_copies", `${qty} copies of ${card.name} (${why}; max ${limit}).`, card.name);
    }
  }
  return { legal: !issues.some((i) => i.severity === "error"), format: fmt.id, mainCount, sideCount, issues };
}

// src/core/roles.ts
var ROLES = [
  "removal",
  "counterspell",
  "sweeper",
  "card_draw",
  "ramp",
  "tutor",
  "threat",
  "protection",
  "lifegain"
];
var INTERACTION_ROLES = ["removal", "counterspell", "sweeper"];
var TARGET_THING = "(?:target|up to (?:one|two) target) (?:\\w+ )?(?:creature|permanent|nonland permanent|planeswalker|battle|artifact or creature|creature or planeswalker)";
var RULES = [
  { role: "removal", id: "destroy-target", pattern: new RegExp(`destroy ${TARGET_THING}`) },
  { role: "removal", id: "exile-target", pattern: new RegExp(`exile ${TARGET_THING}`) },
  {
    role: "removal",
    id: "damage-target",
    pattern: /deals? (?:\d+|x|that much) damage to (?:any target|target (?:\w+ )?(?:creature|planeswalker)|up to one target creature)/
  },
  { role: "removal", id: "bite", pattern: /deals? damage equal to (?:its|their|that creature's) power to (?:any other target|target creature|another target)/ },
  { role: "removal", id: "fight", pattern: /fights? (?:target|up to one target|another target) creature/ },
  { role: "removal", id: "minus-toughness", pattern: /target creature (?:an opponent controls )?gets -\d+\/-\d+/ },
  { role: "removal", id: "edict", pattern: /(?:target|each) opponent sacrifices (?:a|an) (?:creature|nontoken creature|attacking creature|permanent)/ },
  { role: "removal", id: "bounce", pattern: /return target (?:creature|nonland permanent)[^.]* to its owner's hand/ },
  {
    role: "removal",
    id: "aura-lockdown",
    pattern: /enchanted creature can't attack or block|enchanted creature can't attack, block/
  },
  { role: "counterspell", id: "counter-target", pattern: /counter target (?:\w+ )*?spell/ },
  {
    role: "sweeper",
    id: "destroy-all",
    pattern: /(?:destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents|artifacts|enchantments)/
  },
  { role: "sweeper", id: "damage-each", pattern: /deals? \d+ damage to each (?:creature|other creature|opponent and each creature)/ },
  { role: "sweeper", id: "all-minus", pattern: /(?:all|each) (?:other )?creatures? (?:your opponents control )?gets? -\d+\/-\d+/ },
  { role: "sweeper", id: "each-sacrifices", pattern: /each player sacrifices (?:all|a) creatures?/ },
  {
    role: "card_draw",
    id: "draw-cards",
    // "draw", not "draws": "you draw" / "Draw a card", never "whenever an opponent draws a card".
    pattern: /\bdraw (?:a|an additional|two|three|four|x|that many) cards?/
  },
  { role: "card_draw", id: "impulse", pattern: /exile the top (?:card|two cards|three cards)[^.]*\. (?:until|you may play|you may cast)/ },
  { role: "card_draw", id: "investigate", pattern: /\binvestigate\b|create (?:a|two) clue tokens?/ },
  { role: "ramp", id: "add-mana", test: (c) => !isLand(c) && /\{t\}(?:, [^:]*)?: add \{|add \{[wubrgc]\}|add one mana/.test(rulesText(c)) },
  {
    role: "ramp",
    id: "land-search",
    pattern: /search your library for (?:a|up to (?:one|two)) (?:basic )?(?:land|forest|plains|island|swamp|mountain)[^.]*onto the battlefield/
  },
  { role: "ramp", id: "extra-land", pattern: /put a land card from your hand onto the battlefield|play an additional land/ },
  { role: "ramp", id: "treasure", test: (c) => !isLand(c) && /create (?:a|two|three|x) (?:tapped )?treasure tokens?/.test(rulesText(c)) },
  {
    role: "tutor",
    id: "search-card",
    pattern: /search your library for (?:a|an) (?!basic land|land|forest|plains|island|swamp|mountain)(?:[\w-]+ )*?card/
  },
  {
    role: "threat",
    id: "creature-power",
    test: (c) => isCreature(c) && (Number(c.power) >= 2 || /\b(?:haste|flying|trample|double strike|prowess)\b/.test(rulesText(c)))
  },
  { role: "threat", id: "planeswalker", test: (c) => /\bPlaneswalker\b/.test(frontTypeLine(c)) },
  { role: "threat", id: "vehicle-or-manland", pattern: /becomes? an? \d+\/\d+[^.]*creature|crew \d/ },
  { role: "threat", id: "token-maker", test: (c) => !isCreature(c) && !isLand(c) && /create (?:a|two|three|x) \d+\/\d+[^.]*creature tokens?/.test(rulesText(c)) },
  {
    role: "protection",
    id: "grant-protection",
    pattern: /(?:target creature|creatures you control|target permanent|permanents you control)[^.]*gains? (?:hexproof|indestructible|protection|shroud|ward)/
  },
  { role: "protection", id: "phase-out", pattern: /phases? out/ },
  { role: "lifegain", id: "gain-life", pattern: /you gain (?:\d+|x|that much) life|gain life equal/ },
  { role: "lifegain", id: "lifelink", test: (c) => c.keywords.includes("Lifelink") || /\blifelink\b/.test(rulesText(c)) }
];
var memo = /* @__PURE__ */ new WeakMap();
function tagRoles(c) {
  const hit = memo.get(c);
  if (hit) return hit;
  const text = rulesText(c);
  const tags = [];
  for (const r of RULES) {
    if (tags.some((t) => t.role === r.role)) continue;
    const match = r.test ? r.test(c) : r.pattern.test(text);
    if (match) tags.push({ role: r.role, rule: r.id });
  }
  memo.set(c, tags);
  return tags;
}
function hasRole(c, role) {
  return tagRoles(c).some((t) => t.role === role);
}
function isInteraction(c) {
  return tagRoles(c).some((t) => INTERACTION_ROLES.includes(t.role));
}

// src/core/rubric.ts
import { z } from "zod";

// rubric/brawl-rubric.json
var brawl_rubric_default = {
  name: "Brawl (singleton with commander)",
  notes: "Weights and thresholds for rate_power on Brawl and Standard Brawl. Targets are per 100 cards and scale with deck size (60 for Standard Brawl).",
  tiers: [
    { tier: 1, label: "Jank / Precon", min: 0 },
    { tier: 2, label: "Casual", min: 30 },
    { tier: 3, label: "Focused", min: 50 },
    { tier: 4, label: "Optimized", min: 70 },
    { tier: 5, label: "Competitive", min: 85 }
  ],
  weights: {
    manaBase: 0.15,
    commanderSynergy: 0.2,
    ramp: 0.15,
    cardDraw: 0.15,
    interaction: 0.15,
    cardQuality: 0.2
  },
  karsten: {
    notes: "Approximate colored sources for a 100-card singleton deck, after Frank Karsten's Commander tables. Scaled by deck size for Standard Brawl.",
    deckSize: 100,
    table: {
      "1": { "1": 19, "2": 19, "3": 18, "4": 16, "5": 15, "6": 14 },
      "2": { "2": 30, "3": 28, "4": 26, "5": 24, "6": 23 },
      "3": { "3": 36, "4": 33, "5": 31, "6": 29 },
      "4": { "4": 39, "5": 36, "6": 34 }
    }
  },
  targetsPer100: {
    lands: 38,
    ramp: 10,
    cardDraw: 10,
    interaction: 10
  },
  manaBase: {
    coverageWeight: 0.6,
    landCountWeight: 0.2,
    tappedWeight: 0.2,
    shortfallPenalty: 2,
    landTolerance: 2,
    pointsPerLandOff: 10,
    freeTappedLands: 4,
    pointsPerTappedLand: 8
  },
  interaction: {
    volumeWeight: 0.7,
    cheapWeight: 0.3,
    cheapMaxMv: 2
  },
  commanderSynergy: {
    notes: "Share of nonland cards that share a theme with the commander's rules text (or a creature type it names) needed for full marks. When the user pastes a recommendation list (e.g. from EDHREC), the share of nonland cards on it counts half, against targetRecommendedShare.",
    targetShare: 0.35,
    targetRecommendedShare: 0.4,
    themes: {
      tokens: "create[^.]*token",
      "+1/+1 counters": "\\+1/\\+1 counter",
      spells: "instant or sorcery|noncreature spell",
      artifacts: "\\bartifacts?\\b",
      enchantments: "\\benchantments?\\b",
      lifegain: "gain[^.]* life|lifelink",
      sacrifice: "\\bsacrifices?\\b",
      graveyard: "from (your|a) graveyard",
      attacking: "whenever [^.]*attacks",
      "card draw": "draws? (a|two|three) cards?|whenever you draw",
      landfall: "land you control enters|landfall"
    }
  },
  cardQuality: {
    meta: {
      inMetaBase: 0.75,
      inMetaRateBonus: 0.25
    },
    heuristic: {
      popularityWeight: 0.5,
      rarityWeight: 0.2,
      recencyWeight: 0.3,
      popularityBest: 300,
      popularityWorst: 2e4,
      recencyFullYears: 3,
      recencyZeroYears: 15,
      rarityValue: { common: 0.35, uncommon: 0.6, rare: 0.9, mythic: 1 }
    }
  }
};

// rubric/power-rubric.json
var power_rubric_default = {
  name: "Constructed (60-card)",
  notes: "Weights and thresholds for rate_power on 60-card formats. Every number here is tunable; scores are 0-100 per dimension and the weighted total maps to a tier.",
  tiers: [
    { tier: 1, label: "Jank / Precon", min: 0 },
    { tier: 2, label: "Casual", min: 30 },
    { tier: 3, label: "Focused", min: 50 },
    { tier: 4, label: "Optimized", min: 70 },
    { tier: 5, label: "Competitive", min: 85 }
  ],
  weights: {
    manaBase: 0.2,
    speed: 0.2,
    interaction: 0.15,
    cardQuality: 0.25,
    consistency: 0.2
  },
  karsten: {
    notes: "Colored sources needed to cast a spell on curve about 90% of the time in a 60-card deck, after Frank Karsten's 2022 tables. Keyed by colored pips, then mana value; mana values past the last column use the last column.",
    deckSize: 60,
    table: {
      "1": { "1": 14, "2": 13, "3": 12, "4": 10, "5": 9, "6": 9 },
      "2": { "2": 21, "3": 18, "4": 16, "5": 15, "6": 14 },
      "3": { "3": 23, "4": 21, "5": 19, "6": 18 },
      "4": { "4": 24, "5": 23, "6": 21 }
    }
  },
  archetypes: {
    aggro: { avgMv: 2.1, lowDropShare: 0.55, lands: 21, interaction: 6, maxTopEnd: 2 },
    midrange: { avgMv: 2.8, lowDropShare: 0.35, lands: 24, interaction: 9, maxTopEnd: 5 },
    control: { avgMv: 3, lowDropShare: 0.3, lands: 26, interaction: 13, maxTopEnd: 6 },
    ramp: { avgMv: 3.4, lowDropShare: 0.3, lands: 25, interaction: 6, maxTopEnd: 10 }
  },
  inference: {
    notes: "Checked in order: ramp, control, aggro; anything else is midrange. Counts are card copies in a 60-card deck.",
    ramp: { minRamp: 8 },
    control: { minInteraction: 12, maxCreatures: 12 },
    aggro: { maxAvgMv: 2.4, minCreatures: 14 }
  },
  manaBase: {
    coverageWeight: 0.6,
    landCountWeight: 0.2,
    tappedWeight: 0.2,
    shortfallPenalty: 2,
    landTolerance: 1,
    pointsPerLandOff: 20,
    freeTappedLands: 2,
    pointsPerTappedLand: 12
  },
  speed: {
    avgMvWeight: 0.4,
    lowDropWeight: 0.35,
    topEndWeight: 0.25,
    pointsPerMvOver: 50,
    pointsPerExtraTopEnd: 12
  },
  interaction: {
    volumeWeight: 0.7,
    cheapWeight: 0.3,
    cheapMaxMv: 2
  },
  cardQuality: {
    meta: {
      notes: "A nonland card in any supplied meta list scores inMetaBase + inMetaRateBonus x (its play rate / the top play rate); cards in no list score 0.",
      inMetaBase: 0.75,
      inMetaRateBonus: 0.25
    },
    heuristic: {
      notes: "Used when no meta lists are supplied (low confidence). Popularity uses Scryfall's EDHREC rank on a log scale.",
      popularityWeight: 0.4,
      rarityWeight: 0.3,
      recencyWeight: 0.3,
      popularityBest: 300,
      popularityWorst: 2e4,
      recencyFullYears: 3,
      recencyZeroYears: 15,
      rarityValue: { common: 0.35, uncommon: 0.6, rare: 0.9, mythic: 1 }
    }
  },
  consistency: {
    notes: "Blends the simulate_hands results with deck-construction signals.",
    simulationWeight: 0.6,
    structureWeight: 0.4,
    keepableTarget: 0.88,
    landDropTarget: 0.75,
    colorTarget: 0.9,
    fourOfTarget: 0.6,
    freeSingletons: 4,
    pointsPerSingleton: 5,
    simulationIterations: 4e3,
    simulationSeed: 1
  }
};

// src/core/rubric.ts
var tiers = z.array(z.object({ tier: z.number(), label: z.string(), min: z.number() })).min(1);
var karsten = z.object({
  deckSize: z.number(),
  table: z.record(z.string(), z.record(z.string(), z.number()))
});
var manaBase = z.object({
  coverageWeight: z.number(),
  landCountWeight: z.number(),
  tappedWeight: z.number(),
  shortfallPenalty: z.number(),
  landTolerance: z.number(),
  pointsPerLandOff: z.number(),
  freeTappedLands: z.number(),
  pointsPerTappedLand: z.number()
});
var interaction = z.object({ volumeWeight: z.number(), cheapWeight: z.number(), cheapMaxMv: z.number() });
var cardQuality = z.object({
  meta: z.object({ inMetaBase: z.number(), inMetaRateBonus: z.number() }),
  heuristic: z.object({
    popularityWeight: z.number(),
    rarityWeight: z.number(),
    recencyWeight: z.number(),
    popularityBest: z.number(),
    popularityWorst: z.number(),
    recencyFullYears: z.number(),
    recencyZeroYears: z.number(),
    rarityValue: z.object({ common: z.number(), uncommon: z.number(), rare: z.number(), mythic: z.number() })
  })
});
var archetype = z.object({
  avgMv: z.number(),
  lowDropShare: z.number(),
  lands: z.number(),
  interaction: z.number(),
  maxTopEnd: z.number()
});
var constructedRubricSchema = z.object({
  name: z.string(),
  tiers,
  weights: z.object({
    manaBase: z.number(),
    speed: z.number(),
    interaction: z.number(),
    cardQuality: z.number(),
    consistency: z.number()
  }),
  karsten,
  archetypes: z.object({ aggro: archetype, midrange: archetype, control: archetype, ramp: archetype }),
  inference: z.object({
    ramp: z.object({ minRamp: z.number() }),
    control: z.object({ minInteraction: z.number(), maxCreatures: z.number() }),
    aggro: z.object({ maxAvgMv: z.number(), minCreatures: z.number() })
  }),
  manaBase,
  speed: z.object({
    avgMvWeight: z.number(),
    lowDropWeight: z.number(),
    topEndWeight: z.number(),
    pointsPerMvOver: z.number(),
    pointsPerExtraTopEnd: z.number()
  }),
  interaction,
  cardQuality,
  consistency: z.object({
    simulationWeight: z.number(),
    structureWeight: z.number(),
    keepableTarget: z.number(),
    landDropTarget: z.number(),
    colorTarget: z.number(),
    fourOfTarget: z.number(),
    freeSingletons: z.number(),
    pointsPerSingleton: z.number(),
    simulationIterations: z.number().int().positive(),
    simulationSeed: z.number().int()
  })
});
var brawlRubricSchema = z.object({
  name: z.string(),
  tiers,
  weights: z.object({
    manaBase: z.number(),
    commanderSynergy: z.number(),
    ramp: z.number(),
    cardDraw: z.number(),
    interaction: z.number(),
    cardQuality: z.number()
  }),
  karsten,
  targetsPer100: z.object({ lands: z.number(), ramp: z.number(), cardDraw: z.number(), interaction: z.number() }),
  manaBase,
  interaction,
  commanderSynergy: z.object({ targetShare: z.number(), targetRecommendedShare: z.number(), themes: z.record(z.string(), z.string()) }),
  cardQuality
});
var bundledRubrics = {
  constructed: () => ({ key: "bundled:power-rubric.json", json: power_rubric_default }),
  brawl: () => ({ key: "bundled:brawl-rubric.json", json: brawl_rubric_default })
};
var source = bundledRubrics;
var cache = /* @__PURE__ */ new Map();
function setRubricSource(next) {
  source = next;
  cache.clear();
}
function load(pick, schema) {
  if (cache.has(pick.key)) return cache.get(pick.key);
  const parsed = schema.safeParse(pick.json);
  if (!parsed.success) throw new Error(`Invalid rubric ${pick.key}: ${parsed.error.message}`);
  cache.set(pick.key, parsed.data);
  return parsed.data;
}
var constructedRubric = () => load(source.constructed(), constructedRubricSchema);
var brawlRubric = () => load(source.brawl(), brawlRubricSchema);
function karstenSources(table, pips, mv, deckSize) {
  const keys = Object.keys(table.table).map(Number).sort((a, b) => a - b);
  const p = keys.filter((k) => k <= pips).pop() ?? keys[0];
  const row = table.table[String(p)];
  const cols = Object.keys(row).map(Number).sort((a, b) => a - b);
  const col = cols.filter((c) => c <= Math.max(mv, pips)).pop() ?? cols[0];
  const n = row[String(col)];
  return Math.round(n * deckSize / table.deckSize);
}
function tierFor(score, t) {
  const sorted = [...t].sort((a, b) => b.min - a.min);
  return sorted.find((x) => score >= x.min) ?? sorted[sorted.length - 1];
}

// src/core/analyze.ts
var CURVE_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"];
var TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];
function emptyColors() {
  return { W: 0, U: 0, B: 0, R: 0, G: 0 };
}
function landColors(c, basicColors) {
  const made = new Set(c.producedMana.filter((m) => COLORS.includes(m)));
  const text = rulesText(c);
  const fetch = /search your library for an? ([\w\s,]+?)card/.exec(text);
  if (fetch) {
    const what = fetch[1];
    if (/basic land/.test(what)) basicColors.forEach((col) => made.add(col));
    const typeMap = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G" };
    for (const [word, col] of Object.entries(typeMap)) if (what.includes(word)) made.add(col);
  }
  return COLORS.filter((col) => made.has(col));
}
function tappedKind(c) {
  if (!isLand(c)) return null;
  const text = rulesText(c);
  if (!/enters (?:the battlefield )?tapped/.test(text)) return null;
  if (/unless|if you don't|if you control|you may pay/.test(text)) return "conditional";
  return "unconditional";
}
function inferArchetype(a) {
  const r = constructedRubric().inference;
  const scale = a.deckSize / 60;
  if (a.ramp >= r.ramp.minRamp * scale) return "ramp";
  if (a.interaction >= r.control.minInteraction * scale && a.creatures <= r.control.maxCreatures * scale) return "control";
  if (a.averageManaValue <= r.aggro.maxAvgMv && a.creatures >= r.aggro.minCreatures * scale) return "aggro";
  return "midrange";
}
function analyzeDeck(deck, fmt) {
  const play = playEntries(deck);
  const deckSize = countCards(play);
  const karsten2 = fmt.commander ? brawlRubric().karsten : constructedRubric().karsten;
  const cheapMaxMv = fmt.commander ? brawlRubric().interaction.cheapMaxMv : constructedRubric().interaction.cheapMaxMv;
  const curve = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, 0]));
  const types = Object.fromEntries(TYPES.map((t) => [t.toLowerCase(), 0]));
  let landCount = 0;
  let mdfcLandCount = 0;
  let mvSum = 0;
  let nonland = 0;
  const pips = emptyColors();
  for (const e of play) {
    const t = frontTypeLine(e.card);
    for (const ty of TYPES) if (new RegExp(`\\b${ty}\\b`).test(t)) types[ty.toLowerCase()] += e.qty;
    if (isLand(e.card)) {
      landCount += e.qty;
      continue;
    }
    if (isMdfcLand(e.card)) mdfcLandCount += e.qty;
    const mv = castingMv(e.card);
    curve[mv >= 7 ? "7+" : String(Math.floor(mv))] += e.qty;
    mvSum += mv * e.qty;
    nonland += e.qty;
    const p = pipsOf(castingCost(e.card));
    for (const c of COLORS) pips[c] += p.hard[c] * e.qty;
    for (const h of p.hybrid) for (const c of h) pips[c] += e.qty / h.length;
  }
  const basicColors = /* @__PURE__ */ new Set();
  for (const e of play) {
    if (isBasicLand(e.card)) e.card.producedMana.forEach((m) => COLORS.includes(m) && basicColors.add(m));
  }
  const sources = emptyColors();
  for (const e of play) {
    if (!isLand(e.card) && !isMdfcLand(e.card)) continue;
    for (const c of landColors(e.card, basicColors)) sources[c] += e.qty;
  }
  const patterns = /* @__PURE__ */ new Map();
  for (const e of play) {
    if (isLand(e.card)) continue;
    const p = pipsOf(castingCost(e.card));
    const mv = castingMv(e.card);
    for (const color of COLORS) {
      const n = p.hard[color];
      if (!n) continue;
      const turn = Math.max(mv, n);
      const key = `${color}:${n}:${turn}`;
      const req = patterns.get(key) ?? {
        color,
        pips: n,
        mv: turn,
        cards: [],
        copies: 0,
        sourcesNeeded: karstenSources(karsten2, n, turn, deckSize || karsten2.deckSize),
        sources: sources[color],
        ok: true
      };
      req.cards.push(e.name);
      req.copies += e.qty;
      req.ok = req.sources >= req.sourcesNeeded;
      patterns.set(key, req);
    }
  }
  const requirements = [...patterns.values()].sort(
    (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || b.sourcesNeeded - a.sourcesNeeded || a.mv - b.mv
  );
  const shortfalls = requirements.filter((r) => !r.ok).sort((a, b) => b.sourcesNeeded - b.sources - (a.sourcesNeeded - a.sources) || b.copies - a.copies);
  const tapped = { unconditional: 0, conditional: 0, cards: [] };
  for (const e of play) {
    const kind = tappedKind(e.card);
    if (!kind) continue;
    tapped[kind] += e.qty;
    tapped.cards.push({ name: e.name, qty: e.qty, kind });
  }
  const counts = Object.fromEntries(ROLES.map((r) => [r, 0]));
  const roleCards = [];
  let interaction3 = 0;
  let cheap = 0;
  for (const e of play) {
    if (isLand(e.card)) continue;
    const tags = tagRoles(e.card);
    for (const t of tags) counts[t.role] += e.qty;
    roleCards.push({ name: e.name, qty: e.qty, mv: castingMv(e.card), roles: tags });
    if (tags.some((t) => INTERACTION_ROLES.includes(t.role))) {
      interaction3 += e.qty;
      if (castingMv(e.card) <= cheapMaxMv) cheap += e.qty;
    }
  }
  const averageManaValue = nonland ? round(mvSum / nonland, 2) : 0;
  const creatures = play.filter((e) => isCreature(e.card)).reduce((n, e) => n + e.qty, 0);
  const archetype2 = fmt.commander ? "brawl" : inferArchetype({ averageManaValue, creatures, interaction: interaction3, ramp: counts.ramp, deckSize });
  return {
    format: fmt.id,
    deckSize,
    archetype: archetype2,
    curve,
    averageManaValue,
    landCount,
    mdfcLandCount,
    nonlandCount: nonland,
    types,
    colors: {
      deckColors: COLORS.filter((c) => pips[c] > 0),
      pips: Object.fromEntries(COLORS.map((c) => [c, round(pips[c], 1)])),
      sources,
      requirements,
      shortfalls
    },
    tappedLands: tapped,
    roles: { counts, cards: roleCards },
    interaction: { total: interaction3, cheap, cheapMaxMv }
  };
}
function round(n, digits = 0) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function entriesWithRole(entries, role) {
  return entries.filter((e) => hasRole(e.card, role));
}

// src/core/simulate.ts
function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = s + 2654435769 >>> 0;
    let z3 = s;
    z3 = Math.imul(z3 ^ z3 >>> 16, 2246822507);
    z3 = Math.imul(z3 ^ z3 >>> 13, 3266489909);
    return (z3 ^ z3 >>> 16) >>> 0;
  };
  let a = next();
  let b = next();
  let c = next();
  let d = next();
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = a + b + d >>> 0;
    d = d + 1 >>> 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) >>> 0;
    c = c << 21 | c >>> 11;
    c = c + t >>> 0;
    return t / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildLibrary(deck) {
  const lib = [];
  const basicColors = /* @__PURE__ */ new Set();
  for (const e of playEntries(deck)) {
    if (isBasicLand(e.card)) e.card.producedMana.forEach((m) => COLORS.includes(m) && basicColors.add(m));
  }
  for (const e of deck.main) {
    const land = isLand(e.card) || isMdfcLand(e.card);
    const card = {
      name: e.name,
      land,
      produces: land ? landColors(e.card, basicColors) : [],
      mv: land ? 0 : castingMv(e.card),
      pips: pipsOf(castingCost(e.card)).hard,
      roles: tagRoles(e.card).map((t) => t.role)
    };
    for (let i = 0; i < e.qty; i++) lib.push(card);
  }
  return lib;
}
function canPay(pips, lands) {
  const need = [];
  for (const c of COLORS) for (let i = 0; i < pips[c]; i++) need.push(c);
  if (need.length > lands.length) return false;
  const owner = new Array(lands.length).fill(-1);
  const tryAssign = (p, seen) => {
    for (let l = 0; l < lands.length; l++) {
      if (seen[l] || !lands[l].produces.includes(need[p])) continue;
      seen[l] = true;
      if (owner[l] === -1 || tryAssign(owner[l], seen)) {
        owner[l] = p;
        return true;
      }
    }
    return false;
  };
  return need.every((_, p) => tryAssign(p, new Array(lands.length).fill(false)));
}
function castableBy(card, lands, turn) {
  return card.mv <= turn && lands.length >= card.mv && canPay(card.pips, lands);
}
function isKeepable(hand) {
  const lands = hand.filter((c) => c.land);
  if (lands.length < 2 || lands.length > 5) return false;
  return hand.some((c) => !c.land && c.mv <= 3 && canPay(c.pips, lands));
}
function bottom(hand, n) {
  const kept = [...hand];
  const bottomed = [];
  for (let i = 0; i < n; i++) {
    const lands = kept.filter((c) => c.land).length;
    const spells = kept.filter((c) => !c.land);
    let idx;
    if (lands > 3 || !spells.length) idx = kept.findIndex((c) => c.land);
    else {
      const worst = spells.reduce((a, b) => b.mv > a.mv ? b : a);
      idx = kept.indexOf(worst);
    }
    bottomed.push(...kept.splice(idx, 1));
  }
  return { kept, bottomed };
}
var BO1_SMOOTHING_CANDIDATES = 2;
function simulateHands(deck, opts = {}) {
  const iterations = opts.iterations ?? 1e4;
  const seed = opts.seed ?? 1;
  const playDraw = opts.playDraw ?? "play";
  const smoothing = opts.bo1Smoothing ?? false;
  const checks = opts.checks ?? [];
  const library = buildLibrary(deck);
  const N = library.length;
  const landTotal = library.filter((c) => c.land).length;
  const rand = rng(seed);
  const colored = [...new Map(library.filter((c) => !c.land && COLORS.some((col) => c.pips[col] > 0)).map((c) => [c.name, c])).values()];
  const colorHits = new Array(colored.length).fill(0);
  const checkHits = new Array(checks.length).fill(0);
  const checkNames = checks.map((c) => c.card ? normalizeName(c.card) : null);
  let keepable7 = 0;
  const keptAt = { "7": 0, "6": 0, "5": 0 };
  const landHits = { turn2: 0, turn3: 0, turn4: 0, turn5: 0 };
  const targetLands = landTotal / Math.max(1, N) * 7;
  const openingLandCounts = new Array(8).fill(0);
  const maxTurn = Math.max(7, ...checks.map((c) => c.byTurn), ...colored.map((c) => Math.ceil(c.mv)));
  for (let it = 0; it < iterations; it++) {
    let order = shuffle(library, rand);
    if (smoothing && N >= 7) {
      let bestDiff = Math.abs(order.slice(0, 7).filter((c) => c.land).length - targetLands);
      for (let k = 1; k < BO1_SMOOTHING_CANDIDATES; k++) {
        const alt = shuffle(library, rand);
        const diff = Math.abs(alt.slice(0, 7).filter((c) => c.land).length - targetLands);
        if (diff < bestDiff) {
          order = alt;
          bestDiff = diff;
        }
      }
    }
    let hand = order.slice(0, 7);
    let rest = order.slice(7);
    openingLandCounts[hand.filter((c) => c.land).length]++;
    if (isKeepable(hand)) {
      keepable7++;
      keptAt["7"]++;
    } else {
      let kept = false;
      for (let mull = 1; mull <= 2 && !kept; mull++) {
        order = shuffle(library, rand);
        const { kept: k, bottomed } = bottom(order.slice(0, 7), mull);
        hand = k;
        rest = [...order.slice(7), ...bottomed];
        if (mull === 2 || isKeepable(hand)) {
          kept = true;
          keptAt[String(7 - mull)]++;
        }
      }
    }
    const seenBy = (turn) => [...hand, ...rest.slice(0, playDraw === "play" ? turn - 1 : turn)];
    const seenCache = /* @__PURE__ */ new Map();
    const seen = (turn) => {
      let s = seenCache.get(turn);
      if (!s) {
        const cards = seenBy(Math.min(turn, maxTurn));
        s = { cards, lands: cards.filter((c) => c.land) };
        seenCache.set(turn, s);
      }
      return s;
    };
    for (const t of [2, 3, 4, 5]) if (seen(t).lands.length >= t) landHits[`turn${t}`]++;
    colored.forEach((c, i) => {
      const turn = Math.max(1, Math.ceil(c.mv));
      const lands = seen(turn).lands;
      if (lands.length >= turn && canPay(c.pips, lands)) colorHits[i]++;
    });
    checks.forEach((chk, i) => {
      const s = seen(chk.byTurn);
      const name = checkNames[i];
      const hit = s.cards.some(
        (c) => !c.land && (name ? normalizeName(c.name) === name || normalizeName(c.name.split(" // ")[0]) === name : c.roles.includes(chk.role)) && castableBy(c, s.lands, chk.byTurn)
      );
      if (hit) checkHits[i]++;
    });
  }
  const p = (n) => round(n / iterations, 4);
  const colors = colored.map((c, i) => ({ card: c.name, mv: c.mv, turn: Math.max(1, Math.ceil(c.mv)), probability: p(colorHits[i]) })).sort((a, b) => a.probability - b.probability || (a.card < b.card ? -1 : 1));
  return {
    iterations,
    seed,
    playDraw,
    bo1Smoothing: smoothing,
    librarySize: N,
    lands: landTotal,
    keepable7: p(keepable7),
    mulliganRate: p(iterations - keepable7),
    keptAt: { "7": p(keptAt["7"]), "6": p(keptAt["6"]), "5": p(keptAt["5"]) },
    landDrops: { turn2: p(landHits.turn2), turn3: p(landHits.turn3), turn4: p(landHits.turn4), turn5: p(landHits.turn5) },
    colors,
    colorAvailability: colors.length ? round(colors.reduce((s, c) => s + c.probability, 0) / colors.length, 4) : 1,
    checks: checks.map((c, i) => ({ ...c.card ? { card: c.card } : { role: c.role }, byTurn: c.byTurn, probability: p(checkHits[i]) })),
    openingLands: Array.from({ length: Math.min(7, N) + 1 }, (_, k) => ({
      lands: k,
      simulated: p(openingLandCounts[k]),
      exact: round(hypergeometric(N, landTotal, Math.min(7, N), k), 4)
    })),
    notes: [
      "Keepable: 2-5 lands and a spell of mana value 3 or less that the lands in hand can pay for.",
      "Land drops: P(at least N lands seen by turn N). Colors: P(enough lands of the right colors by the turn matching mana value).",
      ...smoothing ? [
        `Bo1 smoothing is an approximation: Arena's exact algorithm is unpublished. Modeled as choosing, from ${BO1_SMOOTHING_CANDIDATES} candidate opening hands, the one whose land count is closest to the deck's land ratio.`
      ] : []
    ]
  };
}
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}
function hypergeometric(N, K, n, k) {
  const v = logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n);
  return Number.isFinite(v) ? Math.exp(v) : 0;
}
function dealSampleHand(deck, seed) {
  const order = shuffle(buildLibrary(deck), rng(seed));
  const hand = order.slice(0, 7);
  return {
    seed,
    hand: hand.map((c) => c.name),
    nextDraws: order.slice(7, 10).map((c) => c.name),
    landsInHand: hand.filter((c) => c.land).length,
    keepable: isKeepable(hand)
  };
}

// src/core/themes.ts
function subtypes(card) {
  return (frontTypeLine(card).split("\u2014")[1] ?? "").trim().split(/\s+/).filter(Boolean);
}
function commanderThemes(deck, themeRegexes) {
  const cmd = deck.commander;
  if (!cmd) return null;
  const text = rulesText(cmd.card);
  const themes = Object.entries(themeRegexes).filter(([, re]) => new RegExp(re).test(text)).map(([name, re]) => ({ name, re: new RegExp(re) }));
  const deckTypes = new Set(deck.main.filter((e) => !isLand(e.card)).flatMap((e) => subtypes(e.card)));
  const tribes = [...deckTypes].filter((t) => new RegExp(`\\b${t.toLowerCase()}s?\\b`).test(text)).sort();
  if (!themes.length && !tribes.length) return null;
  return {
    commander: cmd.name,
    themes: themes.map((t) => t.name),
    tribes,
    matches(card) {
      const t = rulesText(card);
      const types = subtypes(card);
      return [...themes.filter((x) => x.re.test(t)).map((x) => x.name), ...tribes.filter((tr) => types.includes(tr))];
    }
  };
}

// src/core/power.ts
var COLOR_NAMES = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
var PIP_WORDS = ["zero", "one", "two", "three", "four", "five"];
var clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
var pct = (n) => `${Math.round(n * 100)}%`;
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function ratePower(deck, fmt, opts) {
  const a = analyzeDeck(deck, fmt);
  if (fmt.commander) return rateBrawl(deck, a, brawlRubric(), opts);
  const r = constructedRubric();
  let simulation = opts.simulation;
  if (!simulation && a.deckSize >= 7) {
    const sim = simulateHands(deck, { iterations: r.consistency.simulationIterations, seed: r.consistency.simulationSeed });
    const turn = Math.min(5, Math.max(2, Math.round(a.averageManaValue + 1)));
    simulation = {
      keepable7: sim.keepable7,
      landDropsOnCurve: sim.landDrops[`turn${turn}`],
      landDropTurn: turn,
      colorAvailability: sim.colorAvailability
    };
  }
  return rateConstructed(deck, a, r, { ...opts, simulation });
}
function finish(rubric, archetype2, dims) {
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0) || 1;
  const score = round(dims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight, 1);
  const t = tierFor(score, rubric.tiers);
  return { tier: t.tier, label: t.label, score, rubric: rubric.name, archetype: archetype2, dimensions: dims };
}
function requirementReason(r) {
  const color = COLOR_NAMES[r.color];
  const pip = PIP_WORDS[r.pips] ?? String(r.pips);
  return `Only ${r.sources} ${color} sources for ${plural(r.copies, `${pip}-pip ${color} card`)} at mana value ${r.mv}; Karsten recommends ${r.sourcesNeeded}.`;
}
function manaBase2(a, p, landTarget, weight) {
  const reqs = a.colors.requirements;
  let coverage = 100;
  if (reqs.length) {
    const ratios = reqs.map((r) => ({ ratio: Math.min(1, r.sources / r.sourcesNeeded), copies: r.copies }));
    const copies = ratios.reduce((s, r) => s + r.copies, 0) || 1;
    const mean = ratios.reduce((s, r) => s + r.ratio * r.copies, 0) / copies;
    const worst2 = Math.min(...ratios.map((r) => r.ratio));
    coverage = clamp(100 * (1 - p.shortfallPenalty * (1 - (worst2 + mean) / 2)));
  }
  const lands = a.landCount + a.mdfcLandCount * 0.5;
  const off = Math.max(0, Math.abs(lands - landTarget) - p.landTolerance);
  const landScore = clamp(100 - off * p.pointsPerLandOff);
  const tapped = a.tappedLands.unconditional + a.tappedLands.conditional * 0.25;
  const tappedScore = clamp(100 - Math.max(0, tapped - p.freeTappedLands) * p.pointsPerTappedLand);
  const score = round(coverage * p.coverageWeight + landScore * p.landCountWeight + tappedScore * p.tappedWeight);
  const reasons = [];
  const worst = a.colors.shortfalls[0];
  if (worst) reasons.push(requirementReason(worst));
  else if (reqs.length) reasons.push("Colored sources meet the Karsten targets for every colored card.");
  if (off > 0) {
    reasons.push(
      `${a.landCount} lands${a.mdfcLandCount ? ` (+${a.mdfcLandCount} MDFC)` : ""}; about ${Math.round(landTarget)} is typical for this deck.`
    );
  }
  if (a.tappedLands.unconditional > p.freeTappedLands) {
    reasons.push(`${plural(a.tappedLands.unconditional, "land")} always enter tapped, which costs tempo.`);
  }
  if (!reasons.length) reasons.push(`Land count (${a.landCount}) and tapped lands are in a good range.`);
  return { name: "Mana base", score, weight, confidence: "normal", reasons: reasons.slice(0, 3) };
}
function interaction2(a, p, target, weight) {
  const total = a.interaction.total;
  const volume = target > 0 ? Math.min(1, total / target) : 1;
  const cheapShare = total ? a.interaction.cheap / total : 0;
  const score = round(100 * (p.volumeWeight * volume + p.cheapWeight * cheapShare));
  const reasons = [
    `${plural(total, "interactive spell")} (removal, counters, sweepers); about ${Math.round(target)} suits this deck.`
  ];
  if (total) reasons.push(`${a.interaction.cheap} of them cost ${a.interaction.cheapMaxMv} or less.`);
  const sweepers = a.roles.counts.sweeper;
  if (sweepers) reasons.push(`Includes ${plural(sweepers, "sweeper")}.`);
  return { name: "Interaction", score, weight, confidence: "normal", reasons: reasons.slice(0, 3) };
}
function cardQuality2(deck, p, opts, weight) {
  const spells = playEntries(deck).filter((e) => !isLand(e.card));
  const copies = countCards(spells) || 1;
  const meta = opts.meta;
  if (meta && meta.lists.length) {
    let sum = 0;
    const missing = [];
    for (const e of spells) {
      const rate = meta.playRate.get(e.oracleId) ?? 0;
      if (rate > 0) sum += e.qty * (p.meta.inMetaBase + p.meta.inMetaRateBonus * (rate / (meta.maxNonlandRate || 1)));
      else missing.push(e);
    }
    const inMeta = spells.filter((e) => (meta.playRate.get(e.oracleId) ?? 0) > 0);
    const reasons2 = [
      `${countCards(inMeta)} of ${copies} nonland cards appear in the ${plural(meta.lists.length, "supplied meta list")}.`
    ];
    if (missing.length) {
      const names = [...missing].sort((x, y) => y.qty - x.qty || cmp(x.name, y.name)).slice(0, 4).map((e) => e.name);
      reasons2.push(`Not seen in meta lists: ${names.join(", ")}.`);
    }
    return { name: "Card quality", score: round(100 * sum / copies), weight, confidence: "normal", reasons: reasons2 };
  }
  const scored = spells.map((e) => ({ e, q: heuristicQuality(e.card, p.heuristic, opts.asOf) }));
  const score = round(100 * scored.reduce((s, x) => s + x.q * x.e.qty, 0) / copies);
  const weakest = [...scored].sort((x, y) => x.q - y.q || cmp(x.e.name, y.e.name)).slice(0, 3).map((x) => x.e.name);
  const reasons = ["No meta lists supplied, so this is estimated from card popularity, rarity and age (low confidence)."];
  if (weakest.length) reasons.push(`Weakest by that estimate: ${weakest.join(", ")}.`);
  return { name: "Card quality", score, weight, confidence: "low", reasons };
}
function heuristicQuality(card, h, asOf) {
  const rank2 = card.edhrecRank;
  const logBest = Math.log(h.popularityBest);
  const logWorst = Math.log(h.popularityWorst);
  const popularity = rank2 === null ? 0.2 : clamp((logWorst - Math.log(rank2)) / (logWorst - logBest), 0, 1);
  const years = (Date.parse(asOf) - Date.parse(card.releasedAt)) / (365.25 * 24 * 3600 * 1e3);
  const recency = years <= h.recencyFullYears ? 1 : years >= h.recencyZeroYears ? 0 : 1 - (years - h.recencyFullYears) / (h.recencyZeroYears - h.recencyFullYears);
  const rarity = h.rarityValue[wildcardRarity(card)];
  return h.popularityWeight * popularity + h.rarityWeight * rarity + h.recencyWeight * recency;
}
function rateConstructed(deck, a, r, opts) {
  const arch = r.archetypes[a.archetype] ?? r.archetypes.midrange;
  const scale = (a.deckSize || 60) / 60;
  const dims = [
    manaBase2(a, r.manaBase, arch.lands * scale, r.weights.manaBase),
    speed(a, r, arch),
    interaction2(a, r.interaction, arch.interaction * scale, r.weights.interaction),
    cardQuality2(deck, r.cardQuality, opts, r.weights.cardQuality),
    consistency(deck, a, r, opts.simulation)
  ];
  return finish(r, a.archetype, dims);
}
function speed(a, r, arch) {
  const p = r.speed;
  const over = Math.max(0, a.averageManaValue - arch.avgMv);
  const mvScore = clamp(100 - over * p.pointsPerMvOver);
  const low = a.curve["0"] + a.curve["1"] + a.curve["2"];
  const lowShare = a.nonlandCount ? low / a.nonlandCount : 0;
  const lowScore = clamp(100 * lowShare / arch.lowDropShare);
  const top = a.curve["5"] + a.curve["6"] + a.curve["7+"];
  const extraTop = Math.max(0, top - arch.maxTopEnd * ((a.deckSize || 60) / 60));
  const topScore = clamp(100 - extraTop * p.pointsPerExtraTopEnd);
  const score = round(mvScore * p.avgMvWeight + lowScore * p.lowDropWeight + topScore * p.topEndWeight);
  const reasons = [
    `Average mana value ${a.averageManaValue} for ${/^[aeiou]/.test(a.archetype) ? "an" : "a"} ${a.archetype} deck (target about ${arch.avgMv}).`,
    `${pct(lowShare)} of nonland cards cost 2 or less (target ${pct(arch.lowDropShare)}).`
  ];
  if (extraTop > 0) reasons.push(`${plural(top, "card")} at 5+ mana is a heavy top end for this archetype.`);
  return { name: "Speed / curve", score, weight: r.weights.speed, confidence: "normal", reasons };
}
function consistency(deck, a, r, sim) {
  const p = r.consistency;
  const spells = playEntries(deck).filter((e) => !isLand(e.card) && !isBasicLand(e.card));
  const copies = countCards(spells) || 1;
  const fourOfs = spells.filter((e) => e.qty >= 4);
  const fourShare = countCards(fourOfs) / copies;
  const singletons = spells.filter((e) => e.qty === 1).length;
  const selection = a.roles.counts.card_draw + a.roles.counts.tutor;
  const selectionScore = Math.min(1, selection / (6 * ((a.deckSize || 60) / 60)));
  const structure = clamp(
    100 * (0.7 * Math.min(1, fourShare / p.fourOfTarget) + 0.3 * selectionScore) - Math.max(0, singletons - p.freeSingletons) * p.pointsPerSingleton
  );
  const reasons = [];
  let score = structure;
  if (sim) {
    const simScore = 100 * (Math.min(1, sim.keepable7 / p.keepableTarget) + Math.min(1, sim.landDropsOnCurve / p.landDropTarget) + Math.min(1, sim.colorAvailability / p.colorTarget)) / 3;
    score = simScore * p.simulationWeight + structure * p.structureWeight;
    reasons.push(
      `Simulated: ${pct(sim.keepable7)} keepable 7-card hands, ${pct(sim.landDropsOnCurve)} hit land drops on curve through turn ${sim.landDropTurn}, ${pct(sim.colorAvailability)} average color availability on curve.`
    );
  }
  reasons.push(`${pct(fourShare)} of nonland cards are 4-ofs${singletons > p.freeSingletons ? `; ${singletons} singletons dilute draws` : ""}.`);
  if (selection) reasons.push(`${plural(selection, "card")} draw or tutor for more consistency.`);
  return { name: "Consistency", score: round(score), weight: r.weights.consistency, confidence: "normal", reasons: reasons.slice(0, 3) };
}
function rateBrawl(deck, a, r, opts) {
  const scale = (a.deckSize || 100) / 100;
  const t = r.targetsPer100;
  const dims = [
    manaBase2(a, r.manaBase, t.lands * scale, r.weights.manaBase),
    commanderSynergy(deck, r, opts.recommendations),
    countDimension("Ramp", a.roles.counts.ramp, t.ramp * scale, r.weights.ramp, "ramp spells"),
    countDimension("Card draw", a.roles.counts.card_draw, t.cardDraw * scale, r.weights.cardDraw, "card draw sources"),
    interaction2(a, r.interaction, t.interaction * scale, r.weights.interaction),
    cardQuality2(deck, r.cardQuality, opts, r.weights.cardQuality)
  ];
  return finish(r, "brawl", dims);
}
function countDimension(name, have, target, weight, noun) {
  const score = round(100 * Math.min(1, have / (target || 1)));
  return {
    name,
    score,
    weight,
    confidence: "normal",
    reasons: [`${have} ${noun}; about ${Math.round(target)} is typical for this deck size.`]
  };
}
function commanderSynergy(deck, r, recs) {
  const p = r.commanderSynergy;
  const cmd = deck.commander;
  const weight = r.weights.commanderSynergy;
  if (!cmd) {
    return { name: "Commander synergy", score: 0, weight, confidence: "normal", reasons: ["No commander to build around."] };
  }
  const spells = deck.main.filter((e) => !isLand(e.card));
  const total = countCards(spells) || 1;
  const themes = commanderThemes(deck, p.themes);
  const reasons = [];
  let themeScore = null;
  if (themes) {
    const share = countCards(spells.filter((e) => themes.matches(e.card).length > 0)) / total;
    themeScore = 100 * Math.min(1, share / p.targetShare);
    reasons.push(`${cmd.name} cares about: ${[...themes.themes, ...themes.tribes].join(", ")}.`);
    reasons.push(`${pct(share)} of nonland cards support that (target ${pct(p.targetShare)}).`);
  }
  let recScore = null;
  if (recs?.cards.size) {
    const share = countCards(spells.filter((e) => recs.cards.has(e.oracleId))) / total;
    recScore = 100 * Math.min(1, share / p.targetRecommendedShare);
    reasons.push(`${pct(share)} of nonland cards are on your pasted recommendation list (target ${pct(p.targetRecommendedShare)}).`);
  }
  if (themeScore === null && recScore === null) {
    return {
      name: "Commander synergy",
      score: 50,
      weight,
      confidence: "low",
      reasons: [`No clear theme found in ${cmd.name}'s text; synergy can't be measured. Pasting a recommendation list helps.`]
    };
  }
  const score = round(themeScore !== null && recScore !== null ? (themeScore + recScore) / 2 : themeScore ?? recScore);
  return { name: "Commander synergy", score, weight, confidence: "normal", reasons: reasons.slice(0, 3) };
}
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/core/wildcards.ts
var zeroWildcards = () => ({ common: 0, uncommon: 0, rare: 0, mythic: 0 });
var ARENA_MAX_COPIES = 4;
function wildcardCost(deck) {
  const totals = /* @__PURE__ */ new Map();
  for (const { zone, e } of allEntries(deck)) {
    if (zone === "companion" && deck.side.some((s) => s.oracleId === e.oracleId)) continue;
    const t = totals.get(e.oracleId) ?? { qty: 0, card: e.card };
    t.qty += e.qty;
    totals.set(e.oracleId, t);
  }
  const byRarity = zeroWildcards();
  const cards = [];
  const unavailable = [];
  for (const { qty, card } of totals.values()) {
    if (isBasicLand(card)) continue;
    if (!card.onArena) {
      unavailable.push(card.name);
      continue;
    }
    const n = Math.min(qty, ARENA_MAX_COPIES);
    const rarity = wildcardRarity(card);
    byRarity[rarity] += n;
    cards.push({ name: card.name, qty: n, rarity });
  }
  cards.sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || (a.name < b.name ? -1 : 1));
  return {
    byRarity,
    total: RARITIES.reduce((s, r) => s + byRarity[r], 0),
    cards,
    unavailable: unavailable.sort(),
    notes: [
      "Counts every copy as uncrafted; Grindstone can't see your collection.",
      "Each card is priced at its lowest-rarity Arena printing. Basic lands are free."
    ]
  };
}

// src/core/recs.ts
var INCLUSION = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s*[\d,.]+\s*[km]?\s*decks|inclusion)/i;
var SYNERGY = /([+-]?\d+(?:\.\d+)?)\s*%\s*synergy/i;
var DECKS_ONLY = /^[\d,.]+\s*[km]?\s*decks$/i;
function parseRecommendations(text, index, opts = {}) {
  const cards = /* @__PURE__ */ new Map();
  let last;
  let ignored = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const inc = INCLUSION.exec(line);
    const syn = SYNERGY.exec(line);
    if (inc || syn) {
      if (last && inc) last.inclusion = Math.min(1, Number(inc[1]) / 100);
      if (last && syn) last.synergy = Math.max(-1, Math.min(1, Number(syn[1]) / 100));
      continue;
    }
    if (DECKS_ONLY.test(line)) continue;
    const name = line.replace(/^[-•*]\s*/, "").replace(/^\d+\s*x?\s+/i, "").replace(/\s+\([A-Za-z0-9]{2,8}\)(?:\s+\S+)?$/, "").trim();
    const card = index.lookup(name);
    if (!card) {
      ignored++;
      continue;
    }
    if (cards.has(card.oracleId)) {
      last = cards.get(card.oracleId);
      continue;
    }
    last = { name: card.name, oracleId: card.oracleId, rank: cards.size };
    cards.set(card.oracleId, last);
  }
  return {
    ...opts.commander ? { commander: opts.commander } : {},
    source: opts.source ?? "pasted by the user",
    cards,
    ignoredLines: ignored
  };
}
function recommendationScore(recs, card) {
  const r = recs.cards.get(card.oracleId);
  if (!r) return 0;
  if (r.inclusion === void 0 && r.synergy === void 0) {
    return 1 - 0.4 * (r.rank / Math.max(1, recs.cards.size));
  }
  const inclusion = r.inclusion ?? 0.3;
  const synergy = Math.max(0, r.synergy ?? 0);
  return 0.6 + 0.25 * inclusion + 0.15 * Math.min(1, synergy * 2);
}
function describeRecommendation(recs, card) {
  const r = recs.cards.get(card.oracleId);
  if (!r) return null;
  const bits = [];
  if (r.inclusion !== void 0) bits.push(`${Math.round(r.inclusion * 100)}% of decks`);
  if (r.synergy !== void 0) bits.push(`${r.synergy >= 0 ? "+" : ""}${Math.round(r.synergy * 100)}% synergy`);
  const who = recs.commander ? ` for ${recs.commander}` : "";
  return `it's on your recommendation list${who}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}
function recommendationSummary(recs, deck, index, legalityKey) {
  const spells = deck.main.filter((e) => !isLand(e.card));
  const inDeck = spells.filter((e) => recs.cards.has(e.oracleId));
  let unavailable = 0;
  for (const r of recs.cards.values()) {
    const c = index.byOracle.get(r.oracleId);
    if (!c || !c.onArena || !["legal", "restricted"].includes(c.legalities[legalityKey] ?? "")) unavailable++;
  }
  const notes = [];
  if (recs.commander && deck.commander && recs.commander.toLowerCase() !== deck.commander.name.toLowerCase()) {
    const front = deck.commander.card.faces[0]?.name.toLowerCase();
    if (recs.commander.toLowerCase() !== front) {
      notes.push(`The recommendations are for ${recs.commander}, but this deck's commander is ${deck.commander.name}.`);
    }
  }
  return {
    source: recs.source,
    cardsRecognized: recs.cards.size,
    linesIgnored: recs.ignoredLines,
    alreadyInDeck: inDeck.length,
    notOnArenaOrNotLegal: unavailable,
    notes
  };
}

// src/core/meta.ts
import { z as z2 } from "zod";
async function buildMeta(inputs, index, fuzzy) {
  const shares = inputs.map((m) => m.metaShare === void 0 ? void 0 : m.metaShare > 1 ? m.metaShare / 100 : m.metaShare);
  const known = shares.filter((s) => s !== void 0 && s > 0);
  const fallback = known.length ? Math.min(...known) / 2 : 1;
  const raw = shares.map((s) => s !== void 0 && s > 0 ? s : fallback);
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const lists = [];
  const unresolved = [];
  for (const [i, input] of inputs.entries()) {
    const deck = await parseAndResolve(input.list, index, fuzzy);
    const name = input.name ?? input.archetype ?? deck.name ?? `List ${i + 1}`;
    if (deck.unresolved.length) unresolved.push({ list: name, issues: deck.unresolved });
    const main = /* @__PURE__ */ new Map();
    for (const e of [...deck.commander ? [deck.commander] : [], ...deck.main]) {
      main.set(e.oracleId, (main.get(e.oracleId) ?? 0) + e.qty);
    }
    lists.push({
      name,
      archetype: input.archetype ?? input.name ?? deck.name ?? `List ${i + 1}`,
      ...input.winRate !== void 0 ? { winRate: input.winRate } : {},
      weight: raw[i] / total,
      deck,
      main
    });
  }
  const playRate = /* @__PURE__ */ new Map();
  for (const l of lists) for (const id of l.main.keys()) playRate.set(id, (playRate.get(id) ?? 0) + l.weight);
  let maxNonlandRate = 0;
  for (const [id, rate] of playRate) {
    const card = index.byOracle.get(id);
    if (card && !isLand(card)) maxNonlandRate = Math.max(maxNonlandRate, rate);
  }
  return { lists, playRate, maxNonlandRate, unresolved };
}
var snapshotSchema = z2.object({
  format: z2.string(),
  date: z2.string().optional(),
  source: z2.string().optional(),
  decks: z2.array(
    z2.object({
      name: z2.string().optional(),
      archetype: z2.string().optional(),
      metaShare: z2.number().optional(),
      winRate: z2.number().optional(),
      list: z2.string()
    })
  ).min(1)
});
function parseSnapshot(json, where = "snapshot") {
  const parsed = snapshotSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid meta snapshot ${where}: ${parsed.error.message}`);
  return parsed.data;
}
function nonlandCounts(deck) {
  const m = /* @__PURE__ */ new Map();
  for (const e of playEntries(deck)) {
    if (isLand(e.card)) continue;
    const cur = m.get(e.oracleId) ?? { name: e.name, qty: 0 };
    cur.qty += e.qty;
    m.set(e.oracleId, cur);
  }
  return m;
}
function overlap(a, b) {
  let shared = 0;
  for (const [id, x] of a) shared += Math.min(x.qty, b.get(id)?.qty ?? 0);
  const size = Math.max(countCards([...a.values()]), countCards([...b.values()]));
  return size ? shared / size : 0;
}
function compareToMeta(deck, meta) {
  const mine = nonlandCounts(deck);
  const ranked = meta.lists.map((l) => ({ list: l, cards: nonlandCounts(l.deck) })).map((x) => ({ ...x, overlap: overlap(mine, x.cards) })).sort((a, b) => b.overlap - a.overlap || b.list.weight - a.list.weight || (a.list.name < b.list.name ? -1 : 1));
  const best = ranked[0];
  if (!best) return null;
  const sameArchetype = ranked.filter((r) => r.list.archetype === best.list.archetype);
  const core = new Map(best.cards);
  for (const r of sameArchetype) {
    for (const [id, c] of r.cards) {
      const share = sameArchetype.filter((o) => o.cards.has(id)).length / sameArchetype.length;
      if (share >= 0.5 && !core.has(id)) core.set(id, c);
    }
  }
  const missingCore = [...core.entries()].map(([id, c]) => ({ name: c.name, metaQty: c.qty, deckQty: mine.get(id)?.qty ?? 0 })).filter((c) => c.deckQty < c.metaQty).sort((a, b) => b.metaQty - b.deckQty - (a.metaQty - a.deckQty) || (a.name < b.name ? -1 : 1));
  const unusual = [...mine.entries()].filter(([id]) => !meta.playRate.has(id)).map(([, c]) => ({ name: c.name, qty: c.qty })).sort((a, b) => b.qty - a.qty || (a.name < b.name ? -1 : 1));
  const pct2 = (n) => Math.round(n * 1e3) / 10;
  return {
    closest: {
      name: best.list.name,
      archetype: best.list.archetype,
      overlapPercent: pct2(best.overlap),
      ...best.list.winRate !== void 0 ? { winRate: best.list.winRate } : {},
      shareOfSuppliedListsPercent: pct2(best.list.weight)
    },
    ranking: ranked.map((r) => ({ name: r.list.name, archetype: r.list.archetype, overlapPercent: pct2(r.overlap) })),
    missingCore,
    unusual
  };
}

// src/core/suggest.ts
var INTENSITY = {
  light: { percent: 7, cutPool: 0.25 },
  normal: { percent: 15, cutPool: 0.5 },
  heavy: { percent: 30, cutPool: 1 }
};
var SCARCITY = { common: 0.25, uncommon: 0.5, rare: 1, mythic: 2 };
var CASUAL_COST_PENALTY = { common: 0, uncommon: 0.04, rare: 0.12, mythic: 0.2 };
var CANDIDATES_PER_CUT = 3;
function suggestUpgrades(deck, fmt, index, opts) {
  const maxSwaps = opts.maxSwaps ?? 5;
  const keep = new Set((opts.keepCards ?? []).map(normalizeName));
  const analysis = analyzeDeck(deck, fmt);
  const heuristics = fmt.commander ? brawlRubric().cardQuality.heuristic : constructedRubric().cardQuality.heuristic;
  const meta = opts.meta?.lists.length ? opts.meta : void 0;
  const notes = [];
  if (!meta) notes.push("No meta lists supplied: card strength is estimated from popularity, rarity and age.");
  const recs = opts.recommendations?.cards.size ? opts.recommendations : void 0;
  const metaRate = (c) => meta ? (meta.playRate.get(c.oracleId) ?? 0) / (meta.maxNonlandRate || 1) : 0;
  const score = (c) => {
    const quality = heuristicQuality(c, heuristics, opts.asOf);
    const rate = metaRate(c);
    let value;
    if (opts.mode === "competitive") value = meta ? 0.6 * rate + 0.4 * quality : quality;
    else value = (meta ? 0.15 * rate + 0.85 * quality : quality) - CASUAL_COST_PENALTY[wildcardRarity(c)];
    const rec = recs ? recommendationScore(recs, c) : 0;
    if (recs) value = 0.5 * value + 0.5 * rec;
    return { card: c, value, quality, metaRate: rate, rec };
  };
  const identity = deckIdentity(deck, analysis.colors.sources);
  const inDeck = new Set(playEntries(deck).map((e) => e.oracleId));
  const intensity = opts.intensity ?? "normal";
  const deckSize = countCards(playEntries(deck));
  const changeLimit = Math.max(1, Math.floor((opts.maxChangePercent ?? INTENSITY[intensity].percent) / 100 * deckSize));
  const themes = fmt.commander ? commanderThemes(deck, brawlRubric().commanderSynergy.themes) : null;
  if (fmt.commander && deck.commander && !themes) {
    notes.push(`No clear theme found in ${deck.commander.name}'s text, so adds aren't limited to a theme.`);
  }
  const curveTarget = analysis.archetype === "brawl" ? 3.5 : constructedRubric().archetypes[analysis.archetype].avgMv;
  const roleCounts = analysis.roles.counts;
  const rankedCuts = deck.main.filter((e) => !isLand(e.card) && !isBasicLand(e.card) && !keep.has(normalizeName(e.name)) && !keep.has(normalizeName(e.card.faces[0]?.name ?? ""))).map((e) => {
    const s = score(e.card);
    const roles = tagRoles(e.card).map((t) => t.role);
    const redundancy = roles.length ? Math.min(...roles.map((r) => roleCounts[r])) / 12 : 0.5;
    const mvOver = Math.max(0, castingMv(e.card) - (curveTarget + 1.5)) * 0.15;
    const absent = meta && s.metaRate === 0 ? 0.3 : 0;
    const onList = s.rec > 0;
    const offTheme = themes && !themes.matches(e.card).length && !onList ? 0.3 : 0;
    const recShift = recs ? onList ? -0.3 : 0.2 : 0;
    return { e, s, roles, cutScore: 1 - s.value + 0.2 * Math.min(1, redundancy) + mvOver + absent + offTheme + recShift };
  }).sort((a, b) => b.cutScore - a.cutScore || cmp2(a.e.name, b.e.name));
  const nonlandEntries = deck.main.filter((e) => !isLand(e.card)).length;
  const cuts = rankedCuts.slice(0, Math.min(Math.max(maxSwaps * 2, 6), Math.ceil(INTENSITY[intensity].cutPool * nonlandEntries)));
  const pool = index.records.filter(
    (c) => c.onArena && !inDeck.has(c.oracleId) && !isLand(c) && (c.legalities[fmt.legalityKey] === "legal" || c.legalities[fmt.legalityKey] === "restricted") && c.colorIdentity.every((col) => identity.has(col))
  );
  const options = [];
  for (const cut of cuts) {
    const mv = castingMv(cut.e.card);
    const creature = isCreature(cut.e.card);
    const needsReach = analysis.archetype === "aggro" && hasReach(cut.e.card);
    const found = [];
    for (const c of pool) {
      if (Math.abs(castingMv(c) - mv) > 1 || isCreature(c) !== creature) continue;
      if (needsReach && !hasReach(c)) continue;
      const themeHits = themes ? themes.matches(c) : [];
      if (themes && !themeHits.length && !(recs && recs.cards.has(c.oracleId))) continue;
      const roles = tagRoles(c).map((t) => t.role);
      const shared = cut.roles.filter((r) => roles.includes(r));
      if (cut.roles.length && shared.length === 0) continue;
      const add = score(c);
      const roleFit = cut.roles.length ? shared.length / cut.roles.length : 0.5;
      const gain = add.value - cut.s.value + (opts.mode === "casual" ? 0.1 * roleFit : 0.05 * roleFit);
      if (gain <= 0.02) continue;
      const qty = fmt.maxCopies === 1 ? 1 : Math.min(cut.e.qty, ARENA_MAX_COPIES);
      found.push({ cut, add, shared, themeHits, gain, qty, rarity: wildcardRarity(c) });
    }
    found.sort((a, b) => b.gain - a.gain || cmp2(a.add.card.name, b.add.card.name));
    options.push(...found.slice(0, CANDIDATES_PER_CUT));
  }
  const budget = opts.wildcards ?? null;
  const remaining = budget ? { ...budget } : null;
  const perWildcard = (o) => o.gain / (SCARCITY[o.rarity] * o.qty);
  options.sort(
    (a, b) => perWildcard(b) - perWildcard(a) || b.gain - a.gain || cmp2(a.cut.e.name, b.cut.e.name) || cmp2(a.add.card.name, b.add.card.name)
  );
  const usedCuts = /* @__PURE__ */ new Set();
  const usedAdds = /* @__PURE__ */ new Set();
  const totalCost = zeroWildcards();
  const swaps = [];
  let skippedForBudget = 0;
  let skippedForCap = 0;
  let changed = 0;
  for (const o of options) {
    if (swaps.length >= maxSwaps) break;
    if (usedCuts.has(o.cut.e.oracleId) || usedAdds.has(o.add.card.oracleId)) continue;
    if (changed + o.qty > changeLimit) {
      skippedForCap++;
      continue;
    }
    const left = remaining?.[o.rarity];
    if (left !== void 0 && left < o.qty) {
      skippedForBudget++;
      continue;
    }
    if (remaining && left !== void 0) remaining[o.rarity] = left - o.qty;
    usedCuts.add(o.cut.e.oracleId);
    usedAdds.add(o.add.card.oracleId);
    totalCost[o.rarity] += o.qty;
    changed += o.qty;
    swaps.push({
      cut: o.cut.e.name,
      add: o.add.card.name,
      qty: o.qty,
      reason: reasonFor(
        o.cut.e,
        o.add,
        o.shared,
        meta,
        themes ? { commander: themes.commander, hits: o.themeHits } : null,
        recs ? describeRecommendation(recs, o.add.card) : null
      ),
      wildcardCost: { [o.rarity]: o.qty }
    });
  }
  if (skippedForBudget) notes.push(`${skippedForBudget} otherwise-good swap(s) didn't fit the wildcard budget.`);
  if (skippedForCap) {
    notes.push(
      `Stopped at ${changed} of ${deckSize} cards changed to keep the deck recognizable (${intensity} intensity, limit ${changeLimit}); raise intensity or maxChangePercent for more.`
    );
  }
  if (!swaps.length) notes.push("No swap clearly improves the deck under these constraints.");
  return {
    mode: opts.mode,
    swaps,
    totalCost,
    budget,
    remaining,
    changes: { cards: changed, limit: changeLimit, deckSize, intensity },
    commanderThemes: themes ? { commander: themes.commander, themes: themes.themes, tribes: themes.tribes } : null,
    notes
  };
}
function hasReach(c) {
  return /damage to (?:any target|each opponent|target player|target opponent|any other target)/.test(rulesText(c));
}
function deckIdentity(deck, sources) {
  if (deck.commander) return new Set(deck.commander.card.colorIdentity);
  const copies = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let total = 0;
  for (const e of playEntries(deck)) {
    if (isLand(e.card) || !e.card.colorIdentity.length) continue;
    total += e.qty;
    for (const c of e.card.colorIdentity) copies[c] += e.qty;
  }
  return new Set(COLORS.filter((c) => total && copies[c] / total >= 0.15 || sources[c] >= 8));
}
var ROLE_WORDS = {
  removal: "removal",
  counterspell: "counterspell",
  sweeper: "sweeper",
  card_draw: "card draw",
  ramp: "ramp",
  tutor: "tutor",
  threat: "threat",
  protection: "protection",
  lifegain: "lifegain"
};
function reasonFor(cut, add, shared, meta, theme, recNote) {
  const role = shared.length ? `fills the same ${shared.map((r) => ROLE_WORDS[r]).join("/")} role` : "fills a similar slot";
  const cutMv = castingMv(cut.card);
  const addMv = castingMv(add.card);
  const mv = addMv < cutMv ? ` for ${cutMv - addMv} less mana` : addMv > cutMv ? ` at ${addMv - cutMv} more mana` : " at the same mana value";
  let why;
  if (recNote) {
    why = `and ${recNote}`;
  } else if (meta && add.metaRate > 0) {
    const n = meta.lists.filter((l) => l.main.has(add.card.oracleId)).length;
    why = `and appears in ${n} of ${meta.lists.length} meta lists`;
  } else {
    why = add.card.edhrecRank !== null ? "and is a more widely played card" : "and is a stronger card by rarity and age";
  }
  const fits = theme?.hits.length ? `; it supports ${theme.commander}'s ${theme.hits.join("/")} theme` : "";
  return `${add.card.name} ${role}${mv}, ${why}${fits}.`;
}
function cmp2(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/core/search.ts
var COLOR_WORDS = {
  white: "w",
  blue: "u",
  black: "b",
  red: "r",
  green: "g",
  colorless: "c",
  multicolor: "m",
  azorius: "wu",
  dimir: "ub",
  rakdos: "br",
  gruul: "rg",
  selesnya: "gw",
  orzhov: "wb",
  izzet: "ur",
  golgari: "bg",
  boros: "rw",
  simic: "gu",
  bant: "gwu",
  esper: "wub",
  grixis: "ubr",
  jund: "brg",
  naya: "rgw",
  abzan: "wbg",
  jeskai: "urw",
  sultai: "bgu",
  mardu: "rwb",
  temur: "gur"
};
function tokenize(q) {
  const toks = [];
  let i = 0;
  const readValue = () => {
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const v = q.slice(i + 1, end === -1 ? void 0 : end);
      i = end === -1 ? q.length : end + 1;
      return v;
    }
    const start = i;
    while (i < q.length && !/[\s()]/.test(q[i])) i++;
    return q.slice(start, i);
  };
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      toks.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      toks.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === "-" && i + 1 < q.length && !/\s/.test(q[i + 1])) {
      toks.push({ kind: "neg" });
      i++;
      continue;
    }
    if (ch === "!") {
      i++;
      toks.push({ kind: "term", exact: true, value: readValue() });
      continue;
    }
    const m = /^([a-z]+)(<=|>=|!=|:|=|<|>)/i.exec(q.slice(i));
    if (m) {
      i += m[0].length;
      toks.push({ kind: "term", key: m[1].toLowerCase(), op: m[2], value: readValue() });
      continue;
    }
    const word = readValue();
    if (word.toLowerCase() === "or") toks.push({ kind: "or" });
    else if (word.toLowerCase() !== "and") toks.push({ kind: "term", value: word });
  }
  return toks;
}
function parseColors(v) {
  const raw = (COLOR_WORDS[v.toLowerCase()] ?? v).toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "m") return "m";
  if (!/^[wubrgc]+$/.test(raw)) throw new ToolError("bad_query", { reason: `unknown color "${v}"` });
  return new Set([...raw].filter((ch) => ch !== "c").map((ch) => ch.toUpperCase()));
}
function compareNum(a, op, b) {
  switch (op) {
    case ":":
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}
function colorPred(get, op, value, defaultOp) {
  const want = parseColors(value);
  if (want === "m") return (c) => get(c).length >= 2;
  if (typeof want === "number") return (c) => compareNum(get(c).length, op === ":" ? "=" : op, want);
  const eff = op === ":" ? defaultOp : op;
  return (c) => {
    const have = new Set(get(c));
    const sub = [...have].every((x) => want.has(x));
    const sup = [...want].every((x) => have.has(x));
    switch (eff) {
      case "=":
        return sub && sup;
      case "!=":
        return !(sub && sup);
      case "<=":
        return sub;
      case "<":
        return sub && have.size < want.size;
      case ">=":
        return sup;
      case ">":
        return sup && have.size > want.size;
      default:
        return sup;
    }
  };
}
function numericPred(get, op, value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError("bad_query", { reason: `${key} needs a number, got "${value}"` });
  return (c) => {
    const v = get(c);
    return Number.isFinite(v) && compareNum(v, op, n);
  };
}
var IS_FLAGS = {
  arena: (c) => c.onArena,
  permanent: (c) => /\b(Creature|Artifact|Enchantment|Planeswalker|Land|Battle)\b/.test(frontTypeLine(c)),
  spell: (c) => !/\bLand\b/.test(frontTypeLine(c)),
  creature: (c) => /\bCreature\b/.test(frontTypeLine(c)),
  land: (c) => /\bLand\b/.test(frontTypeLine(c)),
  basic: (c) => /\bBasic\b/.test(c.typeLine),
  legendary: (c) => /\bLegendary\b/.test(frontTypeLine(c)),
  commander: (c) => /\bLegendary\b/.test(frontTypeLine(c)) && /\b(Creature|Planeswalker)\b/.test(frontTypeLine(c)) || /can be your commander/i.test(c.oracleText),
  dfc: (c) => ["transform", "modal_dfc", "meld"].includes(c.layout),
  mdfc: (c) => c.layout === "modal_dfc",
  split: (c) => c.layout === "split",
  adventure: (c) => c.layout === "adventure",
  gamechanger: (c) => c.gameChanger
};
function termPred(t) {
  const value = t.value ?? "";
  const lower = value.toLowerCase();
  if (t.exact) {
    const key = normalizeName(value);
    return (c) => normalizeName(c.name) === key || c.faces.some((f) => normalizeName(f.name) === key);
  }
  if (!t.key) {
    const key = normalizeName(value);
    return (c) => normalizeName(c.name).includes(key);
  }
  const op = t.op ?? ":";
  switch (t.key) {
    case "name":
    case "n":
      return (c) => normalizeName(c.name).includes(normalizeName(value));
    case "t":
    case "type":
      return (c) => c.typeLine.toLowerCase().includes(lower);
    case "o":
    case "oracle":
      return (c) => c.oracleText.toLowerCase().replace(new RegExp(escapeRe(c.name.toLowerCase()), "g"), "~").includes(lower);
    case "kw":
    case "keyword":
      return (c) => c.keywords.some((k) => k.toLowerCase() === lower);
    case "c":
    case "color":
      return colorPred((c) => c.colors, op, value, ">=");
    case "id":
    case "identity":
    case "ci":
      return colorPred((c) => c.colorIdentity, op, value, "<=");
    case "mv":
    case "cmc":
    case "manavalue":
      return numericPred((c) => c.cmc, op === ":" ? "=" : op, value, t.key);
    case "pow":
    case "power":
      return numericPred((c) => Number(c.power), op === ":" ? "=" : op, value, t.key);
    case "tou":
    case "toughness":
      return numericPred((c) => Number(c.toughness), op === ":" ? "=" : op, value, t.key);
    case "year":
      return numericPred((c) => Number(c.releasedAt.slice(0, 4)), op === ":" ? "=" : op, value, t.key);
    case "r":
    case "rarity": {
      const idx = RARITIES.findIndex((r) => r === lower || r[0] === lower);
      if (idx < 0) throw new ToolError("bad_query", { reason: `unknown rarity "${value}"` });
      return (c) => compareNum(RARITIES.indexOf(wildcardRarity(c)), op === ":" ? "=" : op, idx);
    }
    case "f":
    case "format":
    case "legal": {
      const key = getFormat(value).legalityKey;
      return (c) => c.legalities[key] === "legal" || c.legalities[key] === "restricted";
    }
    case "banned":
    case "restricted": {
      const key = getFormat(value).legalityKey;
      const status = t.key;
      return (c) => c.legalities[key] === status;
    }
    case "game":
      if (lower !== "arena") throw new ToolError("bad_query", { reason: "only game:arena is supported" });
      return (c) => c.onArena;
    case "is": {
      const p = IS_FLAGS[lower];
      if (!p) throw new ToolError("bad_query", { reason: `unknown is:${value}`, supported: Object.keys(IS_FLAGS) });
      return p;
    }
    case "produces": {
      const want = lower.toUpperCase().split("");
      return (c) => want.every((w) => c.producedMana.includes(w));
    }
    default:
      throw new ToolError("bad_query", {
        reason: `unsupported search key "${t.key}"`,
        supported: ["t", "o", "kw", "c", "id", "mv", "pow", "tou", "r", "f", "banned", "game", "is", "year", "produces"]
      });
  }
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function compileQuery(query) {
  const toks = tokenize(query);
  let pos = 0;
  const parseOr = () => {
    const parts = [parseAnd()];
    while (toks[pos]?.kind === "or") {
      pos++;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0] : (c) => parts.some((p) => p(c));
  };
  const parseAnd = () => {
    const parts = [];
    while (pos < toks.length && toks[pos].kind !== "or" && toks[pos].kind !== "rparen") parts.push(parseUnary());
    if (!parts.length) throw new ToolError("bad_query", { reason: "empty expression" });
    return (c) => parts.every((p) => p(c));
  };
  const parseUnary = () => {
    const t = toks[pos++];
    if (t.kind === "neg") {
      const inner = parseUnary();
      return (c) => !inner(c);
    }
    if (t.kind === "lparen") {
      const inner = parseOr();
      if (toks[pos]?.kind !== "rparen") throw new ToolError("bad_query", { reason: "missing )" });
      pos++;
      return inner;
    }
    return termPred(t);
  };
  const pred = parseOr();
  if (pos < toks.length) throw new ToolError("bad_query", { reason: "unbalanced )" });
  return pred;
}
function searchCards(index, query, opts = {}) {
  const pred = compileQuery(query);
  const fmt = opts.format ? getFormat(opts.format) : void 0;
  const hits = index.records.filter(
    (c) => pred(c) && (!fmt || (c.legalities[fmt.legalityKey] === "legal" || c.legalities[fmt.legalityKey] === "restricted") && c.onArena)
  );
  const order = opts.order ?? "name";
  if (order === "mv") hits.sort((a, b) => a.cmc - b.cmc || cmpName(a, b));
  else if (order === "edhrec") hits.sort((a, b) => (a.edhrecRank ?? 1e9) - (b.edhrecRank ?? 1e9) || cmpName(a, b));
  else if (order === "released") hits.sort((a, b) => cmpStr(b.latestReleasedAt, a.latestReleasedAt) || cmpName(a, b));
  return { total: hits.length, cards: hits.slice(0, opts.limit ?? 50) };
}
function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function cmpName(a, b) {
  return cmpStr(a.name, b.name);
}

// src/core/rules.ts
function findRulesTxtUrl(html) {
  const m = /https:\/\/media\.wizards\.com\/[^"'<>\s]*?MagicCompRules[^"'<>]*?\.txt/i.exec(html);
  return m ? m[0].replace(/ /g, "%20") : null;
}
var RULE_LINE = /^(\d{1,3}(?:\.\d+[a-z]?)?)\.?\s+(\S.*)$/;
function parseRules(text, source2) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const effective = /effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text)?.[1];
  const starts = lines.flatMap((l, i) => /^1\.\s+Game Concepts$/.test(l) ? [i] : []);
  const glossaryAt = lines.flatMap((l, i) => l === "Glossary" ? [i] : []);
  const creditsAt = lines.flatMap((l, i) => l === "Credits" ? [i] : []);
  const bodyStart = starts[1] ?? starts[0] ?? 0;
  const glossaryStart = glossaryAt.find((i) => i > bodyStart) ?? lines.length;
  const glossaryEnd = creditsAt.find((i) => i > glossaryStart) ?? lines.length;
  const rules = [];
  for (let i = bodyStart; i < glossaryStart; i++) {
    const line = lines[i];
    if (!line) continue;
    if (/^Example:/.test(line)) {
      rules[rules.length - 1]?.examples.push(line.replace(/^Example:\s*/, ""));
      continue;
    }
    const m = RULE_LINE.exec(line);
    if (m) rules.push({ number: m[1], text: m[2], examples: [] });
    else if (rules.length) rules[rules.length - 1].text += ` ${line}`;
  }
  const glossary = /* @__PURE__ */ new Map();
  let term = null;
  let def = [];
  const flush = () => {
    if (term && def.length) glossary.set(term.toLowerCase(), { term, definition: def.join(" ") });
    term = null;
    def = [];
  };
  for (let i = glossaryStart + 1; i < glossaryEnd; i++) {
    const line = lines[i];
    if (!line) flush();
    else if (term === null) term = line;
    else def.push(line);
  }
  flush();
  return { ...effective ? { effective } : {}, source: source2, rules, byNumber: new Map(rules.map((r) => [r.number, r])), glossary };
}
function lookupNumber(doc, number, limit = 40) {
  const key = number.trim().replace(/\.$/, "");
  const exact = doc.byNumber.get(key);
  const children = doc.rules.filter(
    (r) => r.number !== key && (r.number.startsWith(`${key}.`) || /\d$/.test(key) && new RegExp(`^${escape(key)}[a-z]$`).test(r.number))
  );
  return [...exact ? [exact] : [], ...children].slice(0, limit);
}
function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function searchRules(doc, query, limit = 10) {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  const glossary = doc.glossary.get(q);
  const scored = doc.rules.map((r) => {
    const text = r.text.toLowerCase();
    let score = text.includes(q) ? 10 : 0;
    for (const t of terms) if (text.includes(t)) score += 1;
    return { r, score };
  }).filter((x) => x.score >= Math.max(1, terms.length)).sort((a, b) => b.score - a.score || a.r.number.length - b.r.number.length || cmpRule(a.r.number, b.r.number)).slice(0, limit).map((x) => x.r);
  return { glossary: glossary ?? null, rules: scored };
}
function cmpRule(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}
export {
  ARENA_MAX_COPIES,
  BO1_SMOOTHING_CANDIDATES,
  COLORS,
  CURVE_BUCKETS,
  CardIndex,
  FORMATS,
  FORMAT_NAMES,
  INTENSITY,
  INTERACTION_ROLES,
  RARITIES,
  ROLES,
  RULES,
  ToolError,
  aggregateCards,
  allEntries,
  analyzeDeck,
  asOfDate,
  brawlRubric,
  brawlRubricSchema,
  buildLibrary,
  buildMeta,
  bundledRubrics,
  byNameThenId,
  canBeCommander,
  canPay,
  castingCost,
  castingMv,
  commanderThemes,
  compareToMeta,
  compileQuery,
  constructedRubric,
  constructedRubricSchema,
  countCards,
  dealSampleHand,
  deckIdentity,
  describeRecommendation,
  entriesWithRole,
  findRulesTxtUrl,
  frontTypeLine,
  getFormat,
  hasReach,
  hasRole,
  heuristicQuality,
  hypergeometric,
  inferArchetype,
  isBasicLand,
  isCreature,
  isInteraction,
  isKeepable,
  isLand,
  isMdfcLand,
  karstenSources,
  landColors,
  levenshtein,
  lookupNumber,
  manaValueOf,
  normalizeName,
  overlap,
  parseAndResolve,
  parseArenaText,
  parseRecommendations,
  parseRules,
  parseSnapshot,
  pipsOf,
  playEntries,
  printedCopyLimit,
  ratePower,
  rawFromDeck,
  recommendationScore,
  recommendationSummary,
  resolveDeck,
  rng,
  round,
  rulesText,
  searchCards,
  searchRules,
  setRubricSource,
  simulateHands,
  snapshotSchema,
  suggestUpgrades,
  summarize,
  tagRoles,
  tappedKind,
  tierFor,
  toPublicDeck,
  validateDeck,
  wildcardCost,
  wildcardRarity,
  zeroWildcards
};
//# sourceMappingURL=core.js.map