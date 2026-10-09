import type { GameModule } from '../../core/game.ts';

/** Browser-safe metadata for MTG Arena. The pipeline lives in ./pipeline/ and is loaded lazily. */
export const mtga: GameModule = {
  id: 'mtga',
  name: 'MTG Arena',
  short: 'MTGA',
  tagline: 'Paste a deck for legality, curve, power tier and upgrades, plus Limited ratings.',
  status: 'beta',
  accent: '--accent-mtga',
  sources: [
    {
      id: 'scryfall',
      name: 'Scryfall',
      url: 'https://scryfall.com',
      attribution: 'Card data and images courtesy of Scryfall',
      rule: 'footer',
      license: 'Scryfall API terms',
      tosNote:
        'Free for Magic software: no paywall, no plain repackaging; images unaltered with artist credit. ' +
        'Bulk data feeds a trimmed in-app index that is not offered as a dataset.',
      custody: 'A',
    },
    {
      id: '17lands',
      name: '17Lands',
      url: 'https://www.17lands.com/public_datasets',
      attribution: 'Limited ratings derived from 17Lands public datasets, licensed CC BY 4.0',
      rule: 'top',
      license: 'CC BY 4.0',
      tosNote: 'Public datasets only (no API scraping); credited at the top of every Limited page.',
      custody: 'A',
    },
    {
      id: 'curated-meta',
      name: 'Whetstone curated meta',
      url: 'https://github.com/JollyKrampus/whetstone/tree/main/curated/mtga/meta',
      attribution: 'Constructed meta lists hand-curated by Whetstone contributors, each linked to its original source.',
      rule: 'footer',
      tosNote: 'Curated by hand from public results; no automated collection from sites that forbid it.',
      custody: 'A',
    },
    {
      id: 'grindstone-mcp',
      name: 'grindstone-mcp',
      url: 'https://github.com/JollyKrampus/grindstone-mcp',
      attribution: 'Deck analysis engine from grindstone-mcp (MIT).',
      rule: 'footer',
      license: 'MIT',
      custody: 'A',
    },
  ],
  nav: [
    { label: 'Overview', path: '' },
    { label: 'Deck analyzer', path: 'deck/' },
    { label: 'Limited', path: 'limited/' },
    { label: 'Card search', path: 'search/' },
    { label: 'Meta', path: 'meta/' },
    { label: 'About', path: 'about/' },
  ],
};

export default mtga;
