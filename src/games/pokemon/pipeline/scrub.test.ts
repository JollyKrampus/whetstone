import { describe, expect, it } from 'vitest';
import { scrubReplayLog, scrubReplaySearch, scrubStandings } from './scrub.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('record-mode scrubbers', () => {
  it('replace standings names, player ids and countries with placeholders in order', () => {
    const body = enc(JSON.stringify([{ name: 'Ash Ketchum', player: 'ashk', country: 'JP', placing: 1, decklist: [] }, { name: 'Misty', player: 'misty', country: 'US', placing: 2 }]));
    expect(JSON.parse(dec(scrubStandings(body)))).toEqual([
      { name: 'Player 1', player: 'player-1', country: 'XX', placing: 1, decklist: [] },
      { name: 'Player 2', player: 'player-2', country: 'XX', placing: 2 },
    ]);
  });

  it('replace replay search players', () => {
    const body = enc(JSON.stringify([{ id: 'x-1', players: ['ashketchum', 'misty'], rating: 1200 }]));
    expect(JSON.parse(dec(scrubReplaySearch(body)))).toEqual([{ id: 'x-1', players: ['Player A', 'Player B'], rating: 1200 }]);
  });

  it('anonymise a battle log, drop chat and presence lines, and keep the result parseable', () => {
    const log = [
      '|j|☆ashketchum',
      '|player|p1|ashketchum|ethan|1520',
      '|player|p2|misty|2|',
      '|c|☆ashketchum|good luck',
      '|raw|ashketchum\'s rating: 1500 → 1520',
      '|poke|p1|Pikachu, L50|',
      '|poke|p2|Starmie, L50|',
      '|start',
      '|switch|p1a: Pikachu|Pikachu, L50|100/100',
      '|switch|p2a: Starmie|Starmie, L50|100/100',
      '|-message|misty forfeited.',
      '|l|☆misty',
      '|win|ashketchum',
    ].join('\n');
    const out = dec(scrubReplayLog(enc(log)));
    expect(out).not.toMatch(/ashketchum|misty/);
    expect(out).not.toMatch(/^\|(c|j|l|raw)\|/m);
    expect(out).toContain('|player|p1|Player A|1|');
    expect(out).toContain('|player|p2|Player B|1|');
    expect(out).toContain('|-message|Player B forfeited.');
    expect(out).toContain('|win|Player A');
    expect(out).toContain('|switch|p1a: Pikachu|Pikachu, L50|100/100');
  });

  it('keep the winner on the same side (the parser maps |win| to a |player| slot), and blank an unknown one', () => {
    const log = ['|player|p1|alice|1|', '|player|p2|bob|1|', '|win|bob'].join('\n');
    expect(dec(scrubReplayLog(enc(log)))).toBe(['|player|p1|Player A|1|', '|player|p2|Player B|1|', '|win|Player B'].join('\n'));
    expect(dec(scrubReplayLog(enc('|player|p1|alice|1|\n|win|someone else')))).toBe('|player|p1|Player A|1|\n|win|');
  });
});
