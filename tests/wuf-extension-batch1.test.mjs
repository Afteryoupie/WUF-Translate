import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  applyRuntimePlatformAdaptations,
  applyTranslationToElement,
  bindLocalModelPicker,
  bindOptionsTabs,
  buildChatCompletionRequestBody,
  buildThinkingPayload,
  chooseBestCaptionTrack,
  clearAllSettings,
  collectTranslatableUnits,
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_SYSTEM_PROMPT,
  ensureLocalLayaDecision,
  ensureLocalLlamaServer,
  executeTranslation,
  exportSanitizedSettings,
  handleRuntimeMessage,
  heuristicMergeAsr,
  importSanitizedSettings,
  isLocalSubtitleProvider,
  isWatchdogLoopbackUrl,
  JevDecisionEngine,
  LayaDecisionEngine,
  loadSettingsSnapshot,
  localModelForPlatform,
  localSubtitlePrompt,
  OPTIONS_TABS,
  parseAsrLlmOutput,
  parseYouTubeTimedTextJson3,
  partitionWebpageBatches,
  planSubtitleWindowBatch,
  queueLocalSubtitle,
  refreshPageContextMenu,
  registerPageContextMenus,
  reserveFreeRequest,
  resetFreeRequestLimiter,
  resolveAsrEntryTimeline,
  resolvePerformanceConfig,
  resolvePresetProvider,
  restoreTranslatedDom,
  runAsrDecisionPipeline,
  runSubtitleDecisionPipeline,
  saveSettingsAndSecrets,
  splitLongSubtitleCue,
  stripSpeakerPrefix,
  SUBTITLE_DECISION_MODES,
  subtitleRepairPrompt,
  t,
  TRANSLATION_ENGINES,
  translateWithGoogle,
  translateWithOpenAICompat,
  translateWithOpenCC,
  UI_LOCALES,
  WUF_DICTIONARIES,
  WUF_NATIVE_HOST,
  WUF_OPTIONS_TAB_STORAGE_KEY,
  WUF_PAGE_CONTEXT_MENU_ID,
  WUF_TRANSLATION_KEYS,
  WufDomTranslator,
  WufProviderError,
} from '../dist/wuf/index.js';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(rootDir, 'wuf-src');
const distDir = resolve(rootDir, 'dist', 'wuf');

function createMockChromeStorage(initialSync = {}, initialLocal = {}) {
  const syncStore = structuredClone(initialSync);
  const localStore = structuredClone(initialLocal);

  const makeArea = store => ({
    data: store,
    get: async keys => {
      if (keys === null || keys === undefined) {
        return structuredClone(store);
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) {
        if (k in store) {
          out[k] = structuredClone(store[k]);
        }
      }
      return out;
    },
    set: async patch => {
      for (const [k, v] of Object.entries(patch)) {
        store[k] = structuredClone(v);
      }
    },
    remove: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        delete store[k];
      }
    },
    clear: async () => {
      for (const k of Object.keys(store)) {
        delete store[k];
      }
    },
  });

  return {
    syncArea: makeArea(syncStore),
    localArea: makeArea(localStore),
    install() {
      globalThis.chrome = {
        storage: {
          sync: this.syncArea,
          local: this.localArea,
        },
      };
    },
    uninstall() {
      delete globalThis.chrome;
    },
  };
}

function startTestHttpServer(handler) {
  return new Promise((resolveServer, rejectServer) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveServer({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () =>
        new Promise(res => {
          server.closeAllConnections?.();
          server.close(() => res());
        }),
      });
    });
    server.on('error', rejectServer);
  });
}

test('WUF manifest key matches identity.json and all packaged dist/wuf assets exist', () => {
  const identity = JSON.parse(readFileSync(resolve(srcDir, 'identity.json'), 'utf8'));
  const srcManifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'));
  const distManifest = JSON.parse(readFileSync(resolve(distDir, 'manifest.json'), 'utf8'));

  assert.equal(srcManifest.key, identity.key);
  assert.equal(distManifest.key, identity.key);
  assert.equal(WUF_NATIVE_HOST, identity.nativeHost);
  assert.equal(WUF_NATIVE_HOST, 'com.wuf_translate.watchdog');
  assert.ok(distManifest.permissions.includes('storage'));
  assert.ok(distManifest.permissions.includes('nativeMessaging'));
  assert.ok(distManifest.permissions.includes('contextMenus'));

  const expectedDistFiles = [
    'manifest.json',
    'background.js',
    'content-webpage.js',
    'content-youtube.js',
    'youtube-main-interceptor.js',
    'popup.html',
    'popup.css',
    'popup.js',
    'options.html',
    'options.css',
    'options.js',
    'theme-init.js',
    'index.js',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ];

  for (const relPath of expectedDistFiles) {
    assert.ok(
      existsSync(resolve(distDir, relPath)),
      `Expected packaged file dist/wuf/${relPath} to exist`,
    );
  }
});

test('Clean-room audit: wuf-src and dist/wuf contain no legacy shinkansen or forbidden references', () => {
  const forbiddenPatterns = [
    /jimmysu0309\.github\.io/i,
    /com\.llm_project\.llama_launcher/i,
    /instapaper/i,
    /chart\.min\.js/i,
  ];

  const scanDir = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (/\.(ts|js|html|css|json)$/.test(entry.name)) {
        const content = readFileSync(full, 'utf8');
        for (const pattern of forbiddenPatterns) {
          assert.ok(
            !pattern.test(content),
            `Forbidden pattern ${pattern} found in ${full}`,
          );
        }
      }
    }
  };

  scanDir(srcDir);
  scanDir(distDir);
});

test('8-language UI dictionary is complete and matches all HTML data-wuf-i18n attributes and _locales', () => {
  assert.deepEqual(
    [...UI_LOCALES],
    ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'],
  );

  for (const locale of UI_LOCALES) {
    const dict = WUF_DICTIONARIES[locale];
    assert.ok(dict, `Missing dictionary for ${locale}`);
    for (const key of WUF_TRANSLATION_KEYS) {
      assert.equal(typeof dict[key], 'string', `Missing key ${key} in ${locale}`);
      assert.ok(dict[key].trim().length > 0, `Empty translation for ${key} in ${locale}`);
      assert.equal(t(locale, key), dict[key]);
    }
  }

  for (const htmlFile of ['popup.html', 'options.html']) {
    const html = readFileSync(resolve(distDir, htmlFile), 'utf8');
    const matches = [...html.matchAll(/data-wuf-i18n="([^"]+)"/g)];
    assert.ok(matches.length > 0, `Expected data-wuf-i18n attributes in ${htmlFile}`);
    for (const [, key] of matches) {
      assert.ok(
        WUF_TRANSLATION_KEYS.includes(key),
        `HTML file ${htmlFile} references unknown i18n key "${key}"`,
      );
    }
  }

  const localeDirs = ['zh_TW', 'zh_CN', 'en', 'ja', 'ko', 'es', 'fr', 'de'];
  for (const dir of localeDirs) {
    const msgPath = resolve(distDir, '_locales', dir, 'messages.json');
    assert.ok(existsSync(msgPath), `Missing ${msgPath}`);
    const messages = JSON.parse(readFileSync(msgPath, 'utf8'));
    assert.ok(messages.extName?.message?.trim().length > 0);
    assert.ok(messages.extDescription?.message?.trim().length > 0);
    assert.ok(messages.contextTranslatePage?.message?.trim().length > 0);
    assert.ok(messages.contextShowOriginal?.message?.trim().length > 0);
  }
});

test('Pre-display theme bootstrap applies cached theme synchronously and guards first visit until storage resolves', async () => {
  const themeBootstrapCode = readFileSync(resolve(distDir, 'theme-init.js'), 'utf8');

  function runThemeBoot({ cached, saved, systemDark = true, storageFails = false }) {
    const attrs = new Map();
    const localStore = new Map(cached ? [['wuf-ui-theme', cached]] : []);
    let releaseStorage;
    const pendingStorage = new Promise(r => {
      releaseStorage = r;
    });

    const context = {
      window: {},
      document: {
        documentElement: {
          setAttribute: (k, v) => attrs.set(k, v),
          removeAttribute: k => attrs.delete(k),
        },
      },
      localStorage: {
        getItem: k => localStore.get(k) ?? null,
        setItem: (k, v) => localStore.set(k, v),
      },
      matchMedia: () => ({ matches: systemDark }),
      chrome: {
        storage: {
          sync: {
            get: async () => {
              await pendingStorage;
              if (storageFails) throw new Error('storage error');
              return { wufSettings: { theme: saved } };
            },
          },
        },
      },
    };
    context.globalThis = context;
    vm.runInNewContext(themeBootstrapCode, context);
    return {
      attrs,
      localStore,
      releaseStorage,
      ready: context.window.__wufThemeReady,
    };
  }

  // 1. Cached light theme on dark system applies synchronously without pending attribute
  const cachedLight = runThemeBoot({ cached: 'light', saved: 'light', systemDark: true });
  assert.equal(cachedLight.attrs.get('data-theme'), 'light');
  assert.equal(cachedLight.attrs.has('data-theme-pending'), false);
  cachedLight.releaseStorage();
  await cachedLight.ready;
  assert.equal(cachedLight.attrs.get('data-theme'), 'light');

  // 2. First visit sets data-theme-pending until storage resolves, then caches and reveals
  const firstVisit = runThemeBoot({ cached: null, saved: 'light', systemDark: true });
  assert.equal(firstVisit.attrs.has('data-theme-pending'), true);
  assert.equal(firstVisit.attrs.get('data-theme'), 'dark');
  firstVisit.releaseStorage();
  await firstVisit.ready;
  assert.equal(firstVisit.attrs.has('data-theme-pending'), false);
  assert.equal(firstVisit.attrs.get('data-theme'), 'light');
  assert.equal(firstVisit.localStore.get('wuf-ui-theme'), 'light');

  // 3. System mode follows OS preference and storage failure still removes data-theme-pending
  const failedBoot = runThemeBoot({
    cached: null,
    saved: null,
    systemDark: false,
    storageFails: true,
  });
  failedBoot.releaseStorage();
  await failedBoot.ready;
  assert.equal(failedBoot.attrs.has('data-theme-pending'), false);
  assert.equal(failedBoot.attrs.get('data-theme'), 'light');
});

test('Popup HTML enables core translation pipeline buttons (webpage, YouTube subtitle)', () => {
  const popupHtml = readFileSync(resolve(distDir, 'popup.html'), 'utf8');
  const buttons = [...popupHtml.matchAll(/<button[^>]*class="wuf-tool-btn"[^>]*>/g)];
  assert.equal(buttons.length, 2);
  for (const [btnTag] of buttons) {
    assert.doesNotMatch(btnTag, /\bdisabled\b/);
    assert.doesNotMatch(btnTag, /aria-disabled="true"/);
  }
  assert.match(popupHtml, /id="wuf-btn-translate-webpage"/);
  assert.match(popupHtml, /id="wuf-btn-translate-youtube"/);
});

test('Options HTML and controller implement a 6-tab layout separating Webpage and YT Video translation with click, keyboard navigation, and persistence', () => {
  const optionsHtml = readFileSync(resolve(distDir, 'options.html'), 'utf8');
  assert.deepEqual(
    [...OPTIONS_TABS],
    ['general', 'webpage', 'youtube', 'local', 'online', 'data'],
  );
  assert.deepEqual(
    [...TRANSLATION_ENGINES],
    ['openai-compat-online', 'openai-compat-local', 'google-translate'],
  );
  assert.deepEqual([...SUBTITLE_DECISION_MODES], ['laya', 'custom', 'off']);
  assert.doesNotMatch(optionsHtml, /<option\s+value="opencc"/);
  assert.match(optionsHtml, /id="wuf-subtitle-system-prompt"/);
  assert.match(optionsHtml, /id="wuf-subtitle-batch-window"/);
  assert.match(optionsHtml, /id="wuf-subtitle-prefetch-lead"/);
  assert.match(optionsHtml, /id="wuf-subtitle-decision-mode"/);
  assert.match(optionsHtml, /id="wuf-subtitle-decision-custom-model"/);
  assert.match(optionsHtml, /id="wuf-subtitle-decision-custom-url"/);

  for (const tabId of OPTIONS_TABS) {
    assert.match(optionsHtml, new RegExp(`data-wuf-tab="${tabId}"`));
    assert.match(optionsHtml, new RegExp(`data-wuf-panel="${tabId}"`));
  }

  class MockTabElement extends EventTarget {
    attrs = new Map();
    hidden = false;
    tabIndex = 0;
    focused = false;
    constructor(attrs) {
      super();
      for (const [k, v] of Object.entries(attrs)) {
        this.attrs.set(k, v);
      }
    }
    getAttribute(k) {
      return this.attrs.get(k) ?? null;
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    }
    focus() {
      this.focused = true;
    }
  }

  const buttons = OPTIONS_TABS.map(
    id => new MockTabElement({ role: 'tab', 'data-wuf-tab': id }),
  );
  const panels = OPTIONS_TABS.map(
    id => new MockTabElement({ role: 'tabpanel', 'data-wuf-panel': id }),
  );
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('[role="tab"]')) return buttons;
      if (selector.includes('[role="tabpanel"]')) return panels;
      return [];
    },
  };

  const savedStore = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: k => savedStore.get(k) ?? null,
    setItem: (k, v) => savedStore.set(k, v),
  };

  try {
    const controller = bindOptionsTabs(root, 'general');
    assert.equal(controller.getActiveTab(), 'general');
    assert.equal(buttons[0].getAttribute('aria-selected'), 'true');
    assert.equal(panels[0].hidden, false);
    for (let i = 1; i < panels.length; i++) {
      assert.equal(panels[i].hidden, true);
    }

    // Click 'webpage' tab (index 1)
    buttons[1].dispatchEvent(new Event('click'));
    assert.equal(controller.getActiveTab(), 'webpage');
    assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
    assert.equal(buttons[0].getAttribute('aria-selected'), 'false');
    assert.equal(panels[1].hidden, false);
    assert.equal(panels[0].hidden, true);
    assert.equal(savedStore.get(WUF_OPTIONS_TAB_STORAGE_KEY), 'webpage');

    // Keyboard ArrowRight advances from 'webpage' (index 1) to 'youtube' (index 2)
    const rightEvent = Object.assign(new Event('keydown'), { key: 'ArrowRight' });
    buttons[1].dispatchEvent(rightEvent);
    assert.equal(controller.getActiveTab(), 'youtube');
    assert.equal(panels[2].hidden, false);
    assert.equal(buttons[2].focused, true);

    // Click 'online' tab (index 4)
    buttons[4].dispatchEvent(new Event('click'));
    assert.equal(controller.getActiveTab(), 'online');
    assert.equal(panels[4].hidden, false);

    // Keyboard Home returns to 'general' (index 0)
    const homeEvent = Object.assign(new Event('keydown'), { key: 'Home' });
    buttons[4].dispatchEvent(homeEvent);
    assert.equal(controller.getActiveTab(), 'general');
    assert.equal(panels[0].hidden, false);
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('Online and local profiles, webpage and subtitle presets, and local-only API keys stay isolated', async () => {
  const mockStorage = createMockChromeStorage();
  mockStorage.install();
  try {
    await saveSettingsAndSecrets(
      {
        activeProviderType: 'online',
        providers: {
          online: {
            ...DEFAULT_SETTINGS.providers.online,
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'online-default-model',
            systemPrompt: 'Online prompt',
            temperature: 0.5,
          },
          local: {
            ...DEFAULT_SETTINGS.providers.local,
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local-default-model',
            systemPrompt: 'Local prompt',
            temperature: 0.1,
          },
        },
        webpage: {
          engine: 'openai-compat-online',
          targetLanguage: 'zh-TW',
          displayMode: 'bilingual',
          customModelOverride: 'webpage-override-model',
        },
        subtitles: {
          engine: 'openai-compat-local',
          targetLanguage: 'ja',
          customModelOverride: 'subtitle-override-model',
          systemPrompt: 'Custom YouTube Subtitle Prompt',
          batchWindowSec: 45,
          prefetchLeadSec: 12,
          decisionMode: 'custom',
          layaDecisionEnabled: false,
          layaEndpointUrl: 'http://127.0.0.1:8080/v1/systemone',
          decisionCustomModel: 'qwen2.5-3b-decision',
          decisionCustomBaseUrl: 'http://127.0.0.1:8080/v1',
        },
      },
      {
        online: 'secret-online-key-123',
        local: 'secret-local-key-456',
      },
    );

    assert.match(DEFAULT_SUBTITLE_SYSTEM_PROMPT, /Translate ALL speech to 台灣繁體中文/);
    assert.equal(DEFAULT_SETTINGS.subtitles.batchWindowSec, 30);
    assert.equal(DEFAULT_SETTINGS.subtitles.prefetchLeadSec, 10);

    // Verify sync storage NEVER contains API keys
    const rawSyncJson = JSON.stringify(mockStorage.syncArea.data);
    assert.ok(!rawSyncJson.includes('secret-online-key-123'));
    assert.ok(!rawSyncJson.includes('secret-local-key-456'));

    // Verify exported settings NEVER contain API keys
    const exported = await exportSanitizedSettings();
    const exportedJson = JSON.stringify(exported);
    assert.ok(!exportedJson.includes('secret-online-key-123'));
    assert.ok(!exportedJson.includes('secret-local-key-456'));

    // Verify independent preset resolution and custom decision model
    const snapshot = await loadSettingsSnapshot('MacIntel');
    assert.equal(snapshot.activeProvider.profileType, 'online');
    assert.equal(snapshot.activeProvider.effectiveModel, 'online-default-model');
    assert.equal(snapshot.activeProvider.apiKey, 'secret-online-key-123');

    assert.equal(snapshot.webpageProvider.profileType, 'online');
    assert.equal(snapshot.webpageProvider.effectiveModel, 'webpage-override-model');
    assert.equal(snapshot.webpageProvider.systemPrompt, 'Online prompt');
    assert.equal(snapshot.webpageProvider.apiKey, 'secret-online-key-123');

    assert.equal(snapshot.subtitleProvider.profileType, 'local');
    assert.equal(snapshot.subtitleProvider.effectiveModel, 'subtitle-override-model');
    assert.equal(snapshot.subtitleProvider.systemPrompt, 'Custom YouTube Subtitle Prompt');
    assert.equal(snapshot.subtitleProvider.apiKey, 'secret-local-key-456');
    assert.equal(snapshot.savedSettings.subtitles.batchWindowSec, 45);
    assert.equal(snapshot.savedSettings.subtitles.prefetchLeadSec, 12);
    assert.equal(snapshot.savedSettings.subtitles.decisionMode, 'custom');
    assert.equal(snapshot.savedSettings.subtitles.layaDecisionEnabled, false);
    assert.equal(
      snapshot.savedSettings.subtitles.decisionCustomModel,
      'qwen2.5-3b-decision',
    );
    assert.equal(
      snapshot.savedSettings.subtitles.decisionCustomBaseUrl,
      'http://127.0.0.1:8080/v1',
    );

    // Verify import strips any embedded credentials and rejects 'opencc' as a translation engine
    const { snapshot: importedSnap, warnings } = await importSanitizedSettings({
      activeProviderType: 'local',
      webpage: {
        engine: 'opencc',
      },
      providers: {
        online: {
          baseUrl: 'https://api.example.com/v1',
          model: 'imported-online',
          apiKey: 'leaked-key-attempt',
          temperature: 99,
        },
        local: {
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'imported-local',
          apiKey: 'leaked-local-attempt',
        },
      },
      providerApiKeys: { online: 'leaked-key-attempt' },
    });
    assert.ok(warnings.length >= 1);
    assert.ok(!JSON.stringify(mockStorage.syncArea.data).includes('leaked'));
    assert.equal(importedSnap.savedSettings.providers.online.model, 'imported-online');
    assert.equal(importedSnap.savedSettings.providers.local.model, 'imported-local');

    // Verify clearAllSettings resets both sync settings and local keys
    const cleared = await clearAllSettings();
    assert.equal(cleared.apiKeys.online, '');
    assert.equal(cleared.apiKeys.local, '');
    assert.equal(cleared.savedSettings.providers.online.model, '');
    assert.equal(cleared.savedSettings.providers.local.model, '');
  } finally {
    mockStorage.uninstall();
  }
});

test('Windows runtime fallback clears Apple/Foundation loopback models at runtime without modifying saved settings or LAN/cloud choices', async () => {
  const mockStorage = createMockChromeStorage();
  mockStorage.install();
  const appleModel = 'apple-intelligence-translation';
  try {
    await saveSettingsAndSecrets({
      activeProviderType: 'local',
      providers: {
        online: {
          ...DEFAULT_SETTINGS.providers.online,
          baseUrl: 'https://mac.example.com/v1',
          model: appleModel,
        },
        local: {
          ...DEFAULT_SETTINGS.providers.local,
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: appleModel,
        },
      },
      webpage: {
        engine: 'openai-compat-local',
        targetLanguage: 'zh-TW',
        displayMode: 'bilingual',
        customModelOverride: appleModel,
      },
      subtitles: {
        engine: 'openai-compat-local',
        targetLanguage: 'zh-TW',
        customModelOverride: 'foundation-models-v1',
        layaDecisionEnabled: true,
        layaEndpointUrl: 'http://127.0.0.1:8080/v1/systemone',
      },
    });

    const winSnapshot = await loadSettingsSnapshot('Win32');
    assert.equal(winSnapshot.runtimeSettings.providers.local.model, '');
    assert.equal(winSnapshot.runtimeSettings.webpage.customModelOverride, '');
    assert.equal(winSnapshot.runtimeSettings.subtitles.customModelOverride, '');
    assert.equal(winSnapshot.activeProvider.effectiveModel, '');
    assert.equal(winSnapshot.activeProvider.runtimeFallbackApplied, true);

    // Online profile and saved sync settings remain intact!
    assert.equal(winSnapshot.runtimeSettings.providers.online.model, appleModel);
    assert.equal(winSnapshot.savedSettings.providers.local.model, appleModel);
    assert.equal(
      mockStorage.syncArea.data.wufSettings.providers.local.model,
      appleModel,
    );

    // LAN and cloud URLs on Windows do NOT get cleared
    assert.equal(
      localModelForPlatform(appleModel, 'http://192.168.1.50:8080/v1', 'Win32'),
      appleModel,
    );
    assert.equal(
      localModelForPlatform(appleModel, 'https://localhost.example.com/v1', 'Win32'),
      appleModel,
    );
    // macOS loopback retains the Apple model
    assert.equal(
      localModelForPlatform(appleModel, 'http://127.0.0.1:8080/v1', 'MacIntel'),
      appleModel,
    );

    // Request body omits model when effective model is empty
    const { body } = buildChatCompletionRequestBody({
      provider: winSnapshot.activeProvider,
      texts: ['Hello world'],
      targetLanguage: 'zh-TW',
      platform: 'Win32',
    });
    assert.equal('model' in body, false);
  } finally {
    mockStorage.uninstall();
  }
});

test('Local /v1/models picker discovers models over real HTTP, hides path/default aliases, preserves saved model on error, and clears to server default', async () => {
  const requests = [];
  const server = await startTestHttpServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'Qwen-Translate', owned_by: 'local-llm' },
            { id: 'Qwen-Translate', owned_by: 'local-llm' },
            { id: 'C:\\models\\Qwen-Translate.gguf', owned_by: 'local-llm' },
            { id: '/fixture/models/translation.gguf', owned_by: 'local-llm' },
            { id: 'default', owned_by: 'local-llm' },
            { id: 'org/Riva-Translate', owned_by: 'local-llm' },
          ],
        }),
      );
      return;
    }
    res.writeHead(500);
    res.end();
  });

  try {
    class MockControl extends EventTarget {
      value = '';
      hidden = false;
      disabled = false;
      textContent = '';
      options = [];
      replaceChildren(...opts) {
        this.options = opts;
      }
    }

    const baseUrl = new MockControl();
    const input = new MockControl();
    const select = new MockControl();
    const refresh = new MockControl();
    const clear = new MockControl();
    const status = new MockControl();
    const apiKey = new MockControl();

    baseUrl.value = `${server.url}/v1`;
    input.value = 'custom-saved-model';
    apiKey.value = 'lan-token';

    let activeType = 'local';
    const update = bindLocalModelPicker({
      baseUrl,
      input,
      select,
      refresh,
      clear,
      status,
      apiKey,
      t: k => k,
      getProviderType: () => activeType,
    });

    await update();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].auth, 'Bearer lan-token');
    assert.equal(input.hidden, true);
    assert.equal(select.hidden, false);
    assert.deepEqual(
      select.options.map(o => o.value),
      ['', 'Qwen-Translate', 'org/Riva-Translate', 'custom-saved-model'],
    );
    assert.equal(select.value, 'custom-saved-model');

    // Manual clear button resets to server default ('')
    let inputEvents = 0;
    input.addEventListener('input', () => {
      inputEvents++;
    });
    clear.dispatchEvent(new Event('click'));
    assert.equal(input.value, '');
    assert.equal(select.value, '');
    assert.equal(inputEvents, 1);

    // Offline failure preserves saved model
    input.value = 'keep-me-when-offline';
    baseUrl.value = 'http://127.0.0.1:1/v1';
    await update();
    assert.equal(input.value, 'keep-me-when-offline');
    assert.equal(select.value, 'keep-me-when-offline');
    assert.equal(status.textContent, 'options.localModel.offlineError');
  } finally {
    await server.close();
  }
});

test('Watchdog readiness checks /api/status and /api/wake JSON, deduplicates concurrent wakes, and never calls management APIs on non-Watchdog endpoints', async () => {
  const calls = [];
  let watchdogState = 'sleeping';
  let currentModelId = 'Qwen-Default';
  let wakeShouldFail = false;

  const server = await startTestHttpServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: watchdogState,
          current_model: currentModelId,
          current_model_id: currentModelId,
          models: [
            { id: 'Qwen-Default', name: 'Qwen Default', path: '/models/qwen.gguf' },
            { id: 'Riva-9B', name: 'Riva 9B', path: '/models/riva.gguf' },
          ],
        }),
      );
      return;
    }
    if (req.url === '/api/wake') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (wakeShouldFail) {
        res.end(JSON.stringify({ status: 'error', state: 'failed' }));
        return;
      }
      watchdogState = 'running';
      res.end(JSON.stringify({ status: 'ok', state: 'running' }));
      return;
    }
    if (req.url?.startsWith('/api/switch')) {
      const parsedUrl = new URL(req.url, 'http://127.0.0.1');
      currentModelId = parsedUrl.searchParams.get('model') || currentModelId;
      watchdogState = 'running';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          current_model: currentModelId,
        }),
      );
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // 1. Non-loopback URLs (cloud, LAN, subdomain tricks) never trigger any local request
    assert.equal(isWatchdogLoopbackUrl('https://openrouter.ai/api/v1'), false);
    assert.equal(isWatchdogLoopbackUrl('https://localhost.example.com/v1'), false);
    assert.equal(isWatchdogLoopbackUrl('http://192.168.1.4:8080/v1'), false);
    await ensureLocalLlamaServer('https://localhost.example.com/v1');
    await ensureLocalLlamaServer('http://192.168.1.4:8080/v1');
    assert.equal(calls.length, 0);

    // 2. Non-Watchdog loopback endpoint (assumeWatchdog: false on non-8080 port) only probes /v1/models
    await ensureLocalLlamaServer(`${server.url}/v1/chat/completions`);
    assert.deepEqual(calls, [{ method: 'GET', url: '/v1/models' }]);
    calls.length = 0;

    // 3. Watchdog endpoint checks /api/status and wakes once for concurrent callers
    await Promise.all([
      ensureLocalLlamaServer(`${server.url}/v1`, '', { assumeWatchdog: true }),
      ensureLocalLlamaServer(`${server.url}/v1/chat/completions`, 'default', {
        assumeWatchdog: true,
      }),
    ]);
    assert.deepEqual(calls, [
      { method: 'GET', url: '/api/status' },
      { method: 'POST', url: '/api/wake' },
    ]);
    calls.length = 0;

    // 4. Running Watchdog with same model does not call /api/wake again
    await ensureLocalLlamaServer(`${server.url}/v1`, 'Qwen-Default', {
      assumeWatchdog: true,
    });
    assert.deepEqual(calls, [{ method: 'GET', url: '/api/status' }]);
    calls.length = 0;

    // 5. Requesting a different model calls /api/switch?model=Riva-9B
    await ensureLocalLlamaServer(`${server.url}/v1`, 'Riva-9B', {
      assumeWatchdog: true,
    });
    assert.deepEqual(calls, [
      { method: 'GET', url: '/api/status' },
      { method: 'POST', url: '/api/switch?model=Riva-9B' },
    ]);
    calls.length = 0;

    // 6. Legacy HTTP 200 with { status: "error", state: "failed" } rejects and allows retry
    watchdogState = 'sleeping';
    wakeShouldFail = true;
    await assert.rejects(
      ensureLocalLlamaServer(`${server.url}/v1`, 'Riva-9B', { assumeWatchdog: true }),
      /模型載入失敗/,
    );
    wakeShouldFail = false;
    await ensureLocalLlamaServer(`${server.url}/v1`, 'Riva-9B', {
      assumeWatchdog: true,
    });
    assert.equal(watchdogState, 'running');
  } finally {
    await server.close();
  }
});

test('OpenAI-compatible client handles online/local requests, omits empty model, and handles HTTP error JSON, timeout, and cancellation', async () => {
  let mode = 'success';
  const receivedBodies = [];
  const receivedHeaders = [];

  const server = await startTestHttpServer(async (req, res) => {
    receivedHeaders.push(req.headers);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    if (rawBody) {
      receivedBodies.push(JSON.parse(rawBody));
    }

    if (mode === 'error-json') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded on upstream' } }));
      return;
    }
    if (mode === 'invalid-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not-json');
      return;
    }
    if (mode === 'slow') {
      await new Promise(r => setTimeout(r, 400));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '第一段譯文\n---WUF-SEG---\n第二段譯文' } }],
      }),
    );
  });

  try {
    const baseProvider = {
      ...DEFAULT_SETTINGS.providers.online,
      baseUrl: `${server.url}/v1`,
      model: '',
      effectiveModel: '',
      profileType: 'online',
      apiKey: 'test-token-xyz',
      runtimeFallbackApplied: false,
    };

    // 1. Multi-segment success with empty effective model omits body.model
    const res1 = await translateWithOpenAICompat({
      provider: baseProvider,
      texts: ['First paragraph', 'Second paragraph'],
      targetLanguage: 'zh-TW',
    });
    assert.deepEqual(res1.translations, ['第一段譯文', '第二段譯文']);
    assert.equal(res1.effectiveModel, '');
    assert.equal('model' in receivedBodies[0], false);
    assert.equal(receivedHeaders[0].authorization, 'Bearer test-token-xyz');

    // 2. Non-2xx HTTP error JSON surfaces upstream error.message and HTTP status
    mode = 'error-json';
    await assert.rejects(
      translateWithOpenAICompat({
        provider: { ...baseProvider, model: 'gpt-4o-mini', effectiveModel: 'gpt-4o-mini' },
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
      }),
      err => {
        assert.ok(err instanceof WufProviderError);
        assert.equal(err.code, 'HTTP_ERROR');
        assert.equal(err.status, 429);
        assert.match(err.message, /Rate limit exceeded on upstream/);
        return true;
      },
    );

    // 3. Invalid JSON response rejects with INVALID_RESPONSE
    mode = 'invalid-json';
    await assert.rejects(
      translateWithOpenAICompat({
        provider: baseProvider,
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
      }),
      err => err instanceof WufProviderError && err.code === 'INVALID_RESPONSE',
    );

    // 4. Timeout rejects with code TIMEOUT
    mode = 'slow';
    await assert.rejects(
      translateWithOpenAICompat({
        provider: baseProvider,
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        timeoutMs: 40,
      }),
      err => err instanceof WufProviderError && err.code === 'TIMEOUT',
    );

    // 5. Caller AbortController cancellation rejects with code ABORTED
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 20);
    await assert.rejects(
      translateWithOpenAICompat({
        provider: baseProvider,
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        timeoutMs: 5000,
        signal: abortController.signal,
      }),
      err => err instanceof WufProviderError && err.code === 'ABORTED',
    );
  } finally {
    await server.close();
  }
});

test('OpenRouter free-tier performance bounds, reasoning payload, and rate limiting', () => {
  resetFreeRequestLimiter();
  const freeProvider = {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
  };

  const perf = resolvePerformanceConfig({ ...freeProvider, webConcurrency: 20 }, 'online');
  assert.equal(perf.webConcurrency, 2);
  assert.equal(perf.webBatchUnits, 40);
  assert.equal(perf.webBatchChars, 7000);

  const payload = buildThinkingPayload({
    ...freeProvider,
    level: 'off',
    routingSort: 'latency',
    allowFallbacks: true,
  });
  assert.deepEqual(payload.reasoning, { enabled: false, exclude: true });
  assert.deepEqual(payload.provider, { sort: 'latency', allow_fallbacks: true });
  assert.equal('models' in payload, false);

  const starts = Array.from({ length: 25 }, () => 1000 + reserveFreeRequest(freeProvider, 1000));
  for (const t0 of starts) {
    const inMinute = starts.filter(t1 => t1 >= t0 && t1 < t0 + 60000).length;
    assert.ok(inMinute <= 20, `Expected <= 20 requests/min, got ${inMinute}`);
  }
  resetFreeRequestLimiter();
});

test('Google Translate fallback and OpenCC provider handle valid conversions and real errors', async () => {
  // 1. OpenCC real conversion
  const converted = await translateWithOpenCC(['这个软件占用了很多内存'], 's2twp');
  assert.equal(converted.length, 1);
  assert.match(converted[0], /軟體/);
  assert.match(converted[0], /記憶體/);

  // 2. OpenCC invalid variant throws WufProviderError
  await assert.rejects(
    translateWithOpenCC(['测试'], 'invalid-variant'),
    err => err instanceof WufProviderError && err.code === 'CONFIG_ERROR',
  );

  // 3. Google Translate against real HTTP server (success, malformed JSON, HTTP 500)
  let googleMode = 'ok';
  const server = await startTestHttpServer((req, res) => {
    if (googleMode === 'http-500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Upstream failure');
      return;
    }
    if (googleMode === 'bad-shape') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ unexpected: true }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([[['你好世界', 'Hello world', null, null, 10]]]));
  });

  try {
    const gOk = await translateWithGoogle({
      texts: ['Hello world'],
      targetLanguage: 'zh-TW',
      endpointUrl: `${server.url}/translate_a/single`,
    });
    assert.deepEqual(gOk, ['你好世界']);

    googleMode = 'bad-shape';
    await assert.rejects(
      translateWithGoogle({
        texts: ['Hello world'],
        targetLanguage: 'zh-TW',
        endpointUrl: `${server.url}/translate_a/single`,
      }),
      err => err instanceof WufProviderError && err.code === 'INVALID_RESPONSE',
    );

    googleMode = 'http-500';
    await assert.rejects(
      translateWithGoogle({
        texts: ['Hello world'],
        targetLanguage: 'zh-TW',
        endpointUrl: `${server.url}/translate_a/single`,
      }),
      err =>
        err instanceof WufProviderError &&
        err.code === 'HTTP_ERROR' &&
        err.status === 500,
    );
  } finally {
    await server.close();
  }
});

test('Background runtime message dispatcher handles settings and translation requests end-to-end', async () => {
  const mockStorage = createMockChromeStorage();
  mockStorage.install();
  try {
    const saveResp = await handleRuntimeMessage({
      type: 'wuf:save-settings',
      settings: {
        uiLocale: 'ja',
        theme: 'dark',
        openccVariant: 's2twp',
      },
      apiKeys: {
        online: 'runtime-secret-key',
      },
    });
    assert.equal(saveResp.ok, true);
    assert.equal(saveResp.data.savedSettings.uiLocale, 'ja');
    assert.equal(saveResp.data.apiKeys.online, 'runtime-secret-key');

    const openccResp = await handleRuntimeMessage({
      type: 'wuf:convert-opencc',
      request: {
        texts: ['计算机软件'],
        variant: 's2twp',
      },
    });
    assert.equal(openccResp.ok, true);
    assert.equal(openccResp.data.conversions[0], '計算機軟體');
    assert.equal(openccResp.data.variant, 's2twp');

    const invalidEngineResp = await handleRuntimeMessage({
      type: 'wuf:translate-text',
      request: {
        texts: ['计算机软件'],
        targetLanguage: 'zh-TW',
        engine: 'opencc',
        purpose: 'manual',
      },
    });
    assert.equal(invalidEngineResp.ok, false);
    assert.equal(invalidEngineResp.error.code, 'CONFIG_ERROR');

    const unknownResp = await handleRuntimeMessage({
      type: 'wuf:non-existent',
    });
    assert.equal(unknownResp.ok, false);
    assert.equal(unknownResp.error.code, 'UNKNOWN_MESSAGE_TYPE');
  } finally {
    mockStorage.uninstall();
  }
});

test('Phase 3 Webpage DOM translator, single top-level context menu, YouTube subtitle pipeline + Laya/custom decision engine', async () => {
  // 1. Single top-level page context menu registration and dynamic title refresh
  const createdMenus = [];
  const updatedMenus = [];
  let installedHandler = null;
  let badgeText = '';
  globalThis.chrome = {
    i18n: {
      getMessage: k => (k === 'contextShowOriginal' ? '顯示原文' : '使用 WUF 翻譯此頁面'),
    },
    tabs: {
      query: async () => [{ id: 101 }],
      onActivated: { addListener: () => {} },
    },
    windows: {
      onFocusChanged: { addListener: () => {} },
    },
    action: {
      getBadgeText: async () => badgeText,
    },
    runtime: {
      onInstalled: { addListener: fn => { installedHandler = fn; } },
      onStartup: { addListener: () => {} },
    },
    contextMenus: {
      removeAll: async () => {},
      create: (props, cb) => {
        createdMenus.push(props);
        cb?.();
      },
      update: async (id, props) => {
        updatedMenus.push({ id, props });
      },
      onClicked: { addListener: () => {} },
    },
  };

  try {
    registerPageContextMenus();
    installedHandler?.();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(createdMenus.length, 1);
    assert.equal(createdMenus[0].id, WUF_PAGE_CONTEXT_MENU_ID);
    assert.equal(createdMenus[0].title, '使用 WUF 翻譯此頁面');

    badgeText = 'ON';
    await refreshPageContextMenu();
    assert.equal(updatedMenus[updatedMenus.length - 1].id, WUF_PAGE_CONTEXT_MENU_ID);
    assert.equal(updatedMenus[updatedMenus.length - 1].props.title, '顯示原文');
  } finally {
    delete globalThis.chrome;
  }

  // 2. Webpage batching
  const units = [
    { element: {}, sourceText: 'Hello world', tagName: 'P' },
    { element: {}, sourceText: 'Second paragraph', tagName: 'P' },
  ];
  const batches = partitionWebpageBatches(units, {
    firstBatchUnits: 1,
    firstBatchChars: 5000,
    webBatchUnits: 1,
    webBatchChars: 5000,
  });
  assert.equal(batches.length, 2);

  // 3. Local subtitle serial queue & prompt
  const localProvider = {
    baseUrl: 'http://127.0.0.1:8080/v1',
    profileType: 'local',
  };
  assert.equal(isLocalSubtitleProvider(localProvider), true);
  assert.match(localSubtitlePrompt('zh-TW'), /Translate ALL speech to 台灣繁體中文/);

  const order = [];
  await Promise.all([
    queueLocalSubtitle(localProvider, async () => {
      await new Promise(r => setTimeout(r, 15));
      order.push(1);
    }),
    queueLocalSubtitle(localProvider, async () => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);

  // 4. YouTube caption track selection, ASR merge, cue splitting, and window batching
  const bestTrack = chooseBestCaptionTrack(
    [
      { baseUrl: 'https://yt.example/asr', languageCode: 'en', kind: 'asr' },
      { baseUrl: 'https://yt.example/manual-ja', languageCode: 'ja' },
    ],
    null,
    'zh-TW',
  );
  assert.equal(bestTrack.track?.baseUrl, 'https://yt.example/manual-ja');

  const rawAsrSegs = [
    { text: 'Hello', startMs: 0, endMs: 1000 },
    { text: 'world.', startMs: 1100, endMs: 2200 },
    { text: 'Next sentence!', startMs: 2400, endMs: 3600 },
  ];
  const mergedAsr = heuristicMergeAsr(rawAsrSegs, 'en');
  assert.equal(mergedAsr.length, 2);
  assert.equal(mergedAsr[0].text, 'Hello world.');

  const parsedEntries = parseAsrLlmOutput('1-2|哈囉世界\n3|下一句', rawAsrSegs, 3600);
  assert.equal(parsedEntries.length, 2);
  assert.equal(parsedEntries[0].t, '哈囉世界');
  const resolvedTimeline = resolveAsrEntryTimeline(parsedEntries, rawAsrSegs, 3600);
  assert.equal(resolvedTimeline.cues.length, 2);
  assert.equal(resolvedTimeline.cues[0].text, '哈囉世界');

  const splitCues = splitLongSubtitleCue(
    0,
    6000,
    '第一句話非常長而且第二句話也確實非常長需要切分開來顯示在螢幕上',
  );
  assert.ok(splitCues.length >= 2);

  const cuesFromJson3 = parseYouTubeTimedTextJson3({
    events: [
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Line 1' }] },
      { tStartMs: 15000, dDurationMs: 2000, segs: [{ utf8: 'Line 2' }] },
      { tStartMs: 50000, dDurationMs: 2000, segs: [{ utf8: 'Line 3' }] },
    ],
  });
  assert.equal(cuesFromJson3.length, 3);
  const windowBatch = planSubtitleWindowBatch(cuesFromJson3, 22, 30, 10);
  assert.equal(windowBatch.windowSegments.length, 2);
  assert.equal(windowBatch.prefetchWindowIndex, 1);

  // 5. Laya / Custom decision engine & subtitle decision pipeline
  const decisionServer = await startTestHttpServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'doc-model' }] }));
      return;
    }
    if (req.url === '/v1/systemone') {
      res.end(
        JSON.stringify({
          answers: {
            valid_0: { type: 'noul', noul: 0.99 },
            needs_0: { type: 'noul', noul: 0.99 },
            format_0: { type: 'noul', noul: 0.01 },
          },
        }),
      );
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      if (bodyStr.includes('questions')) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    valid_0: true,
                    needs_0: true,
                    format_0: false,
                  }),
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '第一句譯文\n---WUF-SEG---\n第二句譯文' } }],
        }),
      );
      return;
    }
    res.end('{}');
  });

  try {
    const layaEngine = new LayaDecisionEngine({
      mode: 'laya',
      apiUrl: `${decisionServer.url}/v1/systemone`,
    });
    assert.equal(JevDecisionEngine, LayaDecisionEngine);
    const layaEval = await layaEngine.evaluateBatch(['Hello world'], 'zh-TW', 'en');
    assert.equal(layaEval[0].is_valid, true);
    assert.equal(layaEval[0].needs_translation, true);

    const customEngine = new LayaDecisionEngine({
      mode: 'custom',
      customBaseUrl: `${decisionServer.url}/v1`,
      customModel: 'qwen-decision',
    });
    const customEval = await customEngine.evaluateBatch(['Hello world'], 'zh-TW', 'en');
    assert.equal(customEval[0].is_valid, true);
    assert.equal(customEval[0].source, 'custom');

    const pipelineOut = await runSubtitleDecisionPipeline(
      {
        texts: ['[Music]', '>> Hello there.'],
        sourceLanguage: 'en',
      },
      {
        subtitles: {
          targetLanguage: 'zh-TW',
          decisionMode: 'custom',
          decisionCustomModel: 'qwen-decision',
          decisionCustomBaseUrl: `${decisionServer.url}/v1`,
        },
      },
      async p => ({
        ok: true,
        result: p.texts.map(l => `譯：${l}`),
      }),
      { engine: customEngine },
    );
    assert.equal(pipelineOut.ok, true);
    assert.deepEqual(pipelineOut.result, ['', '譯：Hello there.']);
    assert.equal(stripSpeakerPrefix('>> Hi'), 'Hi');
    assert.match(
      subtitleRepairPrompt('Prompt', {
        decisionRepair: [{ translation: 'Bad', reason: 'format' }],
      }),
      /Retranslate the supplied source faithfully/,
    );
  } finally {
    await decisionServer.close();
  }
});
