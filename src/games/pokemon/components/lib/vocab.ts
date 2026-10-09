/**
 * Client-safe copies of the vocabulary lists in ../../schema.ts. schema.ts builds zod schemas at
 * import time, so importing a value from it would ship zod to the browser; islands import these
 * instead. vocab.test.ts keeps both lists identical.
 */
import type { Nature, PokemonType } from '../../schema.ts';

export const POKEMON_TYPES: readonly PokemonType[] = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
  'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

export const NATURES: readonly Nature[] = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle', 'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax',
  'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
];
