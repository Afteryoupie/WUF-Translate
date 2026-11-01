import type { SettingsSnapshotPayload, TranslationEngineId, TranslationResponse } from '../types.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import { toWuPageSettings } from './wupage-settings.ts';
import { toWuPageError } from './wupage-errors.ts';
import { configureRuntimeTransport } from '../vendor/wupage/content/runtime';
import { injectContentStyles } from '../vendor/wupage/content/styles';
import { getPageTranslationState, hidePageTranslation, startPageTranslation, subscribePageTranslationState, setPageTranslationDisplayMode } from '../vendor/wupage/content/page-translation';
import { installFrameRuntime } from '../vendor/wupage/content/frame-runtime';
import { installFrameVisibilityBridge } from '../vendor/wupage/content/frame-visibility';
import { sampleDocumentText } from '../vendor/wupage/content/frame-sample';
import { createDocumentKey, frameExclusion } from '../vendor/wupage/shared/frame-session';
import type { RuntimeRequest, RuntimeResponse } from '../vendor/wupage/shared/types';

export interface WuPageAdapterOptions {
  onProgress?: (completed: number, total: number, active: boolean) => void;
  onStateChange?: (translated: boolean) => void;
}

export class WufWuPageTranslator {
  private starting = false;
  private intent = 0;
  private previousState = false;
  private previousProgress = '';
  private identity = '';

  get translated(): boolean { return getPageTranslationState().active; }
  get translating(): boolean {
    const state = getPageTranslationState();
    return this.starting || state.active && state.pending > 0;
  }
  get completedUnits(): number { return getPageTranslationState().translated; }
  get error(): string | undefined { return getPageTranslationState().error; }
  get errorCode(): string | undefined { return getPageTranslationState().errorCode; }
  get retryAt(): number | undefined { return getPageTranslationState().retryAt; }
  get totalUnits(): number {
    const state = getPageTranslationState();
    return state.translated + state.failed + state.pending;
  }

  constructor(private options: WuPageAdapterOptions = {}) {
    const documentKey = createDocumentKey();
    let counter = 0;
    configureRuntimeTransport(async (request, signal) => {
      if (request.type === 'GET_SETTINGS') {
        const response = await sendWufRuntimeMessage<SettingsSnapshotPayload>({ type: 'wuf:get-settings' });
        if (!response.ok) throw toWuPageError(response.error);
        return toWuPageSettings(response.data);
      }
      if (request.type !== 'TRANSLATE_BATCH') {
        const response = await sendWufRuntimeMessage({ type: 'wuf:wupage-frame', request });
        if (!response.ok) throw toWuPageError(response.error);
        return response.data;
      }
      const requestId = `${documentKey}:${++counter}`;
      const cancel = () => { void sendWufRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId }); };
      signal?.throwIfAborted();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const response = await sendWufRuntimeMessage<TranslationResponse & { cached: number }>({ type: 'wuf:wupage-translate', requestId,
          request: { texts: request.texts, targetLanguage: request.targetLang, sourceLanguage: request.sourceLang,
            engine: request.providerId as TranslationEngineId, purpose: 'webpage', modelOverride: request.modelOverride,
            webpageContext: request.context, preservePlaceholders: request.preservePlaceholders,
            wupageSession: request.pageSession } });
        signal?.throwIfAborted();
        if (!response.ok) throw toWuPageError(response.error);
        return { translations: response.data.translations, cached: response.data.cached };
      } finally { signal?.removeEventListener('abort', cancel); }
    });
    injectContentStyles();
    if (globalThis.chrome?.runtime?.id) {
      installFrameVisibilityBridge();
      const frame = installFrameRuntime(documentKey, { top: window === window.top });
      if (window !== window.top) {
        chrome.runtime.onMessage.addListener((request: RuntimeRequest, _sender, respond: (response: RuntimeResponse) => void) => {
          if (request.type === 'FRAME_SAMPLE') { respond({ ok: true, data: sampleDocumentText() }); return; }
          if (request.type === 'FRAME_SNAPSHOT') { frame.updateSnapshot(request.snapshot); return; }
          if (request.type !== 'FRAME_APPLY' || request.documentKey !== documentKey) return;
          void frame.apply(request.snapshot, request.allowed, request.reuseResults).then(
            data => respond({ ok: true, data }), error => respond({ ok: false, error: String(error) }));
          return true;
        });
        const register = async () => {
          const response = await sendWufRuntimeMessage<import('../vendor/wupage/shared/frame-session').FrameSessionSnapshot>({
            type: 'wuf:wupage-frame', request: { type: 'FRAME_REGISTER', documentKey, url: location.href } });
          if (response.ok) {
            const value = response.data;
            const allowed = !frameExclusion(value.settings, value.frames.find(item => item.frameId === 0)?.url || '', location.href, value.selfFrameId ?? 1);
            await frame.apply(value, allowed);
          }
        };
        void register().catch(() => {});
        window.addEventListener('pageshow', event => { if (event.persisted) void register().catch(() => {}); });
      }
    }
    subscribePageTranslationState(() => this.report());
  }

  private report(): void {
    if (window !== window.top) return;
    const translated = this.translated;
    if (translated !== this.previousState) { this.previousState = translated; this.options.onStateChange?.(translated); }
    const progress = JSON.stringify([this.completedUnits, this.totalUnits, this.translating]);
    if (progress !== this.previousProgress) {
      this.previousProgress = progress;
      this.options.onProgress?.(this.completedUnits, this.totalUnits, this.translating);
    }
  }

  async handleTranslatePreset(options: { translateOnly?: boolean; force?: boolean } = {}): Promise<void> {
    if (this.translated && !options.translateOnly) { this.restorePage(); return; }
    const intent = ++this.intent;
    this.starting = true; this.report();
    try {
      const response = await sendWufRuntimeMessage<SettingsSnapshotPayload>({ type: 'wuf:get-settings' });
      if (!response.ok) throw new Error(response.error.message);
      if (intent !== this.intent) return;
      const settings = toWuPageSettings(response.data);
      const identity = JSON.stringify([settings.sourceLang, settings.targetLang, settings.providers]);
      if (this.translated && identity === this.identity) {
        setPageTranslationDisplayMode(settings.translationDisplayMode);
        return;
      }
      this.identity = identity;
      const result = await startPageTranslation(settings, true);
      if (intent === this.intent && result.error) throw new Error(result.error);
    } finally { if (intent === this.intent) { this.starting = false; this.report(); } }
  }

  abortInProgressTranslation(): void { this.restorePage(); }
  restorePage(): void {
    this.intent++; this.starting = false;
    void Promise.resolve(hidePageTranslation()).finally(() => this.report()).catch(() => {});
    this.report();
  }
}
