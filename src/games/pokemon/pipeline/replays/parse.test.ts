import { describe, expect, it } from 'vitest';
import type { Item, Species } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { packedItems, parseLog } from './parse.ts';

const stub = { base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, abilities: ['x'], weightkg: 1, legal: ['M-C'] };
const ids = ['pelipper', 'inteleon', 'raichu', 'indeedeef', 'overqwil', 'rillaboom', 'swampert', 'archaludon', 'grimmsnarl', 'golisopod', 'sinistcha', 'zoroarkhisui', 'kingambit'];
const species: Species[] = [
  ...ids.map((id, i) => ({ ...stub, id, name: id, num: i + 1, types: ['Normal'] as ['Normal'] })),
  { ...stub, id: 'raichumegay', name: 'Raichu-Mega-Y', num: 3, types: ['Electric'], megaOf: 'raichu', requiredItem: 'raichunitey' },
  { ...stub, id: 'swampertmega', name: 'Swampert-Mega', num: 7, types: ['Water', 'Ground'], megaOf: 'swampert', requiredItem: 'swampertite' },
];
species.find((s) => s.id === 'indeedeef')!.name = 'Indeedee-F';
species.find((s) => s.id === 'zoroarkhisui')!.name = 'Zoroark-Hisui';
const items: Item[] = [
  { id: 'raichunitey', name: 'Raichunite Y', legal: ['M-C'], mega: { base: 'raichu', forme: 'raichumegay' } },
  { id: 'swampertite', name: 'Swampertite', legal: ['M-C'], mega: { base: 'swampert', forme: 'swampertmega' } },
];
const dex = dexIndex(species, items);

/** A Bo3 log as Showdown writes it (player names are placeholders). */
export const SAMPLE_LOG = [
  '|j|☆Alice Example',
  '|j|☆Bob Example',
  '|gametype|doubles',
  '|player|p1|Alice Example|1|1086',
  '|player|p2|Bob Example|linebacker|1156',
  '|tier|[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)',
  '|poke|p1|Inteleon, L50, M|',
  '|poke|p1|Pelipper, L50, M|',
  '|poke|p1|Raichu, L50, M|',
  '|poke|p1|Indeedee-F, L50, F|',
  '|poke|p1|Overqwil, L50, M|',
  '|poke|p1|Rillaboom, L50, F|',
  '|poke|p2|Pelipper, L50, F|',
  '|poke|p2|Swampert, L50, M|',
  '|poke|p2|Archaludon, L50, M|',
  '|poke|p2|Grimmsnarl, L50, M|',
  '|poke|p2|Golisopod, L50, M|',
  '|poke|p2|Sinistcha, L50|',
  '|teampreview|4',
  '|showteam|p1|Inteleon||ScopeLens|Sniper|Protect,IceBeam|Timid||M|||50|]Pelipper||FocusSash|Drizzle|Hurricane,Tailwind|Bold||M|||50|]Raichu||RaichuniteY|LightningRod|FakeOut,Protect|Hasty||M|||50|]Indeedee-F||PsychicSeed|PsychicSurge|TrickRoom|Bold||F|||50|]Overqwil||WhiteHerb|SwiftSwim|GunkShot|Adamant||M|||50|]Rillaboom||MiracleSeed|GrassySurge|FakeOut|Jolly||F|||50|',
  '|showteam|p2|Pelipper||SitrusBerry|Drizzle|Hurricane|Modest||F|||50|]Swampert||Swampertite|Torrent|WaveCrash|Adamant||M|||50|]Archaludon||Leftovers|Stamina|ElectroShot|Modest||M|||50|]Grimmsnarl||LightClay|Prankster|Reflect|Careful||M|||50|]Golisopod||Golisopite|EmergencyExit|LeechLife|Adamant||M|||50|]Sinistcha||ColburBerry|Hospitality|RagePowder|Bold|||||50|',
  '|start',
  '|switch|p1a: Pelipper|Pelipper, L50, M|100/100',
  '|switch|p1b: Inteleon|Inteleon, L50, M|100/100',
  '|switch|p2a: Pelipper|Pelipper, L50, F|100/100',
  '|switch|p2b: Swampert|Swampert, L50, M|100/100',
  '|turn|1',
  '|c|☆Alice Example|glhf',
  '|detailschange|p2b: Swampert|Swampert-Mega, L50, M',
  '|-mega|p2b: Swampert|Swampert|Swampertite',
  '|switch|p2b: Sinistcha|Sinistcha, L50|100/100',
  '|switch|p1b: Raichu|Raichu, L50, M|100/100',
  '|switch|p2b: Swampert|Swampert-Mega, L50, M|50/100',
  '|switch|p2b: Archaludon|Archaludon, L50, M|100/100',
  '|switch|p1a: Rillaboom|Rillaboom, L50, F|100/100',
  '|win|Alice Example',
].join('\n');

describe('packedItems', () => {
  it('maps species to held item ids, nickname or not', () => {
    expect(packedItems('Nick|Raichu|RaichuniteY|LightningRod|FakeOut||||||50|]Swampert||Swampertite|Torrent|WaveCrash|||||||')).toEqual(
      new Map([
        ['raichu', 'raichunitey'],
        ['swampert', 'swampertite'],
      ]),
    );
  });
});

describe('parseLog', () => {
  it('reads teams, brought Pokémon in order of appearance, Megas and the winner', () => {
    const game = parseLog(SAMPLE_LOG, dex);
    expect(game).toEqual({
      winner: 1,
      sides: [
        { team: ['inteleon', 'pelipper', 'raichumegay', 'indeedeef', 'overqwil', 'rillaboom'], brought: ['pelipper', 'inteleon', 'raichumegay', 'rillaboom'] },
        { team: ['pelipper', 'swampertmega', 'archaludon', 'grimmsnarl', 'golisopod', 'sinistcha'], brought: ['pelipper', 'swampertmega', 'sinistcha', 'archaludon'] },
      ],
    });
  });

  it('maps the winner by name to the side', () => {
    const game = parseLog(SAMPLE_LOG.replace('|win|Alice Example', '|win|Bob Example'), dex);
    expect(typeof game === 'object' && game.winner).toBe(2);
  });

  it('returns no-result for ties, unfinished logs and unknown winners', () => {
    expect(parseLog(SAMPLE_LOG.replace('|win|Alice Example', '|tie'), dex)).toBe('no-result');
    expect(parseLog(SAMPLE_LOG.replace('|win|Alice Example', ''), dex)).toBe('no-result');
    expect(parseLog(SAMPLE_LOG.replace('|win|Alice Example', '|win|Someone Else'), dex)).toBe('no-result');
  });

  it('refuses logs with species the dex does not know', () => {
    expect(parseLog(SAMPLE_LOG.replace('|poke|p2|Sinistcha, L50|', '|poke|p2|Missingno, L50|'), dex)).toBe('unknown-species');
  });

  it('needs team preview and at least one switch per side', () => {
    expect(parseLog(SAMPLE_LOG.split('\n').filter((l) => !l.startsWith('|poke|p2')).join('\n'), dex)).toBe('no-teams');
  });

  it('takes back an Illusion disguise on |replace|', () => {
    const log = [
      '|player|p1|A|1|',
      '|player|p2|B|1|',
      '|poke|p1|Zoroark-Hisui, L50, M|',
      '|poke|p1|Kingambit, L50, M|',
      '|poke|p1|Pelipper, L50, M|',
      '|poke|p2|Rillaboom, L50, M|',
      '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
      '|switch|p1b: Pelipper|Pelipper, L50, M|100/100',
      '|switch|p2a: Rillaboom|Rillaboom, L50, M|100/100',
      '|switch|p1a: Kingambit|Kingambit, L50, M|100/100',
      '|replace|p1a: Zoroark|Zoroark-Hisui, L50, M',
      '|win|B',
    ].join('\n');
    const game = parseLog(log, dex);
    // Kingambit led for real (first switch), so it stays; the disguised second entrance is Zoroark.
    expect(typeof game === 'object' && game.sides[0].brought).toEqual(['kingambit', 'pelipper', 'zoroarkhisui']);
  });
});
