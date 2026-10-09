export type IssueLevel = 'error' | 'warning' | 'info' | 'ok';

export interface IssueItem {
  level: IssueLevel;
  message: string;
}

const TAG: Record<IssueLevel, string> = { error: 'Error', warning: 'Warning', info: 'Note', ok: 'OK' };

/** Legality or import messages. The level is spelled out, never shown by colour alone. */
export default function IssueList({ issues, label, class: extra }: { issues: readonly IssueItem[]; label?: string; class?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul class={extra ? `pk-issues ${extra}` : 'pk-issues'} aria-label={label}>
      {issues.map((x, i) => (
        <li class="pk-issue" data-level={x.level} key={`${i}-${x.message}`}>
          <span class="pk-issue__tag">{TAG[x.level]}</span>
          <span>{x.message}</span>
        </li>
      ))}
    </ul>
  );
}
