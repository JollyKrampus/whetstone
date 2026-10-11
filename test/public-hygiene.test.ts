/**
 * Enforces the public-repo law in CLAUDE.md: tracked files must not carry secrets, personal email
 * addresses or tailnet details. Private words that must not appear (host names, handles) can be
 * listed one per line in a local, gitignored `.public-denylist`, so the list itself is never public.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = [/^package-lock\.json$/, /\.(png|webp|jpe?g|gif|ico|zip|gz|woff2?)$/i];

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'tailnet name', re: /\b[a-z0-9-]+\.ts\.net\b/i },
  { name: 'tailnet address', re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  {
    name: 'personal email',
    // Any address except no-reply, example and well-known service domains.
    re: /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b|noreply\.|example\.(com|org)\b|anthropic\.com\b)[A-Za-z0-9.-]+\.(com|net|org|io|me|dev|co)\b/i,
  },
];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !SKIP.some((re) => re.test(f)));
}

function denylist(): string[] {
  const file = path.join(ROOT, '.public-denylist');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

describe('public hygiene', () => {
  const files = trackedFiles();
  const words = denylist().map((w) => w.toLowerCase());

  it('tracked files carry no secrets, personal emails, tailnet details or denylisted words', () => {
    const hits: string[] = [];
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!existsSync(full)) continue;
      const text = readFileSync(full, 'utf8');
      if (text.includes('\u0000')) continue;
      for (const { name, re } of PATTERNS) {
        const m = re.exec(text);
        if (m) hits.push(`${f}: ${name} (${m[0].slice(0, 12)}…)`);
      }
      const lower = text.toLowerCase();
      for (const w of words) if (lower.includes(w)) hits.push(`${f}: denylisted word`);
    }
    expect(hits).toEqual([]);
  });

  it('local-only folders are not tracked', () => {
    const bad = files.filter((f) => /^(\.research|data|\.cache|\.claude|dist)\//.test(f) || f === '.public-denylist');
    expect(bad).toEqual([]);
  });
});
