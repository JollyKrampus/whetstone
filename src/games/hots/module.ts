import type { GameModule } from '../../core/game.ts';

/** Browser-safe metadata for Heroes of the Storm. The pipeline lives in ./pipeline/ and is loaded lazily. */
export const hots: GameModule = {
  id: 'hots',
  name: 'Heroes of the Storm',
  short: 'HotS',
  tagline: 'Counters, true-order draft and tier lists, with the reasons behind every pick.',
  status: 'live',
  accent: '--accent-hots',
  sources: [
    // Ids match the pipeline's SourceStatus ids in meta.json so freshness banners can name them.
    {
      id: 'blizzard-news',
      name: 'Blizzard Entertainment',
      url: 'https://news.blizzard.com/en-us/heroes-of-the-storm',
      attribution: 'Patch notes and game content © Blizzard Entertainment, Inc.',
      rule: 'footer',
      license: 'Blizzard fan-site terms (non-commercial)',
      tosNote:
        'Personal, non-commercial, revocable fan-site license; copyright and trademark notices required. ' +
        "We store no sentences from the patch notes: each change is kept as our own structured summary (what changed, " +
        'old and new numbers, buff or nerf, or the kind of change), and every patch links to the original notes.',
      custody: 'A',
    },
    {
      id: 'tact',
      name: 'Blizzard version server',
      url: 'https://us.version.battle.net/v2/products/hero/versions',
      attribution: 'Live and PTR build numbers from the Blizzard version server.',
      rule: 'footer',
      tosNote: 'Public build metadata only; used to detect new patches and hotfixes.',
      custody: 'A',
    },
    {
      id: 'heroes-data2',
      name: 'HeroesToolChest heroes-data2',
      url: 'https://github.com/HeroesToolChest/heroes-data2',
      attribution: 'Hero, ability, talent and map data extracted by HeroesToolChest heroes-data2 (MIT).',
      rule: 'footer',
      license: 'MIT',
      tosNote: 'MIT covers the extraction and packaging; the underlying game data is © Blizzard Entertainment.',
      custody: 'A',
    },
    {
      id: 'heroes-images',
      name: 'HeroesToolChest heroes-images',
      url: 'https://github.com/HeroesToolChest/heroes-images',
      attribution: 'Portraits and icons via HeroesToolChest heroes-images (MIT); artwork © Blizzard Entertainment.',
      rule: 'footer',
      license: 'MIT (artwork © Blizzard Entertainment)',
      tosNote: 'A pinned subset of portraits, icons and map images is converted to WebP and self-hosted with this credit.',
      custody: 'A',
    },
    {
      id: 'liquipedia',
      name: 'Liquipedia',
      url: 'https://liquipedia.net/heroes/',
      attribution: 'Pro draft data from Liquipedia, licensed CC-BY-SA 3.0',
      rule: 'inline',
      license: 'CC-BY-SA 3.0',
      tosNote:
        'Share-alike: derived pro-draft files are published separately under CC-BY-SA 3.0. ' +
        'Fetched through the MediaWiki API only (custom User-Agent, 2 s spacing).',
      custody: 'A-SA',
    },
    {
      id: 'nexus-compendium',
      name: 'Nexus Compendium',
      url: 'https://nexuscompendium.com',
      attribution: 'Free hero rotation and ranked season dates courtesy of Nexus Compendium.',
      rule: 'footer',
      tosNote: 'No published terms; used for the rotation and season only, with attribution.',
      custody: 'A',
    },
    {
      id: 'youtube',
      name: 'YouTube',
      url: 'https://www.youtube.com',
      attribution: 'Video guide details from YouTube.',
      rule: 'inline',
      license: 'YouTube API Services Terms',
      tosNote: 'Optional (needs an API key). Ephemeral: never committed, refreshed or dropped within 30 days.',
      custody: 'C',
    },
    {
      id: 'twitch',
      name: 'Twitch',
      url: 'https://www.twitch.tv/directory/category/heroes-of-the-storm',
      attribution: 'Live data from Twitch.',
      rule: 'inline',
      tosNote:
        'Not used: Whetstone fetches no Twitch data and holds no Twitch credentials. The live page links to the Heroes of the Storm category and loads a featured channel’s player only when you click it.',
      custody: 'C',
    },
  ],
  nav: [
    { label: 'Heroes', path: '' },
    { label: 'Maps', path: 'maps/' },
    { label: 'Tier list', path: 'tierlist/' },
    { label: 'Draft', path: 'draft/' },
    { label: 'ARAM', path: 'aram/' },
    { label: 'Patches', path: 'patches/' },
    { label: 'Catch-up', path: 'catch-up/' },
    { label: 'Pro', path: 'pro/' },
    { label: 'Live', path: 'live/' },
    { label: 'About', path: 'about/' },
  ],
};

export default hots;
