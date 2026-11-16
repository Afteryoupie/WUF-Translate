import type { MergedAsrSentence } from './youtube-pipeline.ts';

export const SUBTITLE_LOOKAHEAD_BASE_MS = 30_000;
export const SUBTITLE_LOOKAHEAD_MIN_MS = 20_000;
export const SUBTITLE_LOOKAHEAD_MAX_MS = 90_000;

export function computeSubtitleLookaheadMs(playbackRate: number): number {
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return Math.max(
    SUBTITLE_LOOKAHEAD_MIN_MS,
    Math.min(SUBTITLE_LOOKAHEAD_MAX_MS, Math.round(SUBTITLE_LOOKAHEAD_BASE_MS * rate)),
  );
}

/**
 * Selects the next pending subtitle sentence based on current media playback time `nowMs`:
 * 1. Active sentence covering `startMs <= nowMs < endMs` (latest `startMs` wins if overlapping; list order preserved on ties).
 * 2. Otherwise, earliest `startMs` upcoming sentence within `[nowMs, nowMs + lookaheadMs]` (`endMs > nowMs`; list order preserved on ties).
 * 3. Expired sentences (`endMs <= nowMs`) are never selected unless playback seeks back before `endMs`.
 */
export function selectNextSubtitleSentence<T extends MergedAsrSentence>(
  sentences: readonly T[],
  nowMs: number,
  playbackRate: number,
  isPending: (sentence: T) => boolean,
): T | undefined {
  if (!Array.isArray(sentences) || sentences.length === 0) return undefined;

  const currentMs = Number.isFinite(nowMs) ? nowMs : 0;
  const horizonMs = currentMs + computeSubtitleLookaheadMs(playbackRate);

  let bestActive: T | undefined;
  let bestUpcoming: T | undefined;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.endMs <= currentMs) continue;
    if (!isPending(s)) continue;

    if (s.startMs <= currentMs) {
      if (!bestActive || s.startMs > bestActive.startMs) {
        bestActive = s;
      }
    } else if (s.startMs <= horizonMs) {
      if (!bestUpcoming || s.startMs < bestUpcoming.startMs) {
        bestUpcoming = s;
      }
    }
  }

  return bestActive ?? bestUpcoming;
}
