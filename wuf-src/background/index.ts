import type {
  RuntimeRequestMessage,
  RuntimeResponseMessage,
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
  ensureLocalLayaDecision,
  ensureLocalLlamaServer,
  fetchLocalModelsCatalog,
  probeWatchdogEndpoint,
  switchLocalModel,
} from '../lib/watchdog-client.ts';
import { registerPageContextMenus } from '../lib/page-context-menu.ts';
import { globalCacheManager } from '../lib/cache-manager.ts';
import { WufProviderError } from '../providers/errors.ts';
import { executeTranslation } from '../providers/index.ts';
import { translateWithOpenCC } from '../providers/opencc.ts';
import { LayaDecisionEngine } from '../subtitle/decision-engine.ts';

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
        const models = await fetchLocalModelsCatalog(baseUrl, apiKey);
        return { ok: true, data: { models } };
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
        await ensureLocalLlamaServer(baseUrl, model);
        const probe = await probeWatchdogEndpoint(baseUrl);
        return { ok: true, data: probe };
      }

      case 'wuf:translate-text': {
        const [saved, secrets] = await Promise.all([
          loadSavedSettings(),
          loadLocalSecrets(),
        ]);

        const req = message.request;
        // Fast-path single text cache lookup
        if (req.texts.length === 1 && req.texts[0].trim()) {
          const cached = await globalCacheManager.get({
            text: req.texts[0],
            sourceLang: 'auto',
            targetLang: req.targetLanguage,
            engine: req.engine,
            model: req.modelOverride,
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
        );

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
                model: response.effectiveModel || req.modelOverride,
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
            ),
          );
        }
        if (sub.decisionMode === 'laya' && sub.layaDecisionEnabled) {
          tasks.push(ensureLocalLayaDecision(sub.layaEndpointUrl));
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

      case 'wuf:evaluate-subtitle-boundaries': {
        const [saved, secrets] = await Promise.all([
          loadSavedSettings(),
          loadLocalSecrets(),
        ]);
        const sub = saved.subtitles;
        const engine = new LayaDecisionEngine({
          enabled: sub.decisionMode !== 'off',
          mode: sub.decisionMode,
          apiUrl: sub.layaEndpointUrl,
          apiKey:
            secrets.providerApiKeys.local || secrets.providerApiKeys.online || '',
          customModel: sub.decisionCustomModel,
          customBaseUrl:
            sub.decisionCustomBaseUrl || saved.providers.local.baseUrl,
        });
        const result = await engine.evaluateBoundaries(message.segments);
        return { ok: true, data: result };
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
        if (message.tabId != null && globalThis.chrome?.action?.setBadgeText) {
          await globalThis.chrome.action.setBadgeText({
            tabId: message.tabId,
            text: message.translated ? 'TR' : '',
          });
          if (message.translated) {
            await globalThis.chrome.action.setBadgeBackgroundColor({
              tabId: message.tabId,
              color: '#007AFF',
            });
          }
        }
        return { ok: true, data: { success: true } };
      }

      case 'wuf:get-cache-stats': {
        const local = (await globalThis.chrome?.storage?.local?.get(null)) || {};
        let count = 0;
        let bytes = 0;
        for (const [k, v] of Object.entries(local)) {
          if (k.startsWith('wuf:cache:') || k.startsWith('tr:')) {
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
          k => k.startsWith('wuf:cache:') || k.startsWith('tr:'),
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
  const onCreatedNavTarget = globalThis.chrome?.webNavigation?.onCreatedNavigationTarget;
  if (onCreatedNavTarget?.addListener) {
    onCreatedNavTarget.addListener(async (details) => {
      try {
        const saved = await loadSavedSettings();
        if (saved.webpage.crossTabSticky !== true) return;
        await hydrateStickyTabs();
        const sourceTabId = details.sourceTabId;
        const newTabId = details.tabId;
        if (sourceTabId == null || newTabId == null) return;
        if (stickyTabs.has(sourceTabId)) {
          stickyTabs.add(newTabId);
          await persistStickyTabs();
        }
      } catch {
        // ignore
      }
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
