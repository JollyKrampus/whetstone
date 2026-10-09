import { describe, expect, it } from 'vitest';
import { exportTeam, parseHeader, parsePaste, spLine } from './paste.ts';
import { fixtureDex } from './testdex.ts';

const dex = fixtureDex();

const SP_PASTE = `
Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- Protect

Boss (Incineroar) (M) @ Sitrus Berry
Ability: Intimidate
EVs: 32 HP / 2 Def / 32 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Knock Off
- Parting Shot
`;

const EV_PASTE = `
Garchomp @ Choice Scarf
Ability: Rough Skin
Tera Type: Steel
EVs: 4 HP / 252 Atk / 252 Spe
IVs: 0 SpA
Jolly Nature
- Earthquake
- Rock Slide
- Dragon Claw
- Protect

Whimsicott @ Focus Sash
Ability: Prankster
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
- Tailwind
- Moonblast
- Encore
- Protect
`;

describe('parseHeader', () => {
  it('splits nickname, species, gender and item', () => {
    expect(parseHeader('Boss (Incineroar) (M) @ Sitrus Berry')).toEqual({ species: 'Incineroar', nickname: 'Boss', item: 'Sitrus Berry' });
    expect(parseHeader('Indeedee-F (F) @ Psychic Seed')).toEqual({ species: 'Indeedee-F', item: 'Psychic Seed' });
    expect(parseHeader('Garchomp')).toEqual({ species: 'Garchomp' });
  });
});

describe('parsePaste: Stat Points', () => {
  const result = parsePaste(SP_PASTE, dex);

  it('reads sets with Stat Points as-is', () => {
    expect(result.convertedFromEvs).toBe(false);
    expect(result.team).toHaveLength(2);
    expect(result.team[0]).toEqual({
      species: 'rillaboom',
      item: 'miracleseed',
      ability: 'grassysurge',
      nature: 'Adamant',
      sp: [32, 32, 0, 0, 2, 0],
      moves: ['fakeout', 'grassyglide', 'woodhammer', 'protect'],
    });
    expect(result.team[1]).toMatchObject({ species: 'incineroar', nickname: 'Boss', sp: [32, 0, 2, 0, 32, 0], nature: 'Careful' });
    expect(result.issues.filter((i) => i.level !== 'info')).toEqual([]);
  });

  it('round-trips through export', () => {
    const text = exportTeam(result.team, dex);
    expect(text).toContain('Boss (Incineroar) @ Sitrus Berry');
    expect(text).toContain('EVs: 32 HP / 32 Atk / 2 SpD');
    expect(text).toContain('Level: 50');
    expect(parsePaste(text, dex).team).toEqual(result.team);
  });
});

describe('parsePaste: EVs', () => {
  const result = parsePaste(EV_PASTE, dex);

  it('converts EV pastes with the HOME rule', () => {
    expect(result.convertedFromEvs).toBe(true);
    expect(result.team[0]!.sp).toEqual([1, 32, 0, 0, 0, 32]);
    expect(result.team[1]!.sp).toEqual([1, 0, 0, 32, 0, 32]);
    expect(result.issues.some((i) => i.level === 'info' && /converted to Stat Points/.test(i.message))).toBe(true);
  });

  it('notes ignored Tera and IV lines', () => {
    const notes = result.issues.filter((i) => i.slot === 0).map((i) => i.message);
    expect(notes.some((m) => /Tera Type/.test(m))).toBe(true);
    expect(notes.some((m) => /IVs/.test(m))).toBe(true);
  });

  it('decides EV vs SP per paste, so small EV lines convert too', () => {
    const mixed = parsePaste('Pelipper\nAbility: Drizzle\nEVs: 4 HP\n- Hurricane\n\nGarchomp\nEVs: 252 Atk\n- Earthquake', dex);
    expect(mixed.convertedFromEvs).toBe(true);
    expect(mixed.team[0]!.sp[0]).toBe(1);
  });
});

describe('parsePaste: names and errors', () => {
  it('registers a Mega forme as its base species with the stone', () => {
    const r = parsePaste('Salamence-Mega\nAbility: Intimidate\n- Hurricane', dex);
    expect(r.team[0]).toMatchObject({ species: 'salamence', item: 'salamencite' });
    expect(r.issues.some((i) => /registered as Salamence/.test(i.message))).toBe(true);
  });

  it('skips unknown Pokémon and drops unknown moves with a warning', () => {
    const r = parsePaste('Missingno\n- Water Gun\n\nKingambit @ Life Orb\n- Kowtow Cleave\n- Splash', dex);
    expect(r.team.map((s) => s.species)).toEqual(['kingambit']);
    expect(r.issues.some((i) => i.level === 'error' && /Missingno/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => i.level === 'warning' && /Splash/.test(i.message))).toBe(true);
  });

  it('fills a single possible ability and keeps 6 sets at most', () => {
    const many = Array.from({ length: 7 }, () => 'Gholdengo\n- Make It Rain').join('\n\n');
    const r = parsePaste(many, dex);
    expect(r.team).toHaveLength(6);
    expect(r.team[0]!.ability).toBe('goodasgold');
    expect(r.issues.some((i) => /only the first 6/.test(i.message))).toBe(true);
  });

  it('reports an empty paste', () => {
    expect(parsePaste('   \n', dex).issues[0]!.level).toBe('error');
  });

  it('handles Windows line endings and team headers', () => {
    const r = parsePaste('=== [gen9championsvgc2026regmc] Rain ===\r\n\r\nPelipper @ Mystic Water\r\nAbility: Drizzle\r\n- Hurricane\r\n', dex);
    expect(r.team).toEqual([{ species: 'pelipper', item: 'mysticwater', ability: 'drizzle', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: ['hurricane'] }]);
  });
});

describe('spLine', () => {
  it('omits zero stats', () => {
    expect(spLine([2, 0, 0, 32, 0, 32])).toBe('2 HP / 32 SpA / 32 Spe');
    expect(spLine([0, 0, 0, 0, 0, 0])).toBe('');
  });
});
