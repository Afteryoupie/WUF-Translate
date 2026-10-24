import type {
  DisplayMode,
  OpenCCVariant,
  ProviderProfileType,
  RoutingSort,
  SettingsSnapshotPayload,
  SubtitleDecisionMode,
  ThemeMode,
  ThinkingLevel,
  TranslationEngineId,
  UiLocale,
  WufSettings,
} from '../types.ts';
import { applyI18nToDom, resolveUiLocale, t, type WufI18nKey } from '../i18n/index.ts';
import { fetchLocalModelsCatalog } from '../lib/watchdog-client.ts';
import { bindLocalModelPicker, type PickerControlLike } from '../lib/local-model-picker.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import { applyThemeMode } from '../ui/theme-init.ts';

export const OPTIONS_TABS = [
  'general',
  'webpage',
  'youtube',
  'local',
  'online',
  'data',
] as const;
export type OptionsTabId = (typeof OPTIONS_TABS)[number];
export const WUF_OPTIONS_TAB_STORAGE_KEY = 'wuf-options-active-tab';

function getInput(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function getSelect(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

function getTextArea(id: string): HTMLTextAreaElement {
  return document.getElementById(id) as HTMLTextAreaElement;
}

function parseOptionalFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function parseIntOrFallback(raw: string, fallback: number): number {
  const num = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(num) ? num : fallback;
}

export function isValidOptionsTab(value: unknown): value is OptionsTabId {
  return typeof value === 'string' && (OPTIONS_TABS as readonly string[]).includes(value);
}

export function resolveInitialOptionsTab(): OptionsTabId {
  const hash = globalThis.location?.hash?.replace(/^#/, '').trim();
  if (isValidOptionsTab(hash)) {
    return hash;
  }
  try {
    const saved = globalThis.localStorage?.getItem(WUF_OPTIONS_TAB_STORAGE_KEY);
    if (isValidOptionsTab(saved)) {
      return saved;
    }
  } catch {
    // Ignore localStorage access errors
  }
  return 'general';
}

export function bindOptionsTabs(
  root: ParentNode,
  initialTab: OptionsTabId = resolveInitialOptionsTab(),
): {
  switchTab: (tabId: OptionsTabId, focusTab?: boolean) => void;
  getActiveTab: () => OptionsTabId;
} {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"][data-wuf-tab]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[role="tabpanel"][data-wuf-panel]'));
  let activeTab: OptionsTabId = isValidOptionsTab(initialTab) ? initialTab : 'general';

  const switchTab = (tabId: OptionsTabId, focusTab: boolean = false) => {
    if (!isValidOptionsTab(tabId)) return;
    activeTab = tabId;

    for (const btn of buttons) {
      const id = btn.getAttribute('data-wuf-tab');
      const selected = id === tabId;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) {
        btn.focus();
      }
    }

    for (const panel of panels) {
      const id = panel.getAttribute('data-wuf-panel');
      panel.hidden = id !== tabId;
    }

    try {
      globalThis.localStorage?.setItem(WUF_OPTIONS_TAB_STORAGE_KEY, tabId);
    } catch {
      // Ignore storage quota errors
    }
    if (globalThis.history?.replaceState) {
      try {
        globalThis.history.replaceState(null, '', `#${tabId}`);
      } catch {
        // Ignore history errors in restricted contexts
      }
    }
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-wuf-tab');
      if (isValidOptionsTab(target)) {
        switchTab(target, false);
      }
    });

    btn.addEventListener('keydown', (event: KeyboardEvent) => {
      const idx = buttons.indexOf(btn);
      if (idx === -1) return;
      let nextIdx: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIdx = (idx + 1) % buttons.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIdx = (idx - 1 + buttons.length) % buttons.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = buttons.length - 1;
      }
      if (nextIdx !== null) {
        event.preventDefault();
        const target = buttons[nextIdx]?.getAttribute('data-wuf-tab');
        if (isValidOptionsTab(target)) {
          switchTab(target, true);
        }
      }
    });
  }

  switchTab(activeTab, false);

  return {
    switchTab,
    getActiveTab: () => activeTab,
  };
}

export async function initOptionsPage(): Promise<void> {
  const root = document.getElementById('wuf-options-root');
  if (!root) return;

  bindOptionsTabs(root);

  let currentLocale: UiLocale = 'zh-TW';
  let currentSnapshot: SettingsSnapshotPayload | null = null;
  let isHydrating = false;

  const localeEl = getSelect('wuf-opt-locale');
  const themeEl = getSelect('wuf-opt-theme');
  const activeProviderEl = getSelect('wuf-opt-active-provider');

  // Online profile controls
  const onlineBaseUrl = getInput('wuf-online-base-url');
  const onlineApiKey = getInput('wuf-online-api-key');
  const onlineModel = getInput('wuf-online-model');
  const onlineTemp = getInput('wuf-online-temperature');
  const onlineTimeout = getInput('wuf-online-timeout');
  const onlineThinking = getSelect('wuf-online-thinking');
  const onlineRoutingSort = getSelect('wuf-online-routing-sort');
  const onlineAllowFallbacks = getInput('wuf-online-allow-fallbacks');
  const onlineStrongMarker = getInput('wuf-online-strong-marker');
  const onlineConcurrency = getInput('wuf-online-concurrency');
  const onlineBatchUnits = getInput('wuf-online-batch-units');
  const onlineBatchChars = getInput('wuf-online-batch-chars');
  const onlineSystemPrompt = getTextArea('wuf-online-system-prompt');
  const onlineExtraBody = getTextArea('wuf-online-extra-body');

  // Local profile controls
  const localBaseUrl = getInput('wuf-local-base-url');
  const localApiKey = getInput('wuf-local-api-key');
  const localModelSelect = getSelect('wuf-local-model-select');
  const localModelInput = getInput('wuf-local-model-input');
  const localModelRefresh = document.getElementById('wuf-local-model-refresh') as HTMLButtonElement;
  const localModelClear = document.getElementById('wuf-local-model-clear') as HTMLButtonElement;
  const localModelStatus = document.getElementById('wuf-local-model-status') as HTMLElement;
  const windowsFallbackNote = document.getElementById('wuf-options-windows-fallback') as HTMLElement;
  const localTemp = getInput('wuf-local-temperature');
  const localTimeout = getInput('wuf-local-timeout');
  const localThinking = getSelect('wuf-local-thinking');
  const localStrongMarker = getInput('wuf-local-strong-marker');
  const localConcurrency = getInput('wuf-local-concurrency');
  const localBatchUnits = getInput('wuf-local-batch-units');
  const localBatchChars = getInput('wuf-local-batch-chars');
  const localSystemPrompt = getTextArea('wuf-local-system-prompt');
  const localExtraBody = getTextArea('wuf-local-extra-body');

  // Webpage & Subtitle preset controls
  const webpageEngine = getSelect('wuf-webpage-engine');
  const webpageTargetLang = getInput('wuf-webpage-target-lang');
  const webpageDisplayMode = getSelect('wuf-webpage-display-mode');
  const webpageModelOverride = getInput('wuf-webpage-model-override');
  const webpageCrossTabSticky = getInput('wuf-webpage-cross-tab-sticky');

  const subtitleEngine = getSelect('wuf-subtitle-engine');
  const subtitleTargetLang = getInput('wuf-subtitle-target-lang');
  const subtitleModelOverride = getInput('wuf-subtitle-model-override');
  const subtitleSystemPrompt = getTextArea('wuf-subtitle-system-prompt');
  const subtitleBatchWindow = getInput('wuf-subtitle-batch-window');
  const subtitlePrefetchLead = getInput('wuf-subtitle-prefetch-lead');
  const subtitleDecisionMode = getSelect('wuf-subtitle-decision-mode');
  const subtitleLayaEndpoint = getInput('wuf-subtitle-laya-endpoint');
  const subtitleDecisionCustomModel = getInput('wuf-subtitle-decision-custom-model');
  const subtitleDecisionCustomUrl = getInput('wuf-subtitle-decision-custom-url');
  const layaEndpointGroup = document.getElementById('wuf-laya-endpoint-group');
  const customDecisionGroup = document.getElementById('wuf-custom-decision-group');

  const openccEnabledEl = getInput('wuf-opt-opencc-enabled');
  const openccVariantEl = getSelect('wuf-opt-opencc-variant');

  const syncDecisionModeVisibility = (mode: SubtitleDecisionMode) => {
    if (layaEndpointGroup) {
      layaEndpointGroup.style.opacity = mode === 'laya' ? '1' : '0.6';
    }
    if (customDecisionGroup) {
      customDecisionGroup.style.opacity = mode === 'custom' ? '1' : '0.85';
    }
  };

  subtitleDecisionCustomModel?.addEventListener('input', () => {
    if (
      !isHydrating &&
      subtitleDecisionCustomModel.value.trim() !== '' &&
      subtitleDecisionMode &&
      subtitleDecisionMode.value !== 'custom'
    ) {
      subtitleDecisionMode.value = 'custom';
    }
  });

  // Backup / Reset controls
  const exportBtn = document.getElementById('wuf-export-btn') as HTMLButtonElement;
  const importBtn = document.getElementById('wuf-import-btn') as HTMLButtonElement;
  const resetBtn = document.getElementById('wuf-reset-btn') as HTMLButtonElement;
  const jsonBox = getTextArea('wuf-json-transfer-box');
  const dataFeedback = document.getElementById('wuf-data-feedback') as HTMLElement;
  const saveStatusPill = document.getElementById('wuf-save-status') as HTMLElement;

  const updateLocalPicker = bindLocalModelPicker({
    baseUrl: localBaseUrl as unknown as PickerControlLike,
    input: localModelInput as unknown as PickerControlLike,
    select: localModelSelect as unknown as PickerControlLike,
    refresh: localModelRefresh as unknown as PickerControlLike,
    clear: localModelClear as unknown as PickerControlLike,
    status: localModelStatus as unknown as PickerControlLike,
    apiKey: localApiKey as unknown as PickerControlLike,
    t: (key: string) => t(currentLocale, key as WufI18nKey),
    getProviderType: () => 'local',
  });

  const bindOverridePicker = (
    engine: HTMLSelectElement,
    input: HTMLInputElement,
    select: HTMLSelectElement,
  ): (() => Promise<void>) => {
    let token = 0;
    const update = async (): Promise<void> => {
      const current = ++token;
      if (engine.value !== 'openai-compat-local') {
        input.hidden = false;
        select.hidden = true;
        return;
      }
      let models: string[] = [];
      try {
        models = await fetchLocalModelsCatalog(localBaseUrl.value.trim(), localApiKey.value.trim());
      } catch {
        // offline: keep saved value selectable
      }
      if (current !== token) return;
      const saved = input.value.trim();
      const names = ['', ...models];
      if (saved && !names.includes(saved)) names.push(saved);
      select.replaceChildren(
        ...names.map((n) => new Option(n || t(currentLocale, 'options.localModel.serverDefault' as WufI18nKey), n)),
      );
      select.value = saved;
      input.hidden = true;
      select.hidden = false;
    };
    select.addEventListener('change', () => {
      input.value = select.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    engine.addEventListener('change', () => void update());
    localBaseUrl.addEventListener('change', () => void update());
    return update;
  };
  const updateWebpageOverride = bindOverridePicker(
    webpageEngine, webpageModelOverride, getSelect('wuf-webpage-model-override-select'));
  const updateSubtitleOverride = bindOverridePicker(
    subtitleEngine, subtitleModelOverride, getSelect('wuf-subtitle-model-override-select'));
  const hydrateControls = async (snapshot: SettingsSnapshotPayload) => {
    isHydrating = true;
    try {
      currentSnapshot = snapshot;
      const saved = snapshot.savedSettings;
      currentLocale = resolveUiLocale(saved.uiLocale);
      document.documentElement.lang = currentLocale;
      applyThemeMode(saved.theme);
      applyI18nToDom(document, currentLocale);

      localeEl.value = currentLocale;
      themeEl.value = saved.theme;
      activeProviderEl.value = saved.activeProviderType;

      const online = saved.providers.online;
      onlineBaseUrl.value = online.baseUrl;
      onlineApiKey.value = snapshot.apiKeys.online;
      onlineModel.value = online.model;
      onlineTemp.value = online.temperature === null ? '' : String(online.temperature);
      onlineTimeout.value = String(online.fetchTimeoutSec);
      onlineThinking.value = online.thinkingLevel;
      onlineRoutingSort.value = online.routingSort;
      onlineAllowFallbacks.checked = online.allowFallbacks;
      onlineStrongMarker.checked = online.useStrongSegMarker;
      onlineConcurrency.value = String(online.webConcurrency);
      onlineBatchUnits.value = String(online.webBatchUnits);
      onlineBatchChars.value = String(online.webBatchChars);
      onlineSystemPrompt.value = online.systemPrompt;
      onlineExtraBody.value = online.extraBodyJson;

      const local = saved.providers.local;
      localBaseUrl.value = local.baseUrl;
      localApiKey.value = snapshot.apiKeys.local;
      localModelInput.value = local.model;
      localTemp.value = local.temperature === null ? '' : String(local.temperature);
      localTimeout.value = String(local.fetchTimeoutSec);
      localThinking.value = local.thinkingLevel;
      localStrongMarker.checked = local.useStrongSegMarker;
      localConcurrency.value = String(local.webConcurrency);
      localBatchUnits.value = String(local.webBatchUnits);
      localBatchChars.value = String(local.webBatchChars);
      localSystemPrompt.value = local.systemPrompt;
      localExtraBody.value = local.extraBodyJson;

      const localFallback =
        saved.providers.local.model.trim() !== '' &&
        snapshot.runtimeSettings.providers.local.model === '';
      windowsFallbackNote.hidden = !localFallback;

      webpageEngine.value = saved.webpage.engine;
      webpageTargetLang.value = saved.webpage.targetLanguage;
      webpageDisplayMode.value = saved.webpage.displayMode;
      webpageModelOverride.value = saved.webpage.customModelOverride;
      if (webpageCrossTabSticky) {
        webpageCrossTabSticky.checked = saved.webpage.crossTabSticky === true;
      }

      subtitleEngine.value = saved.subtitles.engine;
      subtitleTargetLang.value = saved.subtitles.targetLanguage;
      subtitleModelOverride.value = saved.subtitles.customModelOverride;
      if (subtitleSystemPrompt) {
        subtitleSystemPrompt.value = saved.subtitles.systemPrompt;
      }
      if (subtitleBatchWindow) {
        subtitleBatchWindow.value = String(saved.subtitles.batchWindowSec);
      }
      if (subtitlePrefetchLead) {
        subtitlePrefetchLead.value = String(saved.subtitles.prefetchLeadSec);
      }
      if (subtitleDecisionMode) {
        subtitleDecisionMode.value = saved.subtitles.decisionMode;
      }
      if (subtitleLayaEndpoint) {
        subtitleLayaEndpoint.value = saved.subtitles.layaEndpointUrl;
      }
      if (subtitleDecisionCustomModel) {
        subtitleDecisionCustomModel.value = saved.subtitles.decisionCustomModel;
      }
      if (subtitleDecisionCustomUrl) {
        subtitleDecisionCustomUrl.value = saved.subtitles.decisionCustomBaseUrl;
      }
      syncDecisionModeVisibility(saved.subtitles.decisionMode);

      if (openccEnabledEl) {
        openccEnabledEl.checked = saved.openccEnabled;
      }
      openccVariantEl.value = saved.openccVariant;
    } finally {
      isHydrating = false;
    }
    await updateLocalPicker();
      await Promise.all([updateWebpageOverride(), updateSubtitleOverride()]);
  };

  const collectAndAutoSave = async () => {
    if (isHydrating || !currentSnapshot) return;
    const prev = currentSnapshot.savedSettings;
    const nextLocale = resolveUiLocale(localeEl.value);
    const nextTheme = (themeEl.value as ThemeMode) || 'system';
    applyThemeMode(nextTheme);

    const nextSettings: Partial<WufSettings> = {
      uiLocale: nextLocale,
      theme: nextTheme,
      activeProviderType: (activeProviderEl.value as ProviderProfileType) || 'local',
      providers: {
        online: {
          ...prev.providers.online,
          baseUrl: onlineBaseUrl.value.trim(),
          model: onlineModel.value.trim(),
          temperature: parseOptionalFloat(onlineTemp.value),
          fetchTimeoutSec: parseIntOrFallback(
            onlineTimeout.value,
            prev.providers.online.fetchTimeoutSec,
          ),
          thinkingLevel: onlineThinking.value as ThinkingLevel,
          routingSort: onlineRoutingSort.value as RoutingSort,
          allowFallbacks: onlineAllowFallbacks.checked,
          useStrongSegMarker: onlineStrongMarker.checked,
          webConcurrency: parseIntOrFallback(
            onlineConcurrency.value,
            prev.providers.online.webConcurrency,
          ),
          webBatchUnits: parseIntOrFallback(
            onlineBatchUnits.value,
            prev.providers.online.webBatchUnits,
          ),
          webBatchChars: parseIntOrFallback(
            onlineBatchChars.value,
            prev.providers.online.webBatchChars,
          ),
          systemPrompt: onlineSystemPrompt.value,
          extraBodyJson: onlineExtraBody.value.trim(),
        },
        local: {
          ...prev.providers.local,
          baseUrl: localBaseUrl.value.trim(),
          model: localModelInput.value.trim(),
          temperature: parseOptionalFloat(localTemp.value),
          fetchTimeoutSec: parseIntOrFallback(
            localTimeout.value,
            prev.providers.local.fetchTimeoutSec,
          ),
          thinkingLevel: localThinking.value as ThinkingLevel,
          useStrongSegMarker: localStrongMarker.checked,
          webConcurrency: parseIntOrFallback(
            localConcurrency.value,
            prev.providers.local.webConcurrency,
          ),
          webBatchUnits: parseIntOrFallback(
            localBatchUnits.value,
            prev.providers.local.webBatchUnits,
          ),
          webBatchChars: parseIntOrFallback(
            localBatchChars.value,
            prev.providers.local.webBatchChars,
          ),
          systemPrompt: localSystemPrompt.value,
          extraBodyJson: localExtraBody.value.trim(),
        },
      },
      webpage: {
        ...prev.webpage,
        engine: webpageEngine.value as TranslationEngineId,
        targetLanguage: webpageTargetLang.value.trim() || 'zh-TW',
        displayMode: webpageDisplayMode.value as DisplayMode,
        customModelOverride: webpageModelOverride.value.trim(),
        crossTabSticky: webpageCrossTabSticky ? webpageCrossTabSticky.checked : false,
      },
      subtitles: {
        ...prev.subtitles,
        engine: subtitleEngine.value as TranslationEngineId,
        targetLanguage: subtitleTargetLang.value.trim() || 'zh-TW',
        customModelOverride: subtitleModelOverride.value.trim(),
        systemPrompt:
          subtitleSystemPrompt !== null
            ? subtitleSystemPrompt.value
            : prev.subtitles.systemPrompt,
        batchWindowSec: subtitleBatchWindow
          ? parseIntOrFallback(
              subtitleBatchWindow.value,
              prev.subtitles.batchWindowSec,
            )
          : prev.subtitles.batchWindowSec,
        prefetchLeadSec: subtitlePrefetchLead
          ? parseIntOrFallback(
              subtitlePrefetchLead.value,
              prev.subtitles.prefetchLeadSec,
            )
          : prev.subtitles.prefetchLeadSec,
        decisionMode:
          (subtitleDecisionMode?.value as SubtitleDecisionMode) ||
          prev.subtitles.decisionMode,
        layaDecisionEnabled:
          ((subtitleDecisionMode?.value as SubtitleDecisionMode) ||
            prev.subtitles.decisionMode) === 'laya',
        layaEndpointUrl:
          subtitleLayaEndpoint?.value?.trim() || prev.subtitles.layaEndpointUrl,
        decisionCustomModel:
          subtitleDecisionCustomModel?.value?.trim() ??
          prev.subtitles.decisionCustomModel,
        decisionCustomBaseUrl:
          subtitleDecisionCustomUrl?.value?.trim() ??
          prev.subtitles.decisionCustomBaseUrl,
      },
      openccEnabled: openccEnabledEl ? openccEnabledEl.checked : prev.openccEnabled,
      openccVariant: openccVariantEl.value as OpenCCVariant,
    };

    if ( nextSettings.subtitles?.decisionMode ) {
      syncDecisionModeVisibility(nextSettings.subtitles.decisionMode);
    }

    const resp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
      type: 'wuf:save-settings',
      settings: nextSettings,
      apiKeys: {
        online: onlineApiKey.value.trim(),
        local: localApiKey.value.trim(),
      },
    });

    if (resp.ok) {
      currentSnapshot = resp.data;
      if (nextLocale !== currentLocale) {
        currentLocale = nextLocale;
        document.documentElement.lang = currentLocale;
        applyI18nToDom(document, currentLocale);
      }
      const localFallback =
        resp.data.savedSettings.providers.local.model.trim() !== '' &&
        resp.data.runtimeSettings.providers.local.model === '';
      windowsFallbackNote.hidden = !localFallback;
      saveStatusPill.textContent = t(currentLocale, 'common.savedAuto');
    }
  };

  const formControls = root.querySelectorAll<HTMLElement>(
    'input:not(#wuf-json-transfer-box), select, textarea:not(#wuf-json-transfer-box)',
  );
  for (const el of formControls) {
    el.addEventListener('change', () => {
      void collectAndAutoSave();
    });
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.addEventListener('input', () => {
        void collectAndAutoSave();
      });
    }
  }

  exportBtn.addEventListener('click', async () => {
    const resp = await sendWufRuntimeMessage<WufSettings>({
      type: 'wuf:export-settings',
    });
    if (resp.ok) {
      jsonBox.value = JSON.stringify(resp.data, null, 2);
      dataFeedback.textContent = '';
    }
  });

  importBtn.addEventListener('click', async () => {
    try {
      const parsed: unknown = JSON.parse(jsonBox.value);
      const resp = await sendWufRuntimeMessage<{
        snapshot: SettingsSnapshotPayload;
        warnings: string[];
      }>({
        type: 'wuf:import-settings',
        raw: parsed,
      });
      if (resp.ok) {
        await hydrateControls(resp.data.snapshot);
        dataFeedback.textContent =
          resp.data.warnings.length > 0
            ? resp.data.warnings.join('; ')
            : t(currentLocale, 'common.savedAuto');
      }
    } catch (err) {
      dataFeedback.textContent =
        err instanceof Error ? err.message : 'Invalid JSON';
    }
  });

  resetBtn.addEventListener('click', async () => {
    const resp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
      type: 'wuf:clear-settings',
    });
    if (resp.ok) {
      await hydrateControls(resp.data);
      jsonBox.value = '';
      dataFeedback.textContent = t(currentLocale, 'common.resetConfirm');
    }
  });

  // Model test buttons
  const localTestBtn = document.getElementById('wuf-local-model-test') as HTMLButtonElement | null;
  const localTestResult = document.getElementById('wuf-local-test-result');
  const onlineTestBtn = document.getElementById('wuf-online-model-test') as HTMLButtonElement | null;
  const onlineTestResult = document.getElementById('wuf-online-test-result');

  const runModelTest = async (
    engine: 'openai-compat-local' | 'openai-compat-online',
    btn: HTMLButtonElement,
    resultEl: HTMLElement,
    modelOverride: string,
  ) => {
    btn.disabled = true;
    resultEl.hidden = false;
    resultEl.className = 'wuf-test-result testing';
    resultEl.textContent = t(currentLocale, 'options.testingModel');
    const t0 = performance.now();
    try {
      await collectAndAutoSave();
      const resp = await sendWufRuntimeMessage<{ translations: string[] }>({
        type: 'wuf:translate-text',
        request: {
          texts: ['Hello world'],
          targetLanguage: 'zh-TW',
          engine,
          purpose: 'webpage',
          modelOverride: modelOverride || undefined,
        },
      });
      const elapsed = Math.round(performance.now() - t0);
      if (resp.ok && resp.data?.translations?.[0]) {
        resultEl.className = 'wuf-test-result success';
        resultEl.textContent = `✅ ${t(currentLocale, 'options.testSuccess')} (${elapsed}ms): ${resp.data.translations[0]}`;
      } else {
        const errMsg = resp.ok ? 'Empty response' : resp.error?.message || 'Error';
        resultEl.className = 'wuf-test-result error';
        resultEl.textContent = `❌ ${t(currentLocale, 'options.testFailed')}: ${errMsg}`;
      }
    } catch (err) {
      resultEl.className = 'wuf-test-result error';
      resultEl.textContent = `❌ ${t(currentLocale, 'options.testFailed')}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      btn.disabled = false;
    }
  };

  if (localTestBtn && localTestResult) {
    localTestBtn.addEventListener('click', () => {
      void runModelTest(
        'openai-compat-local',
        localTestBtn,
        localTestResult,
        localModelInput.value.trim(),
      );
    });
  }

  if (onlineTestBtn && onlineTestResult) {
    onlineTestBtn.addEventListener('click', () => {
      void runModelTest(
        'openai-compat-online',
        onlineTestBtn,
        onlineTestResult,
        onlineModel.value.trim(),
      );
    });
  }

  const initialResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
    type: 'wuf:get-settings',
  });
  if (initialResp.ok) {
    await hydrateControls(initialResp.data);
  }
}

if (typeof document !== 'undefined') {
  void initOptionsPage();
}
