import type { TranslationRequest, TranslationResponse, WufLocalSecrets, WufSettings } from '../types.ts';
import { isOpenRouter } from '../lib/provider-performance.ts';
import { DEFAULT_ONLINE_PROFILE, resolvePresetProvider } from '../lib/provider-profiles.ts';
import { buildThinkingPayload, resolveChatCompletionsUrl } from '../providers/openai-compat.ts';
import { DEFAULT_SETTINGS } from '../vendor/wupage/core/shared/defaults';
import { translateWithSettings } from '../vendor/wupage/core/background/translation';
import type { OpenAICompatibleConfig, ProviderConfig } from '../vendor/wupage/core/shared/types';
import {
  repairProtectedWebpageText,
  translateLocalWebpage,
  validateProtectedWebpageText,
} from './local-webpage-translator.ts';

/** Keep WUF credentials in the background; route local models to WUF's plain-text pipeline. */
export async function translateWuPage(
  request: TranslationRequest, settings: WufSettings, secrets: WufLocalSecrets, signal?: AbortSignal, bypassCache = false,
): Promise<TranslationResponse & { cached: number }> {
  const wu = structuredClone(DEFAULT_SETTINGS);
  const engine = request.engine;
  if (engine === 'openai-compat-local') {
    return await translateLocalWebpage(request, settings, secrets, signal, bypassCache);
  }
  let provider: ProviderConfig;
  let model = '';
  let timeoutMs: number | undefined;
  if (engine === 'google-translate') {
    provider = { id: engine, label: 'Google', type: 'google-web-translate' };
  } else if (engine === 'microsoft-translate') {
    provider = { id: engine, label: 'Microsoft', type: 'microsoft-web-translate' };
  } else {
    const configured = resolvePresetProvider(settings, secrets, 'webpage', engine, request.modelOverride);
    model = configured.effectiveModel;
    const defaults = wu.providers.find((entry): entry is OpenAICompatibleConfig => entry.type === 'openai-compatible')!;
    const defaultProfile = DEFAULT_ONLINE_PROFILE;
    const hasCustomModelParams =
      isOpenRouter(configured.baseUrl) ||
      configured.temperature !== defaultProfile.temperature ||
      configured.thinkingLevel !== defaultProfile.thinkingLevel ||
      configured.routingSort !== defaultProfile.routingSort ||
      configured.allowFallbacks !== defaultProfile.allowFallbacks ||
      Boolean(configured.extraBodyJson && configured.extraBodyJson.trim());

    const bodyPatch: Record<string, unknown> = {};
    if (hasCustomModelParams) {
      Object.assign(
        bodyPatch,
        buildThinkingPayload({
          baseUrl: configured.baseUrl,
          model,
          level: configured.thinkingLevel,
          routingSort: configured.routingSort,
          allowFallbacks: configured.allowFallbacks,
          extraBodyRaw: configured.extraBodyJson,
        }),
      );
      if (configured.temperature !== defaultProfile.temperature) {
        if (typeof configured.temperature === 'number' && Number.isFinite(configured.temperature)) {
          bodyPatch.temperature = configured.temperature;
        } else if (configured.temperature === null) {
          bodyPatch.temperature = null;
        }
      }
    }
    if (!model) {
      bodyPatch.model = null;
    }

    const customPerf =
      configured.webConcurrency !== defaultProfile.webConcurrency ||
      configured.webBatchChars !== defaultProfile.webBatchChars;
    if (customPerf) {
      wu.concurrency = Math.max(wu.concurrency, configured.webConcurrency);
    }
    if (
      configured.fetchTimeoutSec !== defaultProfile.fetchTimeoutSec &&
      typeof configured.fetchTimeoutSec === 'number' &&
      Number.isFinite(configured.fetchTimeoutSec) &&
      configured.fetchTimeoutSec > 0
    ) {
      timeoutMs = configured.fetchTimeoutSec * 1000;
    }

    provider = {
      ...defaults,
      id: engine,
      baseURL: resolveChatCompletionsUrl(configured.baseUrl),
      apiKey: configured.apiKey,
      model: model || 'default',
      ollamaCompatibility: false,
      systemPrompt: configured.systemPrompt.trim() || defaults.systemPrompt,
      ...(Object.keys(bodyPatch).length > 0
        ? { requestTemplate: { enabled: true, headers: '{}', body: JSON.stringify(bodyPatch) } }
        : {}),
      ...(customPerf
        ? {
            performanceMode: 'custom' as const,
            concurrency: configured.webConcurrency,
            chunkSize: configured.webBatchChars,
          }
        : {}),
    };
    signal?.throwIfAborted();
  }
  wu.providers = [provider];
  wu.activeProviderId = engine;
  wu.sourceLang = request.sourceLanguage || 'auto';
  wu.targetLang = request.targetLanguage;

  let timeoutController: AbortController | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let effectiveSignal = signal;
  if (timeoutMs !== undefined) {
    timeoutController = new AbortController();
    timeoutTimer = setTimeout(() => {
      timeoutController?.abort(new DOMException('TimeoutError', 'TimeoutError'));
    }, timeoutMs);
    (timeoutTimer as { unref?: () => void }).unref?.();
    effectiveSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
  }

  try {
    const result = await translateWithSettings(wu, {
      texts: request.texts, sourceLang: wu.sourceLang, targetLang: wu.targetLang, providerId: engine,
      context: request.webpageContext, preservePlaceholders: request.preservePlaceholders,
      pageSession: request.wupageSession,
    }, { signal: effectiveSignal, persistentCache: !bypassCache });
    if (request.preservePlaceholders) {
      const translations = [...result.translations];
      for (let i = 0; i < request.texts.length; i++) {
        const sourceText = request.texts[i] ?? '';
        if (!/⟪WUPAGE\d+⟫/u.test(sourceText)) continue;
        const validated = validateProtectedWebpageText(sourceText, translations[i] ?? '');
        if (validated !== undefined) {
          translations[i] = validated;
          continue;
        }
        translations[i] = await repairProtectedWebpageText(sourceText, async (fragment) => {
          const fragmentRes = await translateWithSettings(wu, {
            texts: [fragment], sourceLang: wu.sourceLang, targetLang: wu.targetLang, providerId: engine,
            preservePlaceholders: false,
          }, { signal: effectiveSignal, persistentCache: !bypassCache });
          return fragmentRes.translations[0] ?? fragment;
        });
      }
      return { ...result, translations, engine, effectiveModel: model };
    }
    return { ...result, engine, effectiveModel: model };
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
  }
}
