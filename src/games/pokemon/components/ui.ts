/** Prop shapes shared by the Pokémon .astro components. */

export interface ShareRow {
  label: string;
  /** 0–1 */
  share: number;
  href?: string | undefined;
  /** Small text after the label, e.g. "Spe 169". */
  note?: string | undefined;
}
