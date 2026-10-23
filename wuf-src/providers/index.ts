import type {
  TranslationRequest,
  TranslationResponse,
  WufLocalSecrets,
  WufSettings,
} from '../types.ts';
import { resolvePresetProvider } from '../lib/provider-profiles.ts';
import type { WatchdogClientOptions } from '../lib/watchdog-client.ts';
import { WufProviderError } from './errors.ts';
import { translateWithGoogle } from './google-translate.ts';
import { translateWithOpenAICompat } from './openai-compat.ts';
import { translateWithOpenCC } from './opencc.ts';

export interface ExecuteTranslationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: string;
  watchdogOptions?: WatchdogClientOptions;
}

export async function executeTranslation(
  request: TranslationRequest,
  settings: WufSettings,
  secrets: WufLocalSecrets,
  options?: ExecuteTranslationOptions,
): Promise<TranslationResponse> {
  const { engine, texts, targetLanguage, sourceLanguage, purpose, modelOverride } = request;

  if (!Array.isArray(texts)) {
    throw new WufProviderError('Translation request texts must be an array', {
      code: 'CONFIG_ERROR',
      provider: engine,
    });
  }

  const effectiveTargetLang = targetLanguage || settings.webpage.targetLanguage;
  const shouldApplyOpenCC =
    request.applyOpenCC ??
    (settings.openccEnabled && /^zh/i.test(effectiveTargetLang));
  const openccVariant = request.openccVariant ?? settings.openccVariant;

  const maybePostProcessOpenCC = async (
    rawTranslations: string[],
  ): Promise<{ translations: string[]; openccApplied?: typeof openccVariant }> => {
    if (!shouldApplyOpenCC) {
      return { translations: rawTranslations };
    }
    const converted = await translateWithOpenCC(
      rawTranslations,
      openccVariant,
      options?.signal,
    );
    return { translations: converted, openccApplied: openccVariant };
  };

  if (engine === 'google-translate') {
    const rawTranslations = await translateWithGoogle({
      texts,
      targetLanguage: effectiveTargetLang,
      sourceLanguage,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    const { translations, openccApplied } = await maybePostProcessOpenCC(rawTranslations);
    return {
      translations,
      engine: 'google-translate',
      effectiveModel: 'gtx',
      ...(openccApplied ? { openccApplied } : {}),
    };
  }

  if (engine === 'openai-compat-online' || engine === 'openai-compat-local') {
    const provider = resolvePresetProvider(
      settings,
      secrets,
      purpose,
      engine,
      modelOverride,
      options?.platform,
    );

    let rawTranslations: string[];
    let effectiveModel: string;

    try {
      const result = await translateWithOpenAICompat({
        provider,
        texts,
        targetLanguage: effectiveTargetLang,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
        platform: options?.platform,
        watchdogOptions: options?.watchdogOptions,
      });
      rawTranslations = result.translations;
      effectiveModel = result.effectiveModel;
    } catch (err) {
      // Automatic bisection / item-by-item fallback on segment count mismatch
      const isMismatch =
        err instanceof WufProviderError &&
        err.message.includes('Segment count mismatch');

      if (texts.length > 1 && (isMismatch || !options?.signal?.aborted)) {
        const mid = Math.floor(texts.length / 2);
        const [left, right] = await Promise.all([
          executeTranslation(
            { ...request, texts: texts.slice(0, mid) },
            settings,
            secrets,
            options,
          ),
          executeTranslation(
            { ...request, texts: texts.slice(mid) },
            settings,
            secrets,
            options,
          ),
        ]);
        return {
          translations: [...left.translations, ...right.translations],
          engine,
          effectiveModel: left.effectiveModel || right.effectiveModel,
          profileType: provider.profileType,
          openccApplied: left.openccApplied || right.openccApplied,
        };
      }
      throw err;
    }

    const { translations, openccApplied } = await maybePostProcessOpenCC(rawTranslations);
    return {
      translations,
      engine,
      effectiveModel,
      profileType: provider.profileType,
      ...(openccApplied ? { openccApplied } : {}),
    };
  }

  throw new WufProviderError(`Unsupported translation engine: ${String(engine)}`, {
    code: 'CONFIG_ERROR',
    provider: String(engine),
  });
}
