import type {
  ActiveProviderConfig,
  OpenCCVariant,
  TranslationRequest,
  TranslationResponse,
  WufLocalSecrets,
  WufSettings,
} from '../types.ts';
import { computeCacheKey, globalCacheManager } from '../lib/cache-manager.ts';
import { DEFAULT_LOCAL_PROFILE, resolvePresetProvider } from '../lib/provider-profiles.ts';
import {
  ensureLocalLlamaServer,
  isWatchdogLoopbackUrl,
  probeWatchdogEndpoint,
} from '../lib/watchdog-client.ts';
import { WufProviderError } from '../providers/errors.ts';
import {
  resolveChatCompletionsUrl,
  translateWithOpenAICompat,
} from '../providers/openai-compat.ts';
import { translateWithOpenCC } from '../providers/opencc.ts';
import { normalizeProtectedText } from '../vendor/wupage/shared/protected-text';

export const LOCAL_SENTENCE_CHUNK_MAX_CHARS = 360;

export interface LocalSentenceChunk {
  paragraphId: string;
  chunkIndex: number;
  prefix: string;
  coreText: string;
  suffix: string;
}

export interface LocalWebpageTranslationOptions {
  applyOpenCC?: boolean;
  maxChunkChars?: number;
}

const PROTECTED_TOKEN_RE = /⟪WUPAGE\d+⟫|<<<WUF_TAG_\d+>>>[\s\S]*?<<<WUF_END_\d+>>>|<<<WUF_TAG_\d+>>>/gu;
const WUPAGE_TOKEN_SPLIT_RE = /(⟪WUPAGE\d+⟫)/gu;
const WUPAGE_TOKEN_EXACT_RE = /^⟪WUPAGE\d+⟫$/u;
const WUPAGE_MARKER_SCAN_RE = /⟪WUPAGE\d+⟫/gu;

export interface ProtectedLinkPair {
  openMarker: string;
  closeMarker: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

export function extractProtectedLinkPairs(sourceText: string): ProtectedLinkPair[] {
  const occurrences: Array<{ marker: string; start: number; end: number }> = [];
  for (const match of sourceText.matchAll(WUPAGE_MARKER_SCAN_RE)) {
    const marker = match[0];
    const start = match.index ?? 0;
    occurrences.push({ marker, start, end: start + marker.length });
  }
  if (occurrences.length < 2) return [];

  const canOpen = (occ: { start: number; end: number }): boolean => {
    if (occ.end >= sourceText.length) return false;
    const prev = occ.start > 0 ? sourceText[occ.start - 1] : '';
    const next = sourceText[occ.end];
    if (prev && /[\p{L}\p{N}]/u.test(prev)) return false;
    if (/\s/u.test(next) || /[)\]}.,!?;:»」』】〉》]/u.test(next)) return false;
    return true;
  };

  const canClose = (occ: { start: number; end: number }): boolean => {
    if (occ.start === 0) return false;
    const prev = sourceText[occ.start - 1];
    const next = occ.end < sourceText.length ? sourceText[occ.end] : '';
    if (next && /[\p{L}\p{N}]/u.test(next)) return false;
    if (/\s/u.test(prev) || /[(\[{«「『【〈《]/u.test(prev)) return false;
    return true;
  };

  const pairs: ProtectedLinkPair[] = [];
  for (let i = 0; i < occurrences.length; i++) {
    const open = occurrences[i];
    if (!canOpen(open)) continue;
    for (let j = i + 1; j < occurrences.length; j++) {
      const close = occurrences[j];
      if (!canClose(close)) continue;
      if (!sourceText.slice(open.end, close.start).trim()) continue;
      pairs.push({
        openMarker: open.marker,
        closeMarker: close.marker,
        start: open.start,
        end: close.end,
        innerStart: open.end,
        innerEnd: close.start,
      });
      i = j;
      break;
    }
  }
  return pairs;
}

export function validateProtectedWebpageText(
  sourceText: string,
  translatedText: string,
): string | undefined {
  const normalized = normalizeProtectedText(sourceText, translatedText);
  if (normalized === undefined) return undefined;

  const pairs = extractProtectedLinkPairs(sourceText);
  if (!pairs.length) return normalized;

  const pairedMarkers = new Set(pairs.flatMap((pair) => [pair.openMarker, pair.closeMarker]));
  const translatedSpans: Array<{ pair: ProtectedLinkPair; start: number; end: number; innerStart: number }> = [];
  for (const pair of pairs) {
    const start = normalized.indexOf(pair.openMarker);
    const end = normalized.indexOf(pair.closeMarker);
    if (start === -1 || end <= start) return undefined;
    const innerStart = start + pair.openMarker.length;
    if (!normalized.slice(innerStart, end).trim()) return undefined;
    translatedSpans.push({ pair, start, end, innerStart });
  }
  translatedSpans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < translatedSpans.length; i++) {
    if (translatedSpans[i].start < translatedSpans[i - 1].end) return undefined;
  }

  const stripLinkSpans = (
    text: string,
    spans: Array<{ start: number; end: number; closeLength: number }>,
  ): string => {
    let result = '';
    let cursor = 0;
    for (const span of spans) {
      result += text.slice(cursor, span.start);
      cursor = span.end + span.closeLength;
    }
    result += text.slice(cursor);
    return result.replace(WUPAGE_MARKER_SCAN_RE, ' ');
  };

  const sourceOutside = stripLinkSpans(
    sourceText,
    pairs.map((pair) => ({ start: pair.start, end: pair.end - pair.closeMarker.length, closeLength: pair.closeMarker.length })),
  );
  const translatedOutside = stripLinkSpans(
    normalized,
    translatedSpans.map((span) => ({ start: span.start, end: span.end, closeLength: span.pair.closeMarker.length })),
  );
  if (/[\p{L}\p{N}]/u.test(sourceOutside) && !/[\p{L}\p{N}]/u.test(translatedOutside)) {
    return undefined;
  }

  for (const match of sourceText.matchAll(WUPAGE_MARKER_SCAN_RE)) {
    const marker = match[0];
    if (pairedMarkers.has(marker)) continue;
    const srcIdx = match.index ?? 0;
    const trIdx = normalized.indexOf(marker);
    const srcOwner = pairs.find((pair) => srcIdx >= pair.innerStart && srcIdx < pair.end - pair.closeMarker.length)?.openMarker;
    const trOwner = translatedSpans.find((span) => trIdx >= span.innerStart && trIdx < span.end)?.pair.openMarker;
    if (srcOwner !== trOwner) return undefined;
  }

  return normalized;
}

async function translateProseSlices(
  sliceText: string,
  translateFragment: (fragment: string) => Promise<string>,
): Promise<string> {
  const parts = sliceText.split(WUPAGE_TOKEN_SPLIT_RE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || WUPAGE_TOKEN_EXACT_RE.test(part) || !/\p{L}/u.test(part)) {
      continue;
    }
    const lead = /^\s*/u.exec(part)![0];
    const trail = /\s*$/u.exec(part)![0];
    const trimmed = part.trim();
    if (!trimmed) continue;

    const translatedFragment = await translateFragment(trimmed);
    const cleaned = translatedFragment.trim();
    if (cleaned) {
      parts[i] = `${lead}${cleaned}${trail}`;
    }
  }
  return parts.join('');
}

export async function repairProtectedWebpageText(
  sourceText: string,
  translateFragment: (fragment: string) => Promise<string>,
): Promise<string> {
  const pairs = extractProtectedLinkPairs(sourceText);
  if (!pairs.length) {
    return translateProseSlices(sourceText, translateFragment);
  }

  const out: string[] = [];
  let cursor = 0;
  for (const pair of pairs) {
    if (pair.start > cursor) {
      out.push(await translateProseSlices(sourceText.slice(cursor, pair.start), translateFragment));
    }
    const innerSource = sourceText.slice(pair.innerStart, pair.innerEnd);
    const translatedInner = (await translateProseSlices(innerSource, translateFragment)).trim();
    const safeInner = translatedInner || innerSource.trim();
    out.push(`${pair.openMarker}${safeInner}${pair.closeMarker}`);
    cursor = pair.end;
  }
  if (cursor < sourceText.length) {
    out.push(await translateProseSlices(sourceText.slice(cursor), translateFragment));
  }
  return out.join('');
}

interface TextSpan {
  start: number;
  end: number;
}

function maskProtectedSpans(text: string): { masked: string; protectedRanges: Array<[number, number]> } {
  const protectedRanges: Array<[number, number]> = extractProtectedLinkPairs(text).map((pair) => [
    pair.start,
    pair.end,
  ]);
  for (const match of text.matchAll(PROTECTED_TOKEN_RE)) {
    const offset = match.index ?? 0;
    const end = offset + match[0].length;
    if (!protectedRanges.some(([s, e]) => offset >= s && end <= e)) {
      protectedRanges.push([offset, end]);
    }
  }
  protectedRanges.sort((a, b) => a[0] - b[0]);

  const chars = text.split('');
  for (const [start, end] of protectedRanges) {
    if (start < end && start < chars.length) {
      const limit = Math.min(end, chars.length);
      chars[start] = '\uE000';
      for (let idx = start + 1; idx < limit; idx++) {
        chars[idx] = '\uE001';
      }
    }
  }
  return { masked: chars.join(''), protectedRanges };
}

function isInsideProtectedRange(index: number, protectedRanges: Array<[number, number]>): boolean {
  return protectedRanges.some(([start, end]) => index > start && index < end);
}

function trimSpan(text: string, start: number, end: number): TextSpan | null {
  while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && /\s/u.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}

function splitLongSpanAtClauses(
  rawText: string,
  maskedText: string,
  span: TextSpan,
  maxChunkChars: number,
  protectedRanges: Array<[number, number]>,
): TextSpan[] {
  if (span.end - span.start <= maxChunkChars) {
    return [span];
  }

  const parts: TextSpan[] = [];
  let cursor = span.start;

  while (cursor < span.end) {
    const remaining = span.end - cursor;
    if (remaining <= maxChunkChars) {
      const tail = trimSpan(rawText, cursor, span.end);
      if (tail) parts.push(tail);
      break;
    }

    const windowEnd = cursor + maxChunkChars;
    let splitAt = -1;

    // 1. Prefer clause punctuation followed by whitespace within maxChunkChars.
    for (let i = windowEnd; i > cursor + Math.floor(maxChunkChars * 0.35); i--) {
      const ch = maskedText[i - 1];
      if ((ch === ',' || ch === '，' || ch === '、' || ch === ';' || ch === '；' || ch === ':' || ch === '：')
        && !isInsideProtectedRange(i, protectedRanges)) {
        splitAt = i;
        break;
      }
    }

    // 2. Fall back to whitespace boundary within maxChunkChars.
    if (splitAt < 0) {
      for (let i = windowEnd; i > cursor; i--) {
        if (/\s/u.test(maskedText[i - 1]) && !isInsideProtectedRange(i, protectedRanges)) {
          splitAt = i;
          break;
        }
      }
    }

    // 3. No whitespace inside limit: split cleanly outside protected tokens.
    if (splitAt < 0) {
      splitAt = windowEnd;
      const hit = protectedRanges.find(([pStart, pEnd]) => splitAt > pStart && splitAt < pEnd);
      if (hit) {
        splitAt = hit[0] > cursor ? hit[0] : hit[1];
      }
    }

    if (splitAt <= cursor) {
      splitAt = Math.min(span.end, cursor + maxChunkChars);
    }

    const chunkSpan = trimSpan(rawText, cursor, splitAt);
    if (chunkSpan) {
      parts.push(chunkSpan);
    }
    cursor = splitAt;
    while (cursor < span.end && /\s/u.test(rawText[cursor])) {
      cursor++;
    }
  }

  return parts.length > 0 ? parts : [span];
}

function collectSentenceSpans(
  rawText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  maxChunkChars: number,
  protectedRanges: Array<[number, number]>,
): TextSpan[] {
  const rawSentences: TextSpan[] = [];
  let cursor = bodyStart;
  const closingQuotes = new Set(['\'', '"', '”', '’', ')', ']', '}', '»', '》', '】', '」', '』']);

  for (let i = bodyStart; i < bodyEnd; i++) {
    const ch = maskedText[i];
    if (ch === '\n' || ch === '\r') {
      const span = trimSpan(rawText, cursor, i);
      if (span) rawSentences.push(span);
      while (i + 1 < bodyEnd && (maskedText[i + 1] === '\n' || maskedText[i + 1] === '\r')) {
        i++;
      }
      cursor = i + 1;
      continue;
    }

    const isAsciiSentenceEnd = ch === '.' || ch === '!' || ch === '?';
    const isCjkSentenceEnd = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === ';';
    if (!isAsciiSentenceEnd && !isCjkSentenceEnd) continue;
    if (isInsideProtectedRange(i, protectedRanges)) continue;

    // Skip decimals/version numbers like 3.14 or 1.7.0
    if (ch === '.' && i > bodyStart && i + 1 < bodyEnd && /\d/.test(maskedText[i - 1]) && /\d/.test(maskedText[i + 1])) {
      continue;
    }

    let end = i + 1;
    while (end < bodyEnd && (closingQuotes.has(maskedText[end]) || (isAsciiSentenceEnd && maskedText[end] === ch))) {
      end++;
    }

    // ASCII sentence endings require whitespace or end-of-body after closing punctuation.
    if (isAsciiSentenceEnd && end < bodyEnd && !/\s/u.test(maskedText[end])) {
      continue;
    }

    const span = trimSpan(rawText, cursor, end);
    if (span) rawSentences.push(span);
    cursor = end;
    while (cursor < bodyEnd && /\s/u.test(rawText[cursor])) {
      cursor++;
    }
    i = Math.max(i, cursor - 1);
  }

  const tail = trimSpan(rawText, cursor, bodyEnd);
  if (tail) rawSentences.push(tail);

  const atomicSpans: TextSpan[] = [];
  for (const span of rawSentences) {
    if (span.end - span.start > maxChunkChars) {
      atomicSpans.push(...splitLongSpanAtClauses(rawText, maskedText, span, maxChunkChars, protectedRanges));
    } else {
      atomicSpans.push(span);
    }
  }
  return atomicSpans;
}

export function splitParagraphIntoSentenceChunks(
  text: string,
  options: { paragraphId?: string; maxChunkChars?: number } = {},
): LocalSentenceChunk[] {
  const paragraphId = options.paragraphId ?? 'p-0';
  const maxChunkChars = Math.max(40, options.maxChunkChars ?? LOCAL_SENTENCE_CHUNK_MAX_CHARS);
  const body = trimSpan(text, 0, text.length);
  if (!body) {
    return [{ paragraphId, chunkIndex: 0, prefix: text, coreText: '', suffix: '' }];
  }

  const hasMarkersInBody = /⟪WUPAGE\d+⟫/u.test(text.slice(body.start, body.end));
  if (body.end - body.start <= maxChunkChars && !hasMarkersInBody) {
    return [
      {
        paragraphId,
        chunkIndex: 0,
        prefix: text.slice(0, body.start),
        coreText: text.slice(body.start, body.end),
        suffix: text.slice(body.end),
      },
    ];
  }

  const { masked, protectedRanges } = maskProtectedSpans(text);
  const atomicSpans = collectSentenceSpans(
    text,
    masked,
    body.start,
    body.end,
    maxChunkChars,
    protectedRanges,
  );

  if (atomicSpans.length <= 1) {
    return [
      {
        paragraphId,
        chunkIndex: 0,
        prefix: text.slice(0, body.start),
        coreText: text.slice(body.start, body.end),
        suffix: text.slice(body.end),
      },
    ];
  }

  const groupedSpans: TextSpan[] = [];
  let currentGroup: TextSpan = { ...atomicSpans[0] };

  for (let i = 1; i < atomicSpans.length; i++) {
    const next = atomicSpans[i];
    const hasNewlineBetween = /[\r\n]/u.test(text.slice(currentGroup.end, next.start));
    const currentHasMarkers = /⟪WUPAGE\d+⟫/u.test(text.slice(currentGroup.start, currentGroup.end));
    const nextHasMarkers = /⟪WUPAGE\d+⟫/u.test(text.slice(next.start, next.end));
    if (!hasNewlineBetween && !(currentHasMarkers && nextHasMarkers) && next.end - currentGroup.start <= maxChunkChars) {
      currentGroup.end = next.end;
    } else {
      groupedSpans.push(currentGroup);
      currentGroup = { ...next };
    }
  }
  groupedSpans.push(currentGroup);

  return groupedSpans.map((span, idx) => ({
    paragraphId,
    chunkIndex: idx,
    prefix: idx === 0 ? text.slice(0, span.start) : '',
    coreText: text.slice(span.start, span.end),
    suffix:
      idx + 1 < groupedSpans.length
        ? text.slice(span.end, groupedSpans[idx + 1].start)
        : text.slice(span.end),
  }));
}

export function reassembleParagraphChunks(
  paragraphId: string,
  chunks: LocalSentenceChunk[],
  translatedCores: string[],
): string {
  if (chunks.length !== translatedCores.length) {
    throw new Error(
      `Paragraph ${paragraphId} chunk count mismatch: expected ${chunks.length}, received ${translatedCores.length}`,
    );
  }
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].paragraphId !== paragraphId) {
      throw new Error(
        `Paragraph chunk alignment mismatch: expected ${paragraphId}, got ${chunks[i].paragraphId}`,
      );
    }
  }
  const ordered = chunks
    .map((chunk, idx) => ({ chunk, translation: translatedCores[idx] }))
    .sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);

  return ordered
    .map(({ chunk, translation }) => `${chunk.prefix}${translation.trim()}${chunk.suffix}`)
    .join('');
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function buildPlainTextSystemPrompt(
  targetLanguage: string,
  customPrompt: string,
  protectedTokens: string[] = [],
  hasPairedLinks = false,
): string {
  const base = customPrompt.trim()
    ? customPrompt.trim()
    : `You are a precise translation engine. Translate the user text into ${targetLanguage}. Output only the translation in plain text without commentary, quotes, or numbering.`;
  if (protectedTokens.length > 0) {
    const tokenList = protectedTokens.join(', ');
    if (hasPairedLinks) {
      return `${base}\nKeep these exact placeholder tokens unchanged: ${tokenList}. Keep paired link placeholders around only the translated link label text, and translate both the link label and the surrounding prose naturally.`;
    }
    return `${base}\nKeep these exact placeholder tokens unchanged: ${tokenList}.`;
  }
  return base;
}

async function translatePlainChunk(
  text: string,
  provider: ActiveProviderConfig,
  targetLanguage: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const matchedTokens = Array.from(new Set(text.match(/⟪WUPAGE\d+⟫/gu) ?? []));
  const hasPairedLinks = extractProtectedLinkPairs(text).length > 0;
  const systemPrompt = buildPlainTextSystemPrompt(
    targetLanguage,
    provider.systemPrompt,
    matchedTokens,
    hasPairedLinks,
  );
  const res = await translateWithOpenAICompat({
    provider: {
      ...provider,
      systemPrompt,
    },
    texts: [text],
    targetLanguage,
    timeoutMs,
    signal,
  });
  const translated = res.translations[0]?.trim() ?? '';
  if (!translated) {
    throw new WufProviderError('Local translation model returned empty text', {
      code: 'INVALID_RESPONSE',
      provider: 'openai-compat-local',
    });
  }
  return translated;
}

async function translateProtectedChunkPlain(
  sourceText: string,
  provider: ActiveProviderConfig,
  targetLanguage: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const initial = await translatePlainChunk(
    sourceText,
    provider,
    targetLanguage,
    timeoutMs,
    signal,
  );
  const validated = validateProtectedWebpageText(sourceText, initial);
  if (validated !== undefined) {
    return validated;
  }

  // Fallback when the model dropped, swapped, emptied, or over-extended inline
  // link/atomic markers: translate prose fragments sequentially and rebuild markers in code.
  const repaired = await repairProtectedWebpageText(sourceText, (fragment) =>
    translatePlainChunk(fragment, provider, targetLanguage, timeoutMs, signal),
  );
  const verifiedRepaired = validateProtectedWebpageText(sourceText, repaired);
  if (verifiedRepaired === undefined) {
    throw new WufProviderError('Translation response failed to preserve protected inline elements', {
      code: 'INVALID_RESPONSE',
      provider: 'openai-compat-local',
    });
  }
  return verifiedRepaired;
}

export async function translateLocalWebpage(
  request: TranslationRequest,
  settings: WufSettings,
  secrets: WufLocalSecrets,
  signal?: AbortSignal,
  bypassCache = false,
  options: LocalWebpageTranslationOptions = {},
): Promise<TranslationResponse & { cached: number }> {
  signal?.throwIfAborted();
  const configured = resolvePresetProvider(
    settings,
    secrets,
    'webpage',
    'openai-compat-local',
    request.modelOverride,
  );

  let effectiveModel = configured.effectiveModel;
  try {
    await raceWithAbort(
      ensureLocalLlamaServer(configured.baseUrl, effectiveModel, { apiKey: configured.apiKey }),
      signal,
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof WufProviderError) throw err;
    throw new WufProviderError(err instanceof Error ? err.message : String(err), {
      code: 'WATCHDOG_ERROR',
      provider: 'openai-compat-local',
      cause: err,
    });
  }
  signal?.throwIfAborted();

  if (!effectiveModel && isWatchdogLoopbackUrl(configured.baseUrl)) {
    const watchdog = await raceWithAbort(probeWatchdogEndpoint(configured.baseUrl), signal);
    signal?.throwIfAborted();
    effectiveModel = watchdog.currentModelId || watchdog.currentModel || '';
  }

  const providerWithResolvedModel: ActiveProviderConfig = {
    ...configured,
    effectiveModel,
  };

  const timeoutMs =
    Math.max(5, configured.fetchTimeoutSec || DEFAULT_LOCAL_PROFILE.fetchTimeoutSec || 120) * 1000;
  const sourceLang = request.sourceLanguage || 'auto';
  const applyOpenCC = options.applyOpenCC ?? request.applyOpenCC ?? false;
  const openccVariant: OpenCCVariant = request.openccVariant ?? settings.openccVariant;
  const preservePlaceholders = Boolean(request.preservePlaceholders);

  const cacheScope = await computeCacheKey({
    sourceLang,
    targetLang: request.targetLanguage,
    engine: 'openai-compat-local',
    model: effectiveModel || 'default',
    text: JSON.stringify({
      version: 5,
      pipeline: 'wuf-local-plain',
      baseUrl: resolveChatCompletionsUrl(configured.baseUrl),
      model: effectiveModel || 'default',
      targetLanguage: request.targetLanguage,
      sourceLanguage: sourceLang,
      systemPrompt: configured.systemPrompt.trim(),
      preservePlaceholders,
      opencc: [Boolean(applyOpenCC), openccVariant],
    }),
  });

  const translations = new Array<string>(request.texts.length);
  let cachedCount = 0;

  for (let i = 0; i < request.texts.length; i++) {
    signal?.throwIfAborted();
    const sourceText = request.texts[i];
    const paragraphId = request.paragraphIds?.[i] ?? `p-${i}`;

    if (!sourceText.trim()) {
      translations[i] = sourceText;
      continue;
    }

    if (!bypassCache) {
      const hit = await globalCacheManager.get({
        text: sourceText,
        sourceLang,
        targetLang: request.targetLanguage,
        engine: 'openai-compat-local',
        model: cacheScope,
      });
      if (hit !== null) {
        const validated = preservePlaceholders && /⟪WUPAGE\d+⟫/u.test(sourceText)
          ? validateProtectedWebpageText(sourceText, hit)
          : hit;
        if (validated !== undefined) {
          translations[i] = validated;
          cachedCount++;
          continue;
        }
      }
    }

    const chunks = splitParagraphIntoSentenceChunks(sourceText, {
      paragraphId,
      maxChunkChars: options.maxChunkChars ?? LOCAL_SENTENCE_CHUNK_MAX_CHARS,
    });
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
      signal?.throwIfAborted();
      if (!chunk.coreText.trim()) {
        translatedChunks.push('');
        continue;
      }
      const hasMarkers = preservePlaceholders && /⟪WUPAGE\d+⟫/u.test(chunk.coreText);
      const translatedCore = hasMarkers
        ? await translateProtectedChunkPlain(
            chunk.coreText,
            providerWithResolvedModel,
            request.targetLanguage,
            timeoutMs,
            signal,
          )
        : await translatePlainChunk(
            chunk.coreText,
            providerWithResolvedModel,
            request.targetLanguage,
            timeoutMs,
            signal,
          );
      translatedChunks.push(translatedCore);
    }

    signal?.throwIfAborted();
    let reassembled = reassembleParagraphChunks(paragraphId, chunks, translatedChunks);
    if (preservePlaceholders && /⟪WUPAGE\d+⟫/u.test(sourceText)) {
      let validated = validateProtectedWebpageText(sourceText, reassembled);
      if (validated === undefined) {
        const repaired = await repairProtectedWebpageText(sourceText, (fragment) =>
          translatePlainChunk(
            fragment,
            providerWithResolvedModel,
            request.targetLanguage,
            timeoutMs,
            signal,
          ),
        );
        validated = validateProtectedWebpageText(sourceText, repaired);
      }
      if (validated === undefined) {
        throw new WufProviderError('Paragraph assembly failed to preserve protected inline elements', {
          code: 'INVALID_RESPONSE',
          provider: 'openai-compat-local',
        });
      }
      reassembled = validated;
    }

    if (applyOpenCC) {
      const converted = await translateWithOpenCC([reassembled], openccVariant, signal);
      reassembled = converted[0] ?? reassembled;
    }

    translations[i] = reassembled;

    if (!bypassCache && reassembled.trim() && reassembled !== sourceText) {
      await globalCacheManager.setBatch([
        {
          text: sourceText,
          translatedText: reassembled,
          sourceLang,
          targetLang: request.targetLanguage,
          engine: 'openai-compat-local',
          model: cacheScope,
        },
      ]);
    }
  }

  return {
    translations,
    cached: cachedCount,
    engine: 'openai-compat-local',
    effectiveModel: effectiveModel || 'default',
    profileType: 'local',
    ...(applyOpenCC ? { openccApplied: openccVariant } : {}),
  };
}
