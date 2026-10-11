/**
 * Team share links: the compact team text (team.ts packTeam) is deflated with the browser's
 * built-in CompressionStream and written base64url-encoded into the URL hash, so a full team
 * fits in a link of a few hundred characters and never reaches a server log.
 *
 *   #v=1&t=<base64url(deflate-raw(packTeam(team)))>
 *
 * A leading "0" marks an uncompressed payload (fallback where CompressionStream is missing).
 *
 * Links are untrusted input: decoding never inflates more than MAX_TEAM_TEXT bytes (a full team
 * packs to about 1–2 KB), so a small crafted link cannot expand into hundreds of megabytes.
 */
import { createHashCodec, field } from '../../../../core/urlstate.ts';
import { packTeam, unpackTeam, type Team } from './team.ts';

const PAYLOAD = /^[A-Za-z0-9_-]*$/;

/** Most bytes a decoded team may take; six full sets with nicknames stay well under 4 KB. */
export const MAX_TEAM_TEXT = 16 * 1024;

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

/**
 * Read a stream to the end, or give up (null) as soon as it passes `limit` bytes. The rest of the
 * stream is cancelled, so the decompressor never produces it.
 */
export async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Inflate a deflate-raw payload, at most `limit` bytes of output (null beyond that or on bad data). */
export function inflateCapped(bytes: Uint8Array, limit = MAX_TEAM_TEXT): Promise<Uint8Array | null> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return readCapped(body, limit);
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
    let raw: Uint8Array | null;
    if (kind === '0') raw = bytes.byteLength <= MAX_TEAM_TEXT ? bytes : null;
    else if (kind === '1' && canCompress()) raw = await inflateCapped(bytes);
    else return [];
    if (!raw) return [];
    return unpackTeam(new TextDecoder().decode(raw));
  } catch {
    return [];
  }
}
