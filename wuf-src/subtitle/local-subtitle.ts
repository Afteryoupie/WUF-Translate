import type { ActiveProviderConfig, CustomProviderProfile } from '../types.ts';
import { DEFAULT_SUBTITLE_SYSTEM_PROMPT } from '../lib/provider-profiles.ts';

export type SubtitleProviderLike = Partial<ActiveProviderConfig & CustomProviderProfile> & {
  profileType?: 'online' | 'local';
};

/**
 * Determines whether a subtitle provider targets a local single-model endpoint
 * that should be serialized so concurrent video batches do not collide.
 */
export function isLocalSubtitleProvider(provider?: SubtitleProviderLike | null): boolean {
  if (!provider) return false;
  if (provider.profileType === 'local') return true;
  if (provider.profileType === 'online') return false;
  try {
    const hostname = new URL(provider.baseUrl || '').hostname.toLowerCase();
    return (
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname) ||
      /apple|foundation.?models/i.test(provider.model || '')
    );
  } catch {
    return false;
  }
}

const localSubtitleQueues = new Map<string, Promise<unknown>>();

/**
 * Serializes subtitle inference against the same local origin and cleans up
 * settled queue tails without leaving unhandled rejections.
 */
export function queueLocalSubtitle<T>(
  provider: SubtitleProviderLike | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLocalSubtitleProvider(provider) || !provider?.baseUrl) {
    return run();
  }
  const key = new URL(provider.baseUrl).origin;
  const previous = localSubtitleQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  localSubtitleQueues.set(key, next);
  const clear = () => {
    if (localSubtitleQueues.get(key) === next) {
      localSubtitleQueues.delete(key);
    }
  };
  next.then(clear, clear);
  return next;
}

export function localSubtitlePrompt(targetLanguage: string, customPrompt?: string): string {
  if (customPrompt && customPrompt.trim() !== '') {
    return customPrompt;
  }
  const language = targetLanguage === 'zh-TW' ? '台灣繁體中文' : targetLanguage;
  if (language === '台灣繁體中文') {
    return DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  }
  return (
    `Translate ALL speech to ${language}. Output only one line, no explanations or punctuation. ` +
    'Keep names brands numbers and profanity. Remove sound-effect tags only. Never omit dialogue or complete unfinished sentences.'
  );
}
