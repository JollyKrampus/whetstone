import { describe, expect, it } from 'vitest';
import { aramContext, aramStats, rankAram } from './aram.ts';
import { idOf, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const id = (name: string) => idOf(theory, name);

describe('ARAM helper', () => {
  it('ranks the offered heroes and fills the missing Healer first when the team is set', () => {
    const r = rankAram(theory, {
      options: [id('Malfurion'), id('Valla'), id('Tracer')],
      allies: [id('Muradin'), id('Li-Ming'), id('Zeratul'), id("Xal'atath")],
      enemies: [],
      map: '',
    });
    expect(r.ranked.map((s) => s.hero.name)[0]).toBe('Malfurion');
    expect(r.ranked).toHaveLength(3);
    expect(r.ranked[0]!.signals.some((x) => x.key === 'role' && x.value > 0)).toBe(true);
    const valla = r.ranked.find((s) => s.hero.name === 'Valla')!;
    expect(valla.warning?.text).toBe('Leaves your team without a Healer');
    expect(r.usesStats).toBe(false);
  });

  it('counts a gap you can fill as urgent even when an unknown teammate is still to lock', () => {
    // Three known teammates, no Healer: the fifth player's options are random, so they cannot plan for it.
    const r = rankAram(theory, {
      options: [id('Valla'), id('Tracer'), id('Malfurion')],
      allies: [id('Muradin'), id('Li-Ming'), id('Zeratul')],
      enemies: [],
      map: '',
    });
    expect(r.ranked[0]!.hero.name).toBe('Malfurion');
    const fill = r.ranked[0]!.signals.find((s) => s.key === 'role' && s.value > 0)!;
    expect(fill.reasons[0]!.text).toBe('Gives your team the Healer it still needs');
    // Same as the last-pick bonus: base + full urgency.
    expect(fill.value).toBeCloseTo(0.5, 10);
  });

  it('uses counters against known enemies', () => {
    const r = rankAram(theory, { options: [id("Anub'arak"), id('Johanna'), id('Diablo')], allies: [], enemies: [id('Valla'), id('Li-Ming')], map: '' });
    const anub = r.ranked.find((s) => s.hero.name === "Anub'arak")!;
    expect(anub.signals.some((s) => s.key === 'counters' && s.value > 0)).toBe(true);
  });

  it('allows mirrors but reports options that cannot join your team', () => {
    const r = rankAram(theory, { options: [id('Valla'), id('Muradin'), 'chogall'], allies: [id('Muradin'), id('Malfurion'), id('Tracer'), id('Li-Ming')], enemies: [id('Valla')], map: '' });
    expect(r.ranked.map((s) => s.hero.name)).toEqual(['Valla']);
    expect(r.issues.map((i) => i.text)).toEqual([
      'Muradin is already on your team.',
      "No room for Cho'gall: your team has no two free slots left.",
    ]);
  });

  it('only uses ARAM statistics, and only ARAM maps', () => {
    const sl = statsData('sl');
    expect(aramStats(sl)).toBe(false);
    expect(rankAram(sl, { options: [id('Valla')], allies: [], enemies: [], map: '' }).usesStats).toBe(false);
    const aram = statsData('aram');
    expect(aramStats(aram)).toBe(true);
    const r = rankAram(aram, { options: [id('Valla'), id('Muradin')], allies: [], enemies: [], map: 'braxis-outpost' });
    expect(r.usesStats).toBe(true);
    expect(r.ranked[0]!.signals.some((s) => s.key === 'winrate')).toBe(true);
    expect(aramContext(aram, { options: [], allies: [], enemies: [], map: 'cursed-hollow' }).map).toBeUndefined();
    expect(aramContext(aram, { options: [], allies: [], enemies: [], map: 'braxis-outpost' }).map).toBe('braxis-outpost');
  });

  it('has no blind-pick term', () => {
    const r = rankAram(theory, { options: [id('Valla')], allies: [], enemies: [], map: '' });
    expect(r.ranked[0]!.signals.some((s) => s.reasons.some((x) => /can still pick|blind pick/.test(x.text)))).toBe(false);
  });
});
