/**
 * Third-party licence notices for everything the site ships to browsers (LA-3).
 *
 * MIT and similar licences require the copyright and permission notice to travel with every copy
 * of the code. astro.config.mjs collects the packages Vite bundles into the client and Web Worker
 * chunks (`licenseCollector`), adds the Workbox runtime that scripts/sw.ts inlines into sw.js, and
 * writes their notices to dist/licenses.txt after the build. The footer and /credits/ link it.
 *
 * Node-only (fs); imported by astro.config.mjs and the unit tests.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Workbox modules generateSW inlines into sw.js (inlineWorkboxRuntime, scripts/sw.ts). */
export const SW_PACKAGES: readonly string[] = [
  'workbox-cacheable-response',
  'workbox-core',
  'workbox-expiration',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
];

/**
 * Copyright lines for packages that publish no licence file (checked against their repositories).
 * The MIT text is then reproduced with this notice.
 */
export const KNOWN_NOTICES: Readonly<Record<string, string>> = {
  '@smogon/calc': 'Copyright (c) 2013-2025 Honko and other contributors',
};

export interface PackageInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
  homepage?: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

export const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toInfo(dir: string, pkg: Record<string, unknown>): PackageInfo | null {
  if (typeof pkg.name !== 'string' || pkg.name === '') return null;
  const license = typeof pkg.license === 'string' ? pkg.license : typeof (pkg.license as { type?: unknown } | undefined)?.type === 'string' ? String((pkg.license as { type: string }).type) : 'UNKNOWN';
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: unknown } | undefined)?.url;
  const homepage = typeof pkg.homepage === 'string' ? pkg.homepage : typeof repo === 'string' ? repo.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
  return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', license, dir, ...(homepage ? { homepage } : {}) };
}

/**
 * The package a bundled module belongs to: the nearest package.json above the file that names a
 * package, skipping the site itself (`root`) and nested package.json files that only set "type".
 * Returns null for Whetstone's own code and for virtual modules.
 */
export function packageOf(moduleId: string, root: string): PackageInfo | null {
  if (!moduleId || moduleId.startsWith('\0') || moduleId.includes('virtual:')) return null;
  const file = moduleId.split('?')[0]!.replace(/\\/g, '/');
  if (!path.isAbsolute(file)) return null;
  const rootDir = path.resolve(root);
  let dir = path.dirname(file);
  for (;;) {
    if (path.resolve(dir) === rootDir) return null;
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && typeof pkg.name === 'string' && pkg.name !== '') return toInfo(dir, pkg);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Package info for an installed dependency by name (resolved from `root`'s node_modules). */
export function installedPackage(name: string, root: string): PackageInfo | null {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  const pkg = readJson(path.join(dir, 'package.json'));
  return pkg ? toInfo(dir, pkg) : null;
}

/** The package's own licence text, or the MIT text with a known notice when it ships none. */
export function licenseText(info: PackageInfo): string {
  const file = existsSync(info.dir) ? readdirSync(info.dir).filter((f) => LICENSE_FILE.test(f)).sort()[0] : undefined;
  if (file) return readFileSync(path.join(info.dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
  const notice = KNOWN_NOTICES[info.name];
  if (notice && info.license === 'MIT') return `MIT License\n\n${notice}\n\n${MIT_TEXT}`;
  throw new Error(
    `[licenses] ${info.name}@${info.version} (${info.license}) ships no licence file; add its copyright line to KNOWN_NOTICES in scripts/licenses.ts`,
  );
}

/** dist/licenses.txt: one section per package, sorted by name; duplicates (same name) merged. */
export function renderLicenses(packages: readonly PackageInfo[], siteName = 'Whetstone'): string {
  const byName = new Map<string, PackageInfo>();
  for (const p of packages) if (!byName.has(p.name)) byName.set(p.name, p);
  const sorted = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rule = '='.repeat(78);
  const head = [
    `${siteName}: third-party software notices`,
    '',
    'The site bundles the following open-source packages into the scripts, Web Workers and',
    'service worker it serves. Each is listed with its licence and copyright notice.',
    `Whetstone's own code is MIT licensed: https://github.com/JollyKrampus/whetstone/blob/main/LICENSE`,
    'Data sources and their licences are listed on the credits page.',
    '',
  ];
  const body = sorted.flatMap((p) => [rule, `${p.name} ${p.version} (${p.license})${p.homepage ? `\n${p.homepage}` : ''}`, rule, '', licenseText(p), '']);
  return [...head, ...body].join('\n').trimEnd() + '\n';
}
