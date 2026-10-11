import { describe, expect, it } from 'vitest';
import { changeText, cleanSubject, copiesSource, generalCategory, generalSummary, longestSharedRun, mapSummary, qualitativeKind, sourceRuns, statLabel, summarizeLine } from './summary.ts';

describe('summarizeLine', () => {
  it('keeps numbers, a short label, the unit and a computed direction', () => {
    expect(summarizeLine('Health increased from 1698 to 1780.')).toEqual([{ kind: 'numeric', stat: 'Health', old: 1698, new: 1780, dir: 'buff' }]);
    expect(summarizeLine('Cooldown increased from 60 to 75 seconds.')).toEqual([{ kind: 'numeric', stat: 'Cooldown', old: 60, new: 75, unit: 's', dir: 'nerf' }]);
    expect(summarizeLine('Damage bonus increased to 100%, up from 70%.')).toEqual([{ kind: 'numeric', stat: 'Damage bonus', old: 70, new: 100, unit: '%', dir: 'buff' }]);
    expect(summarizeLine('Uncharged damage reduced by 20%.')).toEqual([{ kind: 'numeric', stat: 'Uncharged damage', by: -20, unit: '%', dir: 'nerf' }]);
    expect(summarizeLine('Mana cost lowered from 1,000 to 900.')).toEqual([{ kind: 'numeric', stat: 'Mana cost', old: 1000, new: 900, dir: 'buff' }]);
  });

  it('splits lines with several changes and labels long subjects in our own words', () => {
    expect(summarizeLine('Self healing increased from 30% to 40% and healing of nearby Allies increased from 15% to 20%.')).toEqual([
      { kind: 'numeric', stat: 'Self healing', old: 30, new: 40, unit: '%', dir: 'buff' },
      { kind: 'numeric', stat: 'Healing of nearby Allies', old: 15, new: 20, unit: '%', dir: 'buff' },
    ]);
    expect(summarizeLine('Increased the amount of shield gained from Basic Attacks from 10% to 20% of damage dealt.')).toEqual([
      { kind: 'numeric', stat: 'Shield', old: 10, new: 20, unit: '%', dir: 'buff' },
    ]);
    expect(summarizeLine("Shadowflame's cooldown reduction from Quest Reward increased from 0.5 to 1 second.")).toEqual([
      { kind: 'numeric', stat: 'Cooldown reduction', old: 0.5, new: 1, unit: 's', dir: 'buff' },
    ]);
    expect(summarizeLine('Push-to-point distance increased from 6.25 from where Telekinesis was targeted to 12.5.')).toEqual([
      { kind: 'numeric', stat: 'Push-to-point distance', old: 6.25, new: 12.5, dir: 'buff' },
    ]);
  });

  it('adds one qualitative entry for what the numbers leave unexplained', () => {
    const facts = summarizeLine("Molten Core's Abilities range reduced from 35 to 20, but now grows from 20 to 35 over 9 seconds. Molten Swing is not affected by this.");
    expect(facts[0]).toEqual({ kind: 'numeric', stat: "Molten Core's Abilities range", old: 35, new: 20, dir: 'nerf' });
    expect(facts[1]?.kind).toBe('changed');
    expect(facts).toHaveLength(2);
  });

  it('summarises lines without usable numbers by kind only', () => {
    expect(summarizeLine('Now prevented and interrupted by Immobilize.')).toEqual([{ kind: 'changed', dir: 'change' }]);
    expect(summarizeLine('No longer reduces the cooldown of Lava Wave by 30 seconds.')).toEqual([{ kind: 'removed', dir: 'change' }]);
    expect(summarizeLine('NEW QUEST: Deal damage to enemy Heroes to permanently increase its damage by 0.25% per stack.')[0]?.kind).toBe('added');
    expect(summarizeLine('Fixed an issue where the portal would lose life.')[0]?.kind).toBe('bugfix');
    expect(summarizeLine('REWORK: Now summons a Void Portal.')).toEqual([{ kind: 'reworked', dir: 'rework' }]);
    expect(summarizeLine('Void Orb speed slightly increased.')).toEqual([{ kind: 'changed', dir: 'buff' }]);
    // "now grows from 20 to 35" describes behaviour, not a change of the value.
    expect(summarizeLine('Range now grows from 20 to 35 over 9 seconds.')).toEqual([{ kind: 'changed', dir: 'change' }]);
  });

  it('marks every fact under a rework label as a rework', () => {
    expect(summarizeLine('Damage increased from 10 to 12.', 'REWORK: Big Spell Abilities')).toEqual([{ kind: 'numeric', stat: 'Damage', old: 10, new: 12, dir: 'rework' }]);
  });

  it('classifies qualitative kinds', () => {
    expect(qualitativeKind('Now provides 50% damage reduction against non-Heroes, instead of +100% Health.')).toBe('changed');
    expect(qualitativeKind('Can now be queued during Time Stop.')).toBe('added');
    expect(qualitativeKind('Removed the Mana cost.')).toBe('removed');
    expect(qualitativeKind('Replaced by a new Heroic.')).toBe('reworked');
  });
});

describe('labels and templates', () => {
  it('cleans subjects and caps labels at four words', () => {
    expect(cleanSubject(' and healing of nearby Allies increased ')).toBe('healing of nearby Allies');
    expect(cleanSubject('The Shield has been reduced')).toBe('Shield');
    expect(statLabel('health decay reduction')).toBe('Health decay reduction');
    expect(statLabel('damage done by the chain lightning bounces rewarded from obtaining the Mythic Reward')).toBe('Damage');
    expect(statLabel('something with no known quantity in these words')).toBe('Value');
  });

  it('writes the stored sentence from the facts only', () => {
    expect(changeText({ kind: 'numeric', stat: 'Damage', old: 345, new: 360 })).toBe('Damage 345 → 360');
    expect(changeText({ kind: 'numeric', stat: 'Cooldown', old: 12, new: 10, unit: 's' })).toBe('Cooldown 12 s → 10 s');
    expect(changeText({ kind: 'numeric', stat: 'Damage', by: 15, unit: '%' })).toBe('Damage +15%');
    expect(changeText({ kind: 'changed' })).toBe("Effect changed (see Blizzard's notes)");
    expect(changeText({ kind: 'added', count: 3 })).toBe("3 new effects (see Blizzard's notes)");
    expect(changeText({ kind: 'bugfix' }, 'cooldown 10 → 8')).toBe("Bug fix; game data: cooldown 10 → 8 (see Blizzard's notes)");
  });
});

describe('general and map lines', () => {
  it('counts general lines per category of our own', () => {
    expect(generalCategory('Updated Homescreen and Startup Music.')).toBe('Interface and audio');
    expect(generalCategory('Players can now party with unplaced players in Storm League.')).toBe('Modes and matchmaking');
    expect(generalCategory('Mercenary camps now spawn 30 seconds after the match begins (Down from 60 seconds).')).toBe('Maps and structures');
    expect(generalCategory('Respawn timers have been reduced in the mid-to-late game.')).toBe('Gameplay');
    expect(generalCategory('Fixed an issue where some players did not receive a hero.')).toBe('Bug fixes');
    expect(generalSummary(['Updated Homescreen and Startup Music.', 'Added the ability to ping your Healing Fountain cooldown.', 'Unranked Mode has been removed.'])).toEqual([
      'Modes and matchmaking: 1 change',
      'Interface and audio: 2 changes',
    ]);
  });

  it('keeps map numbers as templates and counts the rest', () => {
    expect(mapSummary(['Skull scaling increased from 5% to 7%.', 'Hero vision is reduced while in the mines.', 'Additional brush has been added in several locations.'])).toEqual([
      'Skull scaling 5% → 7%',
      "2 other changes (see Blizzard's notes)",
    ]);
    expect(mapSummary(['Additional brush has been added in several locations.'])).toEqual(["1 change (see Blizzard's notes)"]);
  });
});

describe('verbatim checks', () => {
  const source = 'Shambler Health and damage now begin 25% below their previous values and gradually return to them.';

  it('measures the longest run of shared words', () => {
    expect(longestSharedRun('Shambler Health and damage now begin 25% below', source)).toBe(8);
    expect(longestSharedRun("1 change (see Blizzard's notes)", source)).toBe(0);
  });

  it('flags a text that repeats eight consecutive words of its source', () => {
    const runs = sourceRuns([source]);
    expect(copiesSource('Shambler Health and damage now begin 25% below', runs)).toBe(true);
    expect(copiesSource('Shambler Health and damage now begin 25%', runs)).toBe(false);
  });
});
