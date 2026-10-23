const TIMEDTEXT_EVENT_NAME = 'wuf-timedtext-captured';

function isTimedTextUrl(url: string): boolean {
  try {
    const parsed = new URL(url, globalThis.location?.origin || 'https://www.youtube.com');
    return parsed.pathname.includes('/api/timedtext');
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
  globalThis.window?.addEventListener('wuf-yt-request-tracks', () => {
    try {
      const player = (document.querySelector('#movie_player') ||
        document.querySelector('.html5-video-player')) as unknown as {
        getPlayerResponse?: () => {
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
            };
          };
        };
        getOption?: (module: string, option: string) => unknown;
      };

      let tracks: unknown[] | null = null;
      let activeTrack: unknown = null;
      try {
        const resp = player?.getPlayerResponse?.() ||
          (globalThis.window as unknown as { ytInitialPlayerResponse?: {
            captions?: {
              playerCaptionsTracklistRenderer?: {
                captionTracks?: unknown[];
              };
            };
          }}).ytInitialPlayerResponse;
        tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
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
          detail: { tracks, activeTrack },
        }),
      );
    } catch {
      // Best effort
    }
  });

  globalThis.window?.addEventListener('wuf-yt-set-track', (e: Event) => {
    try {
      const detail = (e as CustomEvent<{ languageCode?: string; kind?: string }>).detail;
      if (!detail?.languageCode) return;
      const player = (document.querySelector('#movie_player') ||
        document.querySelector('.html5-video-player')) as unknown as {
        loadModule?: (name: string) => void;
        setOption?: (module: string, opt: string, val: unknown) => void;
      };
      player?.loadModule?.('captions');
      player?.setOption?.('captions', 'track', {
        languageCode: detail.languageCode,
        kind: detail.kind || '',
      });
    } catch {
      // Best effort
    }
  });

  globalThis.window?.addEventListener('wuf-yt-set-caption-state', (e: Event) => {
    try {
      const detail = (e as CustomEvent<{ enabled?: boolean }>).detail;
      const player = (document.querySelector('#movie_player') ||
        document.querySelector('.html5-video-player')) as unknown as {
        loadModule?: (name: string) => void;
        setOption?: (module: string, opt: string, val: unknown) => void;
        getOption?: (module: string, opt: string) => unknown;
        getPlayerResponse?: () => unknown;
      };
      if (!player) return;
      if (detail?.enabled) {
        player.loadModule?.('captions');
        const current = player.getOption?.('captions', 'track');
        if (!current) {
          let tracks = player.getOption?.('captions', 'tracklist') as Array<{ languageCode: string; kind?: string }>;
          if (!Array.isArray(tracks) || tracks.length === 0) {
            const resp = (player.getPlayerResponse?.() ||
              (globalThis.window as unknown as { ytInitialPlayerResponse?: { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ languageCode: string; kind?: string }> } } } }).ytInitialPlayerResponse) as {
              captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ languageCode: string; kind?: string }> } };
            };
            tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          }
          if (Array.isArray(tracks) && tracks.length > 0) {
            player.setOption?.('captions', 'track', {
              languageCode: tracks[0].languageCode,
              kind: tracks[0].kind || '',
            });
          }
        }
      } else {
        player.setOption?.('captions', 'track', {});
      }
    } catch {
      // Best effort
    }
  });
}

installYouTubeMainWorldInterceptor();
