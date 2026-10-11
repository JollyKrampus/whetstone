import { describe, expect, it } from 'vitest';
import { cspHash } from '../src/lib/csp.ts';
import { cspOf, pageProblems, scriptHashes } from './csp-check.ts';

const code = "if (location.hash === '#a') history.replaceState(null, '', '#b');";
const page = (csp: string | null, body: string): string =>
  `<!doctype html><html><head>${csp === null ? '' : `<meta http-equiv="content-security-policy" content="${csp.replace(/'/g, '&#39;')}">`}</head><body>${body}</body></html>`;

describe('csp-check', () => {
  it('reads the policy and its script hashes', () => {
    const csp = `default-src 'self'; script-src 'self' '${cspHash(code)}' 'sha256-AAAA'; style-src 'self'`;
    expect(cspOf(page(csp, ''))).toBe(csp);
    expect([...scriptHashes(csp)]).toEqual([cspHash(code), 'sha256-AAAA']);
    expect(cspOf('<meta charset="utf-8">')).toBeNull();
  });

  it('accepts hashed inline scripts, external scripts and data blocks', () => {
    const csp = `script-src 'self' '${cspHash(code)}'`;
    expect(pageProblems(page(csp, `<script>${code}</script><script type="module" src="/x.js"></script><script type="application/json">{"a":1}</script>`))).toEqual([]);
  });

  it('flags an inline script without its hash, inline handlers and scripts without a policy', () => {
    const csp = "script-src 'self'";
    expect(pageProblems(page(csp, `<script>${code}</script>`))).toEqual([expect.stringContaining(cspHash(code))]);
    expect(pageProblems(page(csp, '<button onclick="go()">Go</button>'))).toEqual(['inline event handler onclick=']);
    expect(pageProblems(page(null, '<script>1</script>'))).toEqual(['scripts but no Content-Security-Policy <meta>']);
    // A redirect page with no script needs no policy.
    expect(pageProblems(page(null, '<p><a href="/x/">Continue</a></p>'))).toEqual([]);
  });
});
