interface Props {
  /** 1..100, 50 = neutral. Values outside the range are clamped. */
  score: number;
  /** Rendered size in px (the gauge scales; the number stays legible down to 32). */
  size?: number;
  /** Accessible name; defaults to "Score N out of 100". */
  label?: string;
  /** Greyed style for low-sample rows. */
  muted?: boolean;
  /** Fill colour: the page accent (default) or a semantic tone. */
  tone?: 'accent' | 'positive' | 'negative' | 'neutral';
}

/**
 * 1-100 score gauge: one element whose ::before draws a 300° arc open at the bottom with a CSS
 * conic-gradient (styles in src/styles/components.css), with the number as its text. Pages list
 * hundreds of these, so it carries no SVG. Works in .astro pages and islands.
 */
export default function ScoreRing({ score, size = 44, label, muted = false, tone = 'accent' }: Props) {
  const s = Math.max(1, Math.min(100, Math.round(Number.isFinite(score) ? score : 50)));
  const name = label ?? `Score ${s} out of 100`;
  const cls = `score-ring score-ring--${tone}${muted ? ' score-ring--muted' : ''}`;
  const px = Math.max(24, Math.round(size));
  return (
    <span class={cls} role="img" aria-label={name} style={`--score:${s};--ring-size:${px}px`}>
      <span class="score-ring__value" aria-hidden="true">
        {s}
      </span>
    </span>
  );
}
