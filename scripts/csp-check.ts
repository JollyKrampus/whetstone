/**
 * Post-build check of the Content-Security-Policy (SEC-4): every inline script in every built page
 * must be allowed by a hash in that page's CSP <meta>, and no element may carry an inline event
 * handler (onclick="…"), which the policy blocks. A script whose text changed without its hash
 * (an `is:inline` script edited, or one added without allowInlineScript from src/lib/csp.ts)
 * would otherwise just stop running in the browser, silently. astro.config.mjs runs this after
 * every build and fails the build on any problem.
 *
 *   node scripts/csp-check.ts [--dist <dir>]
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTITIES: Readonly<Record<string, string>> = { '&#39;': "'", '&#x27;': "'", '&quot;': '"', '&#34;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' };

function decode(value: string): string {
  return value.replace(/&(#39|#x27|quot|#34|amp|lt|gt);/g, (m) => ENTITIES[m] ?? m);
}

/** The page's CSP from its <meta http-equiv="content-security-policy">, or null when it has none. */
export function cspOf(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?content-security-policy/i.test(tag)) continue;
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (content) return decode(content[1] ?? content[2] ?? '');
  }
  return null;
}

/** The `'sha256-…'` sources of a policy's script-src directive. */
export function scriptHashes(csp: string): Set<string> {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src ') || d === 'script-src');
  const out = new Set<string>();
  for (const token of directive?.split(/\s+/).slice(1) ?? []) {
    const m = /^'(sha256-[A-Za-z0-9+/=]+)'$/.exec(token);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/** An element attribute such as onclick= (an inline event handler). */
const INLINE_HANDLER = /<[a-z][^>]*?\s(on[a-z]+)\s*=/gi;

/** Problems with one page: inline scripts the policy does not allow, inline event handlers, a missing policy. */
export function pageProblems(html: string): string[] {
  const csp = cspOf(html);
  const handlers = [...html.matchAll(INLINE_HANDLER)].map((m) => `inline event handler ${m[1]}=`);
  // Pages with no script at all (the meta-refresh redirect pages) need no policy.
  if (csp === null) return /<script[\s>]/i.test(html) || handlers.length > 0 ? ['scripts but no Content-Security-Policy <meta>'] : [];
  const allowed = scriptHashes(csp);
  const problems: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    // Data blocks (JSON, ld+json, importmap is not used) never execute, so CSP ignores them.
    if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
    const hash = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
    if (!allowed.has(hash)) problems.push(`inline script not allowed by the CSP (${hash}): ${JSON.stringify(body.trim().slice(0, 80))}`);
  }
  problems.push(...handlers);
  return problems;
}

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/** Every problem in a built site, as `<page>: <problem>` lines (empty when the policy covers everything). */
export function checkDist(dist: string): string[] {
  const problems: string[] = [];
  for (const file of htmlFiles(dist).sort()) {
    const rel = path.relative(dist, file).split(path.sep).join('/');
    for (const p of pageProblems(readFileSync(file, 'utf8'))) problems.push(`${rel}: ${p}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--dist');
  const dist = path.resolve(i >= 0 ? (process.argv[i + 1] ?? 'dist') : (process.env.WHETSTONE_OUT_DIR ?? 'dist'));
  const problems = checkDist(dist);
  for (const p of problems.slice(0, 50)) console.error(p);
  console.log(problems.length === 0 ? `[csp] every inline script in ${dist} is allowed by its page's policy` : `[csp] ${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
