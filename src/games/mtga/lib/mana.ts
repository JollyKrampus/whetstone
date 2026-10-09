/**
 * Mana costs as accessible symbols: "{2}{R}{G/U}" → three symbols with readable labels. Drawn
 * with CSS (no symbol images are fetched). Browser-safe.
 */

export interface ManaSymbol {
  /** Text inside the braces, e.g. "R", "2", "G/U", "W/P". */
  text: string;
  /** Spoken label, e.g. "red", "2 generic", "green or blue". */
  label: string;
  /** Colours for styling: W U B R G, 'C' (colorless), 'N' (generic/number), 'X' (variable). */
  colors: string[];
  phyrexian: boolean;
}

const NAMES: Readonly<Record<string, string>> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
  C: 'colorless',
  S: 'snow',
};

function partLabel(p: string): string {
  if (/^\d+$/.test(p)) return `${p} generic`;
  if (p === 'X' || p === 'Y' || p === 'Z') return p;
  return NAMES[p] ?? p;
}

/** Parse a mana cost into symbols (unknown tokens are kept with their raw text as the label). */
export function manaSymbols(cost: string): ManaSymbol[] {
  const out: ManaSymbol[] = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const text = (m[1] ?? '').toUpperCase();
    const parts = text.split('/');
    const phyrexian = parts.includes('P');
    const core = parts.filter((p) => p !== 'P');
    const colors = core.map((p) => (/^\d+$/.test(p) ? 'N' : p === 'X' || p === 'Y' || p === 'Z' ? 'X' : NAMES[p] ? p : 'N'));
    let label = core.map(partLabel).join(' or ');
    if (phyrexian) label = `Phyrexian ${label}`;
    out.push({ text, label: label || text, colors, phyrexian });
  }
  return out;
}

/** "{1}{R} // {2}{W}" faces → one label for screen readers: "Mana cost: 1 generic, red". */
export function manaLabel(cost: string): string {
  const symbols = manaSymbols(cost);
  return symbols.length ? symbols.map((s) => s.label).join(', ') : 'no mana cost';
}
