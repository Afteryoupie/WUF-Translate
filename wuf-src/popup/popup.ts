import type {
  SettingsSnapshotPayload,
  ThemeMode,
  TranslationEngineId,
  UiLocale,
  WatchdogProbeResult,
  WufSettings,
} from '../types.ts';
import { applyI18nToDom, resolveUiLocale, t } from '../i18n/index.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import { applyThemeMode } from '../ui/theme-init.ts';

function shortModel(name: string): string {
  if (!name) return '';
  return name.length > 28 ? `${name.slice(0, 16)}…${name.slice(-10)}` : name;
}

export async function initPopup(): Promise<void> {
  const root = document.getElementById('wuf-popup-root');
  if (!root) return;

  // DOM Elements
  const modelPill = document.getElementById('wuf-model-pill');
  const themeToggle = document.getElementById('wuf-theme-toggle') as HTMLButtonElement | null;
  const openOptionsBtn = document.getElementById('wuf-open-options') as HTMLButtonElement | null;

  const translateBtn = document.getElementById('wuf-btn-translate-webpage') as HTMLButtonElement | null;
  const translateLabel = document.getElementById('wuf-translate-label');
  const editPageBtn = document.getElementById('wuf-btn-edit-page') as HTMLButtonElement | null;

  const progressIcon = document.getElementById('wuf-progress-icon');
  const progressText = document.getElementById('wuf-progress-text');
  const progressBarWrap = document.getElementById('wuf-progress-bar-wrap');
  const progressBar = document.getElementById('wuf-progress-bar');

  const modeSingleBtn = document.getElementById('wuf-mode-single') as HTMLButtonElement | null;
  const modeDualBtn = document.getElementById('wuf-mode-dual') as HTMLButtonElement | null;
  const targetLangSelect = document.getElementById('wuf-target-lang-select') as HTMLSelectElement | null;
  const autoSiteToggle = document.getElementById('wuf-auto-site-toggle') as HTMLInputElement | null;
  const autoSiteLabel = document.getElementById('wuf-auto-site-label');
  const openccRow = document.getElementById('wuf-opencc-row');
  const openccToggle = document.getElementById('wuf-opencc-toggle') as HTMLInputElement | null;

  const ytBox = document.getElementById('wuf-yt-box');
  const ytSubtitlesToggle = document.getElementById('wuf-yt-subtitles-toggle') as HTMLInputElement | null;
  const translateYoutubeBtn = document.getElementById('wuf-btn-translate-youtube') as HTMLButtonElement | null;
  const ytCaptionSize = document.getElementById('wuf-yt-caption-size') as HTMLSelectElement | null;

  const statusDot = document.getElementById('wuf-status-dot');
  const statusText = document.getElementById('wuf-status-text');
  const wakeBtn = document.getElementById('wuf-wake-btn') as HTMLButtonElement | null;
  const engineSelect = document.getElementById('wuf-engine-select') as HTMLSelectElement | null;
  const localModelSelect = document.getElementById('wuf-local-model-select') as HTMLSelectElement | null;

  const cacheInfo = document.getElementById('wuf-cache-info');
  const clearCacheBtn = document.getElementById('wuf-clear-cache-btn') as HTMLButtonElement | null;
  const clearConfirm = document.getElementById('wuf-clear-confirm');
  const confirmYes = document.getElementById('wuf-confirm-yes') as HTMLButtonElement | null;
  const confirmNo = document.getElementById('wuf-confirm-no') as HTMLButtonElement | null;

  // Load Settings Snapshot
  let currentSnapshot: SettingsSnapshotPayload | null = null;
  let currentLocale: UiLocale = 'zh-TW';

  const getActiveTab = async () => {
    const tabs = await globalThis.chrome?.tabs?.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  };

  const getActiveHost = async (): Promise<string | null> => {
    const tab = await getActiveTab();
    if (!tab?.url) return null;
    try {
      const u = new URL(tab.url);
      if (['http:', 'https:'].includes(u.protocol)) {
        return u.hostname.toLowerCase();
      }
    } catch {
      // Non-web URL
    }
    return null;
  };

  const saveSettings = async (patch: Partial<WufSettings>): Promise<void> => {
    if (!currentSnapshot) return;
    const nextSettings: WufSettings = {
      ...currentSnapshot.savedSettings,
      ...patch,
    };
    const resp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
      type: 'wuf:save-settings',
      settings: nextSettings,
    });
    if (resp.ok) {
      currentSnapshot = resp.data;
      renderSettings(resp.data);
    }
  };

  const renderSettings = (snapshot: SettingsSnapshotPayload) => {
    const saved = snapshot.savedSettings;
    const locale = resolveUiLocale(saved.uiLocale);
    currentLocale = locale;

    // Apply i18n
    applyI18nToDom(document, locale);

    // Pill
    if (modelPill) {
      modelPill.textContent = snapshot.activeProvider.profileType === 'local' ? 'Local' : 'Cloud';
    }

    // Display mode buttons
    const isSingle = saved.webpage.displayMode === 'monolingual';
    if (modeSingleBtn && modeDualBtn) {
      modeSingleBtn.classList.toggle('active', isSingle);
      modeSingleBtn.setAttribute('aria-checked', String(isSingle));
      modeDualBtn.classList.toggle('active', !isSingle);
      modeDualBtn.setAttribute('aria-checked', String(!isSingle));
    }

    // Target language
    if (targetLangSelect) {
      targetLangSelect.value = saved.webpage.targetLanguage;
    }

    // OpenCC row visibility
    const isZh = ['zh-TW', 'zh-CN'].includes(saved.webpage.targetLanguage);
    if (openccRow) {
      openccRow.hidden = !isZh;
    }
    if (openccToggle) {
      openccToggle.checked = Boolean(saved.openccEnabled);
    }

    // Engine select
    if (engineSelect) {
      engineSelect.value = saved.webpage.engine;
    }
  };

  // 1. Initial Load
  const initResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
    type: 'wuf:get-settings',
  });
  if (initResp.ok) {
    currentSnapshot = initResp.data;
    renderSettings(initResp.data);
  }

  // 2. Refresh Translate Action Button state
  const refreshPageState = async () => {
    const tab = await getActiveTab();
    if (!tab?.id || !translateBtn || !translateLabel) return;

    let isTranslated = false;
    let isTranslating = false;
    let isEditing = false;
    let progressInfo: { completedUnits?: number; totalUnits?: number } | null = null;

    try {
      const stateResp = await globalThis.chrome?.tabs?.sendMessage(tab.id, {
        type: 'wuf:get-state',
      });
      if (stateResp?.ok) {
        isTranslated = Boolean(stateResp.translated);
        isTranslating = Boolean(stateResp.translating);
        isEditing = Boolean(stateResp.editing);
        progressInfo = (stateResp.progress as { completedUnits?: number; totalUnits?: number }) || null;
      } else {
        const badge = await globalThis.chrome.action.getBadgeText({ tabId: tab.id });
        isTranslated = Boolean(badge);
      }
    } catch {
      // Content script not injected yet or restricted page
    }

    if (isTranslating) {
      translateBtn.dataset.mode = 'translating';
      translateBtn.disabled = true;
      translateLabel.textContent = t(currentLocale, 'popup.translating');
      if (editPageBtn) editPageBtn.hidden = true;

      if (progressIcon) progressIcon.textContent = '🔄';
      if (progressText) {
        if (progressInfo && progressInfo.totalUnits && progressInfo.totalUnits > 0) {
          const completed = progressInfo.completedUnits || 0;
          const total = progressInfo.totalUnits;
          const pct = Math.min(100, Math.round((completed / total) * 100));
          progressText.textContent = `${t(currentLocale, 'popup.translating')} (${completed}/${total} · ${pct}%)`;
          if (progressBar) progressBar.style.width = `${pct}%`;
          if (progressBarWrap) progressBarWrap.hidden = false;
        } else {
          progressText.textContent = t(currentLocale, 'popup.translating');
          if (progressBarWrap) progressBarWrap.hidden = true;
        }
      }
    } else if (isTranslated) {
      translateBtn.dataset.mode = 'restore';
      translateBtn.disabled = false;
      translateLabel.textContent = t(currentLocale, 'popup.showOriginal');
      if (editPageBtn) {
        editPageBtn.hidden = false;
        editPageBtn.textContent = isEditing
          ? t(currentLocale, 'popup.editDone')
          : t(currentLocale, 'popup.editTranslations');
        editPageBtn.classList.toggle('active', isEditing);
      }
      if (progressIcon) progressIcon.textContent = '✅';
      if (progressText) progressText.textContent = t(currentLocale, 'popup.progressTranslated');
      if (progressBarWrap) progressBarWrap.hidden = true;
    } else {
      translateBtn.dataset.mode = 'translate';
      translateBtn.disabled = false;
      translateLabel.textContent = t(currentLocale, 'popup.translatePage');
      if (editPageBtn) editPageBtn.hidden = true;
      if (progressIcon) progressIcon.textContent = '📄';
      if (progressText) progressText.textContent = t(currentLocale, 'popup.progressOriginal');
      if (progressBarWrap) progressBarWrap.hidden = true;
    }
  };

  // 3. Check YouTube Page & Status
  const refreshYouTubeState = async () => {
    const tab = await getActiveTab();
    if (!tab?.url) {
      if (ytBox) ytBox.hidden = true;
      return;
    }

    const isYT = /(?:^|\.)youtube\.com$/i.test(new URL(tab.url).hostname);
    if (!isYT) {
      if (ytBox) ytBox.hidden = true;
      return;
    }

    if (ytBox) ytBox.hidden = false;
    if (tab.id) {
      try {
        const ytResp = await globalThis.chrome?.tabs?.sendMessage(tab.id, {
          type: 'wuf:get-youtube-state',
        });
        if (ytResp?.ok) {
          if (ytSubtitlesToggle) ytSubtitlesToggle.checked = Boolean(ytResp.active);
          if (ytCaptionSize) ytCaptionSize.value = String(ytResp.captionScale || 100);
          if (ytResp.active && progressIcon && progressText) {
            progressIcon.textContent = '🎬';
            const segCount = ytResp.rawSegmentsCount || 0;
            progressText.textContent = `${t(currentLocale, 'popup.progressYtActive')} (${segCount})`;
            if (progressBarWrap) progressBarWrap.hidden = true;
          }
        }
      } catch {
        // Tab not ready
      }
    }
  };

  // 4. Auto-translate site check
  const refreshAutoSite = async () => {
    if (!autoSiteToggle || !currentSnapshot) return;
    const host = await getActiveHost();
    if (!host) {
      autoSiteToggle.disabled = true;
      autoSiteToggle.checked = false;
      return;
    }
    autoSiteToggle.disabled = false;
    const list = currentSnapshot.savedSettings.webpage.autoTranslateHosts || [];
    autoSiteToggle.checked = list.includes(host);
    if (autoSiteLabel) {
      autoSiteLabel.title = host;
    }
  };

  // 5. Watchdog Probe & Models
  const refreshWatchdog = async () => {
    if (!currentSnapshot) return;
    const baseUrl = currentSnapshot.savedSettings.providers.local.baseUrl;
    const probeResp = await sendWufRuntimeMessage<WatchdogProbeResult>({
      type: 'wuf:probe-watchdog',
      baseUrl,
    });

    if (statusDot) {
      statusDot.className = 'wuf-dot';
    }

    if (!probeResp.ok) {
      if (statusDot) statusDot.classList.add('offline');
      if (statusText) statusText.textContent = t(currentLocale, 'popup.statusOffline');
      if (wakeBtn) wakeBtn.hidden = true;
      return;
    }

    const probe = probeResp.data;
    if (statusDot) statusDot.classList.add(probe.state);

    if (statusText) {
      switch (probe.state) {
        case 'running':
          statusText.textContent = `${t(currentLocale, 'popup.statusRunning')} (${shortModel(probe.currentModel || '')})`;
          if (wakeBtn) wakeBtn.hidden = true;
          break;
        case 'sleeping':
          statusText.textContent = t(currentLocale, 'popup.statusSleeping');
          if (wakeBtn) wakeBtn.hidden = false;
          break;
        case 'starting':
          statusText.textContent = t(currentLocale, 'popup.statusStarting');
          if (wakeBtn) wakeBtn.hidden = true;
          break;
        default:
          statusText.textContent = t(currentLocale, 'popup.statusOffline');
          if (wakeBtn) wakeBtn.hidden = true;
          break;
      }
    }

    // Populate local models
    if (localModelSelect) {
      const modelsResp = await sendWufRuntimeMessage<{ models: string[] }>({
        type: 'wuf:list-local-models',
        baseUrl,
      });
      const list = modelsResp.ok ? modelsResp.data.models : (probe.models || []);
      const currentChoice =
        currentSnapshot.savedSettings.webpage.customModelOverride ||
        currentSnapshot.savedSettings.providers.local.model ||
        '';

      localModelSelect.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = `— ${t(currentLocale, 'common.serverDefault')} —`;
      localModelSelect.appendChild(defOpt);

      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = shortModel(m);
        opt.title = m;
        if (m === currentChoice || m === probe.currentModelId) {
          opt.selected = true;
        }
        localModelSelect.appendChild(opt);
      }
    }
  };

  // 6. Cache stats
  const refreshCache = async () => {
    if (!cacheInfo) return;
    const resp = await sendWufRuntimeMessage<{ count: number; bytes: number }>({
      type: 'wuf:get-cache-stats',
    });
    if (resp.ok) {
      cacheInfo.textContent = `${t(currentLocale, 'popup.cacheLabel')}：${resp.data.count} 筆`;
    } else {
      cacheInfo.textContent = `${t(currentLocale, 'popup.cacheLabel')}：0 筆`;
    }
  };

  // Run all refreshers
  await Promise.all([
    refreshPageState(),
    refreshYouTubeState(),
    refreshAutoSite(),
    refreshWatchdog(),
    refreshCache(),
  ]);

  // Event Listeners

  // Theme Toggle
  themeToggle?.addEventListener('click', async () => {
    if (!currentSnapshot) return;
    const currentTheme = currentSnapshot.savedSettings.theme;
    const isDark =
      currentTheme === 'dark' ||
      (currentTheme === 'system' &&
        globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const next: ThemeMode = isDark ? 'light' : 'dark';
    applyThemeMode(next);
    await saveSettings({ theme: next });
  });

  // Open Options
  openOptionsBtn?.addEventListener('click', async () => {
    try {
      await globalThis.chrome?.runtime?.openOptionsPage();
    } catch {
      const url = globalThis.chrome?.runtime?.getURL('options.html');
      if (url) await globalThis.chrome?.tabs?.create({ url });
    }
  });

  // Primary Translate Button
  translateBtn?.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const isRestore = translateBtn.dataset.mode === 'restore';

    if (isRestore) {
      try {
        await globalThis.chrome?.tabs?.sendMessage(
          tab.id,
          { type: 'wuf:restore-page' },
          { frameId: 0 },
        );
      } catch {
        // ignore
      }
    } else {
      translateBtn.disabled = true;
      if (translateLabel) translateLabel.textContent = t(currentLocale, 'popup.translating');
      try {
        await globalThis.chrome?.tabs?.sendMessage(
          tab.id,
          { type: 'wuf:translate-page', payload: { force: true, translateOnly: true } },
          { frameId: 0 },
        );
      } catch {
        // Auto-inject fallback if tab was opened before extension was loaded/reloaded
        try {
          if (globalThis.chrome?.scripting?.executeScript) {
            await globalThis.chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content-webpage.js'],
            });
            await new Promise(r => setTimeout(r, 120));
            await globalThis.chrome?.tabs?.sendMessage(
              tab.id,
              { type: 'wuf:translate-page', payload: { force: true, translateOnly: true } },
              { frameId: 0 },
            );
          }
        } catch {
          // ignore
        }
      }
    }
    await refreshPageState();
  });

  // Edit Page Button
  editPageBtn?.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const resp = await globalThis.chrome?.tabs?.sendMessage(tab.id, {
      type: 'wuf:toggle-edit',
    });
    if (resp?.ok) {
      editPageBtn.textContent = resp.editing
        ? t(currentLocale, 'popup.editDone')
        : t(currentLocale, 'popup.editTranslations');
      editPageBtn.classList.toggle('active', resp.editing);
    }
  });

  // Display Mode Buttons
  modeSingleBtn?.addEventListener('click', async () => {
    if (!currentSnapshot) return;
    await saveSettings({
      webpage: { ...currentSnapshot.savedSettings.webpage, displayMode: 'monolingual' },
    });
    const tab = await getActiveTab();
    if (tab?.id) {
      await globalThis.chrome?.tabs?.sendMessage(tab.id, {
        type: 'wuf:translate-page',
        payload: { force: true, translateOnly: true },
      });
    }
  });

  modeDualBtn?.addEventListener('click', async () => {
    if (!currentSnapshot) return;
    await saveSettings({
      webpage: { ...currentSnapshot.savedSettings.webpage, displayMode: 'bilingual' },
    });
    const tab = await getActiveTab();
    if (tab?.id) {
      await globalThis.chrome?.tabs?.sendMessage(tab.id, {
        type: 'wuf:translate-page',
        payload: { force: true, translateOnly: true },
      });
    }
  });

  // Target Language Select
  targetLangSelect?.addEventListener('change', async () => {
    if (!currentSnapshot) return;
    const val = targetLangSelect.value;
    const isZh = ['zh-TW', 'zh-CN'].includes(val);
    if (openccRow) openccRow.hidden = !isZh;
    await saveSettings({
      webpage: { ...currentSnapshot.savedSettings.webpage, targetLanguage: val },
      subtitles: { ...currentSnapshot.savedSettings.subtitles, targetLanguage: val },
    });
    const tab = await getActiveTab();
    if (tab?.id) {
      await globalThis.chrome?.tabs?.sendMessage(tab.id, {
        type: 'wuf:translate-page',
        payload: { force: true, translateOnly: true },
      });
    }
  });

  // Auto-site toggle
  autoSiteToggle?.addEventListener('change', async () => {
    if (!currentSnapshot) return;
    const host = await getActiveHost();
    if (!host) return;
    const wp = currentSnapshot.savedSettings.webpage;
    const hosts = (wp.autoTranslateHosts || []).filter(h => h !== host);
    if (autoSiteToggle.checked) {
      hosts.push(host);
    }
    await saveSettings({
      webpage: { ...wp, autoTranslateHosts: hosts },
    });
  });

  // OpenCC toggle
  openccToggle?.addEventListener('change', async () => {
    await saveSettings({ openccEnabled: openccToggle.checked });
  });

  // YouTube Subtitles toggle
  ytSubtitlesToggle?.addEventListener('change', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    await globalThis.chrome?.tabs?.sendMessage(tab.id, {
      type: 'wuf:set-youtube-subtitle-state',
      payload: { enabled: ytSubtitlesToggle.checked },
    });
  });

  translateYoutubeBtn?.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    if (ytSubtitlesToggle) ytSubtitlesToggle.checked = true;
    try {
      await globalThis.chrome?.tabs?.sendMessage(tab.id, {
        type: 'wuf:activate-youtube-subtitles',
      });
    } catch {
      try {
        if (globalThis.chrome?.scripting?.executeScript) {
          await globalThis.chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-youtube.js'],
          });
          await new Promise(r => setTimeout(r, 120));
          await globalThis.chrome?.tabs?.sendMessage(tab.id, {
            type: 'wuf:activate-youtube-subtitles',
          });
        }
      } catch {
        // Fallback
        await globalThis.chrome?.tabs?.sendMessage(tab.id, {
          type: 'wuf:set-youtube-subtitle-state',
          payload: { enabled: true },
        }).catch(() => {});
      }
    }
  });

  // Caption Size
  ytCaptionSize?.addEventListener('change', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    const scale = Number.parseInt(ytCaptionSize.value, 10);
    await globalThis.chrome?.tabs?.sendMessage(tab.id, {
      type: 'wuf:set-youtube-caption-scale',
      payload: { scale },
    });
  });

  // Engine Select
  engineSelect?.addEventListener('change', async () => {
    if (!currentSnapshot) return;
    const engine = engineSelect.value as TranslationEngineId;
    await saveSettings({
      webpage: { ...currentSnapshot.savedSettings.webpage, engine },
    });
  });

  // Local Model Override
  localModelSelect?.addEventListener('change', async () => {
    if (!currentSnapshot) return;
    const chosen = localModelSelect.value;
    await saveSettings({
      webpage: { ...currentSnapshot.savedSettings.webpage, customModelOverride: chosen },
      providers: {
        ...currentSnapshot.savedSettings.providers,
        local: { ...currentSnapshot.savedSettings.providers.local, model: chosen },
      },
    });
    if (chosen) {
      await sendWufRuntimeMessage({
        type: 'wuf:switch-local-model',
        model: chosen,
      });
      await refreshWatchdog();
    }
  });

  // Wake Button
  wakeBtn?.addEventListener('click', async () => {
    if (!currentSnapshot) return;
    wakeBtn.disabled = true;
    if (statusText) statusText.textContent = t(currentLocale, 'status.waking');
    await sendWufRuntimeMessage({
      type: 'wuf:wake-watchdog',
      baseUrl: currentSnapshot.savedSettings.providers.local.baseUrl,
      model: currentSnapshot.savedSettings.providers.local.model,
    });
    await refreshWatchdog();
    wakeBtn.disabled = false;
  });

  // Clear Cache Button
  clearCacheBtn?.addEventListener('click', () => {
    if (clearConfirm) clearConfirm.hidden = false;
  });

  confirmNo?.addEventListener('click', () => {
    if (clearConfirm) clearConfirm.hidden = true;
  });

  confirmYes?.addEventListener('click', async () => {
    if (clearConfirm) clearConfirm.hidden = true;
    await sendWufRuntimeMessage({ type: 'wuf:clear-cache' });
    if (cacheInfo) {
      cacheInfo.textContent = `${t(currentLocale, 'popup.cacheLabel')}：0 筆 (${t(currentLocale, 'popup.cacheCleared')})`;
    }
  });

  // 800ms periodic poll while popup is open to keep live translation progress updated
  const progressPollTimer = setInterval(() => {
    void refreshPageState();
    void refreshYouTubeState();
  }, 800);
  globalThis.addEventListener('unload', () => clearInterval(progressPollTimer));
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    void initPopup();
  });
}
