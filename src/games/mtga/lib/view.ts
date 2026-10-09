/**
 * Small pure helpers shared by the MTGA islands (progress text, meta selections, issue fixes).
 * Browser-safe, no DOM.
 */
import type { FormatId, MetaSelection, WorkerProgress } from '../worker/protocol.ts';
import { FORMAT_IDS } from '../worker/protocol.ts';
import { curatedSelection, mySelection, type CuratedSnapshotView, type MyList } from './metaLists.ts';

/** Which meta lists the analyzer compares against. */
export type MetaChoice = 'auto' | 'mine' | 'curated' | 'none';
export const META_CHOICES: readonly MetaChoice[] = ['auto', 'mine', 'curated', 'none'];

export function isMetaChoice(v: unknown): v is MetaChoice {
  return (META_CHOICES as readonly unknown[]).includes(v);
}

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

/** Readable progress for the card-data download and indexing. */
export function progressText(p: WorkerProgress | null, idle = 'Analyzing the deck…'): string {
  if (!p) return idle;
  const what = p.pool === 'arena' ? 'every Arena card' : 'Standard cards';
  if (p.stage === 'cache') return `Loading ${what} from this browser…`;
  if (p.stage === 'index') return `Indexing ${what}…`;
  if (p.loaded && p.total) return `Downloading ${what}: ${mb(p.loaded)} of ${mb(p.total)}…`;
  if (p.loaded) return `Downloading ${what}: ${mb(p.loaded)}…`;
  return `Downloading ${what}…`;
}

/**
 * Meta lists per format for a choice: 'auto' prefers the visitor's own lists and falls back to
 * the curated ones; example decks are never meta (see curatedSelection).
 */
export function metaByFormat(choice: MetaChoice, mine: readonly MyList[], curated: readonly CuratedSnapshotView[]): Partial<Record<FormatId, MetaSelection>> {
  const out: Partial<Record<FormatId, MetaSelection>> = {};
  if (choice === 'none') return out;
  for (const f of FORMAT_IDS) {
    const my = choice === 'curated' ? null : mySelection(mine, f);
    const cur = choice === 'mine' ? null : curatedSelection(curated.find((s) => s.format === f));
    const pick = choice === 'auto' ? (my ?? cur) : choice === 'mine' ? my : cur;
    if (pick) out[f] = pick;
  }
  return out;
}

/** The card name in an unrecognized line: "4 Lightnig Strike (M21) 123" → "Lightnig Strike". */
export function nameIn(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const m = /^\s*(?:\d+x?\s+)?(.+?)(?:\s+\([A-Za-z0-9]{2,6}\)(?:\s+\S+)?)?\s*$/.exec(line);
  return m?.[1]?.trim() || undefined;
}

/**
 * Replace a misspelled name in the pasted text with a suggestion: on the reported line when it
 * holds the name, else on the first line that does. Returns null when the name is not found.
 */
export function replaceName(text: string, line: number | undefined, wrong: string, right: string): string | null {
  const lines = text.split(/\r?\n/);
  const at = line !== undefined && line >= 1 && line <= lines.length && (lines[line - 1] ?? '').includes(wrong) ? line - 1 : lines.findIndex((l) => l.includes(wrong));
  if (at < 0) return null;
  lines[at] = (lines[at] ?? '').replace(wrong, right);
  return lines.join('\n');
}

/** Bytes as "4.5 MB" / "820 KB". */
export function bytesText(n: number): string {
  if (n >= 1_048_576) return mb(n);
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
