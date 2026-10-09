import { describe, expect, it } from 'vitest';
import { LinksSchema } from '../../schema.ts';
import { outboundSlug } from '../util.ts';
import { buildLinks, heroLinks, liquipediaTitles } from './links.ts';

const urlOf = (links: ReturnType<typeof heroLinks>, site: string, kind?: string) => links.find((l) => l.site === site && (!kind || l.kind === kind))?.url;

describe('outbound slugs', () => {
  it.each([
    ["Anub'arak", 'anubarak'],
    ['D.Va', 'dva'],
    ['E.T.C.', 'etc'],
    ["Kel'Thuzad", 'kelthuzad'],
    ['Li Li', 'li-li'],
    ['Li-Ming', 'li-ming'],
    ['Lt. Morales', 'lt-morales'],
    ['Lúcio', 'lucio'],
    ['Sgt. Hammer', 'sgt-hammer'],
    ['The Lost Vikings', 'the-lost-vikings'],
    ["Xal'atath", 'xalatath'],
  ])('%s → %s', (name, slug) => {
    expect(outboundSlug(name)).toBe(slug);
  });
});

describe('heroLinks', () => {
  it('applies the two Icy Veins exceptions', () => {
    expect(urlOf(heroLinks({ id: 'L90E', slug: 'etc', name: 'E.T.C.' }, null), 'icy-veins')).toBe('https://www.icy-veins.com/heroes/e-t-c-build-guide');
    expect(urlOf(heroLinks({ id: 'KelT', slug: 'kelthuzad', name: "Kel'Thuzad" }, null), 'icy-veins')).toBe('https://www.icy-veins.com/heroes/kel-thuzad-build-guide');
    expect(urlOf(heroLinks({ id: 'Wiza', slug: 'liming', name: 'Li-Ming' }, null), 'icy-veins')).toBe('https://www.icy-veins.com/heroes/li-ming-build-guide');
  });

  it('builds Psionic Storm, Nexus Compendium, Heroes Profile and Fandom links', () => {
    const l = heroLinks({ id: 'HXAL', slug: 'xalatath', name: "Xal'atath" }, null);
    expect(urlOf(l, 'psionic-storm')).toBe('https://psionic-storm.com/en/heroes/xalatath/');
    expect(urlOf(l, 'nexus-compendium')).toBe('https://nexuscompendium.com/heroes/xalatath');
    expect(urlOf(l, 'heroesprofile', 'talents')).toBe("https://www.heroesprofile.com/Global/Talents/Xal'atath");
    expect(urlOf(l, 'fandom')).toBe("https://heroesofthestorm.fandom.com/wiki/Xal'atath");
    expect(urlOf(l, 'liquipedia')).toBeUndefined();
  });

  it('adds Liquipedia only when the page exists', () => {
    expect(urlOf(heroLinks({ id: 'CCho', slug: 'cho', name: 'Cho' }, "Cho'gall"), 'liquipedia')).toBe("https://liquipedia.net/heroes/Cho'gall");
  });
});

describe('buildLinks', () => {
  it('covers member heroes only, keyed by id, and validates', () => {
    const links = buildLinks(
      [
        { id: 'CCho', slug: 'cho', name: 'Cho' },
        { id: 'Gall', slug: 'gall', name: 'Gall' },
        { id: 'chogall', slug: 'chogall', name: "Cho'gall", members: ['CCho', 'Gall'] },
      ],
      new Map([['Gall', 'Gall']]),
    );
    expect(Object.keys(links.heroes)).toEqual(['CCho', 'Gall']);
    expect(links.general.length).toBeGreaterThan(0);
    expect(LinksSchema.safeParse(links).success).toBe(true);
  });

  it('checks the composite page as a fallback title for members', () => {
    expect(liquipediaTitles({ id: 'CCho', slug: 'cho', name: 'Cho' }, "Cho'gall")).toEqual(['Cho', "Cho'gall"]);
  });
});
