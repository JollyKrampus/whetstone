import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tappedKind } from '../src/core/analyze.js';
import { castingMv, isCreature } from '../src/core/cards.js';
import { companionViolations, hasActivatedAbility } from '../src/core/companions.js';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { parseArenaText } from '../src/core/parse.js';
import { saltOf } from '../src/core/salt.js';
import { applySwaps, suggestUpgrades } from '../src/core/suggest.js';
import { validateDeck } from '../src/core/validate.js';
import { arenaExport, buildVersions } from '../src/core/versions.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const asOf = '2026-10-08';
const historic = getFormat('historic');

async function load(file: string) {
  const index = await fixtureIndex();
  return { index, deck: await parseAndResolve(readFixture(file), index) };
}

describe('companion rules', () => {
  it('lists the cards that break Lurrus and fails validation', async () => {
    const { deck } = await load('lurrus-white.txt');
    expect(companionViolations(deck, historic)?.cards.sort()).toEqual(['Inspiring Overseer', 'Mentor of the Meek']);
    const v = validateDeck(deck, historic);
    expect(v.legal).toBe(false);
    expect(v.issues.find((i) => i.code === 'companion_condition')?.message).toMatch(/Lurrus of the Dream-Den: Each permanent card/);
  });

  it('checks odd/even, size and activated-ability conditions', async () => {
    const index = await fixtureIndex();
    const obosh = await parseAndResolve('Companion\n1 Obosh, the Preypiercer\n\nDeck\n4 Shock\n4 Grizzly Bears\n52 Mountain\n\nSideboard\n1 Obosh, the Preypiercer', index);
    expect(companionViolations(obosh, historic)?.cards).toEqual(['Grizzly Bears']);
    const yorion = await parseAndResolve('Companion\n1 Yorion, Sky Nomad\n\nDeck\n60 Plains', index);
    expect(companionViolations(yorion, historic)?.cards[0]).toMatch(/needs 80/);
    expect(hasActivatedAbility(index.lookup('Krenko, Mob Boss')!)).toBe(true);
    expect(hasActivatedAbility(index.lookup('Grizzly Bears')!)).toBe(false);
  });
});

describe('feel-bad cards', () => {
  it('classifies avoid vs. penalize from rubric/salt.json', async () => {
    const index = await fixtureIndex();
    expect(saltOf(index.lookup('Time Warp')!).avoid).toContain('extra turns');
    expect(saltOf(index.lookup('Armageddon')!).avoid).toContain('mass land destruction');
    expect(saltOf(index.lookup('Smothering Tithe')!).avoid[0]).toMatch(/Game Changers/);
    expect(saltOf(index.lookup('Voice of Victory')!)).toMatchObject({ avoid: [], penalize: ['no spells on your turn'] });
    expect(saltOf(index.lookup('Counterspell')!).penalize).toContain('counterspells');
    expect(saltOf(index.lookup('Shock')!)).toMatchObject({ avoid: [], penalize: [], penalty: 0 });
  });

  it('treats fetch lands that bring in a tapped land as tapped', async () => {
    const index = await fixtureIndex();
    expect(tappedKind(index.lookup('Evolving Wilds')!)).toBe('unconditional');
    expect(tappedKind(index.lookup('Fabled Passage')!)).toBe('conditional');
  });
});

describe('deck versions', () => {
  it('"same deck, best cards" upgrades a 3-mana kill spell to a 2-mana one and keeps each job', async () => {
    const { index, deck } = await load('standard-boros.txt');
    const r = suggestUpgrades(deck, getFormat('standard'), index, { profile: 'faithful', asOf });
    expect(r.swaps).toContainEqual(expect.objectContaining({ cut: 'Stroke of Midnight', add: 'Get Lost', qty: 2 }));
    for (const s of r.swaps.filter((x) => x.kind === 'spell' && !x.required)) {
      const cut = index.lookup(s.cut)!;
      const add = index.lookup(s.add)!;
      expect(castingMv(add)).toBeLessThanOrEqual(castingMv(cut));
      expect(castingMv(add)).toBeGreaterThanOrEqual(castingMv(cut) - 1);
      expect(isCreature(add)).toBe(isCreature(cut));
      expect(add.colors.every((c) => cut.colors.includes(c))).toBe(true);
    }
  });

  it('replaces banned cards in every version and keeps feel-bad cards out of the casual one', async () => {
    const { index, deck } = await load('salty-azorius.txt');
    expect(validateDeck(deck, historic).legal).toBe(false);
    const versions = buildVersions(deck, historic, index, { asOf });
    expect(versions.map((v) => v.label)).toEqual(['Same deck, best cards', 'Most competitive', 'Friendly casual']);
    for (const v of versions) {
      expect(v.validation.legal).toBe(true);
      const cuts = v.suggestion.swaps.map((s) => s.cut);
      expect(cuts).toEqual(expect.arrayContaining(['Armageddon', 'Time Warp']));
    }
    const casual = versions[2]!;
    expect(casual.suggestion.swaps.map((s) => s.cut)).toContain('Drannith Magistrate');
    for (const s of casual.suggestion.swaps) expect(saltOf(index.lookup(s.add)!).avoid).toEqual([]);
    expect(casual.feelBadCards.map((c) => c.name)).not.toContain('Drannith Magistrate');
    expect(casual.suggestion.notes.join(' ')).toMatch(/Rhystic Study .* has no replacement/);
  });

  it('fixes a deck that breaks its companion and never adds cards that would', async () => {
    const { index, deck } = await load('lurrus-white.txt');
    for (const v of buildVersions(deck, historic, index, { asOf })) {
      expect(v.validation.legal).toBe(true);
      const after = applySwaps(deck, v.suggestion.swaps, index);
      expect(companionViolations(after, historic)?.cards).toEqual([]);
    }
  });

  it('never makes the faithful or competitive version weaker', async () => {
    const { index, deck } = await load('tiers/t3-gruul.txt');
    const meta = undefined;
    for (const v of buildVersions(deck, historic, index, { asOf, meta, profiles: ['faithful', 'competitive'] })) {
      expect(v.rating.after.score).toBeGreaterThanOrEqual(v.rating.before.score);
    }
  });

  it('respects copies already in the sideboard', async () => {
    const index = await fixtureIndex();
    const text = readFixture('standard-boros.txt').replace('Sideboard\n', 'Sideboard\n3 Get Lost\n');
    const deck = await parseAndResolve(text, index);
    const r = suggestUpgrades(deck, getFormat('standard'), index, { profile: 'faithful', asOf });
    const getLost = r.swaps.find((s) => s.add === 'Get Lost');
    if (getLost) expect(getLost.qty).toBe(1);
    expect(validateDeck(applySwaps(deck, r.swaps, index), getFormat('standard')).legal).toBe(true);
  });

  it('leans toward rarer cards when preferring premium', async () => {
    const { index, deck } = await load('tiers/t3-gruul.txt');
    const rank: Record<string, number> = { common: 0, uncommon: 1, rare: 2, mythic: 3 };
    const avg = (premium: boolean) => {
      const r = suggestUpgrades(deck, historic, index, { profile: 'competitive', preferPremium: premium, asOf });
      const adds = r.swaps.filter((s) => s.kind === 'spell').map((s) => rank[index.lookup(s.add)!.arenaRarity!] ?? 0);
      return adds.reduce((a, b) => a + b, 0) / adds.length;
    };
    expect(avg(true)).toBeGreaterThanOrEqual(avg(false));
  });

  it('renders an Arena import that parses back to the same deck', async () => {
    const { index, deck } = await load('standard-boros.txt');
    const text = arenaExport(deck);
    expect(text).toMatch(/^About\nName Boros Pressure\n\nDeck\n6 Mountain\n4 /);
    const again = await parseAndResolve(text, index);
    expect(again.unresolved).toEqual([]);
    expect(again.main.map((e) => [e.oracleId, e.qty]).sort()).toEqual(deck.main.map((e) => [e.oracleId, e.qty]).sort());
    const brawl = arenaExport((await load('standardbrawl-krenko.txt')).deck);
    expect(brawl).toMatch(/^Commander\n1 Krenko, Mob Boss\n\nDeck\n/);
    // Double-faced cards are exported by their front face, as Arena does.
    const dfc = await parseAndResolve('4 Kumano Faces Kakkazan\n56 Mountain', index);
    expect(arenaExport(dfc).split('\n')).toContain('4 Kumano Faces Kakkazan');
    expect(parseArenaText(arenaExport(dfc)).issues).toEqual([]);
  });

  it('is exposed as build_versions, with the premium default from preferences.json', async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-prefs-'));
    writeFileSync(path.join(configDir, 'preferences.json'), JSON.stringify({ preferPremium: true }));
    const client = await connect(createServer(testContext({ configDir })));
    const r = await call(client, 'build_versions', { text: readFixture('salty-azorius.txt'), format: 'historic' });
    expect(r.isError).toBe(false);
    const versions = r.body.versions as { label: string; arenaExport: string; suggestion: { preferPremium: boolean } }[];
    expect(versions).toHaveLength(3);
    expect(versions.every((v) => v.suggestion.preferPremium)).toBe(true);
    expect(versions[0]!.arenaExport).toMatch(/^About\nName Azorius Lock\n\nDeck\n/);
    const one = await call(client, 'suggest_upgrades', {
      text: readFixture('standard-boros.txt'),
      format: 'standard',
      profile: 'faithful',
      preferPremium: false,
    });
    expect(one.body).toMatchObject({ profile: 'faithful', preferPremium: false });
  });
});
