import type {
  RuntimeRequestMessage,
  RuntimeResponseMessage,
  TranslationResponse,
} from '../types.ts';
import {
  clearAllSettings,
  exportSanitizedSettings,
  importSanitizedSettings,
  loadLocalSecrets,
  loadSavedSettings,
  loadSettingsSnapshot,
  saveSettingsAndSecrets,
} from '../lib/storage.ts';
import {
  ensureLocalLlamaServer,
  fetchLocalModelEntries,
  probeWatchdogEndpoint,
  switchLocalModel,
} from '../lib/watchdog-client.ts';
import { refreshPageContextMenu, registerPageContextMenus } from '../lib/page-context-menu.ts';
import { computeCacheKey, globalCacheManager } from '../lib/cache-manager.ts';
import { WufProviderError } from '../providers/errors.ts';
import { executeTranslation } from '../providers/index.ts';
import { translateWithOpenCC } from '../providers/opencc.ts';
import { runSubtitleDecisionPipeline } from '../subtitle/subtitle-decisions.ts';
import { resolvePresetProvider } from '../lib/provider-profiles.ts';
import { FrameSessionManager } from '../vendor/wupage/background/frame-sessions';
import { ProviderError } from '../vendor/wupage/shared/errors';
import { toWuPageError } from '../webpage/wupage-errors.ts';
import { translateWuPage } from '../webpage/wupage-background.ts';
import { translateLocalWebpage } from '../webpage/local-webpage-translator.ts';
import { CACHE_PREFIX as WUPAGE_CACHE_PREFIX } from '../vendor/wupage/core/shared/defaults';
import { ProviderError as WuPageCoreProviderError } from '../vendor/wupage/core/shared/errors';

let wupageFrames: FrameSessionManager | undefined;
function getWuPageFrames(): FrameSessionManager {
  if (!wupageFrames) { wupageFrames = new FrameSessionManager(); wupageFrames.install(); }
  return wupageFrames;
}

const webpageRequests = new Map<string, AbortController>();

const stickyTabs = new Set<number>();
let _stickyHydratingPromise: Promise<void> | null = null;

async function hydrateStickyTabs(): Promise<void> {
  if (_stickyHydratingPromise) return _stickyHydratingPromise;
  _stickyHydratingPromise = (async () => {
    try {
      const storage =
        globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
      if (!storage?.get) return;
      const res = await storage.get(['wuf:stickyTabs']);
      const saved = res?.['wuf:stickyTabs'];
      if (Array.isArray(saved)) {
        for (const id of saved) {
          if (typeof id === 'number') stickyTabs.add(id);
        }
      }
    } catch {
      // ignore
    }
  })();
  return _stickyHydratingPromise;
}

async function persistStickyTabs(): Promise<void> {
  try {
    const storage =
      globalThis.chrome?.storage?.session ?? globalThis.chrome?.storage?.local;
    if (!storage?.set) return;
    await storage.set({ 'wuf:stickyTabs': Array.from(stickyTabs) });
  } catch {
    // ignore
  }
}

export async function handleRuntimeMessage(
  message: RuntimeRequestMessage,
  sender?: chrome.runtime.MessageSender,
): Promise<RuntimeResponseMessage> {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return handleMessage(message, sender);
  const key = message && typeof message === 'object' && 'requestId' in message && message.requestId
    ? JSON.stringify([sender?.tab?.id, sender?.frameId, sender?.documentId, message.requestId]) : undefined;
  if (message.type === 'wuf:cancel-webpage-request') {
    if (key) webpageRequests.get(key)?.abort();
    return { ok: true, data: {} };
  }
  if (!((message.type === 'wuf:translate-text' && message.request.purpose === 'webpage')
    || message.type === 'wuf:wupage-translate') || !key) {
    return handleMessage(message, sender);
  }
  const controller = new AbortController();
  webpageRequests.set(key, controller);
  try {
    if (message.request.wupageSession && sender) {
      return await getWuPageFrames().translate({ texts: message.request.texts, targetLang: message.request.targetLanguage,
        pageSession: message.request.wupageSession }, sender, async signal => {
        const response = await handleMessage(message, sender, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
        if (!response.ok) throw toWuPageError(response.error);
        return response;
      });
    }
    return await handleMessage(message, sender, controller.signal);
  } catch (error) {
    if (error instanceof ProviderError) return { ok: false, error: { code: error.errorCode, message: error.message, retryAfterMs: error.retryAfterMs } };
    throw error;
  }
  finally { if (webpageRequests.get(key) === controller) webpageRequests.delete(key); }
}

async function handleMessage(
  message: RuntimeRequestMessage,
  sender?: chrome.runtime.MessageSender,
  signal?: AbortSignal,
): Promise<RuntimeResponseMessage> {
  try {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return {
        ok: false,
        error: {
          code: 'INVALID_MESSAGE',
          message: 'Runtime message must have a valid type field',
        },
      };
    }

    switch (message.type) {
      case 'wuf:wupage-frame': {
        if (!sender) throw new Error('Frame requests require a browser sender.');
        if (message.request.type === 'EXECUTE_TRANSLATION_SHORTCUT') throw new Error('Unsupported frame shortcut.');
        return { ok: true, data: await getWuPageFrames().handle(message.request, sender) };
      }
      case 'wuf:get-settings': {
        const snapshot = await loadSettingsSnapshot();
        return { ok: true, data: snapshot };
      }

      case 'wuf:save-settings': {
        const snapshot = await saveSettingsAndSecrets(
          message.settings,
          message.apiKeys,
        );
        return { ok: true, data: snapshot };
      }

      case 'wuf:clear-settings': {
        const snapshot = await clearAllSettings();
        return { ok: true, data: snapshot };
      }

      case 'wuf:export-settings': {
        const exported = await exportSanitizedSettings();
        return { ok: true, data: exported };
      }

      case 'wuf:import-settings': {
        const result = await importSanitizedSettings(message.raw);
        return { ok: true, data: result };
      }

      case 'wuf:list-local-models': {
        const [saved, secrets] = await Promise.all([
          loadSavedSettings(),
          loadLocalSecrets(),
        ]);
        const baseUrl = message.baseUrl ?? saved.providers.local.baseUrl;
        const apiKey = message.apiKey ?? secrets.providerApiKeys.local;
        const modelEntries = await fetchLocalModelEntries(baseUrl, apiKey);
        return {
          ok: true,
          data: {
            models: modelEntries.map(entry => entry.id),
            modelEntries,
          },
        };
      }

      case 'wuf:probe-watchdog': {
        const saved = await loadSavedSettings();
        const baseUrl = message.baseUrl ?? saved.providers.local.baseUrl;
        const probe = await probeWatchdogEndpoint(baseUrl);
        return { ok: true, data: probe };
      }

      case 'wuf:wake-watchdog': {
        const snapshot = await loadSettingsSnapshot();
        const baseUrl =
          message.baseUrl ?? snapshot.runtimeSettings.providers.local.baseUrl;
        const model =
          message.model ?? snapshot.runtimeSettings.providers.local.model;
        await ensureLocalLlamaServer(baseUrl, model, { apiKey: snapshot.apiKeys.local });
        const probe = await probeWatchdogEndpoint(baseUrl);
        return { ok: true, data: probe };
      }

      case 'wuf:wupage-translate': {
        const [saved, secrets] = await Promise.all([loadSavedSettings(), loadLocalSecrets()]);
        signal?.throwIfAborted();
        return { ok: true, data: await translateWuPage(message.request, saved, secrets, signal, message.bypassCache) };
      }

      case 'wuf:translate-text': {
        const [saved, secrets] = await Promise.all([
          loadSavedSettings(),
          loadLocalSecrets(),
        ]);

        const req = message.request;
        signal?.throwIfAborted();
        if (req.purpose === 'webpage' && req.engine === 'openai-compat-local') {
          const shouldApplyOpenCC =
            req.applyOpenCC ?? (saved.openccEnabled && /^zh/i.test(req.targetLanguage));
          return {
            ok: true,
            data: await translateLocalWebpage(req, saved, secrets, signal, false, {
              applyOpenCC: shouldApplyOpenCC,
            }),
          };
        }
        if (req.purpose === 'subtitle') {
          const provider = resolvePresetProvider(saved, secrets, 'subtitle', req.engine, req.modelOverride);
          const key = {
            sourceLang: req.sourceLanguage || 'auto', targetLang: req.targetLanguage,
            engine: req.engine,
            // A changed endpoint, model or prompt must not reuse old subtitles.
            model: JSON.stringify([provider.baseUrl, provider.effectiveModel,
              provider.systemPrompt,
              req.applyOpenCC ?? saved.openccEnabled, req.openccVariant ?? saved.openccVariant]),
          };
          let metadata: TranslationResponse = {
            translations: [], engine: req.engine, effectiveModel: '',
          };
          const checked = await runSubtitleDecisionPipeline(
            { texts: req.texts, sourceLanguage: req.sourceLanguage },
            { ...saved, subtitles: { ...saved.subtitles, targetLanguage: req.targetLanguage } },
            async payload => {
              if (!payload.skipCache && payload.texts.length === 1) {
                const cached = await globalCacheManager.get({ ...key, text: payload.texts[0] });
                if (cached !== null) return { ok: true, result: [cached] };
              }
              const response = await executeTranslation(
                { ...req, texts: payload.texts }, saved, secrets,
                { subtitleRepair: payload.decisionRepair },
              );
              metadata = response;
              return { ok: true, result: response.translations,
                commitSubtitleCache: async translations => {
                  await globalCacheManager.setBatch(translations.flatMap((translatedText, i) =>
                    translatedText?.trim() ? [{ ...key, text: payload.texts[i], translatedText }] : [],
                  ));
                },
              };
            },
            {
              log: report => console.debug('Subtitle decision pipeline', report),
            },
          );
          if (!checked.ok || !checked.result || checked.result.some(text => text === null)) {
            throw new WufProviderError(checked.error || 'Subtitle format repair failed', {
              code: 'INVALID_RESPONSE', provider: req.engine,
            });
          }
          return { ok: true, data: {
            ...metadata,
            translations: checked.result as string[],
            decisionReport: checked.decisionReport,
            intentionalEmpty: checked.intentionalEmpty,
          } };
        }
        // Page cache identity must reflect the effective provider, not only the
        // engine name or an optional model override. Keep subtitle behavior.
        const pageProvider = req.purpose === 'webpage' && req.engine !== 'google-translate'
          ? resolvePresetProvider(saved, secrets, 'webpage', req.engine, req.modelOverride) : undefined;
        const cacheModel = req.purpose === 'webpage' ? await computeCacheKey({
          engine: req.engine, targetLang: req.targetLanguage,
          text: JSON.stringify({ version: 3, protocol: req.preservePlaceholders ? 'wupage-1.5.5' : 'wuf', provider: pageProvider ? { ...pageProvider, apiKey: undefined } : 'google',
            context: req.webpageContext, opencc: [req.applyOpenCC ?? saved.openccEnabled, req.openccVariant ?? saved.openccVariant] }),
        }) : req.modelOverride;
        // Fast-path single text cache lookup
        if (req.texts.length === 1 && req.texts[0].trim()) {
          const cached = await globalCacheManager.get({
            text: req.texts[0],
            sourceLang: 'auto',
            targetLang: req.targetLanguage,
            engine: req.engine,
            model: cacheModel,
          });
          if (cached !== null) {
            return {
              ok: true,
              data: {
                translations: [cached],
                effectiveModel: 'cache-hit',
                profileType: req.engine.includes('local') ? 'local' : 'online',
              },
            };
          }
        }

        const response = await executeTranslation(
          message.request,
          saved,
          secrets,
          { signal },
        );
        signal?.throwIfAborted();

        // Populate cache asynchronously
        if (response.translations.length === req.texts.length) {
          const cacheEntries = [];
          for (let i = 0; i < req.texts.length; i++) {
            const tr = response.translations[i];
            if (tr && tr.trim() && tr !== req.texts[i]) {
              cacheEntries.push({
                text: req.texts[i],
                translatedText: tr,
                sourceLang: 'auto',
                targetLang: req.targetLanguage,
                engine: req.engine,
                model: req.purpose === 'webpage' ? cacheModel : response.effectiveModel || req.modelOverride,
              });
            }
          }
          if (cacheEntries.length > 0) {
            void globalCacheManager.setBatch(cacheEntries);
          }
        }

        return { ok: true, data: response };
      }

      case 'wuf:convert-opencc': {
        const saved = await loadSavedSettings();
        const variant = message.request.variant ?? saved.openccVariant;
        const conversions = await translateWithOpenCC(
          message.request.texts,
          variant,
        );
        return { ok: true, data: { conversions, variant } };
      }

      case 'wuf:warmup-youtube': {
        const snapshot = await loadSettingsSnapshot();
        const sub = snapshot.runtimeSettings.subtitles;
        const tasks: Array<Promise<unknown>> = [];
        if (sub.engine === 'openai-compat-local') {
          tasks.push(
            ensureLocalLlamaServer(
              snapshot.subtitleProvider.baseUrl,
              snapshot.subtitleProvider.effectiveModel,
              { apiKey: snapshot.apiKeys.local },
            ),
          );
        }
        await Promise.all(tasks);
        return {
          ok: true,
          data: {
            warmedUp: true,
            engine: sub.engine,
            model: snapshot.subtitleProvider.effectiveModel,
          },
        };
      }

      case 'wuf:switch-local-model': {
        const snapshot = await loadSettingsSnapshot();
        const baseUrl =
          message.baseUrl ?? snapshot.runtimeSettings.providers.local.baseUrl;
        const res = await switchLocalModel(baseUrl, message.model);
        const probe = await probeWatchdogEndpoint(baseUrl);
        return { ok: true, data: { status: res, probe } };
      }

      case 'wuf:set-page-translated': {
        const tabId = message.tabId ?? sender?.tab?.id;
        if (tabId != null && globalThis.chrome?.action?.setBadgeText) {
          await globalThis.chrome.action.setBadgeText({
            tabId,
            text: message.translated ? 'TR' : '',
          });
          if (message.translated) {
            await globalThis.chrome.action.setBadgeBackgroundColor({
              tabId,
              color: '#007AFF',
            });
          }
          await refreshPageContextMenu();
        }
        return { ok: true, data: { success: true } };
      }

      case 'wuf:get-cache-stats': {
        const local = (await globalThis.chrome?.storage?.local?.get(null)) || {};
        let count = 0;
        let bytes = 0;
        for (const [k, v] of Object.entries(local)) {
          if (k.startsWith('wuf:cache:') || k.startsWith('tr:') || k.startsWith(WUPAGE_CACHE_PREFIX)) {
            count++;
            bytes += JSON.stringify(v).length;
          }
        }
        const memStats = globalCacheManager.getStats();
        return {
          ok: true,
          data: {
            count: count + memStats.memorySize,
            bytes,
            hits: memStats.hits,
            misses: memStats.misses,
          },
        };
      }

      case 'wuf:clear-cache': {
        await globalCacheManager.clear();
        const local = (await globalThis.chrome?.storage?.local?.get(null)) || {};
        const keysToRemove = Object.keys(local).filter(
          k => k.startsWith('wuf:cache:') || k.startsWith('tr:') || k.startsWith(WUPAGE_CACHE_PREFIX),
        );
        if (keysToRemove.length > 0 && globalThis.chrome?.storage?.local?.remove) {
          await globalThis.chrome.storage.local.remove(keysToRemove);
        }
        return { ok: true, data: { cleared: keysToRemove.length } };
      }

      case 'wuf:sticky-query': {
        const saved = await loadSavedSettings();
        if (saved.webpage.crossTabSticky !== true) {
          return { ok: true, data: { shouldTranslate: false } };
        }
        await hydrateStickyTabs();
        const tabId = sender?.tab?.id;
        const openerTabId = sender?.tab?.openerTabId;
        if (
          tabId != null &&
          !stickyTabs.has(tabId) &&
          openerTabId != null &&
          stickyTabs.has(openerTabId)
        ) {
          stickyTabs.add(tabId);
          await persistStickyTabs();
        }
        const shouldTranslate = tabId != null ? stickyTabs.has(tabId) : false;
        return { ok: true, data: { shouldTranslate } };
      }

      case 'wuf:sticky-set': {
        await hydrateStickyTabs();
        const tabId = message.tabId ?? sender?.tab?.id;
        if (tabId != null) {
          stickyTabs.add(tabId);
          await persistStickyTabs();
        }
        return { ok: true, data: { success: true } };
      }

      case 'wuf:sticky-clear': {
        await hydrateStickyTabs();
        const tabId = message.tabId ?? sender?.tab?.id;
        if (tabId != null) {
          stickyTabs.delete(tabId);
          await persistStickyTabs();
        }
        return { ok: true, data: { success: true } };
      }

      default: {
        return {
          ok: false,
          error: {
            code: 'UNKNOWN_MESSAGE_TYPE',
            message: `Unknown message type: ${String((message as { type?: unknown }).type)}`,
          },
        };
      }
    }
  } catch (err) {
    if (err instanceof WuPageCoreProviderError) {
      return { ok: false, error: { code: err.errorCode, message: err.message, retryAfterMs: err.retryAfterMs } };
    }
    if (err instanceof WufProviderError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          status: err.status,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function registerBackgroundListeners(): void {
  const onMessage = globalThis.chrome?.runtime?.onMessage;
  if (!onMessage?.addListener) return;
  onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (
      !message ||
      typeof message !== 'object' ||
      typeof (message as { type?: unknown }).type !== 'string' ||
      !(message as { type: string }).type.startsWith('wuf:')
    ) {
      return false;
    }
    void handleRuntimeMessage(message as RuntimeRequestMessage, sender)
      .then(sendResponse)
      .catch(err => {
        sendResponse({
          ok: false,
          error: {
            code: 'UNHANDLED_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      });
    return true;
  });
}

export function registerWebNavigationListeners(): void {
  const propagateStickyTab = async (sourceTabId?: number, newTabId?: number) => {
    try {
      if (sourceTabId == null || newTabId == null) return;
      const saved = await loadSavedSettings();
      if (saved.webpage.crossTabSticky !== true) return;
      await hydrateStickyTabs();
      if (stickyTabs.has(sourceTabId)) {
        stickyTabs.add(newTabId);
        await persistStickyTabs();
      }
    } catch {
      // ignore
    }
  };

  const onCreatedNavTarget = globalThis.chrome?.webNavigation?.onCreatedNavigationTarget;
  if (onCreatedNavTarget?.addListener) {
    onCreatedNavTarget.addListener((details) => {
      void propagateStickyTab(details.sourceTabId, details.tabId);
    });
  }

  const onTabCreated = globalThis.chrome?.tabs?.onCreated;
  if (onTabCreated?.addListener) {
    onTabCreated.addListener((tab) => {
      void propagateStickyTab(tab?.openerTabId, tab?.id);
    });
  }

  const onTabRemoved = globalThis.chrome?.tabs?.onRemoved;
  if (onTabRemoved?.addListener) {
    onTabRemoved.addListener(async (tabId) => {
      try {
        await hydrateStickyTabs();
        if (stickyTabs.has(tabId)) {
          stickyTabs.delete(tabId);
          await persistStickyTabs();
        }
      } catch {
        // ignore
      }
    });
  }
}

export function registerCommandListeners(): void {
  const onCommand = globalThis.chrome?.commands?.onCommand;
  if (!onCommand?.addListener) return;
  onCommand.addListener(async (command: string) => {
    if (command === 'toggle-translate') {
      const tabs = await globalThis.chrome?.tabs?.query({
        active: true,
        currentWindow: true,
      });
      const tabId = tabs?.[0]?.id;
      if (tabId != null) {
        const badge = await globalThis.chrome.action.getBadgeText({ tabId });
        const restore = Boolean(badge);
        await globalThis.chrome.tabs.sendMessage(
          tabId,
          restore
            ? { type: 'wuf:restore-page' }
            : {
                type: 'wuf:translate-page',
                payload: { force: true, translateOnly: true },
              },
          { frameId: 0 },
        );
      }
    }
  });
}

registerBackgroundListeners();
registerWebNavigationListeners();
registerPageContextMenus();
registerCommandListeners();
