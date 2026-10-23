import type { SettingsSnapshotPayload, TranslationResponse } from '../types.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import {
  chooseBestCaptionTrack,
  heuristicMergeAsr,
  parseAsrLlmOutput,
  parseCaptionResponse,
  planSubtitleWindowBatch,
  refineAsrBoundaries,
  resolveAsrEntryTimeline,
  splitLongSubtitleCue,
  type AsrRawSegment,
  type CaptionTrackInfo,
  type MergedAsrSentence,
  type SplitCuePiece,
} from '../subtitle/youtube-pipeline.ts';

export interface WufYouTubeDisplayCue extends SplitCuePiece {
  sourceText?: string;
}

export interface WufYouTubeNamespace {
  YT: {
    active: boolean;
    rawSegments: AsrRawSegment[];
    displayCues: WufYouTubeDisplayCue[];
    translatedWindows: Set<number>;
    translatingWindows?: Set<number>;
    sessionGen?: number;
  };
  chooseBestCaptionTrack: typeof chooseBestCaptionTrack;
  heuristicMergeAsr: typeof heuristicMergeAsr;
  refineAsrBoundaries: typeof refineAsrBoundaries;
  parseAsrLlmOutput: typeof parseAsrLlmOutput;
  resolveAsrEntryTimeline: typeof resolveAsrEntryTimeline;
  splitLongSubtitleCue: typeof splitLongSubtitleCue;
  translateYouTubeSubtitles: () => Promise<{ ok: boolean; active: boolean }>;
  translateWindowAt?: (currentTimeSec: number) => Promise<void>;
  planSubtitleWindowBatch?: typeof planSubtitleWindowBatch;
}

function isYouTubeWatchPage(): boolean {
  try {
    return (
      /(?:^|\.)youtube\.com$/i.test(globalThis.location?.hostname || '') &&
      globalThis.location?.pathname === '/watch'
    );
  } catch {
    return false;
  }
}

export interface WufOverlayElement extends HTMLElement {
  setCue(text: string, scale?: number): void;
  clear(): void;
  updateAvoidance(controlsVisible: boolean): void;
  setScale(scale: number): void;
}

export function renderYouTubeDisplayCue(
  player: HTMLElement,
  overlay: WufOverlayElement,
  cues: WufYouTubeDisplayCue[],
  nowMs: number,
  active: boolean,
  scale: number,
): void {
  const cue = active ? cues.reduce<WufYouTubeDisplayCue | undefined>((best, c) =>
    c.startMs <= nowMs && nowMs < c.endMs && c.text.trim() && (!best || c.startMs > best.startMs) ? c : best,
  undefined) : undefined;
  player.classList.toggle('wuf-translated-cue-visible', Boolean(cue));
  if (cue) overlay.setCue(cue.text, scale);
  else overlay.clear();
}

export function bindOverlayMethods(overlay: HTMLElement): WufOverlayElement {
  const target = overlay as WufOverlayElement;
  let shadow = target.shadowRoot;
  let segment: HTMLSpanElement | null = null;

  if (!shadow && typeof target.attachShadow === 'function') {
    try {
      shadow = target.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        :host, .wuf-caption-host {
          position: absolute;
          bottom: 68px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 55;
          pointer-events: none;
          display: none;
          text-align: center;
          max-width: 90%;
          transition: bottom 0.15s ease-out;
        }
        .wuf-caption-window {
          display: inline-block;
          background-color: rgba(8, 8, 8, 0.75);
          color: #ffffff;
          padding: 3px 8px;
          border-radius: 2px;
          box-sizing: border-box;
          max-width: 100%;
        }
        .wuf-caption-segment {
          font-family: "YouTube Noto", Roboto, "Helvetica Neue", Arial, sans-serif;
          font-size: calc(20px * var(--wuf-caption-scale, 1));
          font-weight: 500;
          line-height: 1.35;
          letter-spacing: 0.02em;
          text-shadow: rgba(0, 0, 0, 0.8) 0px 0px 2px, rgba(0, 0, 0, 0.5) 0px 1px 2px;
          white-space: pre-wrap;
          word-break: break-word;
        }
      `;
      const container = document.createElement('div');
      container.className = 'wuf-caption-window';
      segment = document.createElement('span');
      segment.className = 'wuf-caption-segment';
      container.appendChild(segment);
      shadow.appendChild(style);
      shadow.appendChild(container);
    } catch {
      // Best-effort shadow
    }
  } else if (shadow) {
    segment = shadow.querySelector('.wuf-caption-segment');
  }

  // Ensure default positioning styles directly on target element
  if (target.style) {
    target.style.position = 'absolute';
    target.style.bottom = target.style.bottom || '68px';
    target.style.left = '50%';
    target.style.transform = 'translateX(-50%)';
    target.style.zIndex = '55';
    target.style.pointerEvents = 'none';
    if (!target.style.display) {
      target.style.display = 'none';
    }
    target.style.textAlign = 'center';
    target.style.maxWidth = '90%';
    target.style.transition = 'bottom 0.15s ease-out';
  }

  target.setCue = function (text: string, scale: number = 1.0): void {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      target.clear();
      return;
    }
    if (target.style) {
      target.style.display = 'block';
      target.style.setProperty('--wuf-caption-scale', String(scale));
    }
    const seg = segment || target.shadowRoot?.querySelector('.wuf-caption-segment');
    if (seg) {
      seg.textContent = trimmed;
    } else {
      target.textContent = trimmed;
    }
  };

  target.clear = function (): void {
    if (target.style) {
      target.style.display = 'none';
    }
    const seg = segment || target.shadowRoot?.querySelector('.wuf-caption-segment');
    if (seg) {
      seg.textContent = '';
    } else {
      target.textContent = '';
    }
  };

  target.updateAvoidance = function (controlsVisible: boolean): void {
    if (target.style) {
      target.style.bottom = controlsVisible ? '68px' : '24px';
    }
  };

  target.setScale = function (scale: number): void {
    if (target.style) {
      target.style.setProperty('--wuf-caption-scale', String(scale));
    }
  };

  return target;
}

const BaseElement = (
  typeof HTMLElement !== 'undefined' ? HTMLElement : class {}
) as unknown as typeof HTMLElement;

/**
 * Web Component: <wuf-subtitle-overlay>
 * Replicates YouTube's native subtitle appearance 1:1 inside a sealed Shadow DOM:
 * - Pure monolingual display (no dual-line stacking).
 * - Exact YouTube Noto font, text shadow, transparent dark background, 2px border radius.
 * - Dynamic bottom clearance for playback controls bar.
 */
export class WufSubtitleOverlayElement extends BaseElement implements WufOverlayElement {
  constructor() {
    super();
    if (typeof HTMLElement !== 'undefined') {
      bindOverlayMethods(this as unknown as HTMLElement);
    }
  }

  public setScale(scale: number): void {
    bindOverlayMethods(this as unknown as HTMLElement).setScale(scale);
  }

  public setCue(text: string, scale: number = 1.0): void {
    bindOverlayMethods(this as unknown as HTMLElement).setCue(text, scale);
  }

  public clear(): void {
    bindOverlayMethods(this as unknown as HTMLElement).clear();
  }

  public updateAvoidance(controlsVisible: boolean): void {
    bindOverlayMethods(this as unknown as HTMLElement).updateAvoidance(controlsVisible);
  }
}

if (
  typeof customElements !== 'undefined' &&
  customElements &&
  typeof customElements.get === 'function' &&
  !customElements.get('wuf-subtitle-overlay')
) {
  try {
    customElements.define('wuf-subtitle-overlay', WufSubtitleOverlayElement);
  } catch {
    // Already defined or unsupported
  }
}

export function initYouTubeContentScript(): WufYouTubeNamespace {
  const normalizeCaptionKey = (text: string): string => {
    return (text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };


  const state = {
    active: false,
    rawSegments: [] as AsrRawSegment[],
    displayCues: [] as WufYouTubeDisplayCue[],
    translatedWindows: new Set<number>(),
    translatingWindows: new Set<number>(),
    sessionGen: 0,
  };

  const warmupSubtitleModel = async () => {
    try {
      await sendWufRuntimeMessage({
        type: 'wuf:warmup-youtube',
      });
    } catch {
      // Warmup failure must never break YouTube activation
    }
  };

  let captionScale = 1.0;

  // Ensures existing conceal style is removed so YouTube native subtitles stay visible
  const removeConcealStyles = () => {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('wuf-yt-conceal-style');
    if (existing) existing.remove();
  };

  const toggleSubtitlesActiveClasses = (active: boolean) => {
    if (typeof document === 'undefined') return;
    removeConcealStyles();
    if (document.body) {
      document.body.classList.toggle('wuf-subtitles-active', active);
    }
    const player =
      document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-player');
    if (player) {
      player.classList.toggle('wuf-subtitles-active', active);
      if (!active) player.classList.remove('wuf-translated-cue-visible');
    }
  };

  const ensureNativeCaptionsEnabled = (enable: boolean = true) => {
    if (typeof document === 'undefined') return;
    const ccBtn = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (ccBtn) {
      const isCcOn = ccBtn.getAttribute('aria-pressed') === 'true';
      if (enable && !isCcOn) {
        ccBtn.click();
      } else if (!enable && isCcOn) {
        ccBtn.click();
      }
    }
    globalThis.window?.dispatchEvent(
      new CustomEvent('wuf-yt-set-caption-state', {
        detail: { enabled: enable },
      }),
    );
  };

  // Cache sentence translations; each occurrence keeps its own display timeline.
  const subtitleTranslationCache = new Map<string, string>();

  const STATUS_BADGE_ID = '__wuf_yt_caption_status';
  let captionStatusTimer: ReturnType<typeof setInterval> | null = null;

  const hideCaptionStatus = () => {
    if (typeof document === 'undefined') return;
    if (captionStatusTimer) {
      clearInterval(captionStatusTimer);
      captionStatusTimer = null;
    }
    const el = document.getElementById(STATUS_BADGE_ID);
    if (el) el.remove();
    document.querySelectorAll('.wuf-caption-placeholder').forEach(p => p.remove());
  };

  const updateCaptionStatusPosition = (statusEl: HTMLElement) => {
    if (!statusEl.parentElement) return;
    const captionWindow = document.querySelector<HTMLElement>(
      '.caption-window:not(#' + STATUS_BADGE_ID + ')'
    );
    if (captionWindow && captionWindow.offsetHeight > 0) {
      const contRect = statusEl.parentElement.getBoundingClientRect();
      const capRect = captionWindow.getBoundingClientRect();
      const ourH = statusEl.offsetHeight || 26;
      const relTop = capRect.top - contRect.top - ourH - 6;
      const relLeft = capRect.left - contRect.left + capRect.width / 2;
      statusEl.style.top = Math.max(8, relTop) + 'px';
      statusEl.style.bottom = '';
      statusEl.style.left = relLeft + 'px';
      statusEl.style.transform = 'translateX(-50%)';
    } else {
      statusEl.style.top = '';
      statusEl.style.bottom = '68px';
      statusEl.style.left = '50%';
      statusEl.style.transform = 'translateX(-50%)';
    }
  };

  const showCaptionStatus = (text: string = '翻譯中...') => {
    if (typeof document === 'undefined' || !state.active) return;
    const container =
      document.querySelector<HTMLElement>('.ytp-caption-window-container') ||
      document.querySelector<HTMLElement>('#movie_player') ||
      document.querySelector<HTMLElement>('.html5-video-player');
    if (!container) return;

    let statusEl = document.getElementById(STATUS_BADGE_ID) as HTMLElement | null;
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = STATUS_BADGE_ID;
      statusEl.style.position = 'absolute';
      statusEl.style.bottom = '68px';
      statusEl.style.left = '50%';
      statusEl.style.transform = 'translateX(-50%)';
      statusEl.style.zIndex = '60';
      statusEl.style.pointerEvents = 'none';
      statusEl.style.backgroundColor = 'rgba(8, 8, 8, 0.75)';
      statusEl.style.color = '#ffffff';
      statusEl.style.fontFamily = '"YouTube Noto", Roboto, Arial, sans-serif';
      statusEl.style.fontSize = '14px';
      statusEl.style.lineHeight = '1.4';
      statusEl.style.padding = '3px 8px';
      statusEl.style.borderRadius = '2px';
      statusEl.style.whiteSpace = 'nowrap';
      statusEl.style.textAlign = 'center';
      statusEl.style.transition = 'bottom 0.15s ease-out';
      container.appendChild(statusEl);

      if (captionStatusTimer) clearInterval(captionStatusTimer);
      captionStatusTimer = setInterval(() => {
        const el = document.getElementById(STATUS_BADGE_ID);
        if (el) {
          updateCaptionStatusPosition(el);
        } else if (captionStatusTimer) {
          clearInterval(captionStatusTimer);
          captionStatusTimer = null;
        }
      }, 250);
    }
    statusEl.textContent = text;
    updateCaptionStatusPosition(statusEl);
  };

  const ensureOverlayElement = (): WufOverlayElement | null => {
    if (typeof document === 'undefined') return null;
    removeConcealStyles();

    const player =
      document.querySelector('#movie_player') ||
      document.querySelector('.html5-video-player');
    if (!player) return null;
    if (!document.getElementById('wuf-yt-cue-visibility')) {
      const style = document.createElement('style');
      style.id = 'wuf-yt-cue-visibility';
      style.textContent = '.wuf-translated-cue-visible .ytp-caption-window-container, .wuf-translated-cue-visible #ytp-caption-window-container { visibility: hidden !important; }';
      document.head.appendChild(style);
    }
    let overlay = player.querySelector<HTMLElement>('wuf-subtitle-overlay, .wuf-subtitle-overlay');
    if (!overlay) {
      overlay = document.createElement('wuf-subtitle-overlay');
      overlay.className = 'wuf-subtitle-overlay';
      overlay.setAttribute('data-wuf-injected', 'true');
      player.appendChild(overlay);
    }
    return bindOverlayMethods(overlay);
  };

  const updateActiveCues = (nowSec: number) => {
    const overlay = ensureOverlayElement();
    if (overlay && typeof document !== 'undefined') {
      const player =
        document.querySelector('#movie_player') ||
        document.querySelector('.html5-video-player');
      if (player) {
        renderYouTubeDisplayCue(player as HTMLElement, overlay, state.displayCues, nowSec * 1000, state.active, captionScale);
        if (player.classList.contains('wuf-translated-cue-visible')) hideCaptionStatus();
        overlay.updateAvoidance(!player.classList.contains('ytp-autohide'));
      }
    }
  };

  const bindVideoListeners = () => {
    if (typeof document === 'undefined') return;
    const video = document.querySelector<HTMLVideoElement>('video');
    if (!video || (video as unknown as { __wufBound?: boolean }).__wufBound) return;
    (video as unknown as { __wufBound?: boolean }).__wufBound = true;
    removeConcealStyles();

    video.addEventListener('timeupdate', () => {
      if (!state.active) return;
      const current = video.currentTime;
      updateActiveCues(current);
      void triggerAheadOfTimeWorker(current);
    });
    video.addEventListener('seeked', () => updateActiveCues(video.currentTime));
  };

  const appendSentenceCues = (sentence: MergedAsrSentence, translation: string) => {
    const text = translation.replace(/\r?\n/g, ' ').trim();
    if (!text) return;
    subtitleTranslationCache.set(normalizeCaptionKey(sentence.text), text);
    if (state.displayCues.some(c => c.startMs === sentence.startMs && c.sourceText === sentence.text)) return;
    const pieces = splitLongSubtitleCue(sentence.startMs, sentence.endMs, text, sentence.sourceSegs.map(s => s.startMs));
    state.displayCues.push(...pieces.map(piece => ({ ...piece, sourceText: sentence.text })));
    if (typeof document !== 'undefined') {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video) updateActiveCues(video.currentTime);
    }
  };

  const translateWindowByIndex = async (
    windowIndex: number,
    gen: number,
  ): Promise<boolean> => {
    if (
      !state.active ||
      gen !== state.sessionGen ||
      state.translatedWindows.has(windowIndex) ||
      state.translatingWindows.has(windowIndex) ||
      state.rawSegments.length === 0
    ) {
      return false;
    }

    const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
      type: 'wuf:get-settings',
    });
    if (!snapResp.ok || !state.active || gen !== state.sessionGen) return false;
    const sub = snapResp.data.runtimeSettings.subtitles;
    const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
    const windowStartMs = windowIndex * windowMs;
    const windowEndMs = windowStartMs + windowMs;

    const windowSegs = state.rawSegments.filter(
      s => s.startMs >= windowStartMs && s.startMs < windowEndMs,
    );

    if (windowSegs.length === 0) {
      state.translatedWindows.add(windowIndex);
      return true;
    }

    state.translatingWindows.add(windowIndex);

    try {
      const merged = heuristicMergeAsr(windowSegs, 'auto');
      if (merged.length === 0) {
        state.translatedWindows.add(windowIndex);
        return true;
      }

      const isLocal = sub?.engine === 'openai-compat-local';

      if (isLocal) {
        // Local translation models receive complete sentence groups sequentially.
        for (const sentence of merged) {
          if (!state.active || gen !== state.sessionGen) return false;
          const cached = subtitleTranslationCache.get(normalizeCaptionKey(sentence.text));
          if (cached !== undefined) {
            // Repeated dialogue still needs cues at its own timestamps.
            appendSentenceCues(sentence, cached);
            continue;
          }
          const response = await sendWufRuntimeMessage<TranslationResponse>({
            type: 'wuf:translate-text',
            request: {
              texts: [sentence.text], targetLanguage: sub.targetLanguage,
              engine: sub.engine, purpose: 'subtitle',
              modelOverride: sub.customModelOverride || undefined,
            },
          });
          if (!state.active || gen !== state.sessionGen) return false;
          if (!response.ok || !response.data.translations[0]) return false;
          appendSentenceCues(sentence, response.data.translations[0]);
        }
      } else {
        const response = await sendWufRuntimeMessage<TranslationResponse>({
          type: 'wuf:translate-text',
          request: {
            texts: merged.map(sentence => sentence.text), targetLanguage: sub.targetLanguage,
            engine: sub.engine, purpose: 'subtitle',
            modelOverride: sub.customModelOverride || undefined,
          },
        });
        if (!response.ok || !state.active || gen !== state.sessionGen) return false;
        merged.forEach((sentence, index) => {
          const translation = response.data.translations[index];
          if (translation) appendSentenceCues(sentence, translation);
        });
      }
      state.translatedWindows.add(windowIndex);
      return true;
    } finally {
      state.translatingWindows.delete(windowIndex);
    }
  };

  let aheadOfTimeWorkerRunning = false;

  const triggerAheadOfTimeWorker = async (currentSec: number) => {
    if (aheadOfTimeWorkerRunning || !state.active || state.rawSegments.length === 0) return;
    aheadOfTimeWorkerRunning = true;
    const myGen = state.sessionGen;

    try {
      const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
        type: 'wuf:get-settings',
      });
      if (!snapResp.ok) return;
      const sub = snapResp.data.runtimeSettings.subtitles;
      const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
      const maxLookaheadWindows = 2; // Pre-buffer up to 60~90 seconds ahead

      while (state.active && myGen === state.sessionGen) {
        const video =
          typeof document !== 'undefined'
            ? document.querySelector<HTMLVideoElement>('video')
            : null;
        const nowMs = video ? video.currentTime * 1000 : currentSec * 1000;
        const currentWin = Math.floor(nowMs / windowMs);

        let candidateWin: number | null = null;
        for (let offset = 0; offset <= maxLookaheadWindows; offset++) {
          const wIdx = currentWin + offset;
          if (!state.translatedWindows.has(wIdx) && !state.translatingWindows.has(wIdx)) {
            const hasSegs = state.rawSegments.some(
              s => s.startMs >= wIdx * windowMs && s.startMs < (wIdx + 1) * windowMs,
            );
            if (hasSegs) {
              candidateWin = wIdx;
              break;
            } else {
              state.translatedWindows.add(wIdx);
            }
          }
        }

        if (candidateWin === null) {
          break;
        }

        if (!await translateWindowByIndex(candidateWin, myGen)) break;
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      aheadOfTimeWorkerRunning = false;
    }
  };

  const translateWindowAt = async (currentTimeSec: number) => {
    if (!state.active || state.rawSegments.length === 0) return;
    const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
      type: 'wuf:get-settings',
    });
    if (!snapResp.ok) return;
    const sub = snapResp.data.runtimeSettings.subtitles;
    const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
    const currentWin = Math.floor(Math.max(0, currentTimeSec * 1000) / windowMs);
    await translateWindowByIndex(currentWin, state.sessionGen);
    void triggerAheadOfTimeWorker(currentTimeSec);
  };

  const forceSubtitleReload = () => {
    if (typeof document === 'undefined') return;
    const ccBtn = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (ccBtn) {
      const isCcOn = ccBtn.getAttribute('aria-pressed') === 'true';
      if (isCcOn) {
        ccBtn.click();
        setTimeout(() => {
          if (state.active) {
            ccBtn.click();
          }
        }, 80);
      } else {
        ccBtn.click();
      }
    }
    globalThis.window?.dispatchEvent(new CustomEvent('wuf-yt-request-tracks'));
  };

  const translateYouTubeSubtitles = async () => {
    state.active = true;
    toggleSubtitlesActiveClasses(true);
    ensureNativeCaptionsEnabled(true);
    if (state.rawSegments.length === 0) {
      forceSubtitleReload();
    }
    showCaptionStatus('翻譯中...');
    ensureOverlayElement();
    bindVideoListeners();
    updatePlayerButtonState();
    await warmupSubtitleModel();

    if (typeof document !== 'undefined') {
      globalThis.window?.dispatchEvent(new CustomEvent('wuf-yt-request-tracks'));
    }

    const video =
      typeof document !== 'undefined'
        ? document.querySelector<HTMLVideoElement>('video')
        : null;
    updateActiveCues(video?.currentTime ?? 0);
    void triggerAheadOfTimeWorker(video?.currentTime ?? 0);
    return { ok: true, active: state.active };
  };

  const wufNs: WufYouTubeNamespace = {
    YT: state,
    chooseBestCaptionTrack,
    heuristicMergeAsr,
    refineAsrBoundaries,
    parseAsrLlmOutput,
    resolveAsrEntryTimeline,
    splitLongSubtitleCue,
    translateYouTubeSubtitles,
    translateWindowAt,
    planSubtitleWindowBatch,
  };

  if (typeof globalThis.window !== 'undefined') {
    (globalThis.window as unknown as { __WUF?: WufYouTubeNamespace }).__WUF = wufNs;
    globalThis.window.addEventListener('wuf-timedtext-captured', (ev: Event) => {
      const detail = (ev as CustomEvent<{ data?: unknown; rawText?: string }>).detail;
      const raw = detail?.rawText || detail?.data;
      if (raw) {
        const segments = parseCaptionResponse(raw);
        if (segments.length > 0) {
          state.rawSegments = segments;
          state.translatedWindows.clear();
          state.translatingWindows.clear();
          state.displayCues = [];
          subtitleTranslationCache.clear();
          state.sessionGen++;
          const video = document.querySelector<HTMLVideoElement>('video');
          updateActiveCues(video?.currentTime ?? 0);
          if (state.active) {
            void triggerAheadOfTimeWorker(video?.currentTime ?? 0);
          }
        }
      }
    });

    globalThis.window.addEventListener('wuf-yt-tracks-response', (ev: Event) => {
      const detail = (ev as CustomEvent<{
        tracks?: CaptionTrackInfo[];
        activeTrack?: CaptionTrackInfo;
      }>).detail;
      if (Array.isArray(detail?.tracks) && detail.tracks.length > 0) {
        const choice = chooseBestCaptionTrack(
          detail.tracks,
          detail.activeTrack,
          'zh-TW',
        );
        if (choice.track && choice.action !== 'skip') {
          globalThis.window.dispatchEvent(
            new CustomEvent('wuf-yt-set-track', {
              detail: {
                languageCode: choice.track.languageCode,
                kind: choice.track.kind,
              },
            }),
          );
        }
      }
    });
  }

  if (isYouTubeWatchPage()) {
    void warmupSubtitleModel();
  }

  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.runtime?.onMessage) {
    globalThis.chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      if (msg && typeof msg === 'object') {
        const m = msg as { type?: string; payload?: { enabled?: boolean; scale?: number } };
        if (m.type === 'wuf:activate-youtube-subtitles') {
          translateYouTubeSubtitles()
            .then(res => sendResponse(res))
            .catch(err => {
              sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
            });
          return true;
        }
        if (m.type === 'wuf:set-youtube-subtitle-state') {
          state.active = Boolean(m.payload?.enabled);
          toggleSubtitlesActiveClasses(state.active);
          ensureNativeCaptionsEnabled(state.active);
          if (state.active) {
            if (state.rawSegments.length === 0) {
              forceSubtitleReload();
            }
            showCaptionStatus('翻譯中...');
            ensureOverlayElement();
            bindVideoListeners();
            const video = document.querySelector<HTMLVideoElement>('video');
            updateActiveCues(video?.currentTime ?? 0);
            if (video) void triggerAheadOfTimeWorker(video.currentTime);
          } else {
            hideCaptionStatus();
            const overlay = ensureOverlayElement();
            if (overlay) overlay.clear();
          }
          updatePlayerButtonState();
          sendResponse({ ok: true, active: state.active });
          return false;
        }
        if (m.type === 'wuf:set-youtube-caption-scale') {
          captionScale = (m.payload?.scale ?? 100) / 100;
          const overlay = ensureOverlayElement();
          if (overlay) overlay.setScale(captionScale);
          sendResponse({ ok: true, scale: captionScale });
          return false;
        }
        if (m.type === 'wuf:get-youtube-state') {
          sendResponse({
            ok: true,
            active: state.active,
            captionScale: Math.round(captionScale * 100),
            isWatchPage: isYouTubeWatchPage(),
            rawSegmentsCount: state.rawSegments.length,
            translatedWindowsCount: state.translatedWindows.size,
          });
          return false;
        }
      }
      return false;
    });
  }

  // ─── 手動字幕翻譯按鈕（注入 YouTube 播放器控制列與快捷鍵）──────────
  const BTN_ID = '__wuf_yt_trans_btn';

  const _WUF_YT_ICON_SVG = `
    <g class="__wuf_yt_icon_off" style="display: block;">
      <rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="none" stroke="#ffffff" stroke-width="1.8"/>
      <g transform="translate(12, 12) scale(0.58) translate(-12, -12)">
        <path fill="#ffffff" d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </g>
    </g>
    <g class="__wuf_yt_icon_on" style="display: none;">
      <rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="#ffffff"/>
      <g transform="translate(12, 12) scale(0.58) translate(-12, -12)">
        <path fill="#0f0f0f" d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
      </g>
    </g>
  `;

  function updatePlayerButtonState() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    const active = state.active === true;
    const targetState = active ? 'true' : 'false';

    if (btn.getAttribute('data-active') === targetState) return;
    btn.setAttribute('data-active', targetState);
    btn.setAttribute('aria-pressed', targetState);
    btn.title = active ? '點擊關閉 WUF AI 字幕翻譯 (Alt+C)' : '點擊開啟 WUF AI 字幕翻譯 (Alt+C)';

    const offGroup = btn.querySelector('.__wuf_yt_icon_off') as HTMLElement | null;
    const onGroup = btn.querySelector('.__wuf_yt_icon_on') as HTMLElement | null;
    if (offGroup) offGroup.style.display = active ? 'none' : 'block';
    if (onGroup) onGroup.style.display = active ? 'block' : 'none';
  }

  let isInjectingButton = false;

  function injectPlayerButton() {
    if (isInjectingButton || typeof document === 'undefined') return;
    isInjectingButton = true;
    try {
      const rightControls = document.querySelector('.ytp-right-controls');
      if (!rightControls) return;

      const ccBtn = rightControls.querySelector('.ytp-subtitles-button');
      const anchor = (ccBtn && ccBtn.parentNode === rightControls)
        ? ccBtn
        : (ccBtn ? ccBtn.closest('.ytp-right-controls > *') : null);
      const target = anchor || rightControls.querySelector('.ytp-settings-button') || rightControls.firstChild;

      let btn = document.getElementById(BTN_ID) as HTMLButtonElement | null;
      if (btn) {
        if (btn.parentNode === rightControls) {
          if (anchor && anchor.parentNode === rightControls && btn.nextSibling !== anchor) {
            rightControls.insertBefore(btn, anchor);
          }
        } else {
          if (target && target.parentNode === rightControls && target !== btn) {
            rightControls.insertBefore(btn, target);
          } else {
            rightControls.appendChild(btn);
          }
        }
        updatePlayerButtonState();
        return;
      }

      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.className = 'ytp-button __wuf_yt_btn';
      btn.type = 'button';
      btn.style.position = 'relative';
      btn.style.width = '48px';
      btn.style.height = '100%';
      btn.style.verticalAlign = 'top';
      btn.style.cursor = 'pointer';
      btn.style.display = 'inline-flex';
      btn.style.alignItems = 'center';
      btn.style.justifyContent = 'center';
      btn.setAttribute('aria-label', 'WUF AI 字幕翻譯 (Alt+C)');

      const active = state.active === true;
      btn.setAttribute('data-active', active ? 'true' : 'false');
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.title = active ? '點擊關閉 WUF AI 字幕翻譯 (Alt+C)' : '點擊開啟 WUF AI 字幕翻譯 (Alt+C)';

      btn.innerHTML = `
        <svg class="__wuf_yt_icon" viewBox="0 0 24 24" width="22" height="22">
          ${_WUF_YT_ICON_SVG}
        </svg>
      `;

      const offGroup = btn.querySelector('.__wuf_yt_icon_off') as HTMLElement | null;
      const onGroup = btn.querySelector('.__wuf_yt_icon_on') as HTMLElement | null;
      if (offGroup) offGroup.style.display = active ? 'none' : 'block';
      if (onGroup) onGroup.style.display = active ? 'block' : 'none';

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (state.active) {
          state.active = false;
          toggleSubtitlesActiveClasses(false);
          ensureNativeCaptionsEnabled(false);
          hideCaptionStatus();
          const overlay = ensureOverlayElement();
          if (overlay) overlay.clear();
          updatePlayerButtonState();
        } else {
          showCaptionStatus('翻譯中...');
          void translateYouTubeSubtitles().then(() => {
            updatePlayerButtonState();
          });
        }
      });

      if (target && target.parentNode === rightControls && target !== btn) {
        rightControls.insertBefore(btn, target);
      } else {
        rightControls.appendChild(btn);
      }
    } finally {
      isInjectingButton = false;
    }
  }

  if (typeof globalThis.window !== 'undefined') {
    globalThis.window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target && ['input', 'textarea'].includes((e.target as HTMLElement).tagName?.toLowerCase())) return;
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        if (state.active) {
          state.active = false;
          toggleSubtitlesActiveClasses(false);
          ensureNativeCaptionsEnabled(false);
          hideCaptionStatus();
          const overlay = ensureOverlayElement();
          if (overlay) overlay.clear();
          updatePlayerButtonState();
        } else {
          showCaptionStatus('翻譯中...');
          void translateYouTubeSubtitles().then(() => {
            updatePlayerButtonState();
          });
        }
      }
    }, true);

    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      let injectTimer: ReturnType<typeof setTimeout> | null = null;
      const playerObserver = new MutationObserver(() => {
        if (injectTimer) return;
        injectTimer = setTimeout(() => {
          injectTimer = null;
          if (document.querySelector('.ytp-right-controls')) {
            injectPlayerButton();
            bindVideoListeners();
          }
        }, 150);
      });
      const targetNode = document.body || document.documentElement;
      if (targetNode) {
        playerObserver.observe(targetNode, { childList: true, subtree: true });
      }
    }

    const onYtNavigate = () => {
      injectPlayerButton();
      bindVideoListeners();
    };

    globalThis.window.addEventListener('yt-navigate-finish', onYtNavigate);
    globalThis.window.addEventListener('yt-page-data-updated', onYtNavigate);
    globalThis.window.addEventListener('spfdone', onYtNavigate);

    // Initial polling guarantee for dynamic player controls mount
    let pollCount = 0;
    const pollInterval = setInterval(() => {
      pollCount++;
      if (document.querySelector('.ytp-right-controls')) {
        injectPlayerButton();
        bindVideoListeners();
      }
      if (pollCount > 15) {
        clearInterval(pollInterval);
      }
    }, 500);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectPlayerButton);
    } else {
      injectPlayerButton();
    }
  }

  return wufNs;
}

initYouTubeContentScript();
