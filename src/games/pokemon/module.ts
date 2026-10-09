import type { GameModule } from '../../core/game.ts';

/** Browser-safe metadata for Pokémon Champions (VGC Doubles). The pipeline lives in ./pipeline/. */
export const pokemon: GameModule = {
  id: 'pokemon',
  name: 'Pokémon Champions',
  short: 'Pokémon',
  tagline: 'VGC Doubles meta, team builder, damage calc, speed tiers and team preview.',
  status: 'beta',
  accent: '--accent-pokemon',
  sources: [
    {
      id: 'showdown',
      name: 'Pokémon Showdown',
      url: 'https://github.com/smogon/pokemon-showdown',
      attribution: 'Pokédex, learnsets and mechanics data from Pokémon Showdown (MIT).',
      rule: 'footer',
      license: 'MIT',
      custody: 'A',
    },
    {
      id: 'smogon',
      name: 'Smogon usage stats',
      url: 'https://www.smogon.com/stats/',
      attribution: 'Ladder usage statistics from Smogon.',
      rule: 'footer',
      tosNote: 'Monthly aggregates, attributed; Smogon sets and analyses are linked, never copied.',
      custody: 'A',
    },
    {
      id: 'limitless',
      name: 'Limitless',
      url: 'https://play.limitlesstcg.com',
      attribution: 'Tournament results via the Limitless API (play.limitlesstcg.com); player names removed.',
      rule: 'footer',
      license: 'Public API',
      tosNote: 'Throttled below 50 requests per 5 minutes; only aggregates and anonymized teams are published.',
      custody: 'A',
    },
    {
      id: 'showdown-replays',
      name: 'Pokémon Showdown replays',
      url: 'https://replay.pokemonshowdown.com',
      attribution: 'Head-to-head results aggregated from public Pokémon Showdown replays; player names removed.',
      rule: 'footer',
      tosNote: 'Public replay API, throttled; only aggregates are published.',
      custody: 'A',
    },
    {
      // Shown wherever sprites appear (every Pokémon page footer); keep in step with SPRITE_CREDIT in pipeline/sprites.ts.
      id: 'showdown-sprites',
      name: 'Pokémon Showdown sprites',
      url: 'https://play.pokemonshowdown.com/sprites/gen5/',
      attribution: 'Sprites: Pokémon Showdown gen5 sprite set (Smogon sprite project); Pokémon images © Nintendo, Creatures and GAME FREAK.',
      rule: 'footer',
      tosNote: 'Self-hosted WebP copies of the legal roster only, re-fetched when the roster changes; never hotlinked.',
      custody: 'A',
    },
    {
      id: 'smogon-calc',
      name: '@smogon/calc',
      url: 'https://github.com/smogon/damage-calc',
      attribution: 'Damage calculations by @smogon/calc (MIT).',
      rule: 'footer',
      license: 'MIT',
      custody: 'A',
    },
  ],
  nav: [
    { label: 'Meta', path: '' },
    { label: 'Tiers', path: 'tiers/' },
    { label: 'Builder', path: 'builder/' },
    { label: 'Calc', path: 'calc/' },
    { label: 'Speed', path: 'speed/' },
    { label: 'Teams', path: 'teams/' },
    { label: 'Team preview', path: 'preview/' },
    { label: 'About', path: 'about/' },
  ],
};

export default pokemon;
