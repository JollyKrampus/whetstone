import { describe, expect, it } from 'vitest';
import { NATURES as SCHEMA_NATURES, POKEMON_TYPES as SCHEMA_TYPES } from '../../schema.ts';
import { NATURES, POKEMON_TYPES } from './vocab.ts';

describe('client vocabulary', () => {
  it('matches schema.ts exactly, in order', () => {
    expect([...POKEMON_TYPES]).toEqual([...SCHEMA_TYPES]);
    expect([...NATURES]).toEqual([...SCHEMA_NATURES]);
  });
});
