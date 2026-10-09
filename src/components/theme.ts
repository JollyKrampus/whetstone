/** Shared by the pre-paint inline script in Base.astro (passed in via define:vars) and ThemeToggle. */
export type Theme = 'dark' | 'light';

/** Same shape as storageKey('site', 'theme') in src/core/storage.ts (the inline script can't import it). */
export const THEME_KEY = 'whetstone:site:theme';

/** Browser UI colour per theme; matches --bg in tokens.css. */
export const THEME_COLORS: Readonly<Record<Theme, string>> = {
  dark: '#0b0f14',
  light: '#f3f5f8',
};
