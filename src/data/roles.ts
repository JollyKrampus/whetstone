import { frontTypeLine, isCreature, isLand, rulesText } from '../core/cards.js';
import type { CardRecord } from '../core/types.js';

export type Role =
  | 'removal'
  | 'counterspell'
  | 'sweeper'
  | 'card_draw'
  | 'ramp'
  | 'tutor'
  | 'threat'
  | 'protection'
  | 'lifegain';

export const ROLES: Role[] = [
  'removal',
  'counterspell',
  'sweeper',
  'card_draw',
  'ramp',
  'tutor',
  'threat',
  'protection',
  'lifegain',
];

export const INTERACTION_ROLES: Role[] = ['removal', 'counterspell', 'sweeper'];

interface Rule {
  role: Role;
  id: string;
  /** Matched against lowercased rules text with reminder text removed. */
  pattern?: RegExp;
  test?: (c: CardRecord) => boolean;
}

const TARGET_THING = '(?:target|up to (?:one|two) target) (?:\\w+ )?(?:creature|permanent|nonland permanent|artifact|enchantment|planeswalker|battle)';

/**
 * Oracle-text heuristics for card roles. Each match is reported with its rule ID so users
 * can audit (and dispute) a tag. Order doesn't matter; a card can have several roles.
 */
export const RULES: Rule[] = [
  { role: 'removal', id: 'destroy-target', pattern: new RegExp(`destroy ${TARGET_THING}`) },
  { role: 'removal', id: 'exile-target', pattern: new RegExp(`exile ${TARGET_THING}`) },
  {
    role: 'removal',
    id: 'damage-target',
    pattern: /deals? (?:\d+|x|that much) damage to (?:any target|target (?:\w+ )?(?:creature|planeswalker)|up to one target creature)/,
  },
  { role: 'removal', id: 'bite', pattern: /deals? damage equal to (?:its|their|that creature's) power to (?:any other target|target creature|another target)/ },
  { role: 'removal', id: 'fight', pattern: /fights? (?:target|up to one target|another target) creature/ },
  { role: 'removal', id: 'minus-toughness', pattern: /target creature (?:an opponent controls )?gets -\d+\/-\d+/ },
  { role: 'removal', id: 'edict', pattern: /(?:target|each) opponent sacrifices (?:a|an) (?:creature|nontoken creature|attacking creature|permanent)/ },
  { role: 'removal', id: 'bounce', pattern: /return target (?:creature|nonland permanent)[^.]* to its owner's hand/ },
  {
    role: 'removal',
    id: 'aura-lockdown',
    pattern: /enchanted creature can't attack or block|enchanted creature can't attack, block/,
  },
  { role: 'counterspell', id: 'counter-target', pattern: /counter target (?:\w+ )*?spell/ },
  {
    role: 'sweeper',
    id: 'destroy-all',
    pattern: /(?:destroy|exile) all (?:other )?(?:creatures|nonland permanents|permanents|artifacts|enchantments)/,
  },
  { role: 'sweeper', id: 'damage-each', pattern: /deals? \d+ damage to each (?:creature|other creature|opponent and each creature)/ },
  { role: 'sweeper', id: 'all-minus', pattern: /(?:all|each) (?:other )?creatures? (?:your opponents control )?gets? -\d+\/-\d+/ },
  { role: 'sweeper', id: 'each-sacrifices', pattern: /each player sacrifices (?:all|a) creatures?/ },
  {
    role: 'card_draw',
    id: 'draw-cards',
    // "draw", not "draws": "you draw" / "Draw a card", never "whenever an opponent draws a card".
    pattern: /\bdraw (?:a|an additional|two|three|four|x|that many) cards?/,
  },
  { role: 'card_draw', id: 'impulse', pattern: /exile the top (?:card|two cards|three cards)[^.]*\. (?:until|you may play|you may cast)/ },
  { role: 'card_draw', id: 'investigate', pattern: /\binvestigate\b|create (?:a|two) clue tokens?/ },
  { role: 'ramp', id: 'add-mana', test: (c) => !isLand(c) && /\{t\}(?:, [^:]*)?: add \{|add \{[wubrgc]\}|add one mana/.test(rulesText(c)) },
  {
    role: 'ramp',
    id: 'land-search',
    pattern: /search your library for (?:a|up to (?:one|two)) (?:basic )?(?:land|forest|plains|island|swamp|mountain)[^.]*onto the battlefield/,
  },
  { role: 'ramp', id: 'extra-land', pattern: /put a land card from your hand onto the battlefield|play an additional land/ },
  { role: 'ramp', id: 'treasure', test: (c) => !isLand(c) && /create (?:a|two|three|x) (?:tapped )?treasure tokens?/.test(rulesText(c)) },
  {
    role: 'tutor',
    id: 'search-card',
    pattern: /search your library for (?:a|an) (?!basic land|land|forest|plains|island|swamp|mountain)(?:[\w-]+ )*?card/,
  },
  {
    role: 'threat',
    id: 'creature-power',
    test: (c) => isCreature(c) && (Number(c.power) >= 2 || /\b(?:haste|flying|trample|double strike|prowess)\b/.test(rulesText(c))),
  },
  { role: 'threat', id: 'planeswalker', test: (c) => /\bPlaneswalker\b/.test(frontTypeLine(c)) },
  { role: 'threat', id: 'vehicle-or-manland', pattern: /becomes? an? \d+\/\d+[^.]*creature|crew \d/ },
  { role: 'threat', id: 'token-maker', test: (c) => !isCreature(c) && !isLand(c) && /create (?:a|two|three|x) \d+\/\d+[^.]*creature tokens?/.test(rulesText(c)) },
  {
    role: 'protection',
    id: 'grant-protection',
    pattern: /(?:target creature|creatures you control|target permanent|permanents you control)[^.]*gains? (?:hexproof|indestructible|protection|shroud|ward)/,
  },
  { role: 'protection', id: 'phase-out', pattern: /phases? out/ },
  { role: 'lifegain', id: 'gain-life', pattern: /you gain (?:\d+|x|that much) life|gain life equal/ },
  { role: 'lifegain', id: 'lifelink', test: (c) => c.keywords.includes('Lifelink') || /\blifelink\b/.test(rulesText(c)) },
];

export interface RoleTag {
  role: Role;
  rule: string;
}

const memo = new WeakMap<CardRecord, RoleTag[]>();

export function tagRoles(c: CardRecord): RoleTag[] {
  const hit = memo.get(c);
  if (hit) return hit;
  const text = rulesText(c);
  const tags: RoleTag[] = [];
  for (const r of RULES) {
    if (tags.some((t) => t.role === r.role)) continue;
    const match = r.test ? r.test(c) : r.pattern!.test(text);
    if (match) tags.push({ role: r.role, rule: r.id });
  }
  memo.set(c, tags);
  return tags;
}

export function hasRole(c: CardRecord, role: Role): boolean {
  return tagRoles(c).some((t) => t.role === role);
}

export function isInteraction(c: CardRecord): boolean {
  return tagRoles(c).some((t) => INTERACTION_ROLES.includes(t.role));
}
