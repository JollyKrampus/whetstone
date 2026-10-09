/**
 * Test-only: real 2.57 kits (kits.json, trimmed to what the extractor reads) as full HeroInput
 * records, plus the composite Cho'gall built from its members.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TALENT_TIERS, type HeroRole } from '../../schema.ts';
import type { HeroInput } from '../types.ts';

interface KitAbility {
  name: string;
  kind: HeroInput['abilities'][number]['kind'];
  text: string;
}
interface KitTalent {
  name: string;
  text: string;
  quest?: boolean;
}
interface Kit {
  id: string;
  slug: string;
  name: string;
  role: HeroRole;
  type: HeroInput['type'];
  abilities: KitAbility[];
  talents: Record<string, KitTalent[]>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ICON = 'img/icons/fixture.webp';
const RATINGS = { damage: 5, utility: 5, survivability: 5, complexity: 5 };

export function readKits(): Kit[] {
  return (JSON.parse(fs.readFileSync(path.join(HERE, 'kits.json'), 'utf8')) as { heroes: Kit[] }).heroes;
}

export function kitToHero(k: Kit): HeroInput {
  const talents = {} as HeroInput['talents'];
  for (const tier of TALENT_TIERS) {
    talents[tier] = (k.talents[tier] ?? []).map((t, i) => ({ id: `${k.id}-${tier}-${i + 1}`, name: t.name, text: t.text, icon: ICON, sort: i + 1, ...(t.quest ? { quest: true } : {}) }));
  }
  return {
    id: k.id,
    slug: k.slug,
    name: k.name,
    title: k.name,
    role: k.role,
    type: k.type,
    franchise: 'Classic',
    difficulty: 'Medium',
    ratings: RATINGS,
    aliases: [],
    portrait: ICON,
    abilities: k.abilities.map((a, i) => ({ id: `${k.id}-${i + 1}`, name: a.name, hotkey: '', kind: a.kind, text: a.text, icon: ICON })),
    talents,
    ...(k.slug === 'cho' || k.slug === 'gall' ? { memberOf: 'chogall' } : {}),
    isNew: false,
  };
}

const EMPTY_TALENTS: HeroInput['talents'] = { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] };

/** Every fixture hero (Cho and Gall as members) plus the composite `chogall`, sorted by slug. */
export function fixtureHeroInputs(): HeroInput[] {
  const heroes = readKits().map(kitToHero);
  heroes.push({
    id: 'chogall',
    slug: 'chogall',
    name: "Cho'gall",
    title: "Twilight's Hammer Chieftain",
    role: 'Tank',
    roleAlt: 'Ranged Assassin',
    type: 'Melee',
    franchise: 'Warcraft',
    difficulty: 'Hard',
    ratings: RATINGS,
    aliases: [],
    portrait: ICON,
    abilities: [],
    talents: EMPTY_TALENTS,
    members: ['CCho', 'Gall'],
    isNew: false,
  });
  return heroes.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export function fixtureHero(slug: string): HeroInput {
  const h = fixtureHeroInputs().find((x) => x.slug === slug);
  if (!h) throw new Error(`no fixture kit for ${slug}`);
  return h;
}
