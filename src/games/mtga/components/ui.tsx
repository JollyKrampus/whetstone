/**
 * Small presentational pieces shared by the MTGA islands (styles in mtga.css).
 */
import type { ComponentChildren } from 'preact';
import type { Color, Rarity } from '../worker/protocol.ts';

export const RARITY_LABEL: Readonly<Record<Rarity, string>> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', mythic: 'Mythic' };
export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];
export const COLOR_NAME: Readonly<Record<Color, string>> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/** Percentage of a 0..1 value with a fixed number of decimals. */
export function pct01(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

interface SectionProps {
  id: string;
  title: string;
  /** Short note next to the title. */
  meta?: ComponentChildren;
  class?: string;
  children: ComponentChildren;
}

/** One result block of an analysis: a card with an anchored heading. */
export function Section({ id, title, meta, class: extra, children }: SectionProps) {
  return (
    <section class={extra ? `dsec card ${extra}` : 'dsec card'} aria-labelledby={`${id}-title`} id={id}>
      <div class="dsec__head">
        <h2 id={`${id}-title`} class="dsec__title" tabindex={-1}>
          {title}
        </h2>
        {meta ? <p class="dsec__meta">{meta}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Rarity marker: a coloured gem plus the word (never colour alone). */
export function RarityTag({ rarity, short = false }: { rarity: Rarity; short?: boolean }) {
  return (
    <span class="rarity">
      <span class={`gem gem--${rarity}`} aria-hidden="true" />
      {short ? (
        <>
          <span class="rarity__abbr" aria-hidden="true">
            {RARITY_LABEL[rarity][0]}
          </span>
          <span class="visually-hidden">{RARITY_LABEL[rarity]}</span>
        </>
      ) : (
        RARITY_LABEL[rarity]
      )}
    </span>
  );
}

/** Coloured pip for a colour with its letter (decorative when a label is next to it). */
export function ColorPip({ color, label }: { color: Color | 'C'; label?: boolean }) {
  return (
    <span class="pip" data-c={color} aria-hidden={label ? undefined : 'true'} title={label ? undefined : color === 'C' ? 'Colorless' : COLOR_NAME[color]}>
      {color}
    </span>
  );
}

/** Horizontal 0..100 meter with its value as text. */
export function Meter({ value, label, tone = 'accent' }: { value: number; label: string; tone?: 'accent' | 'positive' | 'warning' | 'negative' }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <span class={`meter meter--${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <span class="meter__fill" style={{ width: `${v}%` }} />
    </span>
  );
}

export function toneFor(score: number): 'positive' | 'accent' | 'warning' | 'negative' {
  if (score >= 75) return 'positive';
  if (score >= 55) return 'accent';
  if (score >= 35) return 'warning';
  return 'negative';
}

/** Status line for slow work (card data download, analysis). */
export function Busy({ children }: { children: ComponentChildren }) {
  return (
    <p class="busy" role="status">
      <span class="busy__spin" aria-hidden="true" />
      {children}
    </p>
  );
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'error'; title?: string; children: ComponentChildren }) {
  return (
    <div class={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'note'}>
      <svg class="notice__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        {tone === 'info' ? (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 7.5v.5" />
          </>
        ) : (
          <>
            <path d="M12 3.5 2.5 20h19z" />
            <path d="M12 10v4.5M12 17.5v.5" />
          </>
        )}
      </svg>
      <div class="notice__body">
        {title ? <p class="notice__title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
