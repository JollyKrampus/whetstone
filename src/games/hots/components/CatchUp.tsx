import { useEffect, useRef, useState } from 'preact/hooks';
import Badge from '../../../components/Badge.tsx';
import { formatDayUTC } from '../../../core/format.ts';
import { onHashChange, readHash, writeHash } from '../../../core/urlstate.ts';
import ChangeList from './ChangeList.tsx';
import { catchUp, isIsoDate, readSince, sinceHash, type CatchUpData, type CatchUpResult } from './catchup.ts';
import './hots.css';
import { describeCounts, PATCH_KIND } from './labels.ts';

interface Props {
  /** Result for `defaultSince`, computed at build time (the server-rendered view). */
  initial: CatchUpResult;
  defaultSince: string;
  /** Earliest and latest dates the picker offers. */
  min: string;
  max: string;
  /** Static JSON with every patch (CatchUpData), fetched on the first change of date. */
  dataUrl: string;
  /** One-click dates, e.g. "Before 2.57". */
  shortcuts: { label: string; since: string }[];
}

type Status = 'idle' | 'loading' | 'error';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Island: "When did you last play?" Pick a date and see every hero change since, grouped by hero
 * with the biggest changes first. The date lives in the URL hash (#since=YYYY-MM-DD) so the view
 * can be shared; the default view is rendered on the server.
 */
export default function CatchUp({ initial, defaultSince, min, max, dataUrl, shortcuts }: Props) {
  const [since, setSince] = useState(initial.since);
  const [result, setResult] = useState(initial);
  const [status, setStatus] = useState<Status>('idle');
  const data = useRef<CatchUpData | null>(null);
  const pending = useRef(0);

  async function show(next: string, updateHash = true) {
    if (!isIsoDate(next)) return;
    setSince(next);
    if (updateHash) writeHash(sinceHash(next));
    if (next === initial.since && !data.current) {
      setResult(initial);
      return;
    }
    const ticket = ++pending.current;
    try {
      if (!data.current) {
        setStatus('loading');
        const res = await fetch(dataUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data.current = (await res.json()) as CatchUpData;
      }
      if (ticket !== pending.current) return;
      setResult(catchUp(data.current, next));
      setStatus('idle');
    } catch {
      if (ticket === pending.current) setStatus('error');
    }
  }

  useEffect(() => {
    const fromHash = readSince(readHash());
    if (fromHash && fromHash !== initial.since) void show(fromHash, false);
    return onHashChange((hash) => {
      const next = readSince(hash) ?? defaultSince;
      void show(next, false);
    });
    // Props never change after hydration.
  }, []);

  const busy = status === 'loading';
  const heroCount = result.groups.length;
  const lines = result.groups.reduce((n, g) => n + g.lines.length, 0);

  return (
    <div class="hx-catchup" data-catchup data-since={since}>
      <form class="hx-catchup__form" onSubmit={(e) => e.preventDefault()} aria-label="Pick your last session">
        <div class="hx-catchup__row">
          <div class="hx-catchup__field">
            <label for="catchup-since">When did you last play?</label>
            <input
              id="catchup-since"
              class="hx-catchup__date"
              type="date"
              value={since}
              min={min}
              max={max}
              aria-describedby="catchup-hint"
              onInput={(e) => {
                const v = e.currentTarget.value;
                if (isIsoDate(v)) void show(v);
              }}
              data-catchup-date
            />
          </div>
          {shortcuts.length > 0 ? (
            <div class="cluster" role="group" aria-label="Shortcuts">
              {shortcuts.map((s) => (
                <button type="button" class="chip" aria-pressed={since === s.since} key={s.since} onClick={() => void show(s.since)}>
                  {s.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <p id="catchup-hint" class="hx-catchup__hint">
          Shows changes released after that day. The link updates as you pick, so you can share it.
        </p>
      </form>

      <p class="hx-catchup__summary" role="status" aria-live="polite" aria-busy={busy} data-catchup-summary>
        {status === 'error'
          ? 'Could not load the patch history. Check your connection and pick the date again.'
          : busy
            ? 'Loading changes…'
            : result.patches.length === 0
              ? `Nothing has changed since ${formatDayUTC(result.since)}. You're up to date.`
              : `Since ${formatDayUTC(result.since)}: ${plural(result.patches.length, 'patch', 'patches')}, ${plural(heroCount, 'hero', 'heroes')} changed${
                  result.newHeroes.length ? `, ${plural(result.newHeroes.length, 'new hero', 'new heroes')}` : ''
                }${lines ? ` (${describeCounts(result.counts)})` : ''}.`}
      </p>

      {result.patches.length > 0 ? (
        <section class="hx-catchup__section" aria-labelledby="cu-patches">
          <h2 id="cu-patches">Patches in this window</h2>
          <ul class="hx-catchup__patches">
            {result.patches.map((p) => (
              <li key={p.id}>
                <a class="hx-catchup__patch" href={p.href}>
                  <time dateTime={p.date}>{formatDayUTC(p.date)}</time>
                  <span>{p.title}</span>
                  <Badge tone={PATCH_KIND[p.kind].tone}>{PATCH_KIND[p.kind].label}</Badge>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.newHeroes.length > 0 ? (
        <section class="hx-catchup__section" aria-labelledby="cu-new">
          <h2 id="cu-new">New heroes</h2>
          <ul class="hx-newheroes">
            {result.newHeroes.map((h) => (
              <li key={h.id}>
                <HeroChip name={h.name} href={h.href} portrait={h.portrait} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.groups.length > 0 ? (
        <section class="hx-catchup__section" aria-labelledby="cu-heroes">
          <h2 id="cu-heroes">Hero changes, biggest first</h2>
          <ol class="hx-groups">
            {result.groups.map((g) => (
              <li class="hx-group" key={g.hero.id} data-hero={g.hero.id} data-rework={g.rework ? 'true' : undefined} data-new={g.isNew ? 'true' : undefined}>
                <div class="hx-group__head">
                  <HeroChip name={g.hero.name} href={g.hero.href} portrait={g.hero.portrait} />
                  <span class="hx-group__badges">
                    {g.isNew ? <Badge tone="accent">New hero</Badge> : null}
                    {g.rework ? <Badge tone="warning">Rework</Badge> : null}
                    <span class="hx-group__count">{describeCounts(g.counts)}</span>
                  </span>
                </div>
                <ChangeList
                  changes={g.lines.map((l) => ({
                    section: l.section,
                    target: l.target,
                    text: l.text,
                    dir: l.dir,
                    meta: { text: `${formatDayUTC(l.date)} ${PATCH_KIND[l.kind].label.toLowerCase()}`, href: l.patchHref },
                  }))}
                />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {result.general.length > 0 ? (
        <section class="hx-catchup__section" aria-labelledby="cu-general">
          <h2 id="cu-general">General changes</h2>
          <ul class="hx-general">
            {result.general.map((g) => (
              <li key={g.patchId}>
                <a href={g.href}>
                  {g.title} <span class="hx-group__count">({formatDayUTC(g.date)})</span>
                </a>
                <ul>
                  {g.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.patches.length === 0 && status === 'idle' ? (
        <p class="hx-catchup__empty">No patch notes after this date. Pick an earlier day to see older changes.</p>
      ) : null}
    </div>
  );
}

function HeroChip({ name, href, portrait }: { name: string; href: string; portrait: string | null }) {
  const inner = (
    <>
      {portrait ? (
        <img class="hx-hero__img" src={portrait} alt="" width={40} height={40} loading="lazy" />
      ) : (
        <span class="hx-hero__img hx-hero__img--blank" aria-hidden="true">
          {name.slice(0, 1)}
        </span>
      )}
      <span class="hx-hero__name">{name}</span>
    </>
  );
  return href ? (
    <a class="hx-hero" href={href}>
      {inner}
    </a>
  ) : (
    <span class="hx-hero">{inner}</span>
  );
}
