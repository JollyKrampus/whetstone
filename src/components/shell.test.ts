import { describe, expect, it } from 'vitest';
import { STATE_WORD } from './freshness.ts';
import { edgeSourceLabel, edgeSourceTone } from './types.ts';

describe('freshness badge vocabulary', () => {
  it('says something visible for every non-fresh state (colour is never the only cue)', () => {
    expect(STATE_WORD.fresh).toBe('');
    for (const state of ['aging', 'stale', 'broken', 'unknown'] as const) expect(STATE_WORD[state]).not.toBe('');
  });
});

describe('edge source labels', () => {
  it('labels theory distinctly from measured stats', () => {
    expect(edgeSourceLabel('theory')).toBe('Theory');
    expect(edgeSourceTone('theory')).toBe('theory');
    expect(edgeSourceTone('curated')).toBe('theory');
    expect(edgeSourceTone('stats')).toBe('stats');
  });
});
