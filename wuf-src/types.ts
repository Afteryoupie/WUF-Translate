export const UI_LOCALES = [
  'zh-TW',
  'zh-CN',
  'en',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const PROVIDER_PROFILE_TYPES = ['online', 'local'] as const;
export type ProviderProfileType = (typeof PROVIDER_PROFILE_TYPES)[number];

export const TRANSLATION_ENGINES = [
  'openai-compat-online',
  'openai-compat-local',
  'google-translate',
] as const;
export type TranslationEngineId = (typeof TRANSLATION_ENGINES)[number];

export const SUBTITLE_DECISION_MODES = ['laya', 'custom', 'off'] as const;
export type SubtitleDecisionMode = (typeof SUBTITLE_DECISION_MODES)[number];

export const ROUTING_SORTS = ['auto', 'throughput', 'latency', 'price'] as const;
export type RoutingSort = (typeof ROUTING_SORTS)[number];

export const THINKING_LEVELS = ['auto', 'off', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const OPENCC_VARIANTS = ['s2twp', 'tw2sp', 's2t', 't2s'] as const;
export type OpenCCVariant = (typeof OPENCC_VARIANTS)[number];

export const DISPLAY_MODES = ['bilingual', 'monolingual'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

export interface CustomProviderProfile {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number | null;
  fetchTimeoutSec: number;
  thinkingLevel: ThinkingLevel;
  routingSort: RoutingSort;
  allowFallbacks: boolean;
  extraBodyJson: string;
  webConcurrency: number;
  webBatchUnits: number;
  webBatchChars: number;
}

export interface ActiveProviderConfig extends CustomProviderProfile {
  profileType: ProviderProfileType;
  apiKey: string;
  effectiveModel: string;
  runtimeFallbackApplied: boolean;
}

export interface ProviderPerformanceConfig {
  webConcurrency: number;
  webBatchUnits: number;
  webBatchChars: number;
  firstBatchUnits: number;
  firstBatchChars: number;
}

export interface WebpageTranslationPreset {
  engine: TranslationEngineId;
  targetLanguage: string;
  displayMode: DisplayMode;
  customModelOverride: string;
  autoTranslateHosts: string[];
  crossTabSticky?: boolean;
}

export interface SubtitleTranslationPreset {
  engine: TranslationEngineId;
  targetLanguage: string;
  customModelOverride: string;
  systemPrompt: string;
  batchWindowSec: number;
  prefetchLeadSec: number;
  decisionMode: SubtitleDecisionMode;
  layaDecisionEnabled: boolean;
  layaEndpointUrl: string;
  decisionCustomModel: string;
  decisionCustomBaseUrl: string;
}

export interface WufSettings {
  schemaVersion: 1;
  uiLocale: UiLocale;
  theme: ThemeMode;
  activeProviderType: ProviderProfileType;
  providers: {
    online: CustomProviderProfile;
    local: CustomProviderProfile;
  };
  webpage: WebpageTranslationPreset;
  subtitles: SubtitleTranslationPreset;
  openccEnabled: boolean;
  openccVariant: OpenCCVariant;
}

export interface WufLocalSecrets {
  providerApiKeys: {
    online: string;
    local: string;
  };
}

export interface WatchdogModelInfo {
  id: string;
  name?: string;
  path?: string;
  type?: string;
  is_translation?: boolean;
  idle_timeout?: number;
}

export interface WatchdogDecisionSnapshot {
  status: 'sleeping' | 'starting' | 'running' | string;
  current_model?: string;
  current_model_id?: string;
  active_requests?: number;
  device?: string;
  idle_timeout?: number;
  idle_remaining?: number;
  auto_sleep_enabled?: boolean;
  runtime_available?: boolean;
  endpoint?: string;
  last_error?: string;
}

export interface WatchdogStatusResponse {
  status: 'sleeping' | 'starting' | 'running';
  current_model?: string;
  current_model_id?: string;
  backend_type?: string;
  is_translation?: boolean;
  models?: WatchdogModelInfo[];
  idle_timeout?: number;
  idle_remaining?: number;
  auto_sleep_enabled?: boolean;
  active_requests?: number;
  request_count?: number;
  decision?: WatchdogDecisionSnapshot;
}

export interface WatchdogWakeResponse {
  status: 'ok' | 'error' | string;
  state?: 'running' | 'sleeping' | 'failed' | string;
  message?: string;
  current_model?: string;
}

export interface TranslationRequest {
  texts: string[];
  targetLanguage: string;
  sourceLanguage?: string;
  engine: TranslationEngineId;
  purpose: 'webpage' | 'subtitle' | 'manual';
  modelOverride?: string;
  applyOpenCC?: boolean;
  openccVariant?: OpenCCVariant;
  subtitleContext?: import('./subtitle/translation-context.ts').SubtitleTranslationContext;
}

export interface OpenCCConversionRequest {
  texts: string[];
  variant?: OpenCCVariant;
}

export interface TranslationResponse {
  translations: string[];
  engine: TranslationEngineId;
  effectiveModel: string;
  profileType?: ProviderProfileType;
  openccApplied?: OpenCCVariant;
  decisionReport?: import('./subtitle/subtitle-decisions.ts').SubtitleDecisionReport;
  intentionalEmpty?: number[];
  contextDecision?: import('./subtitle/translation-context.ts').SubtitleTopicDecision;
}

export type RuntimeRequestMessage =
  | { type: 'wuf:get-settings' }
  | {
      type: 'wuf:save-settings';
      settings?: Partial<WufSettings>;
      apiKeys?: Partial<WufLocalSecrets['providerApiKeys']>;
    }
  | { type: 'wuf:clear-settings' }
  | { type: 'wuf:export-settings' }
  | { type: 'wuf:import-settings'; raw: unknown }
  | {
      type: 'wuf:list-local-models';
      baseUrl?: string;
      apiKey?: string;
    }
  | {
      type: 'wuf:probe-watchdog';
      baseUrl?: string;
    }
  | {
      type: 'wuf:wake-watchdog';
      baseUrl?: string;
      model?: string;
    }
  | {
      type: 'wuf:translate-text';
      request: TranslationRequest;
    }
  | {
      type: 'wuf:convert-opencc';
      request: OpenCCConversionRequest;
    }
  | {
      type: 'wuf:warmup-youtube';
    }
  | {
      type: 'wuf:evaluate-subtitle-boundaries';
      segments: Array<{ text: string; startMs: number; endMs?: number }>;
    }
  | {
      type: 'wuf:switch-local-model';
      baseUrl?: string;
      model: string;
    }
  | {
      type: 'wuf:set-page-translated';
      tabId?: number;
      translated: boolean;
    }
  | {
      type: 'wuf:get-cache-stats';
    }
  | {
      type: 'wuf:clear-cache';
    }
  | {
      type: 'wuf:sticky-query';
    }
  | {
      type: 'wuf:sticky-set';
      tabId?: number;
    }
  | {
      type: 'wuf:sticky-clear';
      tabId?: number;
    };

export interface SettingsSnapshotPayload {
  savedSettings: WufSettings;
  runtimeSettings: WufSettings;
  apiKeys: WufLocalSecrets['providerApiKeys'];
  activeProvider: ActiveProviderConfig;
  webpageProvider: ActiveProviderConfig;
  subtitleProvider: ActiveProviderConfig;
}

export interface WatchdogProbeResult {
  isLoopback: boolean;
  isWatchdogEndpoint: boolean;
  reachable: boolean;
  state: 'offline' | 'sleeping' | 'starting' | 'running' | 'non-watchdog';
  currentModel?: string;
  currentModelId?: string;
  activeRequests?: number;
  models?: string[];
  errorMessage?: string;
}

export type RuntimeResponseMessage<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
      };
    };
