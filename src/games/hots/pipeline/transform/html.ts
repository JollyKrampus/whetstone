/**
 * A small, tolerant HTML tree builder for Blizzard news articles (no dependency). It handles
 * what the article bodies use: nested elements, void elements, comments, unquoted/quoted
 * attributes, raw-text `<script>`/`<style>` (skipped), implied `</li>`/`</p>` and stray end tags.
 * Not a general HTML5 parser; good enough to walk headings, lists and bold labels. Pure.
 */
import { decodeEntities } from '../util.ts';

export interface HtmlElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
export interface HtmlText {
  type: 'text';
  text: string;
}
export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'template', 'noscript']);
/** Opening one of these closes an open element of the same tag in the current block (`<li>…<li>`). */
const SELF_NESTING_CLOSES = new Set(['li', 'p', 'option', 'tr', 'td', 'th', 'dt', 'dd']);
const BLOCKS_CLOSING_P = new Set(['p', 'div', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'section', 'aside', 'figure', 'hr', 'blockquote']);

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of src.matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1] as HtmlElement;
  const closeTo = (tag: string): boolean => {
    for (let i = stack.length - 1; i > 0; i--) {
      if ((stack[i] as HtmlElement).tag === tag) {
        stack.length = i;
        return true;
      }
    }
    return false;
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      top().children.push({ type: 'text', text: decodeEntities(html.slice(i)) });
      break;
    }
    if (lt > i) top().children.push({ type: 'text', text: decodeEntities(html.slice(i, lt)) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(html.slice(lt, lt + 4000));
    if (!m) {
      top().children.push({ type: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const rest = m[3] ?? '';
    if (closing) {
      if (tag === 'p' && !stack.some((e) => e.tag === 'p')) continue;
      closeTo(tag);
      continue;
    }
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      i = end < 0 ? n : html.indexOf('>', end) + 1 || n;
      continue;
    }
    if (SELF_NESTING_CLOSES.has(tag)) {
      // Close an open same-tag element only up to the nearest list/table container.
      for (let k = stack.length - 1; k > 0; k--) {
        const t = (stack[k] as HtmlElement).tag;
        if (t === tag) {
          stack.length = k;
          break;
        }
        if (t === 'ul' || t === 'ol' || t === 'table' || t === 'tbody' || t === 'section' || t === 'div') break;
      }
    }
    if (BLOCKS_CLOSING_P.has(tag) && top().tag === 'p') stack.pop();
    const el: HtmlElement = { type: 'element', tag, attrs: parseAttrs(rest.replace(/\/\s*$/, '')), children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(rest)) stack.push(el);
  }
  return root;
}

export function isElement(node: HtmlNode | undefined, tag?: string): node is HtmlElement {
  return node?.type === 'element' && (tag === undefined || node.tag === tag);
}

/** Depth-first search for the first element matching `pred`. */
export function findElement(node: HtmlElement, pred: (el: HtmlElement) => boolean): HtmlElement | null {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (pred(child)) return child;
    const hit = findElement(child, pred);
    if (hit) return hit;
  }
  return null;
}

/** Text content; `<br>` becomes a newline. */
export function textOf(node: HtmlNode, skip?: (el: HtmlElement) => boolean): string {
  if (node.type === 'text') return node.text;
  if (skip?.(node)) return '';
  if (node.tag === 'br') return '\n';
  return node.children.map((c) => textOf(c, skip)).join('');
}

export function hasClass(el: HtmlElement, cls: string): boolean {
  return (el.attrs.class ?? '').split(/\s+/).includes(cls);
}
