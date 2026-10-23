import type { SettingsSnapshotPayload, WufLocalSecrets, WufSettings } from '../types.ts';
import {
  applyRuntimePlatformAdaptations,
  DEFAULT_LOCAL_SECRETS,
  DEFAULT_SETTINGS,
  detectRuntimePlatform,
  resolvePresetProvider,
  resolveProviderConfig,
  sanitizeLocalSecrets,
  sanitizeWufSettings,
} from './provider-profiles.ts';

export const SYNC_STORAGE_KEY = 'wufSettings';
export const LOCAL_SECRETS_KEY = 'wufSecrets';

function getChromeStorage(): typeof chrome.storage | null {
  return globalThis.chrome?.storage ?? null;
}

export async function loadSavedSettings(): Promise<WufSettings> {
  const storage = getChromeStorage();
  if (!storage?.sync) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const raw = await storage.sync.get(SYNC_STORAGE_KEY);
  const stored = raw?.[SYNC_STORAGE_KEY];
  if (!stored || typeof stored !== 'object') {
    return structuredClone(DEFAULT_SETTINGS);
  }
  return sanitizeWufSettings(stored, DEFAULT_SETTINGS).settings;
}

export async function loadLocalSecrets(): Promise<WufLocalSecrets> {
  const storage = getChromeStorage();
  if (!storage?.local) {
    return structuredClone(DEFAULT_LOCAL_SECRETS);
  }
  const raw = await storage.local.get(LOCAL_SECRETS_KEY);
  const stored = raw?.[LOCAL_SECRETS_KEY];
  if (!stored || typeof stored !== 'object') {
    return structuredClone(DEFAULT_LOCAL_SECRETS);
  }
  return sanitizeLocalSecrets(stored, DEFAULT_LOCAL_SECRETS);
}

export async function loadSettingsSnapshot(
  platform: string = detectRuntimePlatform(),
): Promise<SettingsSnapshotPayload> {
  const [savedSettings, secrets] = await Promise.all([
    loadSavedSettings(),
    loadLocalSecrets(),
  ]);
  const runtimeSettings = applyRuntimePlatformAdaptations(savedSettings, platform);

  return {
    savedSettings,
    runtimeSettings,
    apiKeys: structuredClone(secrets.providerApiKeys),
    activeProvider: resolveProviderConfig(
      savedSettings,
      secrets,
      savedSettings.activeProviderType,
      undefined,
      platform,
    ),
    webpageProvider: resolvePresetProvider(
      savedSettings,
      secrets,
      'webpage',
      undefined,
      undefined,
      platform,
    ),
    subtitleProvider: resolvePresetProvider(
      savedSettings,
      secrets,
      'subtitle',
      undefined,
      undefined,
      platform,
    ),
  };
}

/**
 * Persists user settings to chrome.storage.sync (strictly free of API keys)
 * and persists API keys exclusively to chrome.storage.local.
 */
export async function saveSettingsAndSecrets(
  settingsPatch?: Partial<WufSettings>,
  apiKeysPatch?: Partial<WufLocalSecrets['providerApiKeys']>,
): Promise<SettingsSnapshotPayload> {
  const storage = getChromeStorage();
  const currentSaved = await loadSavedSettings();
  const currentSecrets = await loadLocalSecrets();

  if (settingsPatch && typeof settingsPatch === 'object') {
    const mergedCandidate: WufSettings = {
      ...currentSaved,
      ...settingsPatch,
      providers: {
        online: {
          ...currentSaved.providers.online,
          ...(settingsPatch.providers?.online ?? {}),
        },
        local: {
          ...currentSaved.providers.local,
          ...(settingsPatch.providers?.local ?? {}),
        },
      },
      webpage: {
        ...currentSaved.webpage,
        ...(settingsPatch.webpage ?? {}),
      },
      subtitles: {
        ...currentSaved.subtitles,
        ...(settingsPatch.subtitles ?? {}),
      },
    };
    const { settings: cleanSettings } = sanitizeWufSettings(mergedCandidate, currentSaved);
    if (storage?.sync) {
      await storage.sync.set({
        [SYNC_STORAGE_KEY]: cleanSettings,
        theme: cleanSettings.theme,
      });
    }
  }

  if (apiKeysPatch && typeof apiKeysPatch === 'object') {
    const nextSecrets = sanitizeLocalSecrets(
      {
        providerApiKeys: {
          ...currentSecrets.providerApiKeys,
          ...apiKeysPatch,
        },
      },
      currentSecrets,
    );
    if (storage?.local) {
      await storage.local.set({
        [LOCAL_SECRETS_KEY]: nextSecrets,
      });
    }
  }

  return loadSettingsSnapshot();
}

export async function clearAllSettings(): Promise<SettingsSnapshotPayload> {
  const storage = getChromeStorage();
  const freshSettings = structuredClone(DEFAULT_SETTINGS);
  const freshSecrets = structuredClone(DEFAULT_LOCAL_SECRETS);

  if (storage?.sync) {
    if (typeof storage.sync.clear === 'function') {
      await storage.sync.clear();
    } else if (typeof storage.sync.remove === 'function') {
      await storage.sync.remove([SYNC_STORAGE_KEY, 'theme']);
    }
    await storage.sync.set({
      [SYNC_STORAGE_KEY]: freshSettings,
      theme: freshSettings.theme,
    });
  }

  if (storage?.local) {
    if (typeof storage.local.clear === 'function') {
      await storage.local.clear();
    } else if (typeof storage.local.remove === 'function') {
      await storage.local.remove([LOCAL_SECRETS_KEY]);
    }
    await storage.local.set({
      [LOCAL_SECRETS_KEY]: freshSecrets,
    });
  }

  return loadSettingsSnapshot();
}

export async function exportSanitizedSettings(): Promise<WufSettings> {
  const saved = await loadSavedSettings();
  const { settings } = sanitizeWufSettings(saved, DEFAULT_SETTINGS);
  return settings;
}

export async function importSanitizedSettings(
  raw: unknown,
): Promise<{ snapshot: SettingsSnapshotPayload; warnings: string[] }> {
  const currentSaved = await loadSavedSettings();
  const { settings: cleanSettings, warnings } = sanitizeWufSettings(raw, currentSaved);
  const storage = getChromeStorage();
  if (storage?.sync) {
    await storage.sync.set({
      [SYNC_STORAGE_KEY]: cleanSettings,
      theme: cleanSettings.theme,
    });
  }
  const snapshot = await loadSettingsSnapshot();
  return { snapshot, warnings };
}
