import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per-user cache directory (card index, rules text). Override with GRINDSTONE_CACHE_DIR. */
export function cacheDir(): string {
  if (process.env.GRINDSTONE_CACHE_DIR) return process.env.GRINDSTONE_CACHE_DIR;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'grindstone', 'cache');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'grindstone');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'grindstone');
}

/** Per-user config directory (meta snapshots). Override with GRINDSTONE_CONFIG_DIR. */
export function configDir(): string {
  if (process.env.GRINDSTONE_CONFIG_DIR) return process.env.GRINDSTONE_CONFIG_DIR;
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'grindstone');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'grindstone');
}

let root: string | undefined;

/** The package root (where package.json, rubric/ and meta/ live), from src/ or dist/. */
export function packageRoot(): string {
  if (root) return root;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('package root not found');
    dir = parent;
  }
  root = dir;
  return dir;
}
