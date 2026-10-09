/**
 * Test helper: the committed fixture dex shard as a DexIndex. Node-only (fs); imported by unit
 * tests, never by islands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DexShardSchema, type DexShard } from '../../schema.ts';
import { createDexIndex, type DexIndex } from './dex.ts';

let cached: DexShard | null = null;

export function fixtureShard(): DexShard {
  cached ??= DexShardSchema.parse(JSON.parse(readFileSync(path.resolve('fixtures/pokemon/public/dex.json'), 'utf8')));
  return cached;
}

export function fixtureDex(): DexIndex {
  return createDexIndex(fixtureShard());
}
