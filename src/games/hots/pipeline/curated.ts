/**
 * Loads the curated YAML inputs the data pipeline needs (curated/hots/*.yaml), validated with
 * the schemas in ../schema.ts. Node only (file system). The theory engine loads its own curated
 * files (traits, rules, counters, synergies, per-hero files) through its loadCurated().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import {
  AliasesFileSchema,
  CreatorsFileSchema,
  CuratedMapsFileSchema,
  RankedPoolFileSchema,
  type AliasesFile,
  type CreatorsFile,
  type CuratedMapsFile,
  type RankedPoolFile,
} from '../schema.ts';

export interface PipelineCurated {
  aliases: AliasesFile;
  maps: CuratedMapsFile;
  rankedPool: RankedPoolFile;
  creators: CreatorsFile;
}

export function curatedDir(root: string): string {
  return path.join(root, 'curated', 'hots');
}

/** Parse and validate one curated YAML file; the error names the file and the first problems. */
export function readCuratedFile<T>(root: string, file: string, schema: ZodType<T>): T {
  const full = path.join(curatedDir(root), file);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`curated/hots/${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`curated/hots/${file} is invalid: ${first}`);
  }
  return parsed.data;
}

export function loadPipelineCurated(root: string): PipelineCurated {
  return {
    aliases: readCuratedFile(root, 'aliases.yaml', AliasesFileSchema),
    maps: readCuratedFile(root, 'maps.yaml', CuratedMapsFileSchema),
    rankedPool: readCuratedFile(root, 'ranked-pool.yaml', RankedPoolFileSchema),
    creators: readCuratedFile(root, 'creators.yaml', CreatorsFileSchema),
  };
}
