import {
  DISPLAY_MODES,
  OPENCC_VARIANTS,
  PROVIDER_PROFILE_TYPES,
  ROUTING_SORTS,
  SUBTITLE_DECISION_MODES,
  THEME_MODES,
  THINKING_LEVELS,
  TRANSLATION_ENGINES,
  UI_LOCALES,
  type ActiveProviderConfig,
  type CustomProviderProfile,
  type ProviderProfileType,
  type SubtitleDecisionMode,
  type SubtitleTranslationPreset,
  type TranslationEngineId,
  type WebpageTranslationPreset,
  type WufLocalSecrets,
  type WufSettings,
} from '../types.ts';
import { inferProviderType, PERFORMANCE_FIELDS } from './provider-performance.ts';

export const DEFAULT_ONLINE_PROFILE: Readonly<CustomProviderProfile> = Object.freeze({
  baseUrl: 'https://openrouter.ai/api/v1',
  model: '',
  systemPrompt: '',
  temperature: 0.3,
  fetchTimeoutSec: 60,
  thinkingLevel: 'off',
  useStrongSegMarker: false,
  routingSort: 'throughput',
  allowFallbacks: true,
  extraBodyJson: '',
  webConcurrency: 6,
  webBatchUnits: 20,
  webBatchChars: 3500,
});

export const DEFAULT_LOCAL_PROFILE: Readonly<CustomProviderProfile> = Object.freeze({
  baseUrl: 'http://127.0.0.1:8080/v1',
  model: '',
  systemPrompt: '',
  temperature: 0.2,
  fetchTimeoutSec: 120,
  thinkingLevel: 'off',
  useStrongSegMarker: false,
  routingSort: 'auto',
  allowFallbacks: false,
  extraBodyJson: '',
  webConcurrency: 1,
  webBatchUnits: 40,
  webBatchChars: 7000,
});

export const DEFAULT_WEBPAGE_PRESET: Readonly<WebpageTranslationPreset> = Object.freeze({
  engine: 'openai-compat-local',
  targetLanguage: 'zh-TW',
  displayMode: 'bilingual',
  customModelOverride: '',
  autoTranslateHosts: [],
  crossTabSticky: false,
});

export const DEFAULT_SUBTITLE_SYSTEM_PROMPT =
  'Translate ALL speech to 台灣繁體中文. Output only one line, no explanations or punctuation. Keep names brands numbers and profanity. Remove sound-effect tags only. Never omit dialogue or complete unfinished sentences.';

export const DEFAULT_SUBTITLE_PRESET: Readonly<SubtitleTranslationPreset> = Object.freeze({
  engine: 'openai-compat-local',
  targetLanguage: 'zh-TW',
  customModelOverride: '',
  systemPrompt: DEFAULT_SUBTITLE_SYSTEM_PROMPT,
  batchWindowSec: 30,
  prefetchLeadSec: 10,
  decisionMode: 'laya',
  layaDecisionEnabled: true,
  layaEndpointUrl: 'http://127.0.0.1:8080/v1/systemone',
  decisionCustomModel: '',
  decisionCustomBaseUrl: '',
});

export const DEFAULT_SETTINGS: Readonly<WufSettings> = Object.freeze({
  schemaVersion: 1,
  uiLocale: 'zh-TW',
  theme: 'system',
  activeProviderType: 'local',
  providers: {
    online: { ...DEFAULT_ONLINE_PROFILE },
    local: { ...DEFAULT_LOCAL_PROFILE },
  },
  webpage: { ...DEFAULT_WEBPAGE_PRESET },
  subtitles: { ...DEFAULT_SUBTITLE_PRESET },
  openccEnabled: true,
  openccVariant: 's2twp',
});

export const DEFAULT_LOCAL_SECRETS: Readonly<WufLocalSecrets> = Object.freeze({
  providerApiKeys: {
    online: '',
    local: '',
  },
});

export function detectRuntimePlatform(): string {
  const nav = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  return nav?.userAgentData?.platform || nav?.platform || '';
}

export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function isAppleOrFoundationModel(model: string): boolean {
  return /^(apple(?:[- ]|$)|foundation.?models)/i.test((model || '').trim());
}

/**
 * Synchronized macOS Apple/Foundation model selections cannot run on a Windows
 * loopback server. Returning '' at runtime falls back to the local server's
 * default model while preserving the saved setting in chrome.storage.sync.
 * LAN and cloud endpoints remain untouched.
 */
export function localModelForPlatform(
  model: string,
  baseUrl: string,
  platform: string = detectRuntimePlatform(),
): string {
  if (!/^win/i.test(platform) || !isAppleOrFoundationModel(model)) {
    return model;
  }
  if (isLoopbackEndpoint(baseUrl)) {
    return '';
  }
  return model;
}

export function sanitizeProviderProfile(
  raw: unknown,
  fallback: CustomProviderProfile,
  warnings?: string[],
): CustomProviderProfile {
  const result: CustomProviderProfile = { ...fallback };
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;

  for (const key of ['baseUrl', 'model', 'systemPrompt', 'extraBodyJson'] as const) {
    if (typeof obj[key] === 'string') {
      result[key] = key === 'systemPrompt' ? obj[key] : obj[key].trim();
    }
  }

  if (obj.temperature === null) {
    result.temperature = null;
  } else if (typeof obj.temperature === 'number') {
    if (Number.isFinite(obj.temperature) && obj.temperature >= 0 && obj.temperature <= 2) {
      result.temperature = obj.temperature;
    } else {
      warnings?.push(`Invalid temperature: ${String(obj.temperature)}`);
    }
  }

  if (typeof obj.fetchTimeoutSec === 'number') {
    if (Number.isFinite(obj.fetchTimeoutSec) && obj.fetchTimeoutSec >= 5 && obj.fetchTimeoutSec <= 600) {
      result.fetchTimeoutSec = obj.fetchTimeoutSec;
    } else {
      warnings?.push(`Invalid fetchTimeoutSec: ${String(obj.fetchTimeoutSec)}`);
    }
  }

  if (typeof obj.thinkingLevel === 'string') {
    if ((THINKING_LEVELS as readonly string[]).includes(obj.thinkingLevel)) {
      result.thinkingLevel = obj.thinkingLevel as CustomProviderProfile['thinkingLevel'];
    } else {
      warnings?.push(`Invalid thinkingLevel: ${obj.thinkingLevel}`);
    }
  }

  if (typeof obj.routingSort === 'string') {
    if ((ROUTING_SORTS as readonly string[]).includes(obj.routingSort)) {
      result.routingSort = obj.routingSort as CustomProviderProfile['routingSort'];
    } else {
      warnings?.push(`Invalid routingSort: ${obj.routingSort}`);
    }
  }

  if (typeof obj.allowFallbacks === 'boolean') {
    result.allowFallbacks = obj.allowFallbacks;
  }

  if (typeof obj.useStrongSegMarker === 'boolean') {
    result.useStrongSegMarker = obj.useStrongSegMarker;
  }

  for (const [field, [min, max]] of Object.entries(PERFORMANCE_FIELDS) as Array<
    ['webConcurrency' | 'webBatchUnits' | 'webBatchChars', readonly [number, number]]
  >) {
    if (obj[field] !== undefined) {
      const val = obj[field];
      if (typeof val === 'number' && Number.isInteger(val) && val >= min && val <= max) {
        result[field] = val;
      } else {
        warnings?.push(`Invalid ${field}: ${String(val)}`);
      }
    }
  }

  return result;
}

export function sanitizeWebpagePreset(
  raw: unknown,
  fallback: WebpageTranslationPreset = DEFAULT_WEBPAGE_PRESET,
  warnings?: string[],
): WebpageTranslationPreset {
  const result: WebpageTranslationPreset = { ...fallback };
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.engine === 'string') {
    if ((TRANSLATION_ENGINES as readonly string[]).includes(obj.engine)) {
      result.engine = obj.engine as TranslationEngineId;
    } else {
      warnings?.push(`Invalid webpage engine: ${obj.engine}`);
    }
  }
  if (typeof obj.targetLanguage === 'string' && obj.targetLanguage.trim()) {
    result.targetLanguage = obj.targetLanguage.trim();
  }
  if (typeof obj.displayMode === 'string') {
    if ((DISPLAY_MODES as readonly string[]).includes(obj.displayMode)) {
      result.displayMode = obj.displayMode as WebpageTranslationPreset['displayMode'];
    } else {
      warnings?.push(`Invalid displayMode: ${obj.displayMode}`);
    }
  }
  if (typeof obj.customModelOverride === 'string') {
    result.customModelOverride = obj.customModelOverride.trim();
  }
  if (Array.isArray(obj.autoTranslateHosts)) {
    result.autoTranslateHosts = [
      ...new Set(
        obj.autoTranslateHosts
          .filter((h): h is string => typeof h === 'string')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  } else {
    result.autoTranslateHosts = [...result.autoTranslateHosts];
  }
  if (typeof obj.crossTabSticky === 'boolean') {
    result.crossTabSticky = obj.crossTabSticky;
  }
  return result;
}

export function sanitizeSubtitlePreset(
  raw: unknown,
  fallback: SubtitleTranslationPreset = DEFAULT_SUBTITLE_PRESET,
  warnings?: string[],
): SubtitleTranslationPreset {
  const result: SubtitleTranslationPreset = { ...fallback };
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.engine === 'string') {
    if ((TRANSLATION_ENGINES as readonly string[]).includes(obj.engine)) {
      result.engine = obj.engine as TranslationEngineId;
    } else {
      warnings?.push(`Invalid subtitle engine: ${obj.engine}`);
    }
  }
  if (typeof obj.targetLanguage === 'string' && obj.targetLanguage.trim()) {
    result.targetLanguage = obj.targetLanguage.trim();
  }
  if (typeof obj.customModelOverride === 'string') {
    result.customModelOverride = obj.customModelOverride.trim();
  }
  if (typeof obj.systemPrompt === 'string') {
    result.systemPrompt = obj.systemPrompt;
  }
  if (obj.batchWindowSec !== undefined) {
    const val = obj.batchWindowSec;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 5 && val <= 300) {
      result.batchWindowSec = val;
    } else {
      warnings?.push(`Invalid subtitle batchWindowSec: ${String(val)}`);
    }
  }
  if (obj.prefetchLeadSec !== undefined) {
    const val = obj.prefetchLeadSec;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 1 && val <= 120) {
      result.prefetchLeadSec = val;
    } else {
      warnings?.push(`Invalid subtitle prefetchLeadSec: ${String(val)}`);
    }
  }
  if (typeof obj.decisionCustomModel === 'string') {
    result.decisionCustomModel = obj.decisionCustomModel.trim();
  }
  if (typeof obj.decisionCustomBaseUrl === 'string') {
    result.decisionCustomBaseUrl = obj.decisionCustomBaseUrl.trim();
  }
  if (typeof obj.layaEndpointUrl === 'string' && obj.layaEndpointUrl.trim()) {
    result.layaEndpointUrl = obj.layaEndpointUrl.trim();
  }
  if (typeof obj.decisionMode === 'string') {
    if ((SUBTITLE_DECISION_MODES as readonly string[]).includes(obj.decisionMode)) {
      result.decisionMode = obj.decisionMode as SubtitleDecisionMode;
      result.layaDecisionEnabled = result.decisionMode === 'laya';
    } else {
      warnings?.push(`Invalid subtitle decisionMode: ${obj.decisionMode}`);
    }
  } else if (typeof obj.layaDecisionEnabled === 'boolean') {
    result.layaDecisionEnabled = obj.layaDecisionEnabled;
    if (obj.layaDecisionEnabled) {
      result.decisionMode = 'laya';
    } else if (result.decisionCustomModel) {
      result.decisionMode = 'custom';
    } else {
      result.decisionMode = 'off';
    }
  }
  return result;
}

/**
 * Validates and sanitizes a WUF settings object (new schema only; does not import
 * legacy Shinkansen storage keys and strictly strips any API keys/credentials).
 */
export function sanitizeWufSettings(
  raw: unknown,
  base: WufSettings = DEFAULT_SETTINGS,
): { settings: WufSettings; warnings: string[] } {
  const warnings: string[] = [];
  const next: WufSettings = structuredClone(base);

  if (!raw || typeof raw !== 'object') {
    return { settings: next, warnings: ['Settings payload must be a JSON object'] };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.uiLocale === 'string') {
    if ((UI_LOCALES as readonly string[]).includes(obj.uiLocale)) {
      next.uiLocale = obj.uiLocale as WufSettings['uiLocale'];
    } else {
      warnings.push(`Unsupported uiLocale: ${obj.uiLocale}`);
    }
  }

  if (typeof obj.theme === 'string') {
    if ((THEME_MODES as readonly string[]).includes(obj.theme)) {
      next.theme = obj.theme as WufSettings['theme'];
    } else {
      warnings.push(`Unsupported theme: ${obj.theme}`);
    }
  }

  if (typeof obj.activeProviderType === 'string') {
    if ((PROVIDER_PROFILE_TYPES as readonly string[]).includes(obj.activeProviderType)) {
      next.activeProviderType = obj.activeProviderType as ProviderProfileType;
    } else {
      warnings.push(`Unsupported activeProviderType: ${obj.activeProviderType}`);
    }
  }

  if (typeof obj.openccEnabled === 'boolean') {
    next.openccEnabled = obj.openccEnabled;
  }

  if (typeof obj.openccVariant === 'string') {
    if ((OPENCC_VARIANTS as readonly string[]).includes(obj.openccVariant)) {
      next.openccVariant = obj.openccVariant as WufSettings['openccVariant'];
    } else {
      warnings.push(`Unsupported openccVariant: ${obj.openccVariant}`);
    }
  }

  if (obj.providers && typeof obj.providers === 'object') {
    const prov = obj.providers as Record<string, unknown>;
    if (prov.online !== undefined) {
      next.providers.online = sanitizeProviderProfile(prov.online, next.providers.online, warnings);
    }
    if (prov.local !== undefined) {
      next.providers.local = sanitizeProviderProfile(prov.local, next.providers.local, warnings);
    }
  }

  if (obj.webpage !== undefined) {
    next.webpage = sanitizeWebpagePreset(obj.webpage, next.webpage, warnings);
  }

  if (obj.subtitles !== undefined) {
    next.subtitles = sanitizeSubtitlePreset(obj.subtitles, next.subtitles, warnings);
  }

  return { settings: next, warnings };
}

export function sanitizeLocalSecrets(
  raw: unknown,
  base: WufLocalSecrets = DEFAULT_LOCAL_SECRETS,
): WufLocalSecrets {
  const next: WufLocalSecrets = structuredClone(base);
  if (!raw || typeof raw !== 'object') return next;
  const obj = raw as Record<string, unknown>;
  const keysObj =
    obj.providerApiKeys && typeof obj.providerApiKeys === 'object'
      ? (obj.providerApiKeys as Record<string, unknown>)
      : obj;

  for (const type of PROVIDER_PROFILE_TYPES) {
    if (typeof keysObj[type] === 'string') {
      next.providerApiKeys[type] = keysObj[type].trim();
    }
  }
  return next;
}

export function applyRuntimePlatformAdaptations(
  saved: WufSettings,
  platform: string = detectRuntimePlatform(),
): WufSettings {
  const runtime = structuredClone(saved);
  runtime.providers.local.model = localModelForPlatform(
    saved.providers.local.model,
    saved.providers.local.baseUrl,
    platform,
  );
  if (runtime.webpage.engine === 'openai-compat-local') {
    runtime.webpage.customModelOverride = localModelForPlatform(
      saved.webpage.customModelOverride,
      saved.providers.local.baseUrl,
      platform,
    );
  }
  if (runtime.subtitles.engine === 'openai-compat-local') {
    runtime.subtitles.customModelOverride = localModelForPlatform(
      saved.subtitles.customModelOverride,
      saved.providers.local.baseUrl,
      platform,
    );
  }
  if (runtime.subtitles.decisionMode === 'custom') {
    const decisionUrl =
      saved.subtitles.decisionCustomBaseUrl || saved.providers.local.baseUrl;
    runtime.subtitles.decisionCustomModel = localModelForPlatform(
      saved.subtitles.decisionCustomModel,
      decisionUrl,
      platform,
    );
  }
  return runtime;
}

export function resolveProviderConfig(
  settings: WufSettings,
  secrets: WufLocalSecrets,
  profileType: ProviderProfileType = settings.activeProviderType,
  modelOverride?: string,
  platform: string = detectRuntimePlatform(),
): ActiveProviderConfig {
  const profile = settings.providers[profileType];
  const rawChosenModel =
    modelOverride !== undefined && modelOverride.trim() !== ''
      ? modelOverride.trim()
      : profile.model.trim();
  const normalizedChosen = rawChosenModel === 'default' ? '' : rawChosenModel;
  const effectiveModel =
    profileType === 'local'
      ? localModelForPlatform(normalizedChosen, profile.baseUrl, platform)
      : normalizedChosen;
  const runtimeFallbackApplied =
    profileType === 'local' && normalizedChosen !== '' && effectiveModel === '';

  return {
    ...profile,
    model: effectiveModel,
    effectiveModel,
    profileType,
    apiKey: secrets.providerApiKeys[profileType] || '',
    runtimeFallbackApplied,
  };
}

export function resolvePresetProvider(
  settings: WufSettings,
  secrets: WufLocalSecrets,
  purpose: 'webpage' | 'subtitle' | 'manual',
  engineOverride?: TranslationEngineId,
  modelOverride?: string,
  platform: string = detectRuntimePlatform(),
): ActiveProviderConfig {
  const preset = purpose === 'subtitle' ? settings.subtitles : settings.webpage;
  const engine = engineOverride ?? preset.engine;
  const profileType: ProviderProfileType =
    engine === 'openai-compat-online'
      ? 'online'
      : engine === 'openai-compat-local'
        ? 'local'
        : settings.activeProviderType;

  const chosenOverride =
    modelOverride !== undefined
      ? modelOverride
      : purpose === 'manual'
        ? ''
        : preset.customModelOverride;

  const resolved = resolveProviderConfig(
    settings,
    secrets,
    profileType,
    chosenOverride,
    platform,
  );
  if (purpose === 'subtitle' && settings.subtitles.systemPrompt.trim() !== '') {
    return {
      ...resolved,
      systemPrompt: settings.subtitles.systemPrompt,
    };
  }
  return resolved;
}

export function isLocalSubtitleEngine(
  engine: TranslationEngineId,
  baseUrl?: string,
): boolean {
  if (engine === 'openai-compat-local') return true;
  if (engine === 'openai-compat-online') return false;
  return baseUrl ? inferProviderType(baseUrl) === 'local' : false;
}
