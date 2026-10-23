import type { SettingsSnapshotPayload, TranslationResponse } from '../types.ts';
import { resolvePerformanceConfig } from '../lib/provider-performance.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import { WufDomTranslator } from '../webpage/dom-translator.ts';

let pageTranslator: WufDomTranslator | null = null;
let isEditing = false;

function ensureTranslator(): WufDomTranslator {
  if (pageTranslator) return pageTranslator;
  pageTranslator = new WufDomTranslator({
    root: document.body,
    doc: document,
    onStateChange: (translated) => {
      void sendWufRuntimeMessage({
        type: 'wuf:set-page-translated',
        translated,
      }).catch(() => {});
      if (translated) {
        void sendWufRuntimeMessage({ type: 'wuf:sticky-set' }).catch(() => {});
      } else {
        void sendWufRuntimeMessage({ type: 'wuf:sticky-clear' }).catch(() => {});
      }
    },
    getConfig: async () => {
      const resp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
        type: 'wuf:get-settings',
      });
      if (!resp.ok) {
        return {
          engine: 'openai-compat-local',
          targetLanguage: 'zh-TW',
          displayMode: 'bilingual',
          batchConfig: {
            webConcurrency: 1,
            webBatchUnits: 40,
            webBatchChars: 7000,
            firstBatchUnits: 16,
            firstBatchChars: 2800,
          },
        };
      }
      const wp = resp.data.runtimeSettings.webpage;
      const batchConfig = resolvePerformanceConfig(
        resp.data.webpageProvider,
        resp.data.webpageProvider.profileType,
      );
      return {
        engine: wp.engine,
        targetLanguage: wp.targetLanguage,
        displayMode: wp.displayMode,
        batchConfig,
      };
    },
    translateBatch: async (texts, _signal) => {
      const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
        type: 'wuf:get-settings',
      });
      const wp = snapResp.ok
        ? snapResp.data.runtimeSettings.webpage
        : {
            engine: 'openai-compat-local' as const,
            targetLanguage: 'zh-TW',
            customModelOverride: '',
          };
      const trResp = await sendWufRuntimeMessage<TranslationResponse>({
        type: 'wuf:translate-text',
        request: {
          texts,
          targetLanguage: wp.targetLanguage,
          engine: wp.engine,
          purpose: 'webpage',
          modelOverride: wp.customModelOverride || undefined,
        },
      });
      if (!trResp.ok) {
        throw new Error(trResp.error.message);
      }
      return trResp.data.translations;
    },
  });
  return pageTranslator;
}

if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.onMessage) {
  globalThis.chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    const type = (msg as { type?: string }).type;
    if (type === 'wuf:translate-page') {
      const payload = (msg as { payload?: { translateOnly?: boolean; force?: boolean } })
        .payload;
      ensureTranslator()
        .handleTranslatePreset(payload || {})
        .then(() => sendResponse({ ok: true }))
        .catch(err => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    if (type === 'wuf:restore-page') {
      ensureTranslator().restorePage();
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'wuf:get-state') {
      const tr = ensureTranslator();
      sendResponse({
        ok: true,
        translated: tr.translated,
        translating: tr.translating,
        editing: isEditing,
        progress: {
          completedUnits: tr.completedUnits,
          totalUnits: tr.totalUnits,
        },
      });
      return false;
    }
    if (type === 'wuf:toggle-edit') {
      isEditing = !isEditing;
      const targets = document.querySelectorAll<HTMLElement>(
        '.wuf-bilingual-translation, [data-wuf-injected="true"]',
      );
      for (const el of targets) {
        el.contentEditable = isEditing ? 'true' : 'inherit';
        el.style.outline = isEditing ? '1px dashed #007AFF' : '';
      }
      sendResponse({ ok: true, editing: isEditing });
      return false;
    }
    return false;
  });
}

async function maybeAutoTranslate(): Promise<void> {
  const resp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({ type: 'wuf:get-settings' });
  if (!resp.ok) return;
  const hosts = resp.data.runtimeSettings.webpage.autoTranslateHosts || [];
  if (hosts.includes(location.hostname.toLowerCase())) {
    await ensureTranslator().handleTranslatePreset({ translateOnly: true, force: true });
    return;
  }

  let navType: string | null = null;
  try {
    const navEntries = performance.getEntriesByType('navigation');
    if (navEntries.length > 0) {
      navType = (navEntries[0] as PerformanceNavigationTiming).type;
    }
  } catch {
    // ignore
  }

  if (navType === 'reload') {
    await sendWufRuntimeMessage({ type: 'wuf:sticky-clear' }).catch(() => {});
  } else if (resp.data.runtimeSettings.webpage.crossTabSticky) {
    const stickyResp = await sendWufRuntimeMessage<{ shouldTranslate: boolean }>({
      type: 'wuf:sticky-query',
    }).catch(() => null);
    if (stickyResp?.ok && stickyResp.data?.shouldTranslate) {
      await ensureTranslator().handleTranslatePreset({ translateOnly: true, force: true });
    }
  }
}

if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.onMessage && window.top === window) {
  void maybeAutoTranslate().catch(() => undefined);
}