import type { ThemeMode } from '../types.ts';

export const WUF_THEME_CACHE_KEY = 'wuf-ui-theme';

declare global {
  interface Window {
    __wufThemeReady?: Promise<void>;
  }
}

export function resolveEffectiveTheme(mode: string | null | undefined): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') {
    return mode;
  }
  try {
    const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
    return prefersDark ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function isKnownThemeMode(mode: unknown): mode is ThemeMode | 'auto' {
  return typeof mode === 'string' && ['system', 'auto', 'light', 'dark'].includes(mode);
}

export function applyThemeMode(mode: ThemeMode | 'auto'): 'light' | 'dark' {
  const effective = resolveEffectiveTheme(mode);
  const root = globalThis.document?.documentElement;
  if (root) {
    root.setAttribute('data-theme', effective);
  }
  try {
    globalThis.localStorage?.setItem(WUF_THEME_CACHE_KEY, mode === 'auto' ? 'system' : mode);
  } catch {
    // Ignore localStorage quota/privacy errors
  }
  return effective;
}

export function bootstrapTheme(): Promise<void> {
  const root = globalThis.document?.documentElement;
  let cached: string | null = null;
  try {
    cached = globalThis.localStorage?.getItem(WUF_THEME_CACHE_KEY) ?? null;
  } catch {
    cached = null;
  }

  if (isKnownThemeMode(cached)) {
    if (root) {
      root.setAttribute('data-theme', resolveEffectiveTheme(cached));
      root.removeAttribute('data-theme-pending');
    }
  } else if (root) {
    root.setAttribute('data-theme-pending', '');
    root.setAttribute('data-theme', resolveEffectiveTheme('system'));
  }

  const syncStorage = globalThis.chrome?.storage?.sync;
  const ready = (async () => {
    try {
      if (!syncStorage?.get) return;
      const stored = await syncStorage.get(['wufSettings', 'theme']);
      const fromSettings = (stored?.wufSettings as { theme?: unknown } | undefined)?.theme;
      const fromTop = stored?.theme;
      const saved = isKnownThemeMode(fromSettings)
        ? fromSettings
        : isKnownThemeMode(fromTop)
          ? fromTop
          : null;
      if (saved) {
        applyThemeMode(saved);
      }
    } catch {
      // Reveal page with current fallback theme even when storage fails
    } finally {
      root?.removeAttribute('data-theme-pending');
    }
  })();

  if (globalThis.window) {
    globalThis.window.__wufThemeReady = ready;
  }
  return ready;
}

bootstrapTheme();
