/**
 * Streaming line readers for the MTGA pipeline. Scryfall's bulk JSONL (~80 MB gzip, ~500 MB of
 * text) and 17Lands' CSVs (up to ~75 MB gzip, gigabytes of text) are decompressed chunk by chunk
 * and split into lines, so the whole text never sits in memory as one string. Node-only.
 */
import { createGunzip } from 'node:zlib';

/** Split a stream of byte (or string) chunks into lines without their terminators (\n or \r\n). */
export async function* splitLines(chunks: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  for await (const chunk of chunks) {
    const text = carry + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    let start = 0;
    for (let nl = text.indexOf('\n', start); nl !== -1; nl = text.indexOf('\n', start)) {
      const end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      yield text.slice(start, end);
      start = nl + 1;
    }
    carry = text.slice(start);
  }
  carry += decoder.decode();
  if (carry.endsWith('\r')) carry = carry.slice(0, -1);
  if (carry.length > 0) yield carry;
}

/**
 * Lines of a gzip buffer, decompressed as a stream. Concatenated gzip members are handled, and a
 * corrupt or truncated file throws instead of yielding a partial result silently.
 */
export function gunzipLines(gz: Uint8Array): AsyncGenerator<string> {
  const gunzip = createGunzip({ chunkSize: 256 * 1024 });
  gunzip.end(Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength));
  return splitLines(gunzip as AsyncIterable<Uint8Array>);
}

/** True when the bytes start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Lines of a buffer that may or may not be gzip-compressed (fixtures are sometimes stored plain). */
export function textLines(bytes: Uint8Array): AsyncGenerator<string> {
  return isGzip(bytes) ? gunzipLines(bytes) : splitLines([bytes]);
}
