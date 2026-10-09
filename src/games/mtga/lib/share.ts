/**
 * Deck share links: the deck travels in the URL hash, so it never reaches a server.
 *
 *   #v=1&d=z<base64url(deflate-raw(utf-8 Arena export))>&f=standard&s=12345
 *
 * `d` starts with `z` when compressed (CompressionStream 'deflate-raw') and with `t` for plain
 * UTF-8 when the browser lacks CompressionStream. Decoding is capped so a crafted link cannot
 * inflate into megabytes, and never throws: a broken link opens an empty analyzer.
 * Browser-safe (also runs in Node ≥ 18, which has the same streams).
 */
import { createHashCodec, field } from '../../../core/urlstate.ts';
import { FORMAT_IDS, type FormatId } from '../worker/protocol.ts';

/** Longest deck text a link may carry once decoded (a 250-card Brawl list is ~6 KB). */
export const MAX_DECK_CHARS = 20_000;
const MAX_TOKEN = 12_000;

export const deckCodec = createHashCodec({
  version: 1,
  maxLength: MAX_TOKEN + 64,
  fields: {
    deck: field.str('d', '', { maxLength: MAX_TOKEN, pattern: /^[zt][A-Za-z0-9_-]*$/ }),
    format: field.enum('f', ['auto', ...FORMAT_IDS] as const, 'auto'),
    seed: field.int('s', 0, { min: 0, max: 4_294_967_295 }),
  },
});

export interface DeckShare {
  text: string;
  format: FormatId | null;
  /** Sample-hand seed; 0 = none chosen. */
  seed: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pump(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
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

function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const hasStreams = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** Encode deck text for the `d` parameter. */
export async function encodeDeckText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.slice(0, MAX_DECK_CHARS));
  if (!hasStreams()) return `t${toBase64Url(bytes)}`;
  const packed = await pump(streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')), MAX_TOKEN * 4);
  return packed ? `z${toBase64Url(packed)}` : `t${toBase64Url(bytes)}`;
}

/** Decode a `d` parameter; null when it is not a valid deck token. */
export async function decodeDeckText(token: string): Promise<string | null> {
  if (!token || token.length > MAX_TOKEN) return null;
  const bytes = fromBase64Url(token.slice(1));
  if (!bytes) return null;
  let raw: Uint8Array<ArrayBuffer> | null;
  if (token[0] === 't') raw = bytes;
  else if (token[0] === 'z' && hasStreams()) raw = await pump(streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')), MAX_DECK_CHARS * 4);
  else return null;
  if (!raw) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

/** The hash for a shared deck (format 'auto' and seed 0 are omitted). */
export async function deckHash(share: DeckShare): Promise<string> {
  return deckCodec.encode({ deck: await encodeDeckText(share.text), format: share.format ?? 'auto', seed: share.seed });
}

/** Read a shared deck from a hash; null when the hash carries no (valid) deck. */
export async function readDeckHash(hash: string): Promise<DeckShare | null> {
  const { state } = deckCodec.decodeWithInfo(hash);
  if (!state.deck) return null;
  const text = await decodeDeckText(state.deck);
  if (text === null || text.trim() === '') return null;
  return { text, format: state.format === 'auto' ? null : state.format, seed: state.seed };
}
