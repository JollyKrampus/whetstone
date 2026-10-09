import type { Reason, ReasonKind } from '../core/game.ts';
import { int, pp } from '../core/format.ts';

interface Props {
  reasons: readonly Reason[];
  /** SourceRef.id -> display name, so stat reasons can say where the number came from. */
  sourceNames?: Readonly<Record<string, string>>;
  /** Show at most this many (the rest are dropped; callers decide how many are worth showing). */
  max?: number;
  class?: string;
}

const KIND_LABEL: Record<ReasonKind, string> = {
  stat: 'Stat',
  theory: 'Theory',
  curated: 'Curated',
  role: 'Role',
  map: 'Map',
  votes: 'Votes',
  pro: 'Pro',
  usage: 'Usage',
};

/** "Why" lines under a score: kind tag + text + numbers + evidence. Static-renderable and island-safe. */
export default function ReasonList({ reasons, sourceNames, max, class: extra }: Props) {
  const shown = max === undefined ? reasons : reasons.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <ul class={extra ? `reasons ${extra}` : 'reasons'}>
      {shown.map((r, i) => {
        const meta: string[] = [];
        if (r.delta !== undefined) meta.push(pp(r.delta));
        if (r.n !== undefined) meta.push(`n = ${int(r.n)}`);
        if (r.source) meta.push(sourceNames?.[r.source] ?? r.source);
        return (
          <li class={`reason reason--${r.kind}`} key={`${r.kind}-${i}`}>
            <span class="reason__kind">{KIND_LABEL[r.kind]}</span>
            <span class="reason__body">
              <span class="reason__text">{r.text}</span>
              {meta.length > 0 ? <span class="reason__meta">{meta.join(' · ')}</span> : null}
              {r.evidence && r.evidence.length > 0 ? (
                <span class="reason__evidence">via {r.evidence.join(', ')}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
