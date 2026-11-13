// WUF integration boundary: only the WuPage settings and protocol consumed by
// the ported webpage engine. DOM/rendering modules retain their upstream types.
import type { FrameSessionRequest, FrameTranslationSettings } from './frame-session';

export type TranslationDisplayMode = 'replace' | 'bilingual' | 'bilingual-accent';
export interface ProviderConfig {
  id: string;
  type: string;
  performanceMode?: 'inherit' | 'custom';
  chunkSize?: number;
  concurrency?: number;
  fingerprint?: string;
  modelOverride?: string;
}
export interface ExtensionSettings {
  sourceLang: string;
  targetLang: string;
  activeProviderId: string;
  providers: ProviderConfig[];
  chunkSize: number;
  concurrency: number;
  translateCodeComments: boolean;
  translationDisplayMode: TranslationDisplayMode;
  frameTranslation: FrameTranslationSettings;
}
export interface TranslateBatchRequest {
  texts: string[];
  paragraphIds?: string[];
  pageSession?: { id: string; documentKey: string };
  preservePlaceholders?: boolean;
  context?: string;
  sourceLang?: string;
  targetLang: string;
  providerId?: string;
  modelOverride?: string;
}
export interface TranslateBatchResponse { translations: string[]; cached: number }
export type RuntimeRequest = FrameSessionRequest
  | { type: 'GET_SETTINGS' }
  | ({ type: 'TRANSLATE_BATCH' } & TranslateBatchRequest)
  | { type: 'EXECUTE_TRANSLATION_SHORTCUT'; command: string };
export type RuntimeResponse = { ok: true; data?: unknown }
  | { ok: false; error: string; errorCode?: string; retryAfterMs?: number };
