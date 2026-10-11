import { afterEach, describe, expect, it } from 'vitest';
import type { Edge } from '../../core/game.ts';
import { clearHotsCache, getDraftableEntities, getTheory, netCounter, theoryLists, THEORY_GATES } from './load.ts';

afterEach(() => {
  clearHotsCache();
});

const edge = (a: string, b: string, score: number, source: Edge['source'] = 'theory', text = `${a} over ${b}`): Edge => ({
  a,
  b,
  score,
  source,
  reasons: [{ kind: source === 'curated' ? 'curated' : 'theory', text }],
});

describe('netCounter (one row per opponent, netted like the draft)', () => {
  it('keeps a one-way edge on its side with its own score', () => {
    expect(netCounter(edge('x', 'y', 77), undefined)).toEqual({ side: 'strong', edge: edge('x', 'y', 77) });
    expect(netCounter(undefined, edge('y', 'x', 69))).toEqual({ side: 'weak', edge: edge('y', 'x', 69) });
    expect(netCounter(undefined, undefined)).toBeNull();
  });

  it('puts the opponent on the side of the net and lowers the score by the edge back', () => {
    // Abathur → Zeratul 72 against Zeratul → Abathur 92: Zeratul is a threat, never also a victim.
    const net = netCounter(edge('abathur', 'zeratul', 72, 'curated'), edge('zeratul', 'abathur', 92, 'curated'));
    expect(net?.side).toBe('weak');
    expect(net?.edge.a).toBe('zeratul');
    expect(net?.edge.score).toBeGreaterThan(50);
    expect(net?.edge.score).toBeLessThan(92);
    // The winning side's reasons first, then what the other kit has going for it.
    expect(net?.edge.reasons.map((r) => r.text)).toEqual(['zeratul over abathur', 'abathur over zeratul']);
  });

  it('drops an exact wash and takes the source of the winning direction', () => {
    expect(netCounter(edge('x', 'y', 77), edge('y', 'x', 77))).toBeNull();
    expect(netCounter(edge('x', 'y', 85, 'curated'), edge('y', 'x', 60))?.edge.source).toBe('curated');
    expect(netCounter(edge('x', 'y', 60, 'curated'), edge('y', 'x', 85))?.edge.source).toBe('theory');
  });
});

describe('theoryLists (fixtures)', () => {
  it('never lists an opponent under both "strong against" and "weak against"', () => {
    for (const hero of getDraftableEntities()) {
      const { strong, weak } = theoryLists(hero);
      const weakIds = new Set(weak.map((r) => r.hero.id));
      expect(strong.filter((r) => weakIds.has(r.hero.id)).map((r) => r.hero.slug), hero.slug).toEqual([]);
    }
  });

  it('nets opponents the way the draft does: the side follows value(fwd) − value(rev)', () => {
    const theory = getTheory();
    const score = new Map(theory.counters.map((e) => [`${e.a}>${e.b}`, e.score]));
    const v = (s: number | undefined): number => (s === undefined ? 0 : Math.atanh(Math.max(-0.995, Math.min(0.995, (s - 50) / 50))));
    for (const hero of getDraftableEntities()) {
      const { strong, weak } = theoryLists(hero);
      for (const r of strong) expect(v(score.get(`${hero.id}>${r.hero.id}`)) - v(score.get(`${r.hero.id}>${hero.id}`)), `${hero.slug} > ${r.hero.slug}`).toBeGreaterThan(0);
      for (const r of weak) expect(v(score.get(`${hero.id}>${r.hero.id}`)) - v(score.get(`${r.hero.id}>${hero.id}`)), `${r.hero.slug} > ${hero.slug}`).toBeLessThan(0);
    }
  });

  it('heads each list with curated rows plus only the strongest generic rows at 65+', () => {
    for (const hero of getDraftableEntities()) {
      const lists = theoryLists(hero);
      for (const [name, rows] of Object.entries(lists)) {
        const where = `${hero.slug} ${name}`;
        const listed = rows.filter((r) => r.gate === 'listed');
        expect(listed.filter((r) => r.source !== 'curated').length, where).toBeLessThanOrEqual(THEORY_GATES.listMaxGeneric);
        for (const r of rows) {
          expect(r.score, where).toBeGreaterThan(50);
          if (r.source === 'curated') expect(r.gate, where).toBe('listed');
          else if (r.score < THEORY_GATES.listMinScore) expect(r.gate, where).toBe('shown');
        }
        // Curated first, then generic by score; a generic row below the bar never outranks a listed one.
        const firstGeneric = rows.findIndex((r) => r.source !== 'curated');
        if (firstGeneric >= 0) expect(rows.slice(firstGeneric).every((r) => r.source !== 'curated'), where).toBe(true);
        const generic = rows.filter((r) => r.source !== 'curated');
        expect(generic.map((r) => r.score), where).toEqual([...generic.map((r) => r.score)].sort((a, b) => b - a));
        const lastListed = generic.findLastIndex((r) => r.gate === 'listed');
        expect(generic.slice(0, lastListed + 1).every((r) => r.gate === 'listed'), where).toBe(true);
      }
    }
  });
});
