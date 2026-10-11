/**
 * Record-mode scrubbers (pipeline-custody/F8): with WHETSTONE_RECORD=1 the shared Http client
 * saves responses as offline fixtures under src/games/pokemon/fixtures/raw/, which are committed.
 * Tournament standings and Showdown replays name real players, so these hooks (HttpInit.scrub)
 * rewrite each body before it is saved: players become placeholders ("Player 1"/"player-1" in
 * standings, "Player A"/"Player B" in replays), countries "XX", and chat, join, leave, rename and
 * raw lines are dropped. The pipeline never sees the scrubbed text; it only changes what is
 * written to disk. pipeline/fixture-privacy.test.ts checks every committed fixture.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const letter = (i: number): string => String.fromCharCode(65 + (i % 26));

/** Limitless standings: name, player id and country replaced by placeholders, in standing order. */
export function scrubStandings(body: Uint8Array): Uint8Array {
  const rows: unknown = JSON.parse(decoder.decode(body));
  if (!Array.isArray(rows)) return body;
  const out = rows.map((row: unknown, i) => {
    if (typeof row !== 'object' || row === null) return row;
    const r = { ...(row as Record<string, unknown>) };
    if ('name' in r) r.name = `Player ${i + 1}`;
    if ('player' in r) r.player = `player-${i + 1}`;
    if ('country' in r) r.country = 'XX';
    return r;
  });
  return encoder.encode(JSON.stringify(out));
}

/** Showdown replay search: every row's player names replaced by "Player A", "Player B", …. */
export function scrubReplaySearch(body: Uint8Array): Uint8Array {
  const rows: unknown = JSON.parse(decoder.decode(body));
  if (!Array.isArray(rows)) return body;
  const out = rows.map((row: unknown) => {
    if (typeof row !== 'object' || row === null) return row;
    const r = { ...(row as Record<string, unknown>) };
    if (Array.isArray(r.players)) r.players = r.players.map((_, i) => `Player ${letter(i)}`);
    return r;
  });
  return encoder.encode(JSON.stringify(out, null, 1));
}

/** Protocol lines that carry chat, presence, renames or free-form HTML/raw text. */
const DROP = /^\|(c|c:|chat|j|J|join|l|L|leave|n|N|name|raw|html|uhtml|uhtmlchange|inactive|inactiveoff)\|/;

/**
 * Showdown battle log: `|player|pN|name|…` becomes `|player|pN|Player X|1|` (p1 → A, p2 → B, …),
 * every other occurrence of those names (e.g. `|win|`, forfeit messages) becomes the same
 * placeholder, and chat/presence/raw lines are dropped.
 */
export function scrubReplayLog(body: Uint8Array): Uint8Array {
  const lines = decoder.decode(body).split('\n');
  const names = new Map<string, string>();
  for (const line of lines) {
    const m = /^\|player\|p(\d)\|([^|\r]*)/.exec(line);
    if (m && m[2]) names.set(m[2], `Player ${letter(Number(m[1]) - 1)}`);
  }
  // Longest names first, so a name that contains another is replaced whole.
  const byLength = [...names.entries()].sort((a, b) => b[0].length - a[0].length);
  const out: string[] = [];
  for (const raw of lines) {
    if (DROP.test(raw)) continue;
    const player = /^\|player\|p(\d)\|[^|\r]*/.exec(raw);
    if (player) {
      out.push(`|player|p${player[1]}|Player ${letter(Number(player[1]) - 1)}|1|${raw.endsWith('\r') ? '\r' : ''}`);
      continue;
    }
    const win = /^\|win\|([^|\r]*)/.exec(raw);
    if (win) {
      out.push(`|win|${names.get(win[1] ?? '') ?? ''}${raw.endsWith('\r') ? '\r' : ''}`);
      continue;
    }
    // Free text (forfeit and timer messages) names players too; very short names are left
    // alone there, as they would also match inside Pokémon and move names.
    let line = raw;
    for (const [name, placeholder] of byLength) if (name.length >= 3) line = line.split(name).join(placeholder);
    out.push(line);
  }
  return encoder.encode(out.join('\n'));
}
