import { describe, expect, it } from 'vitest';
import { dropOtherGames, hotsMethodology, splitSections } from './methodology.ts';

// Shaped like Astro's compiled Markdown for docs/METHODOLOGY.md.
const HTML = [
  '<h1 id="how">How Whetstone computes its numbers</h1><p>Intro.</p>',
  '<h2 id="1-where">1. Where the numbers come from</h2><p>Heroes of the Storm text.</p>',
  '<h2 id="8-tier-lists">8. Tier lists</h2>',
  '<p><strong>Heroes of the Storm:</strong> the band is set by shrunk win rate.</p><table><tr><td>T1</td></tr></table>',
  '<p><strong>Pokémon Champions</strong> bands on <strong>usage %</strong>.</p><ul><li>if above</li></ul><p>Fewer than 30 games count for nothing.</p>',
  '<h2 id="9-votes">9. Community votes &amp; &#x27;scores&#x27;</h2><p>Votes.</p>',
].join('\n');

describe('methodology for /hots/about/', () => {
  it('splits compiled Markdown at h2, keeping ids and plain titles', () => {
    const doc = splitSections(HTML);
    expect(doc.intro).toContain('Intro.');
    expect(doc.sections.map((s) => s.id)).toEqual(['1-where', '8-tier-lists', '9-votes']);
    expect(doc.sections[2]?.title).toBe("9. Community votes & 'scores'");
    expect(doc.sections.map((s) => s.html).join('')).toBe(HTML.slice(HTML.indexOf('<h2')));
  });

  it('cuts another game subsection up to the next bold-led paragraph, h3 or section end', () => {
    const section = splitSections(HTML).sections[1]?.html ?? '';
    const cut = dropOtherGames(section);
    expect(cut).toContain('Heroes of the Storm:');
    expect(cut).toContain('<table>');
    expect(cut).not.toContain('Pokémon');
    expect(cut).not.toContain('Fewer than 30 games');
    expect(dropOtherGames('<p><strong>MTG</strong> x</p><p><strong>HotS</strong> y</p>')).toBe('<p><strong>HotS</strong> y</p>');
    expect(dropOtherGames('<p><strong>Pokémon</strong> x</p><h3>Next</h3>')).toBe('<h3>Next</h3>');
  });

  it('keeps every section and leaves HotS-only sections untouched', () => {
    const doc = hotsMethodology(HTML);
    expect(doc.sections).toHaveLength(3);
    expect(doc.sections[0]?.html).toBe(splitSections(HTML).sections[0]?.html);
  });

  it('keeps a document without h2 as intro', () => {
    expect(splitSections('<p>Only text</p>')).toEqual({ intro: '<p>Only text</p>', sections: [] });
  });
});
