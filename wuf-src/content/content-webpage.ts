import type { SettingsSnapshotPayload, TranslationResponse } from '../types.ts';
import { resolvePerformanceConfig } from '../lib/provider-performance.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import { WufDomTranslator } from '../webpage/dom-translator.ts';

let pageTranslator: WufDomTranslator | null = null;
let isEditing = false;

let progressHost: HTMLDivElement | null = null;
let progressLabel: HTMLDivElement | null = null;
let progressTimer: ReturnType<typeof setTimeout> | undefined;

function showTranslationProgress(completed: number, total: number, active: boolean): void {
  clearTimeout(progressTimer);
  if (!active && total === 0) {
    progressHost?.remove();
    progressHost = null;
    progressLabel = null;
    return;
  }
  if (!progressHost) {
    progressHost = document.createElement('div');
    progressHost.setAttribute('data-wuf-ignore', 'true');
    progressHost.style.cssText = 'all: initial !important; position: fixed !important; bottom: max(24px, env(safe-area-inset-bottom)) !important; left: 50% !important; transform: translateX(-50%) !important; z-index: 2147483647 !important; pointer-events: none !important;';
    const shadow = progressHost.attachShadow({ mode: 'closed' });
    progressLabel = document.createElement('div');
    progressLabel.setAttribute('role', 'status');
    progressLabel.setAttribute('aria-live', 'polite');
    progressLabel.setAttribute('aria-atomic', 'true');
    progressLabel.style.cssText = 'padding: 10px 18px; border-radius: 999px; background: #242620; color: #fff; font: 14px/1.5 system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 4px 16px #0003;';
    shadow.appendChild(progressLabel);
    document.documentElement.appendChild(progressHost);
  }
  const label = active ? '翻譯中' : completed === total ? '翻譯完成' : '翻譯已停止';
  progressLabel!.textContent = total > 0 ? `${label}（${completed}/${total}）` : '準備翻譯中…';
  if (!active) {
    progressTimer = setTimeout(() => {
      progressHost?.remove();
      progressHost = null;
      progressLabel = null;
    }, 2500);
  }
}

function ensureTranslator(): WufDomTranslator {
  if (pageTranslator) return pageTranslator;
  pageTranslator = new WufDomTranslator({
    // Keep YouTube's endless recommendation feed out of the comment queue.
    root: document.querySelector('ytd-watch-flexy #primary') || document.body,
    doc: document,
    onProgress: showTranslationProgress,
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
      // Local translation models often do not preserve multi-item delimiters.
      // One item per request also lets each comment appear as soon as it is ready.
      if (location.hostname.endsWith('youtube.com') && wp.engine === 'openai-compat-local') {
        batchConfig.webConcurrency = 1;
        batchConfig.webBatchUnits = 1;
        batchConfig.firstBatchUnits = 1;
      }
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