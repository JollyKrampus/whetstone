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

// Gauge geometry: a 300° arc open at the bottom. pathLength=100 lets dash lengths be percentages.
const ARC = 300 / 360;
const ARC_LEN = ARC * 100;
const START_DEG = 90 + (360 - 300) / 2;

/** 1-100 score gauge. Static SVG with an accessible label; works in .astro pages and islands. */
export default function ScoreRing({ score, size = 44, label, muted = false, tone = 'accent' }: Props) {
  const s = Math.max(1, Math.min(100, Math.round(Number.isFinite(score) ? score : 50)));
  const name = label ?? `Score ${s} out of 100`;
  const cls = `score-ring score-ring--${tone}${muted ? ' score-ring--muted' : ''}`;
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 44 44" role="img" aria-label={name}>
      <g transform={`rotate(${START_DEG} 22 22)`} fill="none" stroke-width="4" stroke-linecap="round">
        <circle class="score-ring__track" cx="22" cy="22" r="18" pathLength={100} stroke-dasharray={`${ARC_LEN} 100`} />
        <circle
          class="score-ring__fill"
          cx="22"
          cy="22"
          r="18"
          pathLength={100}
          stroke-dasharray={`${(ARC_LEN * s) / 100} 100`}
        />
      </g>
      <text class="score-ring__value" x="22" y="22" text-anchor="middle" dominant-baseline="central">
        {s}
      </text>
    </svg>
  );
}
