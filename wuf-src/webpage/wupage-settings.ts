import type { SettingsSnapshotPayload } from '../types.ts';
import type { ExtensionSettings } from '../vendor/wupage/shared/types';

export function toWuPageSettings(snapshot: SettingsSnapshotPayload): ExtensionSettings {
  const preset = snapshot.runtimeSettings.webpage;
  const provider = snapshot.webpageProvider;
  const isLocalLlm = preset.engine === 'openai-compat-local';
  const localConcurrency = Math.max(1, provider.webConcurrency || 1);
  return {
    sourceLang: 'auto', targetLang: preset.targetLanguage, activeProviderId: preset.engine,
    providers: [{ id: preset.engine, type: preset.engine === 'google-translate' ? 'google-web-translate' : preset.engine === 'microsoft-translate' ? 'microsoft-web-translate' : 'openai-compatible',
      ...(isLocalLlm
        ? { performanceMode: 'custom' as const, chunkSize: 1, concurrency: localConcurrency }
        : preset.engine === 'openai-compat-online'
          ? { performanceMode: 'custom' as const, chunkSize: 3200, concurrency: 3 }
          : {}),
      fingerprint: JSON.stringify([{ ...provider, apiKey: undefined }, snapshot.runtimeSettings.openccEnabled, snapshot.runtimeSettings.openccVariant]),
      modelOverride: preset.customModelOverride || provider.model }],
    chunkSize: isLocalLlm ? 1 : 1200,
    concurrency: isLocalLlm ? localConcurrency : 3,
    translateCodeComments: true,
    translationDisplayMode: preset.displayMode === 'monolingual' ? 'replace' : 'bilingual',
    frameTranslation: { enabled: true, excludeMatches: [] },
  };
}
