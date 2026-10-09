import { describe, expect, it } from 'vitest';
import { memoryStorage, createStore } from '../../../../core/storage.ts';
import { base64UrlToBytes, bytesToBase64Url, decodeTeam, encodeTeam, teamHash } from './share.ts';
import { deleteSaved, listSaved, saveTeam, savedToTeam } from './saved.ts';
import { packTeam, sanitizeSet, unpackTeam, type Team } from './team.ts';

const TEAM: Team = [
  { species: 'rillaboom', item: 'miracleseed', ability: 'grassysurge', nature: 'Adamant', sp: [32, 32, 0, 0, 2, 0], moves: ['fakeout', 'grassyglide', 'woodhammer', 'protect'] },
  { species: 'incineroar', nickname: 'Cat | ~ 1', item: 'sitrusberry', ability: 'intimidate', nature: 'Careful', sp: [32, 0, 2, 0, 32, 0], moves: ['fakeout', 'flareblitz', 'knockoff', 'partingshot'] },
  { species: 'pelipper', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: [] },
];

describe('compact team text', () => {
  it('round-trips, including nicknames with separators', () => {
    expect(unpackTeam(packTeam(TEAM))).toEqual(TEAM);
  });

  it('drops malformed sets instead of throwing', () => {
    expect(unpackTeam('Not An Id|x')).toEqual([]);
    expect(unpackTeam('rillaboom|||99|40.40.0.0.0.0|fakeout')).toEqual([
      { species: 'rillaboom', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: ['fakeout'] },
    ]);
    expect(sanitizeSet({ species: 'kingambit', moves: ['a', 'b', 'c', 'd', 'e'], sp: [1, 2, 3] })).toEqual({
      species: 'kingambit',
      nature: 'Serious',
      sp: [0, 0, 0, 0, 0, 0],
      moves: ['a', 'b', 'c', 'd'],
    });
  });
});

describe('share links', () => {
  it('base64url round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    expect(bytesToBase64Url(bytes)).not.toMatch(/[+/=]/);
  });

  it('compresses a team into a short hash and decodes it back', async () => {
    const payload = await encodeTeam(TEAM);
    expect(payload.startsWith('1')).toBe(true);
    expect(payload.length).toBeLessThan(packTeam(TEAM).length);
    const hash = teamHash.encode({ team: payload });
    expect(hash.startsWith('#v=1&t=')).toBe(true);
    const back = teamHash.decode(hash);
    expect(await decodeTeam(back.team)).toEqual(TEAM);
  });

  it('decodes garbage to an empty team', async () => {
    expect(await decodeTeam('1!!!')).toEqual([]);
    expect(await decodeTeam('1AAAA')).toEqual([]);
    expect(await decodeTeam('')).toEqual([]);
    expect(teamHash.decode('#v=1&t=%%%').team).toBe('');
  });

  it('accepts the uncompressed fallback form', async () => {
    const raw = `0${bytesToBase64Url(new TextEncoder().encode(packTeam(TEAM)))}`;
    expect(await decodeTeam(raw)).toEqual(TEAM);
  });
});

describe('saved teams', () => {
  it('saves, lists newest first, replaces by id and deletes', () => {
    const store = createStore('pokemon', { storage: memoryStorage(), events: null });
    saveTeam({ id: 'a', name: 'Rain', team: TEAM }, store, new Date('2026-10-01T00:00:00Z'));
    saveTeam({ id: 'b', name: '  ', team: TEAM.slice(0, 1) }, store, new Date('2026-10-02T00:00:00Z'));
    let list = listSaved(store);
    expect(list.map((t) => [t.id, t.name])).toEqual([
      ['b', 'Untitled team'],
      ['a', 'Rain'],
    ]);
    saveTeam({ id: 'a', name: 'Rain v2', team: TEAM }, store, new Date('2026-10-03T00:00:00Z'));
    list = listSaved(store);
    expect(list.map((t) => t.name)).toEqual(['Rain v2', 'Untitled team']);
    expect(savedToTeam(list[0]!)).toEqual(TEAM);
    expect(deleteSaved('a', store).map((t) => t.id)).toEqual(['b']);
  });

  it('ignores corrupt storage', () => {
    const storage = memoryStorage({ 'whetstone:pokemon:teams': '{"v":1,"d":[{"id":1}]}' });
    const store = createStore('pokemon', { storage, events: null });
    expect(listSaved(store)).toEqual([]);
  });
});
