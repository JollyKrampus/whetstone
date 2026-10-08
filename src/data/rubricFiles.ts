import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bundledRubrics, type RubricSource } from '../core/rubric.js';

/**
 * Prefers `<configDir>/rubric/<file>` when present, else the bundled package rubric (the
 * old behavior). Rubric getters run many times per tool call, so each override file is
 * read and parsed once.
 */
export function fileRubricSource(configDir: string): RubricSource {
  const files = new Map<string, unknown>();
  const pick = (file: string, fallback: () => { key: string; json: unknown }) => () => {
    const override = path.join(configDir, 'rubric', file);
    if (!files.has(override)) files.set(override, existsSync(override) ? JSON.parse(readFileSync(override, 'utf8')) : null);
    const json = files.get(override);
    return json === null ? fallback() : { key: override, json };
  };
  return {
    constructed: pick('power-rubric.json', bundledRubrics.constructed),
    brawl: pick('brawl-rubric.json', bundledRubrics.brawl),
  };
}
