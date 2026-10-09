import type { PokemonType } from '../schema.ts';
import { typeVar } from './lib/types.ts';

interface Props {
  type: PokemonType;
  /** Optional multiplier label shown after the name, e.g. "×4". */
  mult?: string;
  small?: boolean;
}

/** A type name with its (decorative) colour. Works in .astro pages and islands. */
export default function TypeChip({ type, mult, small = false }: Props) {
  return (
    <span class={small ? 'pk-type pk-type--sm' : 'pk-type'} style={`--t: var(${typeVar(type)})`} data-type={type}>
      {type}
      {mult ? <span class="pk-type__mult">{mult}</span> : null}
    </span>
  );
}

/** Both types of a Pokémon. */
export function TypeList({ types, small = false }: { types: readonly PokemonType[]; small?: boolean }) {
  return (
    <span class="pk-types">
      {types.map((t) => (
        <TypeChip type={t} small={small} key={t} />
      ))}
    </span>
  );
}
