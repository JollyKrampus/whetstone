import type { Team } from '../../../../core/draft.ts';
import type { TeamSummary } from '../../draft/roles.ts';
import { portraitUrl, type RosterHero } from './props.ts';

export interface BoardSlot {
  /** Stable key within the panel. */
  key: string;
  kind: 'ban' | 'pick';
  /** 0-based draft step (Storm League); undefined in free mode. */
  step?: number;
  hero: RosterHero | null;
  /** A ban step that passed without a ban. */
  skipped?: boolean;
  /** 1 or 2 for the two slots of Cho'gall. */
  part?: 1 | 2;
  /** The step on the clock / the free-mode target. */
  current: boolean;
}

interface Props {
  team: Team;
  title: string;
  firstPick?: boolean;
  bans: readonly BoardSlot[];
  picks: readonly BoardSlot[];
  summary: TeamSummary | null;
  /** Free mode: choose an empty slot as the target. */
  onTarget?: (kind: 'ban' | 'pick') => void;
  /** Free mode: remove a placed hero. */
  onRemove?: (hero: RosterHero) => void;
}

function slotCaption(s: BoardSlot): string {
  return s.step === undefined ? '+' : String(s.step + 1);
}

function SlotBody({ s }: { s: BoardSlot }) {
  const free = s.step === undefined;
  const name = s.hero ? s.hero.name : s.skipped ? 'No ban' : s.current ? (free ? 'Adding here' : 'Now') : 'Open';
  const sub = [s.step === undefined ? '' : `Step ${s.step + 1}`, s.part ? `${s.part} of 2` : '', s.current && !free ? 'on the clock' : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <span class="tp-slot__pic" aria-hidden="true">
        {s.hero ? <img src={portraitUrl(s.hero)} alt="" width="40" height="40" loading="lazy" decoding="async" /> : <span class="tp-slot__num">{slotCaption(s)}</span>}
      </span>
      <span class="tp-slot__text">
        <span class="tp-slot__name">{name}</span>
        {sub ? <span class="tp-slot__step">{sub}</span> : null}
      </span>
    </>
  );
}

/** One team's column of the draft board: bans, picks (Storm League step numbers), role summary. */
export default function TeamPanel({ team, title, firstPick, bans, picks, summary, onTarget, onRemove }: Props) {
  const renderSlot = (s: BoardSlot) => {
    const cls = `tp-slot tp-slot--${s.kind}${s.current ? ' tp-slot--current' : ''}${s.hero ? ' tp-slot--filled' : ''}${s.skipped ? ' tp-slot--skipped' : ''}`;
    if (s.hero && onRemove) {
      const hero = s.hero;
      return (
        <li key={s.key}>
          <button type="button" class={cls} onClick={() => onRemove(hero)} aria-label={`Remove ${hero.name} from ${title === 'You' ? 'your' : "the enemy's"} ${s.kind === 'ban' ? 'bans' : 'team'}`}>
            <SlotBody s={s} />
            <span class="tp-slot__x" aria-hidden="true">
              ×
            </span>
          </button>
        </li>
      );
    }
    if (!s.hero && onTarget) {
      return (
        <li key={s.key}>
          <button
            type="button"
            class={cls}
            aria-pressed={s.current}
            onClick={() => onTarget(s.kind)}
            aria-label={`Add the next ${s.kind} to ${title === 'You' ? 'your team' : 'the enemy team'}`}
          >
            <SlotBody s={s} />
          </button>
        </li>
      );
    }
    return (
      <li key={s.key} class={cls} aria-current={s.current ? 'step' : undefined}>
        <SlotBody s={s} />
      </li>
    );
  };

  return (
    <section class={`tp tp--${team.toLowerCase()}`} aria-label={`${title} team`}>
      <header class="tp__head">
        <h3 class="tp__title">{title}</h3>
        {firstPick ? <span class="badge badge--neutral">First pick</span> : null}
      </header>
      <h4 class="tp__label">Bans</h4>
      <ol class="tp__bans">{bans.map(renderSlot)}</ol>
      <h4 class="tp__label">Picks</h4>
      <ol class="tp__picks">{picks.map(renderSlot)}</ol>
      {summary ? (
        <div class="tp__summary">
          <ul class="tp__needs" aria-label="Role needs">
            {summary.needs.map((n) => (
              <li key={n.need} class={`tp__need tp__need--${n.met ? 'met' : n.possible ? 'open' : 'gone'}`}>
                <span aria-hidden="true">{n.met ? '✓' : n.possible ? '○' : '–'}</span> {n.need === 'healer' ? 'Healer' : 'Frontline'}
                <span class="visually-hidden">{n.met ? ': covered' : n.possible ? ': still needed' : ': none left'}</span>
              </li>
            ))}
            {summary.counts
              .filter((c) => c.label === 'Ranged dmg' || c.label === 'Melee')
              .map((c) => (
                <li key={c.label} class="tp__count">
                  {c.value} {c.label === 'Ranged dmg' ? 'ranged dmg' : 'melee'}
                </li>
              ))}
          </ul>
          {summary.notes.length > 0 ? (
            <ul class="tp__notes">
              {summary.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
