/**
 * Team share links: the compact team text (team.ts packTeam) is deflated with the browser's
 * built-in CompressionStream and written base64url-encoded into the URL hash, so a full team
 * fits in a link of a few hundred characters and never reaches a server log.
 *
 *   #v=1&t=<base64url(deflate-raw(packTeam(team)))>
 *
 * A leading "0" marks an uncompressed payload (fallback where CompressionStream is missing).
 */
import { createHashCodec, field } from '../../../../core/urlstate.ts';
import { packTeam, unpackTeam, type Team } from './team.ts';

const PAYLOAD = /^[A-Za-z0-9_-]*$/;

export const teamHash = createHashCodec({
  version: 1,
  fields: {
    team: field.str('t', '', { maxLength: 4000, pattern: PAYLOAD }),
    /** Opponent team (team preview). */
    them: field.str('o', '', { maxLength: 4000, pattern: PAYLOAD }),
  },
  maxLength: 8200,
});

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

const canCompress = (): boolean => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Encode a team for a link. */
export async function encodeTeam(team: Team): Promise<string> {
  const text = packTeam(team);
  if (!text) return '';
  const raw = new TextEncoder().encode(text);
  if (!canCompress()) return `0${bytesToBase64Url(raw)}`;
  return `1${bytesToBase64Url(await pipe(raw, new CompressionStream('deflate-raw')))}`;
}

/** Decode a link payload; anything malformed gives an empty team (never throws). */
export async function decodeTeam(payload: string): Promise<Team> {
  if (!payload || !PAYLOAD.test(payload)) return [];
  try {
    const kind = payload[0];
    const bytes = base64UrlToBytes(payload.slice(1));
    let raw: Uint8Array;
    if (kind === '0') raw = bytes;
    else if (kind === '1' && canCompress()) raw = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else return [];
    return unpackTeam(new TextDecoder().decode(raw));
  } catch {
    return [];
  }
}
