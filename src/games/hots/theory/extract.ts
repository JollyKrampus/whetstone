/**
 * Mechanics extractor (SPEC §5.1.1): deterministic keyword/regex rules over a hero's ability and
 * talent text → `Mechanic[]` tags with evidence. Browser-safe and pure: the same hero always
 * yields the same tags in the same order.
 *
 * How a sentence is read:
 *   1. Text is normalised (per-level scaling removed) and split into sentences. Quest
 *      requirement sentences ("Quest: hit 40 Heroes…") are skipped; rewards are read.
 *   2. References to the hero's own ability/talent names are masked, so "Snow Blind's cooldown"
 *      or "Entangling Roots" never count as a blind or a root.
 *   3. Phrases that mention crowd control without applying it are blanked: states used as
 *      conditions ("Stunned enemies take…", "while Rooted", "when Malfurion is Stunned"),
 *      lists of effects ("Stuns, Roots, and Slows"), removal/immunity ("remove all Slows",
 *      "cannot be Slowed"), anti-heal ("reduces healing received"), enemy shields ("destroys
 *      Shields").
 *   4. Tag patterns run on what is left; the first hit per ability/talent becomes evidence, with
 *      a snippet of the original sentence.
 * Hero-level tags (aa-reliant, sustained-dps, burst, poke, waveclear) are derived afterwards
 * from the per-sentence findings and the hero's numbers.
 *
 * Evidence `kind` says where a tag came from: `ability` (any ability, Heroics included) or
 * `talent`. Heroic abilities also appear as level-10 talents; those duplicates are skipped so
 * the Heroic is the single source. The engine decides how much a tag counts (talent-only or
 * one-of-several-Heroics tags count less), see engine.ts.
 */
import type { Mechanic } from '../schema.ts';
import { MECHANIC_TAGS, TALENT_TIERS, type TalentTier } from '../schema.ts';
import { blank, maskPhrase, normalizeText, snippetAround, splitSentences } from './text.ts';
import type { HeroInput } from './types.ts';

export type MechanicTag = (typeof MECHANIC_TAGS)[number];
type AbilityKind = HeroInput['abilities'][number]['kind'];

/** Most evidence entries kept per tag (abilities first, then talents by tier). */
export const MAX_EVIDENCE = 4;

// ---- model -----------------------------------------------------------------------------

interface Sentence {
  /** Original sentence (normalised typography), used for snippets. */
  original: string;
  /** Own ability/talent names masked with `§`; same length as `original`. */
  masked: string;
  /** `masked` with non-applying mentions blanked; same length. */
  clean: string;
}

interface Entry {
  kind: 'ability' | 'talent';
  name: string;
  abilityKind?: AbilityKind;
  tier?: TalentTier;
  quest: boolean;
  /** Full normalised text (scaling stripped). */
  text: string;
  sentences: Sentence[];
}

interface Hit {
  entry: Entry;
  sentence: Sentence;
  at: number;
  length: number;
}

interface Ctx {
  hero: HeroInput;
  /** Words that refer to the hero itself (name, name parts, pronouns). */
  selfWords: string;
}

// ---- vocabulary ------------------------------------------------------------------------

/** Negative states a hero can inflict; used to find condition/adjective uses. */
const STATES = '(?:Stunned|Rooted|Slowed|Silenced|Blinded|Feared|Taunted|Polymorphed|Sleeping|Asleep|Disabled|Immobilized|Chilled|Frozen|Revealed|Charmed)\\b';
const STATE_LIST = `${STATES}(?:\\s*,\\s*(?:or\\s+|and\\s+)?${STATES}|\\s+(?:or|and)\\s+${STATES})*`;
/** Effect nouns (plural or singular) as they appear in lists. */
const EFFECTS = '(?:Stuns?|Roots?|Slows?|Silences?|Blinds?|Polymorphs?|Taunts?|Fears?|Displacements?|Knockbacks?|Sleeps?)\\b';
const EFFECT_OR_DOT = `(?:${EFFECTS}|damage over time(?: effects)?)`;
const EFFECT_LIST = `${EFFECTS}(?:\\s*,\\s*(?:and\\s+|or\\s+)?${EFFECT_OR_DOT}|\\s+(?:and|or)\\s+${EFFECT_OR_DOT})+`;
const GERUNDS = '(?:Stunning|Rooting|Slowing|Silencing|Blinding|Polymorphing)\\b';
/** A word, possibly a masked ability name. */
const TOKEN = "[\\w'.§-]+";
/** A word of a noun phrase: not a verb or conjunction that would start a new clause. */
const SUBJECT_TOKEN = `(?!(?:and|or|but|then|take|takes|deal|deals|dealing|hit|hits|damage|that|who|which)\\b)${TOKEN}`;

/** Units that are not the hero; their actions are not the hero's mechanics. */
const NON_HERO_UNITS =
  'Locusts?|Minions?|Mercenar(?:y|ies)|Monsters?|Monstrosity|Structures?|Pylons?|Turrets?|Treants?|Demons?|Skeletons?|Zombies?|Spiders?|Hydralisks?|Roachlings?|Banelings?|Imps?|Totems?|Wards?|Mines?|Nests?|Bunkers?|clones?|Mirror Images?|Odin|Valkyrie|Hyperion';

function stripNonApplying(masked: string, ctx: Ctx): string {
  let s = masked;
  // "Stunned, Rooted, or Slowed enemies", "Stealthed Heroes", "Unstoppable enemies".
  s = blank(s, new RegExp(`\\b(?:${STATE_LIST}|Stealthed|Unstoppable|Vulnerable)\\s+(?:enemy\\s+|allied\\s+|non-Heroic\\s+)?(?:enemies|enemy|Heroes|Hero|targets?|allies|ally|units?|Minions?)\\b`, 'gi'));
  // "who are Stunned", "that is Rooted or Slowed".
  s = blank(s, new RegExp(`\\b(?:who|that|which)\\s+(?:are|is|were|have been)\\s+(?:currently\\s+|already\\s+|being\\s+)?${STATE_LIST}`, 'gi'));
  // "while Stunned", "When Malfurion is Stunned", "Whenever an ally with Healing Pathogen is Rooted".
  s = blank(s, new RegExp(`\\b(?:while|when|whenever|if|after being|upon being|until)\\s+(?:${TOKEN}\\s+){0,5}?(?:is\\s+|are\\s+|becomes?\\s+|gets?\\s+)?(?:also\\s+)?${STATE_LIST}`, 'gi'));
  // "Being Stunned or Rooted grants 30 Armor", "…but is Stunned for 1 second".
  s = blank(s, new RegExp(`(?:^|\\b(?:but|and then)\\s+)(?:being|is|gets)\\s+(?:also\\s+)?${STATE_LIST}`, 'gi'));
  // Self as the subject: "all Vikings are Stunned", "Nova is Revealed", "an ally affected by Safeguard is Rooted".
  // The words in between may not contain a verb or conjunction ("Alarak take 165 damage and are
  // Silenced" is about the enemies hit, not Alarak).
  s = blank(s, new RegExp(`\\b(?:${ctx.selfWords}|allies|ally|allied Heroes?|teammates?|the boat|Mech)\\b(?:\\s+${SUBJECT_TOKEN}){0,4}?\\s+(?:is|are|becomes?|gets?)\\s+(?:also\\s+|then\\s+|instantly\\s+)?${STATE_LIST}`, 'gi'));
  // Effect lists not used as verbs: "Stuns, Roots, and Slows", "Stun and Silence effects"; but
  // "Stun, Blind, and damage an enemy" (Cheap Shot) is a list of verbs and stays.
  s = blank(s, new RegExp(`\\b${EFFECT_LIST}(?:\\s+effects?)?(?!\\s+(?:them|enemies|enemy|the|nearby|all|target|him|her|it|an?)\\b|\\s*,?\\s+and\\s+(?:damage|deal)\\b)`, 'gi'));
  // "Stunning, Rooting, or Slowing a Hero grants…" (a condition, not an effect).
  s = blank(s, new RegExp(`\\b${GERUNDS}(?:\\s*,\\s*(?:or\\s+|and\\s+)?${GERUNDS}|\\s+(?:or|and)\\s+${GERUNDS})+\\s+(?:a|an|enemy)\\b`, 'gi'));
  // Removal and immunity: "remove all Roots and Slows", "cannot be Slowed", "duration of Stuns".
  s = blank(s, new RegExp(`\\b(?:remov\\w*|cleans\\w*|immune to|immunity to|reduc\\w* the duration of|duration of|unaffected by|cannot be|can't be|break\\w*\\s+(?:[\\w']+\\s+){0,3}?out of|ignor\\w*|resist\\w*)\\s+(?:all\\s+)?(?:incoming\\s+|enemy\\s+)?(?:${EFFECT_LIST}|${EFFECTS}|${STATES}|damage over time)(?:\\s+effects?)?`, 'gi'));
  // A single CC noun/state as an effect type: "Slow effects", "Stun duration of enemies…" stays.
  s = blank(s, /\b(?:Slow|Stun|Root|Silence|Blind)\s+(?:and\s+\w+\s+)?effects?\b/gi);
  return s;
}

// ---- pattern helpers -------------------------------------------------------------------

type Finder = (s: Sentence, e: Entry, ctx: Ctx) => { at: number; length: number } | null;

/** First match of any regex on the cleaned sentence. */
function any(...res: RegExp[]): Finder {
  return (s) => {
    for (const re of res) {
      const m = re.exec(s.clean);
      if (m) return { at: m.index, length: m[0].length };
    }
    return null;
  };
}

interface TagRule {
  tag: MechanicTag;
  find: Finder;
  /** Ability kinds that never count for this tag (e.g. mounts for `channel`). */
  skipKinds?: AbilityKind[];
  /** Skip a whole ability/talent whose full text matches (e.g. channels that grant Protected). */
  skipEntry?: RegExp;
}

// Allied/ally context near a match.
const ALLY_NEAR = /\b(?:ally|allies|allied|teammates?|them|both|target Hero|another Hero|other Heroes)\b/i;

function windowBefore(text: string, at: number, size = 70): string {
  return text.slice(Math.max(0, at - size), at);
}

function lastIndex(text: string, re: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) last = m.index;
  return last;
}

/** Who becomes Unstoppable: the nearest subject/object word before the match decides. */
function unstoppableWho(s: Sentence, at: number, ctx: Ctx): 'self' | 'ally' | 'both' {
  const before = windowBefore(s.clean, at);
  if (/\bboth\b/i.test(before)) return 'both';
  const ally = lastIndex(before, ALLY_NEAR);
  const self = lastIndex(before, new RegExp(`\\b(?:${ctx.selfWords}|become|becomes|becoming|yourself)\\b`, 'i'));
  return ally > self ? 'ally' : 'self';
}

/** Unstoppable for the hero itself (allied grants count as `cleanse`). */
const unstoppableSelf: Finder = (s, _e, ctx) => {
  for (const m of s.clean.matchAll(/\bunstoppable\b/gi)) {
    if (unstoppableWho(s, m.index, ctx) !== 'ally') return { at: m.index, length: m[0].length };
  }
  return null;
};

const unstoppableAlly: Finder = (s, _e, ctx) => {
  for (const m of s.clean.matchAll(/\bunstoppable\b/gi)) {
    if (unstoppableWho(s, m.index, ctx) !== 'self') return { at: m.index, length: m[0].length };
  }
  return null;
};

const removalCleanse: Finder = (s) => {
  const re = new RegExp(
    `\\b(?:remov\\w*|cleans\\w*|purg\\w*|break\\w*\\s+(?:[\\w']+\\s+){0,3}?out of)\\s+(?:all\\s+)?(?:(?:${EFFECTS}|${STATES}|disabling effects?|negative (?:status )?effects?|crowd control(?: effects)?|damage over time(?: effects)?|debuffs?)(?:\\s*,\\s*(?:and\\s+|or\\s+)?|\\s+(?:and|or)\\s+)?)+`,
    'gi',
  );
  for (const m of s.masked.matchAll(re)) {
    if (/\b(?:Stun|Root|Silence|Polymorph|Blind|Fear|disabling|negative|crowd control)/i.test(m[0])) return { at: m.index, length: m[0].length };
  }
  return null;
};

function cleanFinder(...res: RegExp[]): Finder {
  return any(...res);
}

/** Runs on the masked text (not CC-cleaned) for tags whose wording the CC strips would hide. */
function maskedFinder(...res: RegExp[]): Finder {
  return (s) => {
    for (const re of res) {
      const m = re.exec(s.masked);
      if (m) return { at: m.index, length: m[0].length };
    }
    return null;
  };
}

function combine(...finders: Finder[]): Finder {
  return (s, e, ctx) => {
    for (const f of finders) {
      const hit = f(s, e, ctx);
      if (hit) return hit;
    }
    return null;
  };
}

/** Wraps a finder with a sentence-level veto. */
function unless(finder: Finder, veto: RegExp): Finder {
  return (s, e, ctx) => (veto.test(s.masked) ? null : finder(s, e, ctx));
}

// ---- heal classification ---------------------------------------------------------------

/**
 * A heal that actually happens (amount or recipient named), not a healing modifier such as
 * "receive 25% increased healing" or "increase its healing by 30%".
 */
const HEAL_RE = new RegExp(
  [
    // "heals Varian for 35", "heal for 20%", "healing them for 200", "healed for 60%" (not "for 8 seconds")
    "\\bheal(?:s|ing|ed)?\\s+(?:[\\w'§]+\\s+){0,3}?for\\s+(?:up to\\s+|an additional\\s+)?\\d+(?:\\.\\d+)?%?(?!\\d|\\.\\d|\\s*seconds?\\b|\\s*(?:more|less|longer|faster)\\b)",
    // "heal 20% of Johanna's max Health", "heal 100% of the damage"
    "\\bheal(?:s|ing)?\\s+(?:up to\\s+)?\\d+(?:\\.\\d+)?%?\\s+(?:of\\s+)?(?:[\\w'§]+\\s+){0,2}?(?:max(?:imum)?\\s+)?(?:Health|damage)",
    // "heal nearby allied Heroes", "heals the first allied Hero hit", "heal himself"
    "\\bheal(?:s|ing)?\\s+(?:(?:the|an?|its|their)\\s+(?:target|first|lowest|nearest|ally|allied|assisted)|target|nearby|all|allied|allies|ally|himself|herself|itself|yourself|him|her|them|Heroes|[A-Z][\\w']+'s)\\b",
    // "Allied Heroes hit are healed", "Ana is healed"
    "\\b(?:is|are|be|get|gets)\\s+(?:also\\s+|instantly\\s+)?healed\\b",
    "\\brestor(?:e|es|ing)\\s+(?:up to\\s+)?(?:\\d+(?:\\.\\d+)?%?\\s+)?(?:of\\s+)?(?:[\\w'§]+\\s+){0,3}?(?:max(?:imum)?\\s+)?Health\\b",
    "\\bregenerat(?:e|es|ing)\\s+(?:\\d+(?:\\.\\d+)?%?\\s+)(?:of\\s+)?(?:[\\w'§]+\\s+){0,2}?(?:max(?:imum)?\\s+)?Health\\b",
    "\\blife ?steal\\b",
  ].join('|'),
  'gi',
);
const ANTI_HEAL_RE =
  /\b(?:reduc\w*|lower\w*|decreas\w*|cut\w*)\s+(?:[\w']+\s+){0,4}?(?:healing|heals)(?:\s+(?:received|taken|done))?\b|\b(?:healing|heals)\s+(?:received\s+|taken\s+)?(?:is\s+|are\s+)?(?:reduced|lowered|decreased)\b|\b\d+(?:\.\d+)?%\s+(?:reduced|less)\s+(?:healing|heals)\b|\b(?:cannot|can't|unable to)\s+be\s+healed\b|\bhealing reduction\b|\breduced healing\b/gi;

const HEAL_ALLY =
  /\b(?:ally|allies|allied|teammates?|target Hero|another Hero|other Heroes|friendly Heroes|nearby Heroes|Heroes in (?:the|an) area|all Heroes|(?:the|its|their) target|the host|them)\b/i;
const HEAL_ALLY_SUBJECT = /\b(?:ally|allies|allied|teammates?|Heroes|them|they|(?:the|its|their) target)\b/i;
const HEAL_CONDITION = /\b(?:while|when|whenever|if)\s+(?:[\w'§.]+\s+){0,3}?(?:is|are)\s+healed\b/gi;

/** Who a heal at `at` (matched text `matched`) goes to: the hero, allies, both, or nobody we track. */
function healTarget(text: string, at: number, matched: string, ctx: Ctx): 'self' | 'ally' | 'both' | null {
  // A capitalised "Healing …" mid-sentence is a name ("Healing Potions last…"), not a heal.
  if (at > 0 && /^Heal/.test(matched) && /\S/.test(text.slice(0, at))) return null;
  const before = windowBefore(text, at, 60);
  const after = text.slice(at + matched.length, at + matched.length + 30);
  const nonHero = new RegExp(`\\b(?:${NON_HERO_UNITS}|Misha|MULE|Mule)\\b`, 'i');
  // Someone else's healing: summons, minions, structures.
  if (new RegExp(`${nonHero.source}(?:'s)?(?:\\s+[\\w'§]+){0,3}\\s*$`, 'i').test(before) || nonHero.test(matched)) return null;
  if (/\b(?:Regeneration Globes?|Healing Fountains?|Healing Wells?|repairs?)\b/i.test(text)) return null;
  const selfRe = new RegExp(`\\b(?:${ctx.selfWords}|himself|herself|itself|yourself|him|her)\\b`, 'i');
  const subject = before.slice(-40);
  if (/\bhealed\b/i.test(matched)) {
    // Passive: the subject decides ("Allied Heroes hit are healed", "Ana is healed").
    if (selfRe.test(subject)) return HEAL_ALLY_SUBJECT.test(subject) && /\b(?:both|and)\b/i.test(subject) ? 'both' : 'self';
    return HEAL_ALLY_SUBJECT.test(subject) ? 'ally' : 'self';
  }
  // Active: the object decides ("heals Varian for", "heal nearby allied Heroes", "heal them for")…
  const ally = HEAL_ALLY.test(`${matched} ${after}`);
  const self = selfRe.test(`${matched} ${after.slice(0, 12)}`);
  if (ally && self) return 'both';
  if (ally) return 'ally';
  if (self) return 'self';
  // …or, without an object, the subject ("allied Heroes heal for", "Heal an ally with a wave of healing for").
  return HEAL_ALLY_SUBJECT.test(subject) && !selfRe.test(subject) ? 'ally' : 'self';
}

function healFinder(which: 'self' | 'ally'): Finder {
  return (s, _e, ctx) => {
    const text = blank(blank(s.clean, ANTI_HEAL_RE), HEAL_CONDITION);
    for (const m of text.matchAll(HEAL_RE)) {
      const target = healTarget(text, m.index, m[0], ctx);
      if (target === which || target === 'both') return { at: m.index, length: m[0].length };
    }
    return null;
  };
}

/** Healing reduction applied to enemies (not "Healing Fountain cooldown", not the hero's own healing). */
const antiHeal: Finder = (s) => {
  const text = blank(s.masked, /\bHealing (?:Fountains?|Wells?|Globes?)\b/g);
  for (const m of text.matchAll(ANTI_HEAL_RE)) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40);
    if (/\b(?:its|his|her) healing\b|\bhealing received from allies\b/i.test(around)) continue;
    if (!/\benem|\bHeroes?\s+(?:hit|afflicted|within|marked)|\btarget|\bthem\b|\btheir\b/i.test(around)) continue;
    return { at: m.index, length: m[0].length };
  }
  return null;
};

/** Drops hits where the hero itself owns the thing ("reduce Cho's Armor by 25"). */
function notSelfOwned(finder: Finder): Finder {
  return (s, e, ctx) => {
    const hit = finder(s, e, ctx);
    if (!hit) return null;
    const around = s.masked.slice(Math.max(0, hit.at - 10), hit.at + hit.length + 10);
    return new RegExp(`\\b(?:${ctx.selfWords}|Cho|Gall)'s\\s+Armor\\b`, 'i').test(around) ? null : hit;
  };
}

// ---- percent-of-max-Health damage ------------------------------------------------------

/** "N% of their maximum Health" (owner optional; never the hero's own or an ally's Health). */
const PCT_HP = String.raw`\d+(?:\.\d+)?%\s+(?:of\s+)?(?:(?:their|the target's|its|the enemy's|enemy Heroes'|Heroes'|an enemy's)\s+)?max(?:imum)?\s+Health`;
const PERCENT_HP_DAMAGE = new RegExp(
  [
    // "8% of their maximum Health as damage", "1% maximum Health as bonus damage"
    String.raw`${PCT_HP}\s+(?:as|in)\s+(?:bonus\s+|additional\s+|Spell\s+|Physical\s+)?damage`,
    // "bonus damage equal to 4% of their maximum Health"
    String.raw`\bdamage\s+(?:to\s+[\w']+\s+)?(?:equal to|of)\s+(?:up to\s+)?${PCT_HP}`,
    // "dealing up to 20% of their maximum Health", "take an additional 2% of their maximum Health"
    String.raw`\b(?:deal\w*|take|takes|taking)\s+(?:an additional\s+|a bonus\s+|additional\s+|bonus\s+|up to\s+)?${PCT_HP}`,
  ].join('|'),
  'i',
);

const percentHpDamage: Finder = (s) => {
  const m = PERCENT_HP_DAMAGE.exec(s.masked);
  if (!m) return null;
  // Shields that absorb "damage equal to 14% of their maximum Health" are not damage.
  if (/\babsorb\w*\s+damage\s+equal/i.test(s.masked.slice(Math.max(0, m.index - 12), m.index + m[0].length))) return null;
  return { at: m.index, length: m[0].length };
};

// ---- shields ---------------------------------------------------------------------------

const ENEMY_SHIELD_RE =
  /\b(?:destroy\w*|remov\w*|break\w*|strip\w*|bonus damage (?:to|against)|damage (?:to|against)|deal\w*\s+(?:[\w%]+\s+){0,3}?damage\s+(?:to|against))\s+(?:enemy\s+|their\s+|all\s+|any\s+)?Shields?\b/gi;
const shieldGain: Finder = (s) => {
  const text = blank(s.masked, ENEMY_SHIELD_RE);
  const res = [
    /\b(?:gain|gains|gaining|grant|grants|granting|give|gives|giving|create|creates|creating|apply|applies|applying|receive|receives|provide|provides|providing|with)\b[^.]{0,50}?\bShields?\b/i,
    /\bShield(?:s|ing)?\s+(?:the|an|target|nearby|all|allied|assisted|himself|herself|itself|yourself|allies|him|her|them|\w+ for)\b/i,
    /\bShields?\s+(?:equal|that absorbs|of|for|which|absorbing|lasting)\b/i,
    /\bpoint Shield\b/i,
  ];
  for (const re of res) {
    const m = re.exec(text);
    if (m) {
      const idx = text.indexOf('Shield', m.index);
      return { at: idx >= 0 ? idx : m.index, length: 6 };
    }
  }
  return null;
};

// ---- armor -----------------------------------------------------------------------------

function armorGain(kind: 'Spell' | 'Physical'): Finder {
  return (s) => {
    for (const m of s.masked.matchAll(new RegExp(`\\b\\d+\\s+${kind} Armor\\b`, 'g'))) {
      const before = windowBefore(s.masked, m.index, 40);
      if (/\b(?:reduc\w*|lower\w*|los\w*|remov\w*|ignor\w*|shred\w*|enemies|enemy)\b[^.]*$/i.test(before) && !/\b(?:gain|grant)/i.test(before)) continue;
      // Summons with armor ("Beetles have 30 Spell Armor") are not the hero.
      if (new RegExp(`\\b(?:${NON_HERO_UNITS}|Beetles?|Pufferfish)\\s+(?:gains?|has|have)\\s+$`, 'i').test(before)) continue;
      return { at: m.index, length: m[0].length };
    }
    if (kind === 'Spell') {
      const m = /\breduc\w*\s+(?:that damage and further\s+|all\s+)?Ability Damage(?: taken)?\s+by\s+\d+%/i.exec(s.masked);
      if (m) return { at: m.index, length: m[0].length };
    }
    return null;
  };
}

// ---- tag rules -------------------------------------------------------------------------

const SKIP_MOUNT: AbilityKind[] = ['mount'];

const RULES: TagRule[] = [
  // crowd control
  {
    tag: 'stun',
    find: unless(
      cleanFinder(
        /\bstun(?:s|ning)?\b(?!\s+(?:minions|structures|non-heroic|mercenaries))/i,
        /\b(?:are|is|be|being|becomes?|get)\s+(?:also\s+|then\s+|briefly\s+|instantly\s+)?stunned\b/i,
        /\bstunned\s+for\b/i,
        // Suppression ("trapped… cannot move or act", "Devoured enemies cannot fight") works like a stun.
        /\b(?:cannot|can't)\s+(?:move or act|fight)\b/i,
      ),
      /\bto neutral Mercenaries\b/i,
    ),
  },
  {
    tag: 'root',
    find: cleanFinder(/\broot(?:s|ing)?\b/i, /\b(?:are|is|be|becomes?)\s+(?:also\s+|then\s+)?rooted\b/i, /\brooted\s+for\b/i),
  },
  {
    tag: 'slow',
    find: (s, e, ctx) => {
      const hit = cleanFinder(
        /\bslow(?:s|ing)?\b(?!-)/i,
        /\b(?:are|is|be|becomes?)\s+(?:also\s+|then\s+)?slowed\b/i,
        /\bslowed\s+by\b/i,
        /\breduc\w*\s+(?:their|its|the target's|enemy|enemies'|enemy Heroes'?)\s+Movement Speed\b/i,
      )(s, e, ctx);
      if (!hit) return null;
      // Attack-speed-only slows are not movement slows.
      const around = s.clean.slice(hit.at, hit.at + 60);
      if (/Attack Speed/i.test(around) && !/Movement Speed/i.test(s.clean)) return null;
      return hit;
    },
  },
  {
    tag: 'silence',
    find: cleanFinder(/\bsilenc(?:e|es|ing)\b/i, /\b(?:are|is|be)\s+(?:also\s+)?silenced\b/i, /\bsilenced\s+for\b/i),
  },
  {
    tag: 'blind',
    find: cleanFinder(/\bblind(?:s|ing)?\b(?!\s+(?:rage|effects?))/i, /\b(?:are|is|be)\s+(?:also\s+)?blinded\b/i, /\bblinded\s+(?:for|and)\b/i),
  },
  {
    tag: 'polymorph',
    find: cleanFinder(
      /\bpolymorph(?:s|ing)?\b/i,
      /\b(?:are|is|be)\s+polymorphed\b/i,
      /\b(?:transform|turn)s?\s+(?:an?\s+|the\s+|target\s+)?(?:enemy|enemies|target)(?:\s+Heroes?)?\s+into\b/i,
    ),
  },
  { tag: 'sleep', find: cleanFinder(/\bto sleep\b/i, /\bsleep(?:s|ing)?\s+(?:enemy|enemies|them|the target|target)\b/i, /\basleep\b/i) },
  {
    tag: 'taunt',
    find: cleanFinder(
      /\btaunt(?:s|ing)?\s+(?:enemy|enemies|nearby|all|the|target|them)\b/i,
      /\bforc(?:e|es|ed|ing)\s+(?:[\w']+\s+){0,4}?to attack\b/i,
      /\b(?:are|is)\s+taunted\b/i,
    ),
  },
  {
    tag: 'fear',
    find: cleanFinder(
      /\bfear(?:s|ing)?\s+(?:them|enemies|enemy|nearby|all|the|target)\b/i,
      /\bin fear\b/i,
      /\b(?:forced|force them|forcing them)\s+to\s+(?:run|flee)\b/i,
      /\b(?:are|is)\s+feared\b/i,
    ),
  },
  {
    tag: 'displace',
    find: cleanFinder(
      /\bknock(?:s|ing|ed)?\s+(?:[\w']+\s+){0,4}?(?:back|away|aside|into the air)\b/i,
      /\bknockback\b/i,
      /\bpush(?:es|ing)?\s+(?:[\w']+\s+){0,4}?(?:away|back|aside)\b/i,
      /\bpushed\s+(?:[\w']+\s+)?(?:away|back|aside)\b/i,
      // "pushing Alarak and all enemies hit … towards the targeted direction"
      /\bpush(?:es|ing)?\s+(?:[\w'§]+\s+){0,3}?(?:all\s+)?(?:enemies|enemy Heroes|the target|them)\b(?!\s+(?:lanes?|Structures?))/i,
      /\b(?:throw|throws|throwing|toss|tosses|tossing|kick|kicks|kicking|punt|punts|fling|flings)\s+(?:them|the target|target enemy|an enemy|the enemy|enemies|enemy Heroes|the first enemy)\b/i,
      // Enemies sent back to an earlier position (Temporal Loop).
      /\b(?:they|enemies|enemy Heroes|the target)\s+(?:are|is)\s+teleported\b/i,
    ),
  },
  {
    tag: 'pull',
    find: cleanFinder(
      /\bpull(?:s|ing|ed)?\s+(?:[\w']+\s+){0,5}?(?:toward|towards|together)\b/i,
      /\bpull(?:s|ing)?\s+(?:the first|enemies|an enemy|the target|target|them|all|nearby|enemy)\b/i,
      /\bdraws?\s+(?:[\w']+\s+){0,4}?toward/i,
      /\bdrag(?:s|ging)?\s+(?:them|the target|enemies|it|the enemy|an enemy)\b/i,
      /\bforced to walk towards?\b/i,
    ),
  },
  { tag: 'time-stop', find: cleanFinder(/\btime stop\b/i) },

  // defensive and mobility
  { tag: 'unstoppable', find: unstoppableSelf },
  {
    tag: 'invulnerable',
    find: unless(
      maskedFinder(/\binvulnerab(?:le|ility)\b/i, /\bProtected\b/, /\bprevent(?:ing|s)?\s+all\s+(?:incoming\s+)?damage\b/i, /\bimmune to all damage\b/i),
      new RegExp(`\\b(?:${NON_HERO_UNITS})\\s+(?:are|is)\\s+(?:also\\s+)?Invulnerable\\b|\\bHearthstone\\b`, 'i'),
    ),
  },
  { tag: 'stasis', find: maskedFinder(/\bstasis\b/i) },
  { tag: 'untargetable', find: maskedFinder(/\buntargetable\b/i, /\bcan(?:not|'t) be targeted\b/i) },
  {
    tag: 'unkillable',
    find: maskedFinder(/\bunkillable\b/i, /\bcannot (?:die|be killed)\b/i, /\bcannot be reduced to (?:less|below)\b/i, /\bcannot drop below\b/i),
  },
  { tag: 'cleanse', find: combine(removalCleanse, unstoppableAlly) },
  { tag: 'spell-armor', find: armorGain('Spell') },
  { tag: 'physical-armor', find: armorGain('Physical') },
  {
    tag: 'block',
    find: maskedFinder(
      /\b(?:stacks? of|charges? of|gains?|grants?)\s+Block\b|\bBlock (?:charge|stack)s?\b/,
      // Not "blocks 330 damage with Deflect": damage blocking is not Basic Attack block.
      /\bblock(?:s|ing)?\s+(?:the next|incoming|\d+\s+(?:enemy\s+)?(?:Hero(?:ic)?\s+)?Basic|enemy Basic|Basic)\b/i,
      /\bparr(?:y|ies|ying)\b/i,
      /\b(?:evade|evades|evading|evasion|dodge|dodges|dodging)\b/i,
      /\breduc\w*\s+the damage (?:of|from)\s+(?:the next\s+)?(?:\d+\s+)?(?:incoming\s+)?(?:enemy\s+)?(?:Hero\s+)?Basic Attacks?\b/i,
      /\bPhysical Armor against\b/i,
    ),
  },
  { tag: 'shield', find: shieldGain },
  { tag: 'heal-self', find: healFinder('self') },
  { tag: 'heal-ally', find: healFinder('ally') },
  {
    tag: 'stealth',
    find: maskedFinder(
      /\b(?:gain|gains|gaining|grant|grants|granting|enter|enters|entering|become|becomes|becoming|is|are|remain|remains)\s+(?:[\w']+\s+){0,2}?(?:Stealth|Stealthed|Cloaked|invisible)\b/i,
      /\bStealth(?:ed)?\s+(?:for|while|when|until|after)\b/i,
      /\bpermanently\s+(?:Stealthed|Cloaked)\b/i,
      /\bvanish(?:es|ing)?\b/i,
    ),
  },
  {
    tag: 'reveal',
    find: unless(
      cleanFinder(/\breveal(?:s|ing)?\b/i, /\b(?:are|is|become|becomes)\s+revealed\b/i, /\bdetect(?:s|ing)?\s+(?:Stealthed|nearby|enemy)/i),
      /\b(?:Stealthed and )?Revealed\s+(?:while|when)\b/,
    ),
  },
  {
    tag: 'dash',
    find: unless(
      maskedFinder(
        /\b(?:dash|dashes|dashing|lunge|lunges|lunging|leap|leaps|leaping|vault|vaults|vaulting|pounce|pounces|pouncing|swoop|swoops|tumble|tumbles|blink|blinks)\b/i,
        // "Charge to the target enemy", "Charge at an enemy" — not "all charges at the same time".
        /(?<!\b(?:all|its|of|the|their|additional|extra|\d+)\s)\bcharg(?:e|es|ing)\s+(?:forward\s+)?(?:at|toward|towards|forward|into|through|in a|to (?:the |an? )?(?:target|enemy|ally|location|area))\b/i,
        /\b(?:jump|jumps|jumping|hop|hops|roll|rolls|rolling|surge|surges)\s+(?:forward|over|toward|towards|onto|across|to (?:the |a |an |target))\b/i,
        /\bquickly (?:move|travel)s?\b/i,
        // "Kick through target enemy" (Flying Kick) moves the hero through its target.
        /\bkicks?\s+through\b/i,
      ),
      new RegExp(`\\b(?:${NON_HERO_UNITS}|Misha|Murlocs?|Ghouls?|Boars|Wolves|meteors?|enemies|enemy Heroes)\\b[^.]{0,40}?\\b(?:dash|dashes|charge|charges|leap|leaps|leaping|rolls)\\b`, 'i'),
    ),
  },
  {
    tag: 'teleport',
    find: unless(
      maskedFinder(
        /\bteleport(?:s|ing|ed)?\b/i,
        /\btunnel(?:s|ing)?\s+to\b/i,
        /\bburrow(?:s|ing)?\s+to\b/i,
        /\bwarp(?:s|ing)?\s+to\b/i,
        /\bswap(?:s|ping)?\s+(?:places|positions|locations?)\b/i,
        /\bswapping it with\b/i,
        /\breturn(?:s|ing)?\s+to\s+(?:her|his|its|their)\s+(?:original|previous|recall|marked)\b/i,
      ),
      /\b(?:Hall of Storms|Hearthstone)\b|\b(?:they|enemies|enemy Heroes|the target)\s+(?:are|is)\s+teleported\b/i,
    ),
  },

  // damage and macro
  { tag: 'percent-hp-damage', find: percentHpDamage },
  { tag: 'anti-heal', find: antiHeal },
  {
    tag: 'armor-shred',
    find: notSelfOwned(
      maskedFinder(
        /\b(?:reduc\w*|lower\w*|decreas\w*|shred\w*)\s+(?:[\w']+\s+){0,5}?Armor\s+by\s+\d+/i,
        /\b(?:enemies|enemy|they|targets?|Heroes)\s+(?:[\w']+\s+){0,3}?lose\s+\d+\s+Armor\b/i,
        /\bArmor\s+(?:is\s+)?(?:reduced|lowered)\s+by\b/i,
        /\breduce\s+(?:their|the target's|its|enemy)\s+Armor\b/i,
        /\bignor\w*\s+(?:[\w']+\s+){0,2}?Armor\b/i,
        /\bVulnerab(?:le|ility)\b/,
        /\bmaximum reduction of \d+\s+(?:Physical |Spell )?Armor\b/i,
      ),
    ),
  },
  {
    tag: 'dot',
    find: unless(
      cleanFinder(
        /\bdeal\w*\s+(?:an additional\s+|additional\s+)?(?:\d+%?\s+)?(?:bonus\s+|more\s+)?damage\s+over\s+(?:\d|the|several|a few)/i,
        /\b\d+\s+(?:bonus\s+)?damage\s+over\s+(?:\d|the next)/i,
        /\bdamage over time\b/i,
        /\b(?:burn|burns|burning|ignite|ignites|poison|poisons|bleed)\s+(?:nearby\s+|all\s+)?(?:enemies|enemy|them|their target|the target|targets|Brew-soaked)\b/i,
        /\b(?:Burning|Ignited|Poisoned|poisoned|bleeding)\s+(?:enemies|enemy|targets?|Heroes)\b/,
        /\bcause\w*\s+(?:enemies|them)\s+to\s+(?:bleed|burn)\b/i,
        /\b(?:set|light)\s+(?:enemies|them|it)?\s*on fire\b/i,
        /\btake\s+\d+\s+damage\s+(?:every|over|per second for)\b/i,
        /\b(?:damage|damaging)\s+(?:them\s+)?(?:every|each)\s+(?:\d+(?:\.\d+)?\s+)?seconds?\s+for\s+\d/i,
      ),
      /\b(?:lose|loses|losing)\s+(?:Health|health)\s+over\b|\babsorb\w*\s+(?:up to\s+)?\d+\s+damage\s+over\b/,
    ),
  },
  {
    tag: 'aoe',
    find: unless(
      maskedFinder(
        /\b(?:damage|damaging|dealing|deals?|hits?|hitting|explod\w*)\b[^.]{0,70}?\b(?:nearby enemies|enemies in (?:an?|the|its)\s+(?:[\w-]+\s+)?(?:area|radius|cone|line|path|arc)|enemies within|all enemies|enemies hit|enemies around|in an area|in a (?:large |small |wide |long )?(?:area|cone|line|arc|radius)|in its path|enemies in its path|enemies in the (?:target )?area|surrounding enemies|enemies near|enemies along)\b/i,
        /\b(?:nearby enemies|all enemies|enemies in (?:an|the) (?:target )?area|enemies hit)\b[^.]{0,40}?\b(?:take|takes|taking)\b[^.]{0,20}\bdamage\b/i,
        /\b(?:an area|the area|target area|a cone|a line|an arc)\b[^.]{0,60}?\b(?:damage|dealing)\b/i,
        /\bdeal\w*\s+(?:an additional\s+|up to\s+)?\d+\s+(?:bonus\s+|additional\s+|Spell\s+)?damage\s+(?:to\s+)?(?:all\s+)?(?:enemies|nearby enemies)\b/i,
        /\bsplash\b/i,
      ),
      // Damage the hero takes is not area damage it deals; a skillshot that stops at the first
      // enemy is single-target even when it is aimed at an area.
      /\bdamage\s+(?:dealt\s+)?to\s+(?:the\s+)?(?:Mech|him|her|you)\b|\bdamage taken\b|\bto the first enemy\b(?![^.]*\b(?:nearby enemies|enemies in|all enemies|in an area)\b)/i,
    ),
  },
  {
    tag: 'summons',
    find: unless(
      maskedFinder(
        // "Spawns a Locust to attack…", "Create a turret that attacks…", "Summon a Gargantuan to guard an area".
        /\b(?:summon|summons|summoning|spawn|spawns|spawning|raise|raises|raising|deploy|deploys|deploying|hatch|hatches|create|creates|creating|build|builds|call(?:s)? (?:down|forth))\b(?!\s+(?:a\s+)?Mount\b)[^.]{0,60}?\b(?:that|which|to)\b[^.]{0,30}?\b(?:attack|attacks|attacking|fight|fights|walk|walks|march|marches|chase|chases|guard|guards)\b/i,
        /\b(?:summon|summons|summoning|spawn|spawns|spawning|raise|raises|call(?:s)? down|warps? in)\s+(?:[\w'-]+\s+){0,4}?(?:Locusts?|Skeletal\s+\w+|Skeletons?|Warriors?|Hydralisks?|Banelings?|Roachlings?|Zerglings?|Demons?|Imps?|Turrets?|Treants?|Wolves|Spiders?|Spiderlings?|Scarabs?|Beetles?|Ghouls?|Golems?|Elementals?|Hounds?|Gnolls?|Probes?|Pylons?|Photon Cannons?|Clones?|Mirror Images?|Minions?|Lieutenants?|Ultralisks?|Raiders?|Hyperion|Banshees?|Zombies?|Gargantuan|Sentry|Totems?|Infestors?)\b/i,
        /\bcreates?\s+(?:a|an|\d+)\s+(?:[\w'-]+\s+){0,2}?(?:copies|copy|clones?|Mirror Images?|illusions?)\b/i,
      ),
      /\bSummon Mount\b|\bSummons that attack\b|\bHeroes and Summons\b/i,
    ),
  },
  {
    tag: 'global',
    find: unless(
      maskedFinder(
        // Not "unlimited range": that is a long-range shot or beam fired from where the hero stands.
        /\banywhere\b(?!\s+within\s+(?:\d|range))/i,
        /\bglobal (?:cast )?range\b/i,
        /\bon the Battleground\b/i,
        /\bacross the (?:battlefield|battleground|map)\b/i,
        /\bany (?:allied|friendly) (?:Hero|Structure|Minion|Mercenary|Fort|Keep)/i,
        /\b(?:allied|destroyed) Fort or Keep\b/i,
        /\ba great distance\b/i,
        /\bentire (?:map|Battleground)\b/i,
      ),
      // Map-wide vision is not map-wide presence.
      /\breveal\w*\b|\bvision\b/i,
    ),
  },
  {
    tag: 'waveclear',
    find: maskedFinder(
      /\b(?:\d+%\s+)?(?:increased|bonus|more|additional)\s+damage\s+(?:to|against|versus|vs\.?)\s+(?:enemy\s+)?(?:Minions|non-Heroes|non-Heroic|Minions and Mercenaries|Minions, Mercenaries)/i,
      /\binstantly kill(?:s|ing)?\s+(?:enemy\s+)?Minions\b/i,
    ),
  },
  {
    tag: 'siege',
    find: maskedFinder(
      /\b(?:\d+%\s+)?(?:increased|bonus|more|additional)\s+damage\s+(?:to|against|versus|vs\.?)\s+(?:enemy\s+)?Structures\b/i,
      /\bsiege\b(?!\s+Mode)/i,
      /\b(?:disable|disables|disabling)\b[^.]{0,50}?\b(?:Structures|Towers|Forts)\b/i,
      /\b(?:attack|walk|walks|march|marches|push|pushes)\s+(?:down|along)\s+the\s+(?:nearest\s+|targeted\s+)?lane\b/i,
      /\bStructures\s+(?:hit\s+)?are disabled\b/i,
      /\bno longer deals? reduced damage to Structures\b/i,
      /\bdamage to Structures is increased\b/i,
      /\bat a Structure\b/i,
      /\battack(?:s|ing)?\s+(?:enemy\s+)?Structures\b/i,
    ),
  },
  {
    tag: 'channel',
    skipKinds: SKIP_MOUNT,
    // A channel that makes the hero Protected or Unstoppable cannot be interrupted (Deflect,
    // Lightning Breath, Counter-Strike).
    skipEntry: /\b(?:Unstoppable|Protected|Invulnerab\w*)\b/,
    find: unless(
      maskedFinder(/\bchannel(?:s|ing|ed|led|ling)?\b/i),
      // Interrupting someone else's channel, abilities usable during a channel, and channels that
      // make the hero Protected/Unstoppable (they cannot be interrupted) are not a weakness.
      /\b(?:interrupt\w*|cancel\w*)\s+(?:[\w']+\s+){0,2}?(?:enemy\s+)?channel|\bor Channeling\b|\b(?:can be (?:cast|used)|usable)\s+while\s+channel\w*|\b(?:Unstoppable|Protected|Invulnerab\w*)\b/i,
    ),
  },
];

// ---- entries ---------------------------------------------------------------------------

function selfWords(hero: HeroInput): string {
  // Not "they"/"it": in tooltips those almost always mean the enemies hit.
  const words = new Set<string>(['he', 'she', 'himself', 'herself', 'Vikings', 'Viking']);
  const name = hero.name.replace(/^The\s+/i, '');
  words.add(hero.name);
  words.add(name);
  for (const part of name.split(/[\s'.-]+/)) if (part.length >= 3) words.add(part);
  if (hero.members) {
    words.add('Cho');
    words.add('Gall');
  }
  return [...words]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const REFERENCE_BEFORE = /\b(?:of|with|by|cast|casting|use|using|uses|during|into|hitting|hits|after|reset|resets|reactivate|activate|activating|cooldown of)\s+$/i;
const REFERENCE_AFTER = /^(?:'s\b|s'|\s+(?:deals|now|also|gains|can|will|has|reduces|increases|grants|applies|removes|heals|is|becomes|hits|lasts|spreads|travels|explodes|no longer|causes)\b)/;

function maskNames(sentence: string, names: string[]): string {
  let out = sentence;
  for (const name of names) {
    if (/\s/.test(name)) {
      out = maskPhrase(out, name);
      continue;
    }
    // Single-word names only where the sentence clearly refers to the ability.
    const re = new RegExp(`(?<![\\w'])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'g');
    out = out.replace(re, (m, offset: number) => {
      const before = out.slice(0, offset);
      const after = out.slice(offset + m.length);
      return REFERENCE_BEFORE.test(before) || REFERENCE_AFTER.test(after) ? '§'.repeat(m.length) : m;
    });
  }
  return out;
}

const QUEST_SENTENCE = /^(?:Repeatable\s+)?Quest:/i;

function buildEntries(hero: HeroInput, ctx: Ctx): Entry[] {
  const abilityNames = new Set(hero.abilities.map((a) => a.name));
  const allNames = new Set<string>(abilityNames);
  for (const tier of TALENT_TIERS) for (const t of hero.talents[tier]) allNames.add(t.name);
  const names = [...allNames].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  const prepare = (text: string): Sentence[] =>
    splitSentences(text)
      .filter((s) => !QUEST_SENTENCE.test(s))
      .map((original) => {
        const masked = maskNames(original, names);
        return { original, masked, clean: stripNonApplying(masked, ctx) };
      });

  const entries: Entry[] = [];
  for (const a of hero.abilities) {
    // Hearthstone and plain mounts carry no hero mechanics.
    if (/^(?:Hearthstone|Summon Mount)$/.test(a.name)) continue;
    entries.push({ kind: 'ability', name: a.name, abilityKind: a.kind, quest: false, text: normalizeText(a.text), sentences: prepare(a.text) });
  }
  for (const tier of TALENT_TIERS) {
    for (const t of hero.talents[tier]) {
      // Heroic abilities are repeated as talents; the ability is the single source.
      if (abilityNames.has(t.name)) continue;
      entries.push({ kind: 'talent', name: t.name, tier, quest: t.quest === true, text: normalizeText(t.text), sentences: prepare(t.text) });
    }
  }
  return entries;
}

// ---- derived, hero-level tags ----------------------------------------------------------

/** Talents that make Basic Attacks stronger or faster. */
const AA_BOOST =
  /\b(?:Basic Attacks?|Attack Speed|Attack Damage)\b[^.]{0,60}?\b(?:increas\w*|bonus|additional|more|extra|deal|deals|empower\w*|cleave|splash|bounce)\b|\b(?:increas\w*|bonus|additional|gain\w*|grant\w*)\b[^.]{0,30}?\b(?:Attack Speed|Basic Attack damage|Attack Damage|Basic Attack range)\b/i;
/** Abilities whose effect is built around Basic Attacks. */
const AA_MENTION = /\bBasic Attacks?\b|\bAttack Speed\b|\bAttack Damage\b/;
/** Sentences about Basic Attacks the hero receives ("Parry all incoming Basic Attacks"). */
const AA_INCOMING = /\b(?:incoming|enemy|enemies'?)\s+(?:Hero\s+)?Basic Attacks?\b/i;
/** Damage numbers: "deals 153 damage", "dealing 225 damage", "400 to 1100 damage" (→ 1100). */
const DAMAGE_NUMBER = /\b(\d+)(?:\s+to\s+(\d+))?\s+(?:bonus\s+|additional\s+|Spell\s+|Physical\s+|Ability\s+)?damage\b/g;

/** Largest single-hit damage number in a sentence (not per-second, over-time, shields, structures or quests). */
function maxHit(text: string): { value: number; at: number; length: number } | null {
  // "Deal 552 damage to the target … over 4 seconds" is damage over time, not a hit.
  // Bonus damage for a completed channel is conditional, not a reliable hit.
  if (/\bover\s+(?:the next\s+)?\d+(?:\.\d+)?\s+seconds?\b|\bper second\b|\bfull duration\b/i.test(text)) return null;
  let best: { value: number; at: number; length: number } | null = null;
  for (const m of text.matchAll(DAMAGE_NUMBER)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (/^\s*(?:per second|every|a second|each second|over|to non-|to Structures|against Structures|to Minions)/i.test(after)) continue;
    if (/absorb\w*\s*(?:up to\s*)?$|\b(?:Upon|After)\s+dealing\s*$|\bat a Structure,?\s*dealing\s*$|%\s*$|\bby\s*$/i.test(before)) continue;
    const value = Number(m[2] ?? m[1]);
    if (!best || value > best.value) best = { value, at: m.index, length: m[0].length };
  }
  return best;
}

interface Derived {
  tag: MechanicTag;
  hits: Hit[];
}

/** Thresholds of the derived tags, calibrated on the 2.57 roster (docs/THEORY.md). */
const AA_RELIANT_SCORE = 6;
const AA_RELIANT_TALENTS = 3;
const BURST_SINGLE = 220;
const BURST_PAIR = 400;
const BURST_HEROIC = 600;
const POKE_MIN_HIT = 75;

const ASSASSINS = new Set<HeroInput['role']>(['Ranged Assassin', 'Melee Assassin']);
const DAMAGE_ROLES = new Set<HeroInput['role']>(['Ranged Assassin', 'Melee Assassin', 'Bruiser']);

function derive(hero: HeroInput, entries: Entry[], hits: Map<MechanicTag, Hit[]>): Derived[] {
  const out: Derived[] = [];
  const firstSentenceHit = (e: Entry, re: RegExp, veto?: RegExp): Hit | null => {
    for (const s of e.sentences) {
      if (veto?.test(s.masked)) continue;
      const m = re.exec(s.masked);
      if (m) return { entry: e, sentence: s, at: m.index, length: m[0].length };
    }
    return null;
  };
  const isHit = (h: Hit | null): h is Hit => h !== null;
  const basics = entries.filter((e) => e.kind === 'ability' && (e.abilityKind === 'basic' || e.abilityKind === 'trait' || e.abilityKind === 'active'));

  // aa-reliant: abilities built around Basic Attacks plus a talent tree that keeps boosting them.
  // Score = 2 × such abilities + boosting talents; damage roles only (tanks/healers are not carries).
  // Deliberately strict (mixed heroes such as Sonya or Sylvanas stay out); curators add the rest.
  const aaCore = basics.map((e) => firstSentenceHit(e, AA_MENTION, AA_INCOMING)).filter(isHit);
  const aaTalents = entries.filter((e) => e.kind === 'talent').map((e) => firstSentenceHit(e, AA_BOOST)).filter(isHit);
  const aaScore = 2 * aaCore.length + aaTalents.length;
  const aaReliant = DAMAGE_ROLES.has(hero.role) && aaCore.length >= 1 && aaTalents.length >= AA_RELIANT_TALENTS && aaScore >= AA_RELIANT_SCORE;
  if (aaReliant) out.push({ tag: 'aa-reliant', hits: [...aaCore, ...aaTalents] });

  // sustained-dps: Basic-Attack carries, or two or more basic abilities that deal damage over time.
  const ticking = basics.map((e) => firstSentenceHit(e, /\b\d+\s+damage\s+(?:per second|every\s+(?:\d+(?:\.\d+)?\s+)?seconds?|a second)\b/i)).filter(isHit);
  if (aaReliant || (ticking.length >= 2 && DAMAGE_ROLES.has(hero.role))) {
    out.push({ tag: 'sustained-dps', hits: ticking.length >= 2 ? ticking : [...aaCore, ...aaTalents] });
  }

  // burst: assassins whose damage comes in large single hits rather than a stream of Basic Attacks
  // (a basic ability hitting for ≥ 220, two hitting for ≥ 400 together, or a Heroic hitting for
  // ≥ 600). Blizzard's damage rating is not used: nearly every assassin is rated 8 or more.
  if (ASSASSINS.has(hero.role) && !aaReliant) {
    const big: Hit[] = [];
    const basicHits: { hit: Hit; value: number }[] = [];
    for (const e of entries) {
      if (e.kind !== 'ability' || e.abilityKind === 'mount' || e.abilityKind === 'trait') continue;
      let best: { hit: Hit; value: number } | null = null;
      for (const s of e.sentences) {
        const m = maxHit(s.masked);
        if (m && (!best || m.value > best.value)) best = { hit: { entry: e, sentence: s, at: m.at, length: m.length }, value: m.value };
      }
      if (!best) continue;
      if (e.abilityKind === 'heroic') {
        if (best.value >= BURST_HEROIC) big.push(best.hit);
      } else {
        basicHits.push(best);
      }
    }
    basicHits.sort((a, b) => b.value - a.value);
    const top = basicHits[0]?.value ?? 0;
    const top2 = top + (basicHits[1]?.value ?? 0);
    if (top >= BURST_SINGLE || top2 >= BURST_PAIR || big.length > 0) {
      out.push({ tag: 'burst', hits: [...basicHits.slice(0, 2).map((b) => b.hit), ...big] });
    }
  }

  // poke: a ranged damage dealer (not a Basic-Attack carry) with two or more basic abilities that
  // hit for a real chunk. Tooltips rarely say how an ability is aimed, so role and numbers decide.
  if (hero.type === 'Ranged' && (hero.role === 'Ranged Assassin' || hero.role === 'Support') && !aaReliant) {
    const shots: Hit[] = [];
    for (const e of entries) {
      if (e.kind !== 'ability' || e.abilityKind !== 'basic') continue;
      for (const s of e.sentences) {
        const m = maxHit(s.masked);
        if (m && m.value >= POKE_MIN_HIT) {
          shots.push({ entry: e, sentence: s, at: m.at, length: m.length });
          break;
        }
      }
    }
    if (shots.length >= 2) out.push({ tag: 'poke', hits: shots });
  }

  // waveclear: explicit minion damage, or area damage on two or more basic abilities.
  const aoeBasics = (hits.get('aoe') ?? []).filter((h) => h.entry.kind === 'ability' && (h.entry.abilityKind === 'basic' || h.entry.abilityKind === 'trait'));
  const aoeBasicNames = new Set(aoeBasics.map((h) => h.entry.name));
  if (aoeBasicNames.size >= 2) out.push({ tag: 'waveclear', hits: aoeBasics });
  return out;
}

// ---- main ------------------------------------------------------------------------------

/** Dev aid: every sentence the extractor reads, with its masked and cleaned forms. */
export function debugSentences(hero: HeroInput): { name: string; kind: 'ability' | 'talent'; original: string; masked: string; clean: string }[] {
  const ctx: Ctx = { hero, selfWords: selfWords(hero) };
  return buildEntries(hero, ctx).flatMap((e) => e.sentences.map((s) => ({ name: e.name, kind: e.kind, ...s })));
}

const TAG_ORDER = new Map<string, number>(MECHANIC_TAGS.map((t, i) => [t, i]));

function evidenceOrder(a: Hit, b: Hit): number {
  const rank = (h: Hit) => (h.entry.kind === 'ability' ? 0 : 1);
  return rank(a) - rank(b);
}

/**
 * Extracts mechanics tags from a hero's ability and talent text. Pure and deterministic; tags
 * come out in MECHANIC_TAGS order, evidence abilities first (kit order), then talents by tier.
 * Composites (no kit of their own) return []: the engine merges their members' mechanics.
 */
export function extractMechanics(hero: HeroInput): Mechanic[] {
  const ctx: Ctx = { hero, selfWords: selfWords(hero) };
  const entries = buildEntries(hero, ctx);
  const hits = new Map<MechanicTag, Hit[]>();
  for (const rule of RULES) {
    for (const e of entries) {
      if (e.abilityKind && rule.skipKinds?.includes(e.abilityKind)) continue;
      if (rule.skipEntry?.test(e.text)) continue;
      for (const s of e.sentences) {
        const found = rule.find(s, e, ctx);
        if (found) {
          const list = hits.get(rule.tag) ?? [];
          list.push({ entry: e, sentence: s, at: found.at, length: found.length });
          hits.set(rule.tag, list);
          break;
        }
      }
    }
  }
  for (const d of derive(hero, entries, hits)) {
    const list = hits.get(d.tag) ?? [];
    const seen = new Set(list.map((h) => h.entry.name));
    for (const h of d.hits) {
      if (!seen.has(h.entry.name)) {
        list.push(h);
        seen.add(h.entry.name);
      }
    }
    if (list.length) hits.set(d.tag, list);
  }

  const mechanics: Mechanic[] = [];
  for (const [tag, list] of hits) {
    const ordered = [...list].sort(evidenceOrder).slice(0, MAX_EVIDENCE);
    mechanics.push({
      tag,
      evidence: ordered.map((h) => ({
        kind: h.entry.kind,
        name: h.entry.name,
        snippet: snippetAround(h.sentence.original, h.at, h.length),
      })),
    });
  }
  return mechanics.sort((a, b) => (TAG_ORDER.get(a.tag) ?? 0) - (TAG_ORDER.get(b.tag) ?? 0));
}
