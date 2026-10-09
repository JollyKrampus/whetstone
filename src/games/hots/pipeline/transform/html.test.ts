import { describe, expect, it } from 'vitest';
import { findElement, hasClass, isElement, parseHtml, textOf, type HtmlElement } from './html.ts';

describe('parseHtml', () => {
  it('builds a tree with attributes, void elements and decoded text', () => {
    const doc = parseHtml('<section class="blog main"><p>A &amp; B<br>C</p><img src=x.png alt=\'y\'></section>');
    const section = findElement(doc, (el) => el.tag === 'section') as HtmlElement;
    expect(hasClass(section, 'blog')).toBe(true);
    expect(textOf(section)).toBe('A & B\nC');
    expect(isElement(section.children[1], 'img')).toBe(true);
    expect((section.children[1] as HtmlElement).attrs).toEqual({ src: 'x.png', alt: 'y' });
  });

  it('closes implied list items and paragraphs', () => {
    const doc = parseHtml('<ul><li>one<li>two</ul><p>a<p>b<div>c</div>');
    const ul = findElement(doc, (el) => el.tag === 'ul') as HtmlElement;
    expect(ul.children.filter((c) => isElement(c, 'li')).map((li) => textOf(li))).toEqual(['one', 'two']);
    expect(doc.children.filter((c) => isElement(c, 'p')).map((p) => textOf(p))).toEqual(['a', 'b']);
  });

  it('skips comments, doctype, scripts and styles and tolerates stray end tags', () => {
    const doc = parseHtml('<!doctype html><!-- x --><script>var a = "<p>";</script><style>p{}</style></b><p>ok</p>');
    expect(textOf(doc)).toBe('ok');
  });

  it('keeps nested lists inside their item', () => {
    const doc = parseHtml('<ul><li><strong>Level 1</strong><ul><li>Change</li></ul></li></ul>');
    const outer = findElement(doc, (el) => el.tag === 'li') as HtmlElement;
    expect(findElement(outer, (el) => el.tag === 'ul')).not.toBeNull();
    expect(textOf(outer, (el) => el.tag === 'ul')).toBe('Level 1');
  });
});
