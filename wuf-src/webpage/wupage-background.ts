import type { TranslationRequest, TranslationResponse, WufLocalSecrets, WufSettings } from '../types.ts';
import { resolvePresetProvider } from '../lib/provider-profiles.ts';
import { ensureLocalLlamaServer, probeWatchdogEndpoint } from '../lib/watchdog-client.ts';
import { resolveChatCompletionsUrl } from '../providers/openai-compat.ts';
import { DEFAULT_SETTINGS } from '../vendor/wupage/core/shared/defaults';
import { translateWithSettings } from '../vendor/wupage/core/background/translation';
import type { OpenAICompatibleConfig, ProviderConfig } from '../vendor/wupage/core/shared/types';

/** Keep WUF credentials in the background; WuPage owns the translation protocol. */
export async function translateWuPage(
  request: TranslationRequest, settings: WufSettings, secrets: WufLocalSecrets, signal?: AbortSignal, bypassCache = false,
): Promise<TranslationResponse & { cached: number }> {
  const wu = structuredClone(DEFAULT_SETTINGS);
  const engine = request.engine;
  let provider: ProviderConfig;
  let model = '';
  if (engine === 'google-translate') {
    provider = { id: engine, label: 'Google', type: 'google-web-translate' };
  } else if (engine === 'microsoft-translate') {
    provider = { id: engine, label: 'Microsoft', type: 'microsoft-web-translate' };
  } else {
    const configured = resolvePresetProvider(settings, secrets, 'webpage', engine, request.modelOverride);
    model = configured.effectiveModel;
    if (engine === 'openai-compat-local') {
      await ensureLocalLlamaServer(configured.baseUrl, model);
      signal?.throwIfAborted();
      if (!model) {
        const watchdog = await probeWatchdogEndpoint(configured.baseUrl);
        model = watchdog.currentModelId || watchdog.currentModel || '';
      }
    }
    const defaults = wu.providers.find((entry): entry is OpenAICompatibleConfig => entry.type === 'openai-compatible')!;
    provider = { ...defaults, id: engine, baseURL: resolveChatCompletionsUrl(configured.baseUrl), apiKey: configured.apiKey,
      model: model || 'default', ollamaCompatibility: false, systemPrompt: configured.systemPrompt.trim() || defaults.systemPrompt,
      ...(!model ? { requestTemplate: { enabled: true, headers: '{}', body: '{"model":null}' } } : {}) };
    signal?.throwIfAborted();
  }
  wu.providers = [provider];
  wu.activeProviderId = engine;
  wu.sourceLang = request.sourceLanguage || 'auto';
  wu.targetLang = request.targetLanguage;
  const result = await translateWithSettings(wu, {
    texts: request.texts, sourceLang: wu.sourceLang, targetLang: wu.targetLang, providerId: engine,
    context: request.webpageContext, preservePlaceholders: request.preservePlaceholders,
    pageSession: request.wupageSession,
  }, { signal, persistentCache: !bypassCache });
  return { ...result, engine, effectiveModel: model };
}
