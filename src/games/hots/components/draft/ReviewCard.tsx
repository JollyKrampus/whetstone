import CopyButton from '../../../../components/CopyButton.tsx';
import ScoreRing from '../../../../components/ScoreRing.tsx';
import { int, pp } from '../../../../core/format.ts';
import type { Reason } from '../../../../core/game.ts';
import type { DraftReview, ReviewPair, TeamReview } from '../../draft/review.ts';
import { Conditions, InlineCredit } from './SuggestionList.tsx';
import { portraitUrl, sourceName, type CreditProp } from './props.ts';

interface Props {
  review: DraftReview;
  /** Plain-text summary for the copy button. */
  summary: string;
  /** Inline credit for the statistics' source, when any line uses them. */
  credit: CreditProp | null;
  /** Source names by SourceRef id, for stat meta. */
  sourceNames?: Readonly<Record<string, string>>;
}

function Basis({ basis }: { basis: 'stat' | 'theory' }) {
  return <span class={`badge ${basis === 'stat' ? 'badge--stats' : 'badge--theory'} rv-basis`}>{basis === 'stat' ? 'Stat' : 'Theory'}</span>;
}

function Why({ reason, names }: { reason: Reason; names?: Readonly<Record<string, string>> | undefined }) {
  const meta: string[] = [];
  if (reason.kind === 'stat') {
    if (reason.delta !== undefined) meta.push(pp(reason.delta));
    if (reason.n !== undefined) meta.push(`n = ${int(reason.n)}`);
    const source = sourceName(names, reason.source);
    if (source) meta.push(source);
  }
  return (
    <span class="rv-why">
      <span>{reason.text}</span>
      <Conditions reason={reason} />
      {meta.length ? <span class="sg-reason__meta">{meta.join(' · ')}</span> : null}
    </span>
  );
}

function Pair({ pair, joiner, names }: { pair: ReviewPair; joiner: string; names?: Readonly<Record<string, string>> | undefined }) {
  return (
    <li class="rv-pair">
      <span class="rv-pair__heroes">
        <img src={portraitUrl(pair.a)} alt="" width="32" height="32" loading="lazy" decoding="async" />
        <img src={portraitUrl(pair.b)} alt="" width="32" height="32" loading="lazy" decoding="async" />
      </span>
      <span class="rv-pair__body">
        <span class="rv-pair__title">
          {pair.a.name} {joiner} {pair.b.name} <Basis basis={pair.basis} />
        </span>
        <Why reason={pair.reason} names={names} />
      </span>
      <ScoreRing score={pair.score} size={36} label={`${pair.basis === 'stat' ? 'Statistics' : 'Theory'} score ${pair.score} out of 100`} />
    </li>
  );
}

function Side({ title, team, other, map, names }: { title: string; team: TeamReview; other: string; map: string | null; names?: Readonly<Record<string, string>> | undefined }) {
  const best = team.mapFit[0];
  const worst = team.mapFit.length > 1 ? team.mapFit.at(-1) : undefined;
  return (
    <section class="rv-side" aria-label={`${title}: review`}>
      <h4 class="rv-side__title">{title}</h4>
      <p class="rv-label">Best counters into {other}</p>
      {team.counters.length ? (
        <ol class="rv-list">
          {team.counters.map((c) => (
            <Pair key={`${c.a.id}-${c.b.id}`} pair={c} joiner="into" names={names} />
          ))}
        </ol>
      ) : (
        <p class="rv-none">No clear counter edge.</p>
      )}
      <p class="rv-label">Best pair</p>
      {team.synergy ? (
        <ul class="rv-list">
          <Pair pair={team.synergy} joiner="with" names={names} />
        </ul>
      ) : (
        <p class="rv-none">No standout pair.</p>
      )}
      {map ? (
        <>
          <p class="rv-label">On {map}</p>
          {best ? (
            <p class="rv-map">
              Best fit: {best.hero.name} ({best.score}){worst && worst.value < 0 ? `. Weakest: ${worst.hero.name} (${worst.score})` : ''}.
            </p>
          ) : (
            <p class="rv-none">No map-specific edges for this team.</p>
          )}
        </>
      ) : null}
      <p class="rv-label">Composition</p>
      {team.sound ? (
        <p class="rv-verdict rv-verdict--ok">
          <span aria-hidden="true">✓ </span>No composition problems found.
        </p>
      ) : (
        <ul class="rv-verdict rv-verdict--warn">
          {team.summary.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The finished-draft review: strongest counters each way, best pair per team, map fit and the
 * guardrail verdict, with a plain-text copy for chat. Every line says whether it is theory or a
 * statistic.
 */
export default function ReviewCard({ review, summary, credit, sourceNames }: Props) {
  return (
    <section class="rv card" aria-labelledby="rv-title">
      <div class="rv-head">
        <h3 class="rv-title" id="rv-title">
          Draft review
        </h3>
        <CopyButton text={summary} label="Copy summary" copiedLabel="Summary copied" class="rv-copy" />
      </div>
      <p class="rv-lead">
        {review.usesStats
          ? 'Key matchups from match statistics where they pass the list bar, theory elsewhere.'
          : 'Key matchups from theory: rules applied to hero kits, not win rates.'}{' '}
        The copied summary is plain text with the share link, ready for Discord.
      </p>
      {review.usesStats && credit ? <InlineCredit credit={credit} /> : null}
      <div class="rv-sides">
        <Side title="You" team={review.ours} other="the enemy" map={review.map?.name ?? null} names={sourceNames} />
        <Side title="Enemy" team={review.theirs} other="your team" map={review.map?.name ?? null} names={sourceNames} />
      </div>
    </section>
  );
}
