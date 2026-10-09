import { describe, expect, it } from 'vitest';
import { parseCooldown, parseCost, renderGameText, scalingPercent, stripScaling } from './gametext.ts';

describe('renderGameText', () => {
  it('strips colour/style markup, renders line breaks and per-level scaling', () => {
    const raw = 'Deals <c val="bfd4fd" hlt-name="#TooltipNumbers">153~~0.04~~</c> damage.<n/><n/><s val="StandardTooltipDetails">Bonus</s> applies.';
    expect(renderGameText(raw)).toBe('Deals 153 (+4% per level) damage.\n\nBonus applies.');
  });

  it('keeps decimals of scaling without float noise', () => {
    expect(scalingPercent('0.0475')).toBe('4.75');
    expect(renderGameText('90~~0.035~~ damage')).toBe('90 (+3.5% per level) damage');
  });

  it('drops inline images, decodes entities and collapses blank lines', () => {
    expect(renderGameText('<img path="@UI/StormTalentInTextQuestIcon"/>Quest: Gain&nbsp;5 &amp; more<n/><n/><n/>Reward')).toBe('Quest: Gain 5 & more\n\nReward');
  });

  it('returns an empty string for missing text', () => {
    expect(renderGameText(undefined)).toBe('');
    expect(renderGameText(null)).toBe('');
  });

  it('stripScaling removes the annotations again', () => {
    expect(stripScaling('Deals 153 (+4% per level) damage')).toBe('Deals 153 damage');
  });
});

describe('parseCooldown', () => {
  it('reads seconds from cooldown text', () => {
    expect(parseCooldown('Cooldown: 4 seconds')).toBe(4);
    expect(parseCooldown('Charge Cooldown: 0.75 seconds')).toBe(0.75);
    expect(parseCooldown('<s val="x">Cooldown:</s> 100 seconds')).toBe(100);
  });

  it('is undefined without a number of seconds', () => {
    expect(parseCooldown('Passive')).toBeUndefined();
    expect(parseCooldown(undefined)).toBeUndefined();
  });
});

describe('parseCost', () => {
  it('turns "Kind: amount" into "amount Kind"', () => {
    expect(parseCost('Mana: 50')).toBe('50 Mana');
    expect(parseCost('Mana: 6 per second')).toBe('6 Mana per second');
    expect(parseCost('Health: 15%')).toBe('15% Health');
    expect(parseCost('<s val="x">Fury: 20</s>')).toBe('20 Fury');
  });

  it('returns other text unchanged and undefined for nothing', () => {
    expect(parseCost('No cost')).toBe('No cost');
    expect(parseCost('')).toBeUndefined();
  });
});
