/**
 * Content-Security-Policy helpers for the few scripts that must run inline (SEC-4).
 *
 * astro.config.mjs turns on Astro's `security.csp`, which writes a CSP <meta> into every page and
 * hashes the scripts and styles Astro bundles itself. An `is:inline` script is not hashed, so a
 * page or layout that needs one builds the exact code as a string, renders it with
 * `<script is:inline set:html={code} />` and registers its hash in its frontmatter:
 *
 *   const code = `…`;
 *   allowInlineScript(Astro, code);
 *
 * Call it in the frontmatter of the page or of a layout (which runs before <head> is written); a
 * component deeper in the body runs too late for its hash to reach the CSP. Never hash markup that
 * contains data: only constant code belongs here.
 */
import { createHash } from 'node:crypto';

export type CspHash = `sha256-${string}`;

/** CSP source expression for an inline script or style body (exact text between the tags). */
export function cspHash(code: string): CspHash {
  return `sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}`;
}

interface CspContext {
  csp?: { insertScriptHash(hash: CspHash): void } | undefined;
}

/** Allow one constant inline script on the page being rendered (no-op in dev, where Astro adds no CSP). */
export function allowInlineScript(astro: CspContext, code: string): string {
  astro.csp?.insertScriptHash(cspHash(code));
  return code;
}
