import { manaLabel, manaSymbols } from '../lib/mana.ts';

interface Props {
  cost: string;
  class?: string;
}

/** Mana cost as CSS-drawn symbols with a spoken label (no symbol images are loaded). */
export default function ManaCost({ cost, class: extra }: Props) {
  const parts = cost.split(' // ');
  if (!cost) return null;
  return (
    <span class={extra ? `mana ${extra}` : 'mana'} role="img" aria-label={`Mana cost: ${parts.map(manaLabel).join('; then ')}`}>
      {parts.map((part, i) => (
        <span class="mana__face" key={i}>
          {i > 0 ? <span class="mana__sep">//</span> : null}
          {manaSymbols(part).map((s, j) => (
            <span
              key={j}
              class={`mana__sym${s.colors.length > 1 ? ' mana__sym--hybrid' : ''}${s.phyrexian ? ' mana__sym--phy' : ''}`}
              data-c={s.colors[0]}
              data-c2={s.colors[1]}
              aria-hidden="true"
            >
              {s.colors.length > 1 ? s.text.replace('/P', '').split('/').map((t) => t[0]).join('') : s.text.replace('/P', '')}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
