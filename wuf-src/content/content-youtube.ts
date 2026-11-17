import type { SettingsSnapshotPayload, TranslationResponse } from '../types.ts';
import { sendWufRuntimeMessage } from '../lib/runtime-client.ts';
import {
  areCaptionSegmentsEqual,
  chooseBestCaptionTrack,
  createSubtitleWorker,
  findPrepaintSnapMs,
  getCurrentWatchVideoId,
  heuristicMergeAsr,
  parseAsrLlmOutput,
  parseCaptionResponse,
  planSubtitleWindowBatch,
  resolveAsrEntryTimeline,
  splitLongSubtitleCue,
  type AsrRawSegment,
  type CaptionTrackInfo,
  type MergedAsrSentence,
  type SplitCuePiece,
  type SubtitleDiagnosticEvent,
  type SubtitleSession,
  type SubtitleWorkerEngine,
  type WorkerResult,
  type WorkerSentence,
} from '../subtitle/youtube-pipeline.ts';

export interface WufYouTubeDisplayCue extends SplitCuePiece {
  sourceText?: string;
  sentenceId?: string;
}

export interface WufYouTubeNamespace {
  YT: {
    active: boolean;
    rawSegments: AsrRawSegment[];
    displayCues: WufYouTubeDisplayCue[];
    translatedWindows: Set<number>;
    translatingWindows?: Set<number>;
    sessionGen?: number;
    diagnostics?: SubtitleDiagnosticEvent[];
  };
  chooseBestCaptionTrack: typeof chooseBestCaptionTrack;
  heuristicMergeAsr: typeof heuristicMergeAsr;
  parseAsrLlmOutput: typeof parseAsrLlmOutput;
  resolveAsrEntryTimeline: typeof resolveAsrEntryTimeline;
  splitLongSubtitleCue: typeof splitLongSubtitleCue;
  translateYouTubeSubtitles: () => Promise<{ ok: boolean; active: boolean }>;
  translateWindowAt?: (currentTimeSec: number) => Promise<void>;
  planSubtitleWindowBatch?: typeof planSubtitleWindowBatch;
  requestSubtitleWork?: () => void;
  destroy?: () => void;
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
  const state = {
    active: false,
    rawSegments: [] as AsrRawSegment[],
    mergedSentences: [] as MergedAsrSentence[],
    mergedSentencesSource: null as AsrRawSegment[] | null,
    displayCues: [] as WufYouTubeDisplayCue[],
    translatedWindows: new Set<number>(),
    translatingWindows: new Set<number>(),
    translatedSentenceKeys: new Set<string>(),
    sessionGen: 1,
    sourceLanguage: 'auto',
    targetLanguage: 'zh-TW',
    isAsr: false,
    videoId: getCurrentWatchVideoId(),
    cachedSubtitlesConfig: undefined as SettingsSnapshotPayload['runtimeSettings']['subtitles'] | undefined,
    diagnostics: [] as SubtitleDiagnosticEvent[],
  };

  let inFlightSettingsPromise: Promise<SettingsSnapshotPayload | null> | null = null;
  let inFlightWarmupPromise: Promise<void> | null = null;
  let boundConfigSignature: string | null = null;
  let boundSessionGen = 0;
  let settingsReadSeq = 0;
  let settingsSynchronizing = false;
  let disposed = false;

  const computeConfigSignature = (snap: SettingsSnapshotPayload): string =>
    JSON.stringify([snap.runtimeSettings.subtitles, snap.subtitleProvider]);

  const applySettingsSnapshot = (snap: SettingsSnapshotPayload) => {
    const sub = snap.runtimeSettings.subtitles;
    state.cachedSubtitlesConfig = sub;
    if (sub.targetLanguage) {
      state.targetLanguage = sub.targetLanguage;
    }
    if (boundConfigSignature === null) {
      boundConfigSignature = computeConfigSignature(snap);
    }
  };

  const syncSubtitlesSettings = async (): Promise<SettingsSnapshotPayload | null> => {
    if (inFlightSettingsPromise) return inFlightSettingsPromise;
    const p = (async () => {
      try {
        const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
          type: 'wuf:get-settings',
        });
        if (snapResp.ok) {
          applySettingsSnapshot(snapResp.data);
          return snapResp.data;
        }
      } catch {
        // Ignore settings read failures before initialization
      }
      return null;
    })();
    inFlightSettingsPromise = p;
    try {
      return await p;
    } finally {
      if (inFlightSettingsPromise === p) {
        inFlightSettingsPromise = null;
      }
    }
  };

  const warmupSubtitleModel = async () => {
    if (inFlightWarmupPromise) return inFlightWarmupPromise;
    const p = (async () => {
      try {
        const snap = state.cachedSubtitlesConfig ? null : await syncSubtitlesSettings();
        const engine = state.cachedSubtitlesConfig?.engine ?? snap?.runtimeSettings.subtitles.engine;
        if (engine === 'openai-compat-local') {
          await sendWufRuntimeMessage({ type: 'wuf:warmup-youtube' });
        }
      } catch {
        // Warmup failure must never break YouTube activation
      }
    })();
    inFlightWarmupPromise = p;
    try {
      await p;
    } finally {
      if (inFlightWarmupPromise === p) {
        inFlightWarmupPromise = null;
      }
    }
  };

  let captionScale = 1.0;
  let lastCcAutoEnableMs = 0;

  const getActivePlayer = (): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    return (
      document.querySelector<HTMLElement>('#movie_player') ||
      document.querySelector<HTMLElement>('.html5-video-player')
    );
  };

  const getActiveVideo = (): HTMLVideoElement | null => {
    if (typeof document === 'undefined') return null;
    return (
      document.querySelector<HTMLVideoElement>('#movie_player video, .html5-video-player video') ||
      document.querySelector<HTMLVideoElement>('video')
    );
  };

  const toggleSubtitlesActiveClasses = (active: boolean) => {
    if (typeof document === 'undefined') return;
    if (document.body) {
      document.body.classList.toggle('wuf-subtitles-active', active);
    }
    const player = getActivePlayer();
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
        lastCcAutoEnableMs = Date.now();
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

  const STATUS_BADGE_ID = '__wuf_yt_caption_status';
  let captionStatusTimer: ReturnType<typeof setInterval> | null = null;
  let cueBoundaryTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingSentenceKey: string | null = null;
  let waitingBadgeReady = false;
  let sessionTerminalErrorText: string | null = null;
  let currentWorkerSentences: WorkerSentence[] = [];
  let activationAtMs: number | null = null;
  let captionsReadyAtMs: number | null = null;
  let seekAtMs: number | null = null;
  let recordedFirstCueGen = 0;

  const clearWaitingStatusTimer = (resetKey: boolean = true) => {
    if (waitingStatusTimer !== null) {
      clearTimeout(waitingStatusTimer);
      waitingStatusTimer = null;
    }
    if (resetKey) {
      waitingSentenceKey = null;
      waitingBadgeReady = false;
    }
  };

  const clearCueBoundaryTimer = () => {
    if (cueBoundaryTimer !== null) {
      clearTimeout(cueBoundaryTimer);
      cueBoundaryTimer = null;
    }
  };

  const hideCaptionStatus = () => {
    if (typeof document === 'undefined') return;
    if (captionStatusTimer) {
      clearInterval(captionStatusTimer);
      captionStatusTimer = null;
    }
    const el = document.getElementById(STATUS_BADGE_ID);
    if (el) el.remove();
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
      document.querySelector<HTMLElement>('#movie_player') ||
      document.querySelector<HTMLElement>('.html5-video-player') ||
      document.querySelector<HTMLElement>('.ytp-caption-window-container');
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

    const player = getActivePlayer();
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
    if (typeof (overlay as Partial<WufOverlayElement>).setCue === 'function') {
      return overlay as unknown as WufOverlayElement;
    }
    return bindOverlayMethods(overlay);
  };

  const getCaptionContainer = (player?: HTMLElement | null): HTMLElement | null => {
    if (typeof document === 'undefined') return null;
    const root = player ?? getActivePlayer();
    return (
      root?.querySelector<HTMLElement>('.ytp-caption-window-container, #ytp-caption-window-container') ||
      document.querySelector<HTMLElement>('.ytp-caption-window-container, #ytp-caption-window-container')
    );
  };

  const hasVisibleNativeCaptionText = (container: Element): boolean => {
    const segments = container.querySelectorAll('.ytp-caption-segment');
    for (const seg of segments) {
      if (!seg.closest(`#${STATUS_BADGE_ID}`) && (seg.textContent || '').trim()) {
        return true;
      }
    }
    const windows = container.querySelectorAll(`.caption-window:not(#${STATUS_BADGE_ID})`);
    for (const win of windows) {
      if ((win.textContent || '').trim()) {
        return true;
      }
    }
    return false;
  };

  const scheduleCueBoundaryTimer = (video: HTMLVideoElement | null, nowMs: number) => {
    clearCueBoundaryTimer();
    if (!state.active || !video || video.paused || state.displayCues.length === 0) return;

    let nextBoundaryMs = Infinity;
    for (const cue of state.displayCues) {
      if (cue.startMs > nowMs && cue.startMs < nextBoundaryMs) {
        nextBoundaryMs = cue.startMs;
      }
      if (cue.startMs <= nowMs && nowMs <= cue.endMs) {
        const endTick = cue.endMs + 1;
        if (endTick > nowMs && endTick < nextBoundaryMs) {
          nextBoundaryMs = endTick;
        }
      }
    }

    if (!Number.isFinite(nextBoundaryMs)) return;
    const playbackRate = video.playbackRate > 0 ? video.playbackRate : 1;
    const delayMs = Math.max(1, Math.min(30_000, Math.round((nextBoundaryMs - nowMs) / playbackRate)));
    cueBoundaryTimer = setTimeout(() => {
      cueBoundaryTimer = null;
      if (!state.active) return;
      const activeVideo = getActiveVideo();
      if (!activeVideo) return;
      updateActiveCues(activeVideo.currentTime);
    }, delayMs);
  };

  let captionObserver: MutationObserver | null = null;
  let observedCaptionContainer: Element | null = null;
  let syncingFromCaptionMutation = false;

  const ensureCaptionContainerObserver = (player?: HTMLElement | null) => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const container = getCaptionContainer(player);
    if (!container || container === observedCaptionContainer) return;
    if (captionObserver) {
      captionObserver.disconnect();
    }
    observedCaptionContainer = container;
    captionObserver = new MutationObserver((mutations) => {
      if (!state.active || syncingFromCaptionMutation) return;
      const isStatusBadgeOnly = mutations.every((m) => {
        const targetEl = m.target instanceof Element ? m.target : m.target.parentElement;
        if (targetEl?.closest(`#${STATUS_BADGE_ID}`)) return true;
        const nodes = [...m.addedNodes, ...m.removedNodes];
        return (
          nodes.length > 0 &&
          nodes.every((n) => n instanceof Element && (n.id === STATUS_BADGE_ID || !!n.closest(`#${STATUS_BADGE_ID}`)))
        );
      });
      if (isStatusBadgeOnly) return;
      const video = getActiveVideo();
      if (!video) return;
      syncingFromCaptionMutation = true;
      try {
        updateActiveCues(video.currentTime);
      } finally {
        syncingFromCaptionMutation = false;
      }
    });
    captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
  };

  const getMonotonicNow = (): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  };

  const pushDiagnostic = (event: SubtitleDiagnosticEvent) => {
    state.diagnostics.push(event);
    if (state.diagnostics.length > 200) {
      state.diagnostics.splice(0, state.diagnostics.length - 200);
    }
  };

  const buildWorkerSentences = (): WorkerSentence[] => {
    if (
      currentWorkerSentences.length === 0 ||
      !Array.isArray(state.mergedSentences) ||
      state.mergedSentencesSource !== state.rawSegments
    ) {
      state.mergedSentences = heuristicMergeAsr(state.rawSegments, state.sourceLanguage);
      state.mergedSentencesSource = state.rawSegments;
      currentWorkerSentences = state.mergedSentences.map((s, idx) => ({
        ...s,
        id: `s${idx}`,
      }));
    }
    return currentWorkerSentences;
  };

  const findActiveSentenceAt = (nowMs: number): WorkerSentence | undefined => {
    if (state.rawSegments.length === 0) return undefined;
    const sentences = buildWorkerSentences();
    let best: WorkerSentence | undefined;
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.startMs <= nowMs && nowMs < s.endMs) {
        if (!best || s.startMs > best.startMs) {
          best = s;
        }
      }
    }
    return best;
  };

  const syncStatusBadgeForPlayback = (effectiveNowMs: number, hasTranslatedCue: boolean) => {
    if (!state.active) {
      clearWaitingStatusTimer();
      hideCaptionStatus();
      return;
    }

    if (sessionTerminalErrorText) {
      clearWaitingStatusTimer();
      showCaptionStatus(sessionTerminalErrorText);
      return;
    }

    if (hasTranslatedCue) {
      const nowPerf = getMonotonicNow();
      const activeSent = findActiveSentenceAt(effectiveNowMs);
      if (recordedFirstCueGen !== state.sessionGen) {
        recordedFirstCueGen = state.sessionGen;
        pushDiagnostic({
          type: 'first-active-cue',
          generation: state.sessionGen,
          sentenceId: activeSent?.id ?? 'cue',
          startMs: Math.round(effectiveNowMs),
          attempt: 1,
          ...(activationAtMs !== null
            ? { activationToDisplayMs: Math.max(0, nowPerf - activationAtMs) }
            : {}),
          ...(captionsReadyAtMs !== null
            ? { captionsToDisplayMs: Math.max(0, nowPerf - captionsReadyAtMs) }
            : {}),
        });
      }
      if (seekAtMs !== null) {
        const seekElapsed = Math.max(0, nowPerf - seekAtMs);
        seekAtMs = null;
        pushDiagnostic({
          type: 'seek-first-cue',
          generation: state.sessionGen,
          sentenceId: activeSent?.id ?? 'cue',
          startMs: Math.round(effectiveNowMs),
          attempt: 1,
          elapsedMs: seekElapsed,
        });
      }
      clearWaitingStatusTimer();
      hideCaptionStatus();
      return;
    }

    const activeSentence = findActiveSentenceAt(effectiveNowMs);
    if (!activeSentence) {
      clearWaitingStatusTimer();
      hideCaptionStatus();
      return;
    }

    const status = subtitleWorker.getSentenceStatus(activeSentence.id);
    const isLegacyDone = state.translatedSentenceKeys.has(
      `${activeSentence.startMs}:${activeSentence.text}`,
    );
    if (status === 'done' || isLegacyDone) {
      // e.g. intentionalEmpty sentence: no displayCue, no waiting or failure badge
      clearWaitingStatusTimer();
      hideCaptionStatus();
      return;
    }

    if (status === 'failed') {
      clearWaitingStatusTimer();
      showCaptionStatus('翻譯暫時失敗');
      return;
    }

    const waitKey = `${state.sessionGen}:${activeSentence.id}`;
    if (waitingSentenceKey !== waitKey) {
      clearWaitingStatusTimer(false);
      waitingSentenceKey = waitKey;
      waitingBadgeReady = false;
      hideCaptionStatus();
      waitingStatusTimer = setTimeout(() => {
        waitingStatusTimer = null;
        if (!state.active || waitingSentenceKey !== waitKey) return;
        waitingBadgeReady = true;
        const video = getActiveVideo();
        const currentMs = (video?.currentTime ?? effectiveNowMs / 1000) * 1000;
        const currentSent = findActiveSentenceAt(currentMs);
        if (!currentSent || `${state.sessionGen}:${currentSent.id}` !== waitKey) {
          clearWaitingStatusTimer();
          hideCaptionStatus();
          return;
        }
        const st = subtitleWorker.getSentenceStatus(currentSent.id);
        const legacyDoneNow = state.translatedSentenceKeys.has(
          `${currentSent.startMs}:${currentSent.text}`,
        );
        if (st === 'done' || legacyDoneNow) {
          clearWaitingStatusTimer();
          hideCaptionStatus();
          return;
        }
        if (st === 'failed') {
          clearWaitingStatusTimer();
          showCaptionStatus('翻譯暫時失敗');
          return;
        }
        showCaptionStatus('翻譯中...');
      }, 300);
    } else if (waitingBadgeReady) {
      showCaptionStatus('翻譯中...');
    }
  };

  const updateActiveCues = (nowSec: number) => {
    const overlay = ensureOverlayElement();
    if (overlay && typeof document !== 'undefined') {
      const player = getActivePlayer();
      if (player) {
        ensureCaptionContainerObserver(player);
        const rawNowMs = nowSec * 1000;
        let effectiveNowMs = rawNowMs;
        if (state.active) {
          const container = getCaptionContainer(player);
          if (container && hasVisibleNativeCaptionText(container)) {
            effectiveNowMs = findPrepaintSnapMs(state.displayCues, rawNowMs, 150) ?? rawNowMs;
          }
        }
        renderYouTubeDisplayCue(player, overlay, state.displayCues, effectiveNowMs, state.active, captionScale);
        const hasTranslatedCue = player.classList.contains('wuf-translated-cue-visible');
        syncStatusBadgeForPlayback(effectiveNowMs, hasTranslatedCue);
        overlay.updateAvoidance(!player.classList.contains('ytp-autohide'));
        scheduleCueBoundaryTimer(getActiveVideo(), effectiveNowMs);
      }
    }
  };

  const bindVideoListeners = () => {
    if (typeof document === 'undefined') return;
    ensureCaptionContainerObserver();
    const video = getActiveVideo();
    if (!video || (video as unknown as { __wufBound?: boolean }).__wufBound) return;
    (video as unknown as { __wufBound?: boolean }).__wufBound = true;

    const syncAndTrigger = () => {
      if (!state.active) return;
      const current = video.currentTime;
      updateActiveCues(current);
      requestSubtitleWork();
    };

    video.addEventListener('timeupdate', syncAndTrigger);
    video.addEventListener('play', syncAndTrigger);
    video.addEventListener('playing', syncAndTrigger);
    video.addEventListener('ratechange', () => {
      if (!state.active) return;
      updateActiveCues(video.currentTime);
      requestSubtitleWork();
    });
    video.addEventListener('pause', () => {
      clearCueBoundaryTimer();
    });
    video.addEventListener('seeked', () => {
      if (!state.active) return;
      seekAtMs = getMonotonicNow();
      const current = video.currentTime;
      updateActiveCues(current);
      if (
        aheadOfTimeWorkerRunning &&
        state.cachedSubtitlesConfig?.engine !== 'openai-compat-local' &&
        state.cachedSubtitlesConfig?.engine !== 'google-translate'
      ) {
        const windowMs = Math.max(5, state.cachedSubtitlesConfig?.batchWindowSec || 30) * 1000;
        const seekWin = Math.floor((current * 1000) / windowMs);
        void translateWindowByIndex(seekWin, state.sessionGen, state.cachedSubtitlesConfig);
      }
      requestSubtitleWork();
    });
  };

  const appendSentenceCues = (sentence: MergedAsrSentence & { id?: string }, translation: string) => {
    const text = translation.replace(/\r?\n/g, ' ').trim();
    if (!text) return;
    const sentenceId = typeof sentence.id === 'string' ? sentence.id : undefined;
    if (
      state.displayCues.some(c =>
        sentenceId !== undefined && c.sentenceId !== undefined
          ? c.sentenceId === sentenceId
          : c.startMs === sentence.startMs && c.sourceText === sentence.text,
      )
    ) {
      return;
    }
    const pieces = splitLongSubtitleCue(sentence.startMs, sentence.endMs, text, sentence.sourceSegs.map(s => s.startMs));
    state.displayCues.push(
      ...pieces.map(piece => ({
        ...piece,
        sourceText: sentence.text,
        ...(sentenceId !== undefined ? { sentenceId } : {}),
      })),
    );
    if (typeof document !== 'undefined') {
      const video = getActiveVideo();
      if (video) updateActiveCues(video.currentTime);
    }
  };

  const translateWindowByIndex = async (
    windowIndex: number,
    gen: number,
    prefetchedSub?: SettingsSnapshotPayload['runtimeSettings']['subtitles'],
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

    const s = state as typeof state & {
      mergedSentences?: MergedAsrSentence[];
      mergedSentencesSource?: AsrRawSegment[] | null;
      translatedSentenceKeys?: Set<string>;
      targetLanguage?: string;
      cachedSubtitlesConfig?: SettingsSnapshotPayload['runtimeSettings']['subtitles'];
    };

    let sub = prefetchedSub;
    if (!sub) {
      const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
        type: 'wuf:get-settings',
      });
      if (!snapResp.ok || !state.active || gen !== state.sessionGen) return false;
      sub = snapResp.data.runtimeSettings.subtitles;
    }
    s.cachedSubtitlesConfig = sub;
    if (sub.targetLanguage) {
      s.targetLanguage = sub.targetLanguage;
    }

    if (sub?.engine === 'openai-compat-local' || sub?.engine === 'google-translate') {
      return false;
    }

    const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
    const windowStartMs = windowIndex * windowMs;
    const windowEndMs = windowStartMs + windowMs;

    if (!Array.isArray(s.mergedSentences) || s.mergedSentencesSource !== state.rawSegments) {
      s.mergedSentences = heuristicMergeAsr(state.rawSegments, state.sourceLanguage);
      s.mergedSentencesSource = state.rawSegments;
    }
    if (!s.translatedSentenceKeys) {
      s.translatedSentenceKeys = new Set<string>();
    }

    const getBounds = (sentence: MergedAsrSentence) => {
      const startMs = sentence.startMs ?? sentence.sourceSegs?.[0]?.startMs ?? 0;
      const lastSeg = sentence.sourceSegs?.[sentence.sourceSegs.length - 1];
      const endMs =
        sentence.endMs ??
        lastSeg?.endMs ??
        (lastSeg ? lastSeg.startMs + 1500 : startMs + 1500);
      return { startMs, endMs };
    };

    const windowSentences = s.mergedSentences.filter((sentence) => {
      const { startMs, endMs } = getBounds(sentence);
      return (
        (endMs > windowStartMs || (endMs === startMs && startMs >= windowStartMs)) &&
        startMs < windowEndMs
      );
    });

    if (windowSentences.length === 0) {
      state.translatedWindows.add(windowIndex);
      return true;
    }

    const pendingSentences = windowSentences.filter((sentence) => {
      const { startMs } = getBounds(sentence);
      const key = `${startMs}:${sentence.text}`;
      return (
        !s.translatedSentenceKeys!.has(key) &&
        !state.displayCues?.some((c) => c.startMs === startMs && c.sourceText === sentence.text)
      );
    });

    if (pendingSentences.length === 0) {
      state.translatedWindows.add(windowIndex);
      return true;
    }

    state.translatingWindows.add(windowIndex);

    try {
      const markTranslated = (sentence: MergedAsrSentence) => {
        const { startMs } = getBounds(sentence);
        s.translatedSentenceKeys!.add(`${startMs}:${sentence.text}`);
      };

      const response = await sendWufRuntimeMessage<TranslationResponse>({
        type: 'wuf:translate-text',
        request: {
          texts: pendingSentences.map(sentence => sentence.text), targetLanguage: sub.targetLanguage,
          sourceLanguage: state.sourceLanguage,
          engine: sub.engine, purpose: 'subtitle',
          modelOverride: sub.customModelOverride || undefined,
        },
      });
      if (!response.ok || !state.active || gen !== state.sessionGen) return false;
      pendingSentences.forEach((sentence, index) => {
        if (response.data.intentionalEmpty?.includes(index)) {
          markTranslated(sentence);
          return;
        }
        const translation = response.data.translations[index];
        if (translation) {
          markTranslated(sentence);
          appendSentenceCues(sentence, translation);
        }
      });
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
      applySettingsSnapshot(snapResp.data);
      const sub = snapResp.data.runtimeSettings.subtitles;
      if (sub.engine === 'openai-compat-local' || sub.engine === 'google-translate') {
        return;
      }
      const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
      const maxLookaheadWindows = 2; // Pre-buffer up to 60~90 seconds ahead

      while (state.active && myGen === state.sessionGen) {
        const video = getActiveVideo();
        const nowMs = video ? video.currentTime * 1000 : currentSec * 1000;
        const currentWin = Math.floor(nowMs / windowMs);
        if (!Array.isArray(state.mergedSentences) || state.mergedSentencesSource !== state.rawSegments) {
          state.mergedSentences = heuristicMergeAsr(state.rawSegments, state.sourceLanguage);
          state.mergedSentencesSource = state.rawSegments;
        }

        let candidateWin: number | null = null;
        for (let offset = 0; offset <= maxLookaheadWindows; offset++) {
          const wIdx = currentWin + offset;
          if (!state.translatedWindows.has(wIdx) && !state.translatingWindows.has(wIdx)) {
            const wStart = wIdx * windowMs;
            const wEnd = wStart + windowMs;
            const hasPendingSentences = state.mergedSentences.some(
              s =>
                (s.endMs > wStart || (s.endMs === s.startMs && s.startMs >= wStart)) &&
                s.startMs < wEnd &&
                !state.translatedSentenceKeys.has(`${s.startMs}:${s.text}`),
            );
            if (hasPendingSentences) {
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

        if (!await translateWindowByIndex(candidateWin, myGen, sub)) {
          const nextWin = Math.floor(((getActiveVideo()?.currentTime ?? currentSec) * 1000) / windowMs);
          if (state.active && myGen === state.sessionGen && nextWin !== currentWin) continue;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      aheadOfTimeWorkerRunning = false;
    }
  };

  const deferredWorkerCallbacks: Array<() => void> = [];

  const handleWorkerResult = (
    sentence: WorkerSentence,
    result: Extract<WorkerResult, { ok: true }>,
    generation: number,
  ) => {
    if (!state.active || generation !== state.sessionGen) return;
    if (settingsSynchronizing) {
      deferredWorkerCallbacks.push(() => handleWorkerResult(sentence, result, generation));
      return;
    }
    if (result.intentionalEmpty) {
      const video = getActiveVideo();
      if (video) updateActiveCues(video.currentTime);
      return;
    }
    appendSentenceCues(sentence, result.translation);
  };

  const handleWorkerError = (
    sentence: WorkerSentence,
    error: Extract<WorkerResult, { ok: false }>['error'],
    generation: number,
  ) => {
    if (!state.active || generation !== state.sessionGen) return;
    if (settingsSynchronizing) {
      deferredWorkerCallbacks.push(() => handleWorkerError(sentence, error, generation));
      return;
    }
    if (error.status === 401 || error.status === 403 || error.code === 'CONFIG_ERROR') {
      sessionTerminalErrorText = '請檢查翻譯連線與認證設定';
      clearWaitingStatusTimer();
      showCaptionStatus(sessionTerminalErrorText);
      return;
    }
    if (
      error.code === 'SEND_MESSAGE_FAILED' ||
      error.code === 'RUNTIME_UNAVAILABLE' ||
      error.code === 'INTERNAL_ERROR'
    ) {
      sessionTerminalErrorText = '翻譯暫時失敗';
      clearWaitingStatusTimer();
      showCaptionStatus(sessionTerminalErrorText);
      return;
    }
    const status = subtitleWorker.getSentenceStatus(sentence.id);
    if (status === 'failed') {
      // Keep the dialogue readable without sending local subtitles to another
      // provider. This is a session-only display cue, never a cached translation.
      appendSentenceCues(sentence, sentence.text);
    }
  };

  const handleWorkerDiagnostic = (event: SubtitleDiagnosticEvent) => {
    pushDiagnostic(event);
  };

  const subtitleWorker = createSubtitleWorker({
    getPlayback: () => {
      const video = getActiveVideo();
      const nowMs = Math.max(0, (video?.currentTime ?? 0) * 1000);
      const playbackRate = video && video.playbackRate > 0 ? video.playbackRate : 1;
      return { nowMs, playbackRate };
    },
    now: getMonotonicNow,
    setTimer: (cb, delayMs) => setTimeout(cb, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    capacity: (engine) => {
      if (settingsSynchronizing) return 0;
      return engine === 'google-translate' ? 3 : 1;
    },
    translate: async (sentence, session): Promise<WorkerResult> => {
      try {
        const resp = await sendWufRuntimeMessage<TranslationResponse>({
          type: 'wuf:translate-text',
          request: {
            texts: [sentence.text],
            targetLanguage: session.targetLanguage || state.targetLanguage || 'zh-TW',
            sourceLanguage: session.sourceLanguage || state.sourceLanguage || 'auto',
            engine: session.engine,
            purpose: 'subtitle',
            modelOverride: session.modelOverride || undefined,
          },
        });
        if (!resp.ok) {
          return {
            ok: false,
            error: {
              code: resp.error.code || 'INTERNAL_ERROR',
              ...(resp.error.status !== undefined ? { status: resp.error.status } : {}),
            },
          };
        }
        const isIntentionalEmpty = Boolean(resp.data.intentionalEmpty?.includes(0));
        const translation = String(resp.data.translations?.[0] ?? '');
        if (!isIntentionalEmpty && !translation.trim()) {
          return {
            ok: false,
            error: { code: 'INVALID_RESPONSE' },
          };
        }
        return {
          ok: true,
          translation,
          ...(isIntentionalEmpty ? { intentionalEmpty: true } : {}),
        };
      } catch {
        return {
          ok: false,
          error: { code: 'INTERNAL_ERROR' },
        };
      }
    },
    onResult: handleWorkerResult,
    onError: handleWorkerError,
    onDiagnostic: handleWorkerDiagnostic,
  });

  const dispatchOrWakeForSub = (sub: SettingsSnapshotPayload['runtimeSettings']['subtitles'], gen: number) => {
    if (!state.active || state.rawSegments.length === 0 || gen !== state.sessionGen || settingsSynchronizing) {
      return;
    }
    if (sub.engine === 'openai-compat-local' || sub.engine === 'google-translate') {
      if (boundSessionGen !== state.sessionGen) {
        boundSessionGen = state.sessionGen;
        const workerSentences = buildWorkerSentences();
        const session: SubtitleSession = {
          generation: state.sessionGen,
          engine: sub.engine as SubtitleWorkerEngine,
          sentences: workerSentences,
          sourceLanguage: state.sourceLanguage,
          targetLanguage: sub.targetLanguage || state.targetLanguage || 'zh-TW',
          modelOverride: sub.customModelOverride || undefined,
        };
        subtitleWorker.replaceSession(session);
      } else {
        subtitleWorker.wake();
      }
    } else {
      const video = getActiveVideo();
      void triggerAheadOfTimeWorker(video?.currentTime ?? 0);
    }
  };

  const requestSubtitleWork = (): void => {
    if (disposed || !state.active || state.rawSegments.length === 0 || settingsSynchronizing) {
      return;
    }
    const gen = state.sessionGen;
    if (state.cachedSubtitlesConfig) {
      dispatchOrWakeForSub(state.cachedSubtitlesConfig, gen);
      return;
    }
    void syncSubtitlesSettings().then((snap) => {
      if (!snap || !state.active || gen !== state.sessionGen || settingsSynchronizing) return;
      dispatchOrWakeForSub(snap.runtimeSettings.subtitles, gen);
    });
  };

  const translateWindowAt = async (currentTimeSec: number) => {
    if (!state.active || state.rawSegments.length === 0) return;
    const snap = await syncSubtitlesSettings();
    const sub = snap?.runtimeSettings.subtitles ?? state.cachedSubtitlesConfig;
    if (!sub) return;
    if (sub.engine === 'openai-compat-local' || sub.engine === 'google-translate') {
      requestSubtitleWork();
      return;
    }
    const windowMs = Math.max(5, sub.batchWindowSec || 30) * 1000;
    const currentWin = Math.floor(Math.max(0, currentTimeSec * 1000) / windowMs);
    await translateWindowByIndex(currentWin, state.sessionGen, sub);
    void triggerAheadOfTimeWorker(currentTimeSec);
  };

  const disableYouTubeSubtitles = () => {
    state.active = false;
    state.sessionGen++;
    boundSessionGen = 0;
    sessionTerminalErrorText = null;
    activationAtMs = null;
    seekAtMs = null;
    deferredWorkerCallbacks.length = 0;
    subtitleWorker.stop();
    clearCueBoundaryTimer();
    clearWaitingStatusTimer();
    toggleSubtitlesActiveClasses(false);
    ensureNativeCaptionsEnabled(false);
    hideCaptionStatus();
    const overlay = ensureOverlayElement();
    if (overlay) overlay.clear();
    updatePlayerButtonState();
  };

  const toggleYouTubeSubtitles = () => {
    if (state.active) {
      disableYouTubeSubtitles();
    } else {
      activationAtMs = getMonotonicNow();
      sessionTerminalErrorText = null;
      void translateYouTubeSubtitles().then(() => {
        updatePlayerButtonState();
      });
    }
  };

  const resetCaptionBuffers = (nextVideoId: string) => {
    state.videoId = nextVideoId;
    state.rawSegments = [];
    state.mergedSentences = [];
    state.mergedSentencesSource = null;
    currentWorkerSentences = [];
    state.displayCues = [];
    state.translatedWindows.clear();
    state.translatingWindows.clear();
    state.translatedSentenceKeys.clear();
    state.sessionGen++;
    boundSessionGen = 0;
    sessionTerminalErrorText = null;
    captionsReadyAtMs = null;
    seekAtMs = null;
    deferredWorkerCallbacks.length = 0;
    subtitleWorker.stop();
    clearCueBoundaryTimer();
    clearWaitingStatusTimer();
    hideCaptionStatus();
  };

  const forceSubtitleReload = () => {
    if (typeof document === 'undefined') return;
    const ccBtn = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (ccBtn) {
      const isCcOn = ccBtn.getAttribute('aria-pressed') === 'true';
      if (isCcOn) {
        if (Date.now() - lastCcAutoEnableMs >= 500) {
          ccBtn.click();
          setTimeout(() => {
            if (state.active) {
              ccBtn.click();
            }
          }, 80);
        }
      } else {
        lastCcAutoEnableMs = Date.now();
        ccBtn.click();
      }
    }
    globalThis.window?.dispatchEvent(new CustomEvent('wuf-yt-request-tracks'));
  };

  let storageChangeListener: ((changes: Record<string, unknown>, areaName: string) => void) | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    state.active = false;
    sessionTerminalErrorText = null;
    deferredWorkerCallbacks.length = 0;
    subtitleWorker.dispose();
    clearCueBoundaryTimer();
    clearWaitingStatusTimer();
    hideCaptionStatus();
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (
      storageChangeListener &&
      typeof globalThis.chrome !== 'undefined' &&
      globalThis.chrome?.storage?.onChanged?.removeListener
    ) {
      globalThis.chrome.storage.onChanged.removeListener(storageChangeListener);
      storageChangeListener = null;
    }
  };

  const translateYouTubeSubtitles = async () => {
    state.active = true;
    toggleSubtitlesActiveClasses(true);
    ensureNativeCaptionsEnabled(true);
    if (state.rawSegments.length === 0) {
      forceSubtitleReload();
    }
    if (typeof document !== 'undefined') {
      globalThis.window?.dispatchEvent(new CustomEvent('wuf-yt-request-tracks'));
    }
    ensureOverlayElement();
    bindVideoListeners();
    updatePlayerButtonState();

    const video =
      typeof document !== 'undefined'
        ? document.querySelector<HTMLVideoElement>('video')
        : null;
    updateActiveCues(video?.currentTime ?? 0);
    if (typeof requestSubtitleWork === 'function') {
      requestSubtitleWork();
    } else if (typeof triggerAheadOfTimeWorker === 'function') {
      void triggerAheadOfTimeWorker(video?.currentTime ?? 0);
    }

    await warmupSubtitleModel();

    if (state.active) {
      const activeVideo =
        typeof document !== 'undefined'
          ? document.querySelector<HTMLVideoElement>('video')
          : null;
      updateActiveCues(activeVideo?.currentTime ?? 0);
      if (typeof requestSubtitleWork === 'function') {
        requestSubtitleWork();
      }
    }
    return { ok: true, active: state.active };
  };

  const wufNs: WufYouTubeNamespace = {
    YT: state,
    chooseBestCaptionTrack,
    heuristicMergeAsr,
    parseAsrLlmOutput,
    resolveAsrEntryTimeline,
    splitLongSubtitleCue,
    translateYouTubeSubtitles,
    translateWindowAt,
    planSubtitleWindowBatch,
    requestSubtitleWork,
    destroy,
  };

  if (typeof globalThis.window !== 'undefined') {
    (globalThis.window as unknown as { __WUF?: WufYouTubeNamespace }).__WUF = wufNs;
    globalThis.window.addEventListener('wuf-timedtext-captured', (ev: Event) => {
      const detail = (ev as CustomEvent<{ data?: unknown; rawText?: string; url?: string }>).detail;
      const raw = detail?.rawText || detail?.data;
      if (raw) {
        let nextSourceLang = 'auto';
        let nextIsAsr = false;
        let eventVideoId = '';
        try {
          const params = new URL(detail.url || '', 'https://www.youtube.com').searchParams;
          eventVideoId = params.get('v') || '';
          nextSourceLang = params.get('tlang') || params.get('lang') || 'auto';
          nextIsAsr = params.get('kind') === 'asr';
        } catch {
          nextSourceLang = 'auto';
          nextIsAsr = false;
        }

        const currentWatchId = getCurrentWatchVideoId();
        if (eventVideoId && currentWatchId && eventVideoId !== currentWatchId) {
          return;
        }

        const segments = parseCaptionResponse(raw);
        if (segments.length > 0) {
          const resolvedVideoId = eventVideoId || currentWatchId || state.videoId;
          if (
            state.rawSegments.length > 0 &&
            resolvedVideoId === state.videoId &&
            nextSourceLang === state.sourceLanguage &&
            nextIsAsr === state.isAsr &&
            areCaptionSegmentsEqual(state.rawSegments, segments)
          ) {
            if (state.active) {
              const video = getActiveVideo();
              updateActiveCues(video?.currentTime ?? 0);
              requestSubtitleWork();
            }
            return;
          }

          resetCaptionBuffers(resolvedVideoId);
          state.sourceLanguage = nextSourceLang;
          state.isAsr = nextIsAsr;
          state.rawSegments = segments;
          captionsReadyAtMs = getMonotonicNow();
          const video = getActiveVideo();
          if (state.active) {
            requestSubtitleWork();
          }
          updateActiveCues(video?.currentTime ?? 0);
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
          state.targetLanguage || 'zh-TW',
        );
        if (
          choice.track &&
          (choice.action === 'switch' || choice.action === 'switch-to-native')
        ) {
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
    void syncSubtitlesSettings();
  }

  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome?.storage?.onChanged?.addListener) {
    storageChangeListener = (changes: Record<string, unknown>, areaName: string) => {
      if (disposed) return;
      const isSettingsEvent =
        (areaName === 'sync' && Object.prototype.hasOwnProperty.call(changes, 'wufSettings')) ||
        (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, 'wufSecrets'));
      if (!isSettingsEvent) return;

      settingsReadSeq += 1;
      const mySeq = settingsReadSeq;
      const videoIdAtStart = state.videoId;
      const genAtStart = state.sessionGen;
      settingsSynchronizing = true;

      void (async () => {
        try {
          const snapResp = await sendWufRuntimeMessage<SettingsSnapshotPayload>({
            type: 'wuf:get-settings',
          });
          if (disposed || mySeq !== settingsReadSeq) return;

          if (!snapResp.ok) {
            settingsSynchronizing = false;
            deferredWorkerCallbacks.length = 0;
            boundSessionGen = 0;
            subtitleWorker.stop();
            if (state.active) {
              showCaptionStatus('翻譯暫時失敗');
            }
            return;
          }

          const nextSig = computeConfigSignature(snapResp.data);
          const prevSig = boundConfigSignature;
          state.cachedSubtitlesConfig = snapResp.data.runtimeSettings.subtitles;
          if (snapResp.data.runtimeSettings.subtitles.targetLanguage) {
            state.targetLanguage = snapResp.data.runtimeSettings.subtitles.targetLanguage;
          }
          boundConfigSignature = nextSig;

          if (!state.active || state.videoId !== videoIdAtStart) {
            settingsSynchronizing = false;
            deferredWorkerCallbacks.length = 0;
            if (!state.active) {
              boundSessionGen = 0;
              subtitleWorker.stop();
            }
            return;
          }

          if (prevSig !== null && nextSig === prevSig && state.sessionGen === genAtStart) {
            settingsSynchronizing = false;
            for (const callback of deferredWorkerCallbacks.splice(0)) callback();
            requestSubtitleWork();
            return;
          }

          // Subtitle-relevant configuration changed -> invalidate old cues and start a larger generation
          settingsSynchronizing = false;
          sessionTerminalErrorText = null;
          deferredWorkerCallbacks.length = 0;
          state.displayCues = [];
          state.translatedWindows.clear();
          state.translatingWindows.clear();
          state.translatedSentenceKeys.clear();
          state.sessionGen += 1;
          boundSessionGen = 0;
          subtitleWorker.stop();
          clearWaitingStatusTimer();
          const video = getActiveVideo();
          requestSubtitleWork();
          updateActiveCues(video?.currentTime ?? 0);
        } catch {
          if (disposed || mySeq !== settingsReadSeq) return;
          settingsSynchronizing = false;
          deferredWorkerCallbacks.length = 0;
          boundSessionGen = 0;
          subtitleWorker.stop();
          if (state.active) {
            showCaptionStatus('翻譯暫時失敗');
          }
        }
      })();
    };
    globalThis.chrome.storage.onChanged.addListener(storageChangeListener);
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
          const enabled = Boolean(m.payload?.enabled);
          if (enabled) {
            void translateYouTubeSubtitles();
          } else {
            disableYouTubeSubtitles();
          }
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
        toggleYouTubeSubtitles();
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
        toggleYouTubeSubtitles();
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
      const nextVideoId = getCurrentWatchVideoId();
      if (nextVideoId !== state.videoId) {
        resetCaptionBuffers(nextVideoId);
        state.sourceLanguage = 'auto';
        state.isAsr = false;
        hideCaptionStatus();
        updateActiveCues(getActiveVideo()?.currentTime ?? 0);
        toggleSubtitlesActiveClasses(state.active);
        if (state.active && nextVideoId) {
          ensureNativeCaptionsEnabled(true);
          globalThis.window?.dispatchEvent(new CustomEvent('wuf-yt-request-tracks'));
        }
        if (isYouTubeWatchPage()) {
          void syncSubtitlesSettings();
        }
      }
      injectPlayerButton();
      bindVideoListeners();
      updatePlayerButtonState();
    };

    globalThis.window.addEventListener('yt-navigate-finish', onYtNavigate);
    globalThis.window.addEventListener('yt-page-data-updated', onYtNavigate);
    globalThis.window.addEventListener('spfdone', onYtNavigate);

    // Initial polling guarantee for dynamic player controls mount
    let pollCount = 0;
    pollInterval = setInterval(() => {
      pollCount++;
      if (document.querySelector('.ytp-right-controls')) {
        injectPlayerButton();
        bindVideoListeners();
      }
      if (pollCount > 15 && pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
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
