import type { ComponentChildren } from 'preact';
import type { Tone } from './types.ts';

interface Props {
  tone?: Tone;
  /** Extra explanation; exposed as a tooltip and to assistive tech, never the only carrier of meaning. */
  title?: string;
  class?: string;
  children: ComponentChildren;
}

/** Small label pill. Usable from .astro (static HTML) and from islands. */
export default function Badge({ tone = 'neutral', title, class: extra, children }: Props) {
  return (
    <span class={extra ? `badge badge--${tone} ${extra}` : `badge badge--${tone}`} title={title}>
      {children}
      {title ? <span class="visually-hidden">: {title}</span> : null}
    </span>
  );
}
