import { stripSpeakerPrefix } from './subtitle-decisions.ts';

export const WUF_ASR_CUE_MAX_CHARS = 24;
export const WUF_ASR_CUE_MIN_PIECE_MS = 1200;
export const WUF_ASR_LAST_CUE_FALLBACK_MS = 1500;

export interface CaptionTrackInfo {
  languageCode: string;
  kind?: string;
  baseUrl?: string;
  name?: { simpleText?: string } | string;
  vssId?: string;
  isTranslatable?: boolean;
  translationLanguageCode?: string;
}

export interface CaptionTrackHints {
  preferEnglishAsr?: boolean;
  originalAudioLang?: string;
  defaultCaptionTrackIndex?: number;
}

export interface ChosenCaptionTrackResult {
  track?: CaptionTrackInfo;
  sourceLanguage?: string;
  action: 'skip' | 'switch-to-native' | 'switch' | 'noop' | 'none';
}

function baseLang(code: string | undefined): string {
  return (code || '').trim().toLowerCase().split(/[-_]/)[0] || '';
}

function isAsrTrack(track: CaptionTrackInfo): boolean {
  return (track.kind || '').toLowerCase() === 'asr';
}

function isSameTrack(
  a: CaptionTrackInfo | null | undefined,
  b: CaptionTrackInfo | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a === b ||
    (a.languageCode === b.languageCode &&
      Boolean(isAsrTrack(a)) === Boolean(isAsrTrack(b)) &&
      !a.translationLanguageCode &&
      !b.translationLanguageCode)
  );
}

/**
 * Selects the optimal YouTube caption track following WUF priority rules:
 * Manual exact target > Manual Chinese variant > Manual English >
 * Manual original audio > Original-language ASR > Unambiguous default/unique ASR.
 */
export function chooseBestCaptionTrack(
  tracks: CaptionTrackInfo[],
  activeTrack: CaptionTrackInfo | null | undefined,
  targetLanguage: string = 'zh-TW',
  hints?: CaptionTrackHints | boolean,
): ChosenCaptionTrackResult {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return { action: 'none' };
  }

  const normalizedHints: CaptionTrackHints =
    hints && typeof hints === 'object' ? hints : {};
  const targetLower = (targetLanguage || 'zh-TW').trim().toLowerCase();
  const targetBase = baseLang(targetLower);

  const manualTracks = tracks.filter(t => !isAsrTrack(t));
  const asrTracks = tracks.filter(t => isAsrTrack(t));

  // 1. Exact manual target match (e.g. zh-TW when target is zh-TW)
  const exactManual = manualTracks.find(
    t => t.languageCode.toLowerCase() === targetLower,
  );
  if (exactManual) {
    if (isSameTrack(activeTrack, exactManual)) {
      return {
        track: exactManual,
        sourceLanguage: exactManual.languageCode,
        action: 'skip',
      };
    }
    return {
      track: exactManual,
      sourceLanguage: exactManual.languageCode,
      action: 'switch-to-native',
    };
  }

  // 2. Manual same-base Chinese variant (e.g. zh, zh-CN, zh-Hans when target is zh-TW)
  if (targetBase === 'zh') {
    const chineseVariantManual = manualTracks.find(
      t => baseLang(t.languageCode) === 'zh',
    );
    if (chineseVariantManual) {
      return {
        track: chineseVariantManual,
        sourceLanguage: chineseVariantManual.languageCode,
        action: isSameTrack(activeTrack, chineseVariantManual) ? 'noop' : 'switch',
      };
    }
  }

  // 3. Manual English track
  const manualEnglish = manualTracks.find(t => baseLang(t.languageCode) === 'en');
  if (manualEnglish) {
    return {
      track: manualEnglish,
      sourceLanguage: manualEnglish.languageCode,
      action: isSameTrack(activeTrack, manualEnglish) ? 'noop' : 'switch',
    };
  }

  // 4. Manual original audio language track (or first available manual track)
  const origBase = baseLang(normalizedHints.originalAudioLang);
  if (origBase) {
    const manualOrig = manualTracks.find(t => baseLang(t.languageCode) === origBase);
    if (manualOrig) {
      return {
        track: manualOrig,
        sourceLanguage: manualOrig.languageCode,
        action: isSameTrack(activeTrack, manualOrig) ? 'noop' : 'switch',
      };
    }
  }
  if (manualTracks.length > 0) {
    const firstManual = manualTracks[0];
    return {
      track: firstManual,
      sourceLanguage: firstManual.languageCode,
      action: isSameTrack(activeTrack, firstManual) ? 'noop' : 'switch',
    };
  }

  // 5. ASR tracks: if originalAudioLang is known, ONLY accept ASR matching originalAudioLang
  if (origBase) {
    const origAsr = asrTracks.find(t => baseLang(t.languageCode) === origBase);
    if (!origAsr) {
      return { action: 'none' };
    }
    return {
      track: origAsr,
      sourceLanguage: origAsr.languageCode,
      action: isSameTrack(activeTrack, origAsr) ? 'noop' : 'switch',
    };
  }

  // 6. ASR with explicit defaultCaptionTrackIndex
  if (
    typeof normalizedHints.defaultCaptionTrackIndex === 'number' &&
    normalizedHints.defaultCaptionTrackIndex >= 0 &&
    normalizedHints.defaultCaptionTrackIndex < tracks.length
  ) {
    const candidate = tracks[normalizedHints.defaultCaptionTrackIndex];
    if (candidate) {
      return {
        track: candidate,
        sourceLanguage: candidate.languageCode,
        action: isSameTrack(activeTrack, candidate) ? 'noop' : 'switch',
      };
    }
  }

  // 7. Single unambiguous ASR track
  if (asrTracks.length === 1) {
    const onlyAsr = asrTracks[0];
    return {
      track: onlyAsr,
      sourceLanguage: onlyAsr.languageCode,
      action: isSameTrack(activeTrack, onlyAsr) ? 'noop' : 'switch',
    };
  }

  return { action: 'none' };
}

export interface AsrRawSegment {
  text: string;
  normText?: string;
  startMs: number;
  endMs?: number;
  jevBreakBefore?: boolean | null;
}

export interface MergedAsrSentence {
  text: string;
  startMs: number;
  endMs: number;
  sourceSegs: AsrRawSegment[];
}

const ABBREVIATION_END_RE =
  /\b(?:Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e)\.$/i;
const SENTENCE_TERMINATOR_RE = /[.!?。！？…]+["'”’)]*$/;

export function heuristicMergeAsr(
  rawSegments: AsrRawSegment[],
  sourceLanguage: string = 'en',
  fallbackTailMs: number = WUF_ASR_LAST_CUE_FALLBACK_MS,
): MergedAsrSentence[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) return [];
  const isCjk = /^(ja|zh)/i.test(sourceLanguage);
  const joinSep = isCjk ? '' : ' ';
  const maxWords = 30;

  const sentences: MergedAsrSentence[] = [];
  let currentSegs: AsrRawSegment[] = [];
  let currentWords = 0;

  const countWords = (text: string): number => {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    if (isCjk) return Math.ceil(trimmed.length / 2);
    return trimmed.split(/\s+/).length;
  };

  const flush = (nextStartMs?: number) => {
    if (currentSegs.length === 0) return;
    const first = currentSegs[0];
    const last = currentSegs[currentSegs.length - 1];
    const computedEnd =
      nextStartMs !== undefined
        ? nextStartMs
        : last.endMs !== undefined && last.endMs > last.startMs
          ? last.endMs
          : last.startMs + fallbackTailMs;
    sentences.push({
      text: currentSegs.map(s => s.text.trim()).filter(Boolean).join(joinSep),
      startMs: first.startMs,
      endMs: Math.max(first.startMs + 200, computedEnd),
      sourceSegs: [...currentSegs],
    });
    currentSegs = [];
    currentWords = 0;
  };

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const segWords = countWords(seg.text);

    if (currentSegs.length === 0) {
      currentSegs.push(seg);
      currentWords = segWords;
      continue;
    }

    const prev = currentSegs[currentSegs.length - 1];
    const prevText = prev.text.trim();
    const onsetGap = seg.startMs - prev.startMs;
    const hasExplicitEnd = typeof prev.endMs === 'number' && prev.endMs > prev.startMs;
    const silenceGap = hasExplicitEnd ? seg.startMs - prev.endMs! : onsetGap;

    const wouldExceedWordCap = currentWords + segWords > maxWords;
    const isLongSilence = hasExplicitEnd ? silenceGap >= 2500 : onsetGap >= 4000;
    const isLocalGapBreak = !hasExplicitEnd && onsetGap >= 1200;
    const endsWithPunct =
      SENTENCE_TERMINATOR_RE.test(prevText) && !ABBREVIATION_END_RE.test(prevText);

    let shouldBreak = false;
    if (wouldExceedWordCap || isLongSilence) {
      shouldBreak = true;
    } else if (seg.jevBreakBefore === true) {
      shouldBreak = true;
    } else if (seg.jevBreakBefore === false) {
      shouldBreak = false;
    } else if (endsWithPunct || isLocalGapBreak) {
      shouldBreak = true;
    }

    if (shouldBreak) {
      flush(seg.startMs);
    }
    currentSegs.push(seg);
    currentWords += segWords;
  }

  flush();
  return sentences;
}

export async function refineAsrBoundaries<T extends AsrRawSegment>(
  rawSegments: T[],
  config: { jevEnabled?: boolean; decisionMode?: 'laya' | 'custom' | 'off' } | undefined,
  requestBoundaries: (segments: T[]) => Promise<{ ok?: boolean; breakBefore?: Array<boolean | null> }>,
): Promise<T[]> {
  if (!Array.isArray(rawSegments) || rawSegments.length < 2) return rawSegments;
  const enabled =
    config?.decisionMode !== undefined
      ? config.decisionMode !== 'off'
      : Boolean(config?.jevEnabled);
  if (!enabled) return rawSegments;

  try {
    const resp = await requestBoundaries(rawSegments);
    if (!resp?.ok || !Array.isArray(resp.breakBefore)) {
      return rawSegments;
    }
    return rawSegments.map((seg, i) => {
      const hint = resp.breakBefore?.[i];
      if (typeof hint === 'boolean') {
        return { ...seg, jevBreakBefore: hint };
      }
      return { ...seg };
    });
  } catch {
    return rawSegments;
  }
}

export interface AsrParsedEntry {
  s: number;
  e: number;
  t: string;
  startIdx?: number;
  endIdx?: number;
  intentionalEmpty?: boolean;
}

export function stripSubtitlePunctuation(text: string): string {
  return String(text || '')
    .replace(/^[，。！？、；：,.!?;:\s]+|[，。！？、；：,.!?;:\s]+$/g, '')
    .trim();
}

export function parseAsrLlmOutput(
  rawText: string,
  segments: AsrRawSegment[],
  windowEndMs: number,
  approvedEmptyIndices: number[] = [],
  stripPunctFn: (s: string) => string = stripSubtitlePunctuation,
): AsrParsedEntry[] {
  const count = segments.length;
  if (count === 0) return [];
  const windowStartMs = segments[0].startMs;
  const clean = String(rawText || '')
    .trim()
    .replace(/^\s*```[^\n]*\n?/, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  if (!clean) {
    throw new Error('ASR response is empty');
  }

  // Legacy JSON format support: [{"s":0,"e":1500,"t":"..."}]
  if (clean.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch {
      throw new Error('ASR response invalid legacy JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('ASR response empty legacy JSON');
    }
    const items = parsed as Array<{ s?: number; e?: number; t?: string }>;
    const firstS = Number(items[0]?.s);
    const lastE = Number(items[items.length - 1]?.e);
    if (
      !Number.isFinite(firstS) ||
      !Number.isFinite(lastE) ||
      firstS > windowStartMs ||
      lastE < windowEndMs
    ) {
      throw new Error('ASR response has incomplete legacy timeline');
    }
    return items.map(item => ({
      s: Number(item.s),
      e: Number(item.e),
      t: stripPunctFn(String(item.t || '')),
    }));
  }

  const approvedEmptySet = new Set(approvedEmptyIndices);
  const lines = clean.split('\n').filter(l => l.trim().length > 0);
  const entries: AsrParsedEntry[] = [];
  let expectedStart = 0;

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s*(?:[-–~]\s*(\d+))?\s*[|｜]\s*(.*?)\s*$/);
    if (!match) {
      throw new Error(`ASR response malformed line: ${line}`);
    }
    let startIdx = Number(match[1]) - 1;
    let endIdx = Number(match[2] || match[1]) - 1;
    if (startIdx < 0 || endIdx < 0) {
      throw new Error('ASR response invalid 0-based start index');
    }
    if (endIdx < startIdx) {
      [startIdx, endIdx] = [endIdx, startIdx];
    }
    if (startIdx >= count) {
      throw new Error('ASR response range starts past segment count');
    }
    endIdx = Math.min(endIdx, count - 1);

    if (startIdx !== expectedStart) {
      throw new Error('ASR response has gap or overlap in segment ranges');
    }

    const rawTranslation = match[3] ?? '';
    const stripped = stripPunctFn(rawTranslation);
    const isApprovedEmpty =
      stripped === '' &&
      startIdx === endIdx &&
      approvedEmptySet.has(startIdx);

    if (stripped === '' && !isApprovedEmpty) {
      throw new Error('ASR response contains unapproved empty translation');
    }

    const s = segments[startIdx].startMs;
    const e =
      endIdx + 1 < count
        ? segments[endIdx + 1].startMs
        : Math.max(s + 200, windowEndMs);

    const entry: AsrParsedEntry = {
      s,
      e,
      t: stripped,
    };
    if (isApprovedEmpty) {
      entry.intentionalEmpty = true;
    }
    entries.push(entry);
    expectedStart = endIdx + 1;
  }

  if (expectedStart !== count) {
    throw new Error('ASR response missing tail segments');
  }

  return entries;
}

export function resolveAsrEntryTimeline(
  entries: AsrParsedEntry[],
  _segments: AsrRawSegment[],
  windowEndMs: number,
): {
  cues: Array<{
    startMs: number;
    endMs: number;
    text: string;
    intentionalEmpty?: boolean;
  }>;
} {
  const cues = entries.map((entry, idx) => {
    const nextStart = idx + 1 < entries.length ? entries[idx + 1].s : windowEndMs;
    return {
      startMs: entry.s,
      endMs: Math.max(entry.s, Math.min(entry.e, nextStart)),
      text: entry.t,
      ...(entry.intentionalEmpty ? { intentionalEmpty: true } : {}),
    };
  });
  return { cues };
}

export interface SplitCuePiece {
  startMs: number;
  endMs: number;
  text: string;
}

function isProtectedWordBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const prevCode = text.charCodeAt(index - 1);
  const nextCode = text.charCodeAt(index);
  // Surrogate pair protection (emoji)
  if (prevCode >= 0xd800 && prevCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
    return true;
  }
  const prevChar = text[index - 1];
  const nextChar = text[index];
  // ASCII word / model identifier protection
  if (/[A-Za-z0-9_-]/.test(prevChar) && /[A-Za-z0-9_-]/.test(nextChar)) {
    return true;
  }
  return false;
}

/**
 * Splits a long translated subtitle cue into readable sequential pieces (<= 24 chars)
 * along natural punctuation/whitespace boundaries while protecting English words,
 * model IDs, emoji surrogate pairs, and enforcing >= 1200ms per piece.
 */
export function splitLongSubtitleCue(
  startMs: number,
  endMs: number,
  text: string,
  segStarts: number[] = [],
  maxChars: number = WUF_ASR_CUE_MAX_CHARS,
  minPieceMs: number = WUF_ASR_CUE_MIN_PIECE_MS,
): SplitCuePiece[] {
  const clean = String(text || '').trim();
  const totalDuration = endMs - startMs;
  if (!clean || clean.length <= maxChars || totalDuration < minPieceMs * 2) {
    return [{ startMs, endMs, text: clean }];
  }

  const maxByDuration = Math.floor(totalDuration / minPieceMs);
  const minByLength = Math.ceil(clean.length / maxChars);
  const targetPieces = Math.min(maxByDuration, Math.max(2, minByLength));

  if (targetPieces <= 1) {
    return [{ startMs, endMs, text: clean }];
  }

  // DP / greedy natural boundary partition into `targetPieces` pieces (or minimum valid pieces)
  const piecesText = partitionCueText(clean, targetPieces, maxChars);
  if (piecesText.length <= 1) {
    return [{ startMs, endMs, text: clean }];
  }

  const pieceCount = piecesText.length;
  const totalWeight = piecesText.reduce(
    (sum, p) => sum + Math.max(1, p.replace(/\s+/g, '').length),
    0,
  );
  const validOnsets = (Array.isArray(segStarts) ? segStarts : [])
    .filter(ms => Number.isFinite(ms) && ms > startMs && ms < endMs)
    .sort((a, b) => a - b);

  const boundaries: number[] = [startMs];
  let cumulativeWeight = 0;

  for (let i = 1; i < pieceCount; i++) {
    cumulativeWeight += Math.max(1, piecesText[i - 1].replace(/\s+/g, '').length);
    const idealMs = Math.round(
      startMs + (totalDuration * cumulativeWeight) / totalWeight,
    );
    const minAllowed = boundaries[i - 1] + minPieceMs;
    const maxAllowed = endMs - (pieceCount - i) * minPieceMs;

    let chosen = idealMs;
    // Snap to closest valid onset if within reasonable range and bounds
    for (const onset of validOnsets) {
      if (
        onset >= minAllowed &&
        onset <= maxAllowed &&
        Math.abs(onset - idealMs) <= 1200
      ) {
        chosen = onset;
        break;
      }
    }
    chosen = Math.max(minAllowed, Math.min(maxAllowed, chosen));
    boundaries.push(chosen);
  }
  boundaries.push(endMs);

  return piecesText.map((pieceText, idx) => ({
    startMs: boundaries[idx],
    endMs: boundaries[idx + 1],
    text: pieceText,
  }));
}

function partitionCueText(
  text: string,
  desiredPieces: number,
  maxChars: number,
): string[] {
  const n = text.length;
  const minTailChars = Math.min(6, Math.floor(n / desiredPieces));

  const tryPartition = (pieces: number, enforceMaxChars: boolean): string[] | null => {
    const result: string[] = [];
    let cursor = 0;

    for (let rem = pieces; rem > 1; rem--) {
      const remainingLen = n - cursor;
      const idealLen = Math.round(remainingLen / rem);
      const minCut = cursor + Math.max(minTailChars, remainingLen - (rem - 1) * (enforceMaxChars ? maxChars : n));
      const maxCut = cursor + Math.min(
        enforceMaxChars ? maxChars : remainingLen - minTailChars,
        remainingLen - (rem - 1) * minTailChars,
      );

      if (minCut > maxCut) return null;

      let bestPos = -1;
      let bestScore = -Infinity;

      for (let pos = minCut; pos <= maxCut; pos++) {
        if (isProtectedWordBoundary(text, pos)) continue;
        let score = -Math.abs(pos - (cursor + idealLen));
        const prevChar = text[pos - 1];
        const currChar = text[pos];
        if (/[，。！？、；：,.!?;:]/.test(prevChar)) {
          score += 30;
        } else if (/\s/.test(currChar) || /\s/.test(prevChar)) {
          score += 22;
        }
        const pieceCandidate = text.slice(cursor, pos).trim();
        if (pieceCandidate.length < minTailChars) continue;
        if (enforceMaxChars && pieceCandidate.length > maxChars) continue;
        if (score > bestScore) {
          bestScore = score;
          bestPos = pos;
        }
      }

      if (bestPos === -1) return null;
      const piece = text.slice(cursor, bestPos).trim();
      result.push(piece);
      cursor = bestPos;
      while (cursor < n && /\s/.test(text[cursor])) cursor++;
    }

    const tail = text.slice(cursor).trim();
    if (!tail || tail.length < minTailChars) return null;
    if (enforceMaxChars && tail.length > maxChars) return null;
    result.push(tail);
    return result;
  };

  return (
    tryPartition(desiredPieces, true) ||
    tryPartition(desiredPieces + 1, true) ||
    tryPartition(desiredPieces, false) ||
    [text]
  );
}

export interface YouTubeTimedTextEvent {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
}

export function parseYouTubeTimedTextJson3(data: {
  events?: YouTubeTimedTextEvent[];
}): AsrRawSegment[] {
  if (!data || !Array.isArray(data.events)) return [];
  const out: AsrRawSegment[] = [];
  for (const ev of data.events) {
    if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;
    const rawText = ev.segs
      .map(s => s.utf8 || '')
      .join('')
      .replace(/\n+/g, ' ');
    const text = stripSpeakerPrefix(rawText);
    if (!text) continue;
    const startMs = ev.tStartMs;
    const endMs =
      typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0
        ? startMs + ev.dDurationMs
        : undefined;
    out.push({
      text,
      normText: text.toLowerCase(),
      startMs,
      ...(endMs !== undefined ? { endMs } : {}),
    });
  }
  return out;
}

export function parseYouTubeTimedTextXml(xmlText: string): AsrRawSegment[] {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const out: AsrRawSegment[] = [];

  const decodeEntities = (s: string): string => {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  };

  const textTagRe = /<text\b[^>]*?start="([^"]+)"(?:[^>]*?dur="([^"]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTagRe.exec(xmlText)) !== null) {
    const startSec = parseFloat(match[1]);
    const durSec = match[2] ? parseFloat(match[2]) : 2.0;
    const rawContent = decodeEntities(match[3]).replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
    const text = stripSpeakerPrefix(rawContent);
    if (!text) continue;
    const startMs = Math.round(startSec * 1000);
    const endMs = startMs + Math.round(durSec * 1000);
    out.push({
      text,
      normText: text.toLowerCase(),
      startMs,
      endMs,
    });
  }

  if (out.length === 0) {
    const pTagRe = /<p\b[^>]*?t="(\d+)"(?:[^>]*?d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    while ((match = pTagRe.exec(xmlText)) !== null) {
      const startMs = parseInt(match[1], 10);
      const durMs = match[2] ? parseInt(match[2], 10) : 2000;
      const rawContent = decodeEntities(match[3]).replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
      const text = stripSpeakerPrefix(rawContent);
      if (!text) continue;
      out.push({
        text,
        normText: text.toLowerCase(),
        startMs,
        endMs: startMs + durMs,
      });
    }
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}

export function parseCaptionResponse(input: unknown): AsrRawSegment[] {
  if (!input) return [];
  if (typeof input === 'object' && input !== null) {
    return parseYouTubeTimedTextJson3(input as { events?: YouTubeTimedTextEvent[] });
  }
  if (typeof input !== 'string') return [];
  const trimmed = input.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { events?: YouTubeTimedTextEvent[] };
      const res = parseYouTubeTimedTextJson3(parsed);
      if (res.length > 0) return res;
    } catch {
      // fallback to XML
    }
  }
  return parseYouTubeTimedTextXml(trimmed);
}

export function planSubtitleWindowBatch(
  segments: AsrRawSegment[],
  currentTimeSec: number,
  batchWindowSec: number = 30,
  prefetchLeadSec: number = 10,
  translatedWindows: Set<number> = new Set(),
): {
  windowIndex: number;
  windowStartMs: number;
  windowEndMs: number;
  windowSegments: AsrRawSegment[];
  prefetchWindowIndex: number | null;
} {
  const windowMs = Math.max(5, batchWindowSec) * 1000;
  const leadMs = Math.max(1, prefetchLeadSec) * 1000;
  const currentMs = Math.max(0, currentTimeSec * 1000);
  const windowIndex = Math.floor(currentMs / windowMs);
  const windowStartMs = windowIndex * windowMs;
  const windowEndMs = windowStartMs + windowMs;
  const windowSegments = segments.filter(
    s => s.startMs >= windowStartMs && s.startMs < windowEndMs,
  );
  const remainingInWindowMs = windowEndMs - currentMs;
  const nextWindowIndex = windowIndex + 1;
  const shouldPrefetch =
    remainingInWindowMs <= leadMs && !translatedWindows.has(nextWindowIndex);

  return {
    windowIndex,
    windowStartMs,
    windowEndMs,
    windowSegments,
    prefetchWindowIndex: shouldPrefetch ? nextWindowIndex : null,
  };
}
