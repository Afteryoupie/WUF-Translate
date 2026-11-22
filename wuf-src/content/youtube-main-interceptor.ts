import {
  getCurrentWatchVideoId,
  hasAutoTranslation,
  type CaptionTrackInfo,
} from '../subtitle/youtube-pipeline.ts';

const TIMEDTEXT_EVENT_NAME = 'wuf-timedtext-captured';
const CAPTION_PREF_KEY = 'yt-player-caption-language-preferences';
const DEFERRED_RESTORE_DELAY_MS = 150;

interface StorageSnapshot {
  local: string | null;
  session: string | null;
}

interface CaptionTrackSnapshot {
  languageCode: string;
  kind?: string;
  vssId?: string;
}

interface PreWufCaptionSnapshot {
  videoId: string;
  wasNativeCcEnabled: boolean;
  activeTrack: CaptionTrackSnapshot | null;
  storage: StorageSnapshot;
  mutatedByWuf: boolean;
  lastForcedLanguageCode: string | null;
}

interface YouTubeAudioFormatLike {
  audioTrack?: {
    id?: string;
    displayName?: string;
    audioIsDefault?: boolean;
  };
}

interface YouTubePlayerResponseLike {
  videoDetails?: { videoId?: string };
  streamingData?: {
    adaptiveFormats?: YouTubeAudioFormatLike[];
    formats?: YouTubeAudioFormatLike[];
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        languageCode: string;
        kind?: string;
        baseUrl?: string;
        name?: { simpleText?: string };
        vssId?: string;
        isTranslatable?: boolean;
      }>;
      audioTracks?: Array<{
        defaultCaptionTrackIndex?: number;
        captionTrackIndices?: number[];
      }>;
      defaultAudioTrackIndex?: number;
    };
  };
}

interface YouTubePlayerLike {
  getPlayerResponse?: () => YouTubePlayerResponseLike | null | undefined;
  loadModule?: (name: string) => void;
  setOption?: (module: string, opt: string, val: unknown) => void;
  getOption?: (module: string, opt: string) => unknown;
}

export function extractOriginalAudioLang(
  resp: YouTubePlayerResponseLike | null | undefined,
): string | undefined {
  const formats: YouTubeAudioFormatLike[] = [
    ...(Array.isArray(resp?.streamingData?.adaptiveFormats)
      ? resp.streamingData.adaptiveFormats
      : []),
    ...(Array.isArray(resp?.streamingData?.formats) ? resp.streamingData.formats : []),
  ];
  let fallbackId: string | undefined;
  for (const fmt of formats) {
    const id = fmt?.audioTrack?.id;
    if (typeof id !== 'string' || !id.trim()) continue;
    if (fmt.audioTrack?.audioIsDefault === true) {
      const lang = id.split('.')[0].trim();
      if (lang) return lang;
    }
    if (!fallbackId) {
      fallbackId = id;
    }
  }
  if (fallbackId) {
    const lang = fallbackId.split('.')[0].trim();
    if (lang) return lang;
  }
  return undefined;
}

export function extractDefaultCaptionTrackIndex(
  resp: YouTubePlayerResponseLike | null | undefined,
): number | undefined {
  const renderer = resp?.captions?.playerCaptionsTracklistRenderer;
  const audioTracks = renderer?.audioTracks;
  if (!Array.isArray(audioTracks) || audioTracks.length === 0) return undefined;
  const defaultAudioIdx =
    typeof renderer?.defaultAudioTrackIndex === 'number' &&
    renderer.defaultAudioTrackIndex >= 0 &&
    renderer.defaultAudioTrackIndex < audioTracks.length
      ? renderer.defaultAudioTrackIndex
      : 0;
  const idx = audioTracks[defaultAudioIdx]?.defaultCaptionTrackIndex;
  return typeof idx === 'number' && idx >= 0 ? idx : undefined;
}

function getSafeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    const store = globalThis[kind];
    if (store && typeof store.getItem === 'function') {
      return store;
    }
  } catch {
    // Restricted storage access
  }
  return null;
}

function safeGetStorageItem(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeRestoreStorageItem(storage: Storage | null, key: string, value: string | null): void {
  if (!storage) return;
  try {
    if (value === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota or security errors
  }
}

function getStorageSnapshot(): StorageSnapshot {
  return {
    local: safeGetStorageItem(getSafeStorage('localStorage'), CAPTION_PREF_KEY),
    session: safeGetStorageItem(getSafeStorage('sessionStorage'), CAPTION_PREF_KEY),
  };
}

export function extractPreferredLanguageCode(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      languageCode?: unknown;
      data?: unknown;
    } | null;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.languageCode === 'string' && parsed.languageCode) {
        return parsed.languageCode;
      }
      if (typeof parsed.data === 'string') {
        try {
          const inner = JSON.parse(parsed.data) as { languageCode?: unknown } | null;
          if (inner && typeof inner === 'object' && typeof inner.languageCode === 'string' && inner.languageCode) {
            return inner.languageCode;
          }
        } catch {
          // Fall through to regex fallback
        }
      } else if (
        parsed.data &&
        typeof parsed.data === 'object' &&
        typeof (parsed.data as { languageCode?: unknown }).languageCode === 'string' &&
        (parsed.data as { languageCode: string }).languageCode
      ) {
        return (parsed.data as { languageCode: string }).languageCode;
      }
    }
  } catch {
    // Fall through to regex fallback
  }
  const match = raw.match(/\\?"languageCode\\?"\s*:\s*\\?"([^"\\]+)\\?"/);
  return match ? match[1] : null;
}

function restoreStorageIfChanged(snapshot: StorageSnapshot, expectedForcedLang?: string): void {
  const entries: Array<[Storage | null, string | null]> = [
    [getSafeStorage('localStorage'), snapshot.local],
    [getSafeStorage('sessionStorage'), snapshot.session],
  ];
  const expectedLower = expectedForcedLang?.toLowerCase();
  for (const [storage, before] of entries) {
    if (!storage) continue;
    const current = safeGetStorageItem(storage, CAPTION_PREF_KEY);
    if (current === before) continue;
    if (expectedLower) {
      const currentLang = extractPreferredLanguageCode(current);
      if (!currentLang || currentLang.toLowerCase() !== expectedLower) {
        continue;
      }
    }
    safeRestoreStorageItem(storage, CAPTION_PREF_KEY, before);
  }
}

export function isTimedTextUrl(
  url: string,
  currentVideoId: string = getCurrentWatchVideoId(),
): boolean {
  try {
    const parsed = new URL(url, globalThis.location?.origin || 'https://www.youtube.com');
    if (!parsed.pathname.includes('/api/timedtext')) return false;
    const reqVideoId = parsed.searchParams.get('v') || '';
    if (reqVideoId && currentVideoId && reqVideoId !== currentVideoId) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function dispatchTimedTextPayload(url: string, rawText: string): void {
  if (!rawText || !rawText.trim()) return;
  try {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
    // Dispatch data (if JSON) and rawText (for XML / JSON fallback)
    globalThis.window?.dispatchEvent(
      new CustomEvent(TIMEDTEXT_EVENT_NAME, {
        detail: { url, data: parsed, rawText },
      }),
    );
  } catch {
    // Best-effort
  }
}

export function installYouTubeMainWorldInterceptor(): void {
  if (typeof globalThis.window === 'undefined') return;
  const win = globalThis.window as Window & { __WUF_MAIN_INTERCEPTOR_INSTALLED?: boolean };
  if (win.__WUF_MAIN_INTERCEPTOR_INSTALLED) return;
  win.__WUF_MAIN_INTERCEPTOR_INSTALLED = true;

  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = async function (...args: Parameters<typeof fetch>) {
      const response = await origFetch.apply(this, args);
      try {
        const reqInput = args[0];
        const url =
          typeof reqInput === 'string'
            ? reqInput
            : reqInput instanceof URL
              ? reqInput.href
              : (reqInput as Request)?.url || '';
        if (url && isTimedTextUrl(url)) {
          const clone = response.clone();
          void clone.text().then(text => dispatchTimedTextPayload(url, text));
        }
      } catch {
        // Never break page fetch
      }
      return response;
    };
  }

  // 攔截 YouTube 播放器用來抓取 timedtext 的 XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined') {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest & { __wufUrl?: string },
      ...args: [string, string | URL, ...unknown[]]
    ) {
      try {
        const u = args[1];
        this.__wufUrl = typeof u === 'string' ? u : u instanceof URL ? u.href : '';
      } catch {
        // ignore
      }
      return origOpen.apply(this, args as Parameters<typeof origOpen>);
    };

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest & { __wufUrl?: string },
      ...args: Parameters<typeof origSend>
    ) {
      const url = this.__wufUrl || '';
      if (url && isTimedTextUrl(url)) {
        this.addEventListener('readystatechange', () => {
          try {
            if (this.responseType && this.responseType !== 'text') return;
            if (this.readyState === 4 && this.status === 200 && this.responseText) {
              dispatchTimedTextPayload(url, this.responseText);
            }
          } catch {
            // Never break host page
          }
        });
      }
      return origSend.apply(this, args);
    };
  }

  // ─── Player Response & Captions Control Bridge ───────────
  let preWufSnapshot: PreWufCaptionSnapshot | null = null;
  let deferredPrefRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDeferredPrefRestore = () => {
    if (deferredPrefRestoreTimer !== null) {
      clearTimeout(deferredPrefRestoreTimer);
      deferredPrefRestoreTimer = null;
    }
  };

  const scheduleDeferredPrefRestore = (snapshot: StorageSnapshot, forcedLang: string) => {
    clearDeferredPrefRestore();
    deferredPrefRestoreTimer = setTimeout(() => {
      deferredPrefRestoreTimer = null;
      restoreStorageIfChanged(snapshot, forcedLang);
    }, DEFERRED_RESTORE_DELAY_MS);
  };

  const getPlayerElement = (): YouTubePlayerLike | null => {
    if (typeof document === 'undefined') return null;
    return (document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-player')) as unknown as YouTubePlayerLike | null;
  };

  const capturePreWufSnapshot = (
    player: YouTubePlayerLike | null,
    wasNativeCcEnabledHint?: boolean,
  ): void => {
    const currentVideoId = getCurrentWatchVideoId();
    if (preWufSnapshot !== null && preWufSnapshot.videoId === currentVideoId) return;
    let activeTrack: CaptionTrackSnapshot | null = null;
    try {
      const current = player?.getOption?.('captions', 'track') as {
        languageCode?: unknown;
        kind?: unknown;
        vssId?: unknown;
      } | null | undefined;
      if (current && typeof current === 'object' && typeof current.languageCode === 'string' && current.languageCode) {
        activeTrack = {
          languageCode: current.languageCode,
          kind: typeof current.kind === 'string' ? current.kind : '',
          ...(typeof current.vssId === 'string' && current.vssId ? { vssId: current.vssId } : {}),
        };
      }
    } catch {
      activeTrack = null;
    }
    preWufSnapshot = {
      videoId: currentVideoId,
      wasNativeCcEnabled:
        typeof wasNativeCcEnabledHint === 'boolean'
          ? wasNativeCcEnabledHint || Boolean(activeTrack)
          : Boolean(activeTrack),
      activeTrack,
      storage: getStorageSnapshot(),
      mutatedByWuf: false,
      lastForcedLanguageCode: null,
    };
  };

  globalThis.window?.addEventListener('yt-navigate-finish', () => {
    const currentVideoId = getCurrentWatchVideoId();
    if (preWufSnapshot && preWufSnapshot.videoId !== currentVideoId) {
      clearDeferredPrefRestore();
      preWufSnapshot = null;
    }
  });

  globalThis.window?.addEventListener('wuf-yt-request-tracks', () => {
    try {
      const player = getPlayerElement();

      let tracks: unknown[] | null = null;
      let activeTrack: unknown = null;
      let originalAudioLang: string | undefined;
      let defaultCaptionTrackIndex: number | undefined;
      try {
        let resp = player?.getPlayerResponse?.() ?? null;
        if (!resp) {
          const initial = (globalThis.window as unknown as {
            ytInitialPlayerResponse?: YouTubePlayerResponseLike;
          }).ytInitialPlayerResponse;
          if (initial) {
            const currentVideoId = getCurrentWatchVideoId();
            const initialVideoId = initial.videoDetails?.videoId || '';
            if (!currentVideoId || initialVideoId === currentVideoId) {
              resp = initial;
            }
          }
        }
        tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
        originalAudioLang = extractOriginalAudioLang(resp);
        defaultCaptionTrackIndex = extractDefaultCaptionTrackIndex(resp);
      } catch {
        tracks = null;
      }

      try {
        if (player?.getOption) {
          activeTrack = player.getOption('captions', 'track');
        }
      } catch {
        activeTrack = null;
      }

      globalThis.window?.dispatchEvent(
        new CustomEvent('wuf-yt-tracks-response', {
          detail: { tracks, activeTrack, originalAudioLang, defaultCaptionTrackIndex },
        }),
      );
    } catch {
      // Best effort
    }
  });

  globalThis.window?.addEventListener('wuf-yt-set-track', (e: Event) => {
    try {
      const detail = (e as CustomEvent<{ languageCode?: string; kind?: string; vssId?: string }>).detail;
      if (!detail?.languageCode) return;
      const player = getPlayerElement();
      if (!player) return;

      capturePreWufSnapshot(player);
      if (preWufSnapshot?.mutatedByWuf && preWufSnapshot.lastForcedLanguageCode) {
        restoreStorageIfChanged(preWufSnapshot.storage, preWufSnapshot.lastForcedLanguageCode);
      }
      const beforeStorage = getStorageSnapshot();
      if (preWufSnapshot) {
        preWufSnapshot.mutatedByWuf = true;
        preWufSnapshot.lastForcedLanguageCode = detail.languageCode;
      }

      let activeHadAutoTranslate = false;
      try {
        const current = player.getOption?.('captions', 'track') as CaptionTrackInfo | null | undefined;
        activeHadAutoTranslate = hasAutoTranslation(current);
      } catch {
        activeHadAutoTranslate = false;
      }

      const nextTrack: Record<string, unknown> = {
        languageCode: detail.languageCode,
        kind: detail.kind || '',
      };
      if (detail.vssId) {
        nextTrack.vssId = detail.vssId;
      }
      if (activeHadAutoTranslate) {
        nextTrack.translationLanguage = undefined;
      }

      player.loadModule?.('captions');
      player.setOption?.('captions', 'track', nextTrack);

      restoreStorageIfChanged(beforeStorage);
      scheduleDeferredPrefRestore(beforeStorage, detail.languageCode);
    } catch {
      // Best effort
    }
  });

  globalThis.window?.addEventListener('wuf-yt-set-caption-state', (e: Event) => {
    try {
      const detail = (e as CustomEvent<{ enabled?: boolean; wasNativeCcEnabled?: boolean }>).detail;
      const player = getPlayerElement();
      if (!player) return;

      if (detail?.enabled) {
        capturePreWufSnapshot(player, detail.wasNativeCcEnabled);
        player.loadModule?.('captions');
      } else {
        clearDeferredPrefRestore();
        const snapshot = preWufSnapshot;
        preWufSnapshot = null;
        if (!snapshot) return;

        if (snapshot.mutatedByWuf) {
          restoreStorageIfChanged(snapshot.storage, snapshot.lastForcedLanguageCode ?? undefined);
        }

        if (snapshot.wasNativeCcEnabled) {
          if (snapshot.mutatedByWuf && snapshot.activeTrack?.languageCode) {
            const beforeRestore = getStorageSnapshot();
            player.loadModule?.('captions');
            player.setOption?.('captions', 'track', {
              languageCode: snapshot.activeTrack.languageCode,
              kind: snapshot.activeTrack.kind || '',
              ...(snapshot.activeTrack.vssId ? { vssId: snapshot.activeTrack.vssId } : {}),
            });
            restoreStorageIfChanged(beforeRestore);
          }
        } else {
          player.setOption?.('captions', 'track', {});
        }

        if (snapshot.mutatedByWuf) {
          restoreStorageIfChanged(snapshot.storage, snapshot.lastForcedLanguageCode ?? undefined);
          if (snapshot.lastForcedLanguageCode) {
            scheduleDeferredPrefRestore(snapshot.storage, snapshot.lastForcedLanguageCode);
          }
        }
      }
    } catch {
      // Best effort
    }
  });
}

installYouTubeMainWorldInterceptor();
