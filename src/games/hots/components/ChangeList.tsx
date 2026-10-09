import './hots.css';
import { DIR, type ChangeDir } from './labels.ts';

interface DirChipProps {
  dir?: ChangeDir | undefined;
}

/** "▲ Buff" / "▼ Nerf" / "◆ Change" / "↻ Rework": glyph, word and tone, never colour alone. */
export function DirChip({ dir }: DirChipProps) {
  const spec = DIR[dir ?? 'change'];
  return (
    <span class={`badge badge--${spec.tone} hx-dir`} data-dir={dir ?? 'change'}>
      <span class="hx-dir__icon" aria-hidden="true">
        {spec.icon}
      </span>
      {spec.label}
    </span>
  );
}

export interface ChangeLineItem {
  section: string;
  target?: string | undefined;
  text: string;
  dir?: ChangeDir | undefined;
  /** Optional trailing context, e.g. a patch link on the catch-up page. */
  meta?: { text: string; href?: string } | undefined;
}

interface Props {
  changes: readonly ChangeLineItem[];
  class?: string;
}

/**
 * Patch change lines with their direction chip, the ability or talent they touch and the
 * section they were filed under. Static-renderable from .astro and usable inside islands.
 */
export default function ChangeList({ changes, class: extra }: Props) {
  if (changes.length === 0) return null;
  return (
    <ul class={extra ? `hx-changes ${extra}` : 'hx-changes'}>
      {changes.map((c, i) => (
        <li class="hx-change" key={`${i}-${c.text}`}>
          <DirChip dir={c.dir} />
          <span class="hx-change__body">
            <span>
              {c.target ? <span class="hx-change__target">{c.target}: </span> : null}
              <span class="hx-change__text">{c.text}</span>
            </span>
            <span class="hx-change__section">
              {c.section}
              {c.meta ? (
                <span class="hx-change__meta">
                  {' · '}
                  {c.meta.href ? <a href={c.meta.href}>{c.meta.text}</a> : c.meta.text}
                </span>
              ) : null}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
