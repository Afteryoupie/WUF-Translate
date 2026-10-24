import { UI_LOCALES, type UiLocale } from '../types.ts';
import {
  WUF_DICTIONARIES,
  WUF_TRANSLATION_KEYS,
  type WufI18nKey,
} from './locales.ts';

export { WUF_DICTIONARIES, WUF_TRANSLATION_KEYS, type WufI18nKey };

export function resolveUiLocale(raw?: string | null): UiLocale {
  if (!raw) return 'zh-TW';
  const trimmed = raw.trim();
  if ((UI_LOCALES as readonly string[]).includes(trimmed)) {
    return trimmed as UiLocale;
  }
  const lower = trimmed.toLowerCase().replace('_', '-');
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) {
    return 'zh-TW';
  }
  if (lower.startsWith('zh')) {
    return 'zh-CN';
  }
  for (const candidate of ['en', 'ja', 'ko', 'es', 'fr', 'de'] as const) {
    if (lower.startsWith(candidate)) {
      return candidate;
    }
  }
  return 'zh-TW';
}

export function t(locale: UiLocale, key: WufI18nKey): string {
  const dict = WUF_DICTIONARIES[locale] ?? WUF_DICTIONARIES['zh-TW'];
  return dict[key] ?? WUF_DICTIONARIES['zh-TW'][key] ?? key;
}

export function applyI18nToDom(root: ParentNode, locale: UiLocale): void {
  const elements = root.querySelectorAll<HTMLElement>('[data-wuf-i18n]');
  for (const el of elements) {
    const key = el.getAttribute('data-wuf-i18n') as WufI18nKey | null;
    if (key && key in WUF_DICTIONARIES['zh-TW']) {
      el.textContent = t(locale, key);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-wuf-i18n-title]')) {
    const key = el.getAttribute('data-wuf-i18n-title') as WufI18nKey | null;
    if (key && key in WUF_DICTIONARIES['zh-TW']) {
      const label = t(locale, key);
      el.title = label;
      el.setAttribute('aria-label', label);
    }
  }
}
