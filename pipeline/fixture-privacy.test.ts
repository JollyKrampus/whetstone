/**
 * Guard for the committed offline fixtures (pipeline-custody/F8): record mode can write real
 * responses into src/games/<game>/fixtures/raw/, so every tracked fixture is checked here for
 * class-C responses (video and stream metadata, never committed) and for player names, which
 * must be placeholders ("Player 1", "Player A") in tournament standings and replay logs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked files under src/games/<game>/fixtures/raw/ (untracked local recordings are not checked). */
function trackedRawFixtures(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src/games'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((f) => /^src\/games\/[^/]+\/fixtures\/raw\//.test(f))
    .sort();
}

const PLACEHOLDER = /^(Player [A-Z0-9]+|)$/;

/** Problems in a Showdown battle log: real names on player/win lines, or chat/join/rating lines. */
function replayLogProblems(text: string): string[] {
  const problems: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const player = /^\|player\|p\d\|([^|]*)/.exec(line);
    if (player && !PLACEHOLDER.test(player[1] ?? '')) problems.push(`player name ${JSON.stringify(player[1])}`);
    const win = /^\|win\|([^|]*)/.exec(line);
    if (win && !PLACEHOLDER.test(win[1] ?? '')) problems.push(`winner ${JSON.stringify(win[1])}`);
    if (/^\|(c|c:|j|J|l|L|n|N|raw|chat|join|leave)\|/.test(line)) problems.push(`chat, join or rating line ${JSON.stringify(line.slice(0, 40))}`);
  }
  return problems;
}

/** Problems in Limitless standings: any entry whose name or player id is not a placeholder. */
function standingsProblems(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const problems: string[] = [];
  for (const row of json as Array<Record<string, unknown>>) {
    if (typeof row?.name === 'string' && !/^Player \d+$/.test(row.name)) problems.push(`name ${JSON.stringify(row.name)}`);
    if (typeof row?.player === 'string' && !/^player-\d+$/.test(row.player)) problems.push(`player ${JSON.stringify(row.player)}`);
  }
  return problems;
}

describe('committed fixtures', () => {
  const files = trackedRawFixtures();

  it('finds the raw fixtures', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('hold no class-C (video or stream) responses', () => {
    expect(files.filter((f) => /\/fixtures\/raw\/(youtube|twitch)\//.test(f))).toEqual([]);
  });

  it('hold placeholder player names only', () => {
    const problems: string[] = [];
    for (const rel of files) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      if (/\/replays\/log-[^/]+\.txt$/.test(rel)) problems.push(...replayLogProblems(text).map((p) => `${rel}: ${p}`));
      if (/\/limitless\/standings-[^/]+\.json$/.test(rel)) problems.push(...standingsProblems(JSON.parse(text)).map((p) => `${rel}: ${p}`));
    }
    expect(problems).toEqual([]);
  });

  it('flags real names and chat lines', () => {
    expect(replayLogProblems('|player|p1|Player A|1|\n|win|Player B\n|t:|1')).toEqual([]);
    expect(replayLogProblems('|player|p1|ashketchum|1|\n|c|☆ashketchum|gg\n|win|ashketchum')).toHaveLength(3);
    expect(standingsProblems([{ name: 'Player 1', player: 'player-1' }])).toEqual([]);
    expect(standingsProblems([{ name: 'Ash Ketchum', player: 'ash' }])).toHaveLength(2);
  });
});
