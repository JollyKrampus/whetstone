import type { DexState } from './hooks.ts';

/**
 * What the Pokémon tools say while the Champions dex shard loads, and when it cannot: a sentence
 * that names the problem and a "Try again" button that re-runs the loader (useDex's retry).
 */
export default function DexStatus({ state, retry }: { state: DexState; retry: () => void }) {
  if (state.status === 'error') {
    return (
      <div class="pk-dexerror" role="alert">
        <p>
          The Champions Pokédex could not load ({state.message}). Check your connection and try again.
        </p>
        <button type="button" class="btn btn--sm" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <p class="pk-status pk-dexloading" role="status">
      Loading the Champions Pokédex…
    </p>
  );
}
