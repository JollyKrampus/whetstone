import { describe, expect, it } from 'vitest';
import { memoryStorage, createStore } from '../../../../core/storage.ts';
import { MAX_TEAM_TEXT, base64UrlToBytes, bytesToBase64Url, decodeTeam, encodeTeam, inflateCapped, readCapped, teamHash } from './share.ts';
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

  it('refuses a link that inflates past the cap (decompression bomb)', async () => {
    // About 3 KB of deflate (it fits the link codec's 4000 characters) inflating to 2.5 MB.
    const bomb = new TextEncoder().encode(`${packTeam(TEAM)}~${'~'.repeat(2_500_000)}`);
    const body = new Blob([bomb]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(body).arrayBuffer());
    const payload = `1${bytesToBase64Url(packed)}`;
    expect(teamHash.decode(`#v=1&t=${payload}`).team).toBe(payload);
    expect(await inflateCapped(packed)).toBeNull();
    expect(await decodeTeam(payload)).toEqual([]);
    // A real team is far below the cap.
    const real = base64UrlToBytes((await encodeTeam(TEAM)).slice(1));
    expect((await inflateCapped(real))!.byteLength).toBeLessThan(MAX_TEAM_TEXT / 10);
  });

  it('stops reading a stream at the limit', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect(await readCapped(endless, 4096)).toBeNull();
    expect(pulled).toBeLessThan(10);
  });

  it('never unpacks more than six sets', () => {
    const many = Array.from({ length: 50 }, () => packTeam(TEAM.slice(0, 1))).join('~');
    expect(unpackTeam(many)).toHaveLength(6);
    expect(unpackTeam(`${'~'.repeat(100_000)}`)).toEqual([]);
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
