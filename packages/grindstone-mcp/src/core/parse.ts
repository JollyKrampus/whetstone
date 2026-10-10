/** Arena export → raw (unresolved) deck. Never throws on a bad line. */

export type Section = 'commander' | 'companion' | 'main' | 'side';

export interface RawEntry {
  qty: number;
  name: string;
  set?: string;
  collectorNumber?: string;
  section: Section;
  line: number;
}

export interface Issue {
  code: string;
  reason: string;
  line?: number;
  text?: string;
  suggestions?: string[];
}

export interface RawDeck {
  name?: string;
  entries: RawEntry[];
  issues: Issue[];
}

const HEADERS: Record<string, Section | 'about' | 'ignore'> = {
  commander: 'commander',
  companion: 'companion',
  deck: 'main',
  main: 'main',
  mainboard: 'main',
  sideboard: 'side',
  side: 'side',
  about: 'about',
  maybeboard: 'ignore',
};

// "4 Llanowar Elves (DOM) 168", "4x Llanowar Elves", "1 Fire // Ice (MH2) 290 *F*"
const CARD_LINE = /^(\d+)\s*x?\s+(.+?)(?:\s+\(([A-Za-z0-9_]{2,8})\)(?:\s+(\S+))?)?(?:\s+\*[A-Z]+\*)?\s*$/i;

export function parseArenaText(text: string): RawDeck {
  const deck: RawDeck = { entries: [], issues: [] };
  let section: Section | 'about' | 'ignore' = 'main';
  let mainHasCards = false;
  let blankAfterMain = false;
  let switchedOnBlank = false;

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // byte-order mark
  const lines = body.split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line) {
      if (section === 'main' && mainHasCards) blankAfterMain = true;
      return;
    }
    if (line.startsWith('//') || line.startsWith('#')) return;

    const header = HEADERS[line.replace(/:$/, '').trim().toLowerCase()];
    if (header) {
      section = header;
      blankAfterMain = false;
      return;
    }
    if (section === 'about') {
      const m = /^name\s+(.+)$/i.exec(line);
      if (m) deck.name = m[1]!.trim();
      return;
    }
    if (section === 'ignore') return;

    // Older exports separate main and sideboard with a bare blank line and no header.
    if (section === 'main' && blankAfterMain && !switchedOnBlank && !headerFollows(lines, i, 'sideboard')) {
      section = 'side';
      switchedOnBlank = true;
    }
    blankAfterMain = false;

    const m = CARD_LINE.exec(line);
    if (!m) {
      deck.issues.push({ code: 'unparsed_line', reason: 'Expected "<qty> <card name> [(SET) number]".', line: lineNo, text: line });
      return;
    }
    const qty = Number(m[1]);
    if (qty < 1) {
      deck.issues.push({ code: 'bad_quantity', reason: 'Quantity must be at least 1.', line: lineNo, text: line });
      return;
    }
    deck.entries.push({
      qty,
      name: m[2]!.trim(),
      ...(m[3] ? { set: m[3].toUpperCase() } : {}),
      ...(m[4] ? { collectorNumber: m[4] } : {}),
      section,
      line: lineNo,
    });
    if (section === 'main') mainHasCards = true;
  });
  return deck;
}

/** True when a later line is the given section header (so a blank line is just spacing). */
function headerFollows(lines: string[], from: number, header: string): boolean {
  for (let j = from; j < lines.length; j++) {
    if (lines[j]!.trim().replace(/:$/, '').toLowerCase() === header) return true;
  }
  return false;
}
