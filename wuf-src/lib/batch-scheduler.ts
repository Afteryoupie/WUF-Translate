/**
 * Clean-Room BatchScheduler (M02)
 *
 * Implements intelligent batching, bounded concurrency, cache pre-checks,
 * and automatic bisection fallback for translation alignment.
 *
 * Requirements:
 * - First batch fast feedback: Max 4 segments or 1000 characters.
 * - Dynamic subsequent batches: 10-20 segments or up to 3000 characters.
 * - Cache integration: Pre-fills hit items, schedules only miss items.
 * - Bisection fallback: If batch translation returns mismatched segment count,
 *   splits recursively until segment-exact alignment is achieved.
 */

import { globalCacheManager, type CacheManager } from './cache-manager.ts';

export interface BatchItem {
  index: number;
  text: string;
}

export interface BatchSchedulerConfig {
  firstBatchMaxCount?: number;
  firstBatchMaxChars?: number;
  subsequentBatchMaxCount?: number;
  subsequentBatchMaxChars?: number;
  concurrency?: number;
  cache?: CacheManager;
  onProgress?: (progress: { completed: number; total: number; stage?: string }) => void;
  signal?: AbortSignal;
}

export type BatchTranslateFn = (
  texts: string[],
  signal?: AbortSignal,
) => Promise<string[]>;

export interface ScheduleOptions {
  texts: string[];
  translateFn: BatchTranslateFn;
  fallbackFn?: BatchTranslateFn;
  sourceLang?: string;
  targetLang: string;
  engine: string;
  model?: string;
  config?: BatchSchedulerConfig;
}

/**
 * Splits texts into intelligent batches respecting first-batch fast path.
 */
export function partitionTextBatches(
  items: BatchItem[],
  firstBatchMaxCount: number = 4,
  firstBatchMaxChars: number = 1000,
  subsequentBatchMaxCount: number = 15,
  subsequentBatchMaxChars: number = 3000,
): BatchItem[][] {
  if (items.length === 0) return [];

  const batches: BatchItem[][] = [];
  let currentIndex = 0;

  // 1. First batch (Fast-path)
  const firstBatch: BatchItem[] = [];
  let firstChars = 0;
  while (currentIndex < items.length) {
    const item = items[currentIndex];
    const textLen = item.text.length;
    if (
      firstBatch.length > 0 &&
      (firstBatch.length >= firstBatchMaxCount || firstChars + textLen > firstBatchMaxChars)
    ) {
      break;
    }
    firstBatch.push(item);
    firstChars += textLen;
    currentIndex++;
  }
  if (firstBatch.length > 0) {
    batches.push(firstBatch);
  }

  // 2. Subsequent batches
  while (currentIndex < items.length) {
    const batch: BatchItem[] = [];
    let currentChars = 0;
    while (currentIndex < items.length) {
      const item = items[currentIndex];
      const textLen = item.text.length;
      if (
        batch.length > 0 &&
        (batch.length >= subsequentBatchMaxCount || currentChars + textLen > subsequentBatchMaxChars)
      ) {
        break;
      }
      batch.push(item);
      currentChars += textLen;
      currentIndex++;
    }
    if (batch.length > 0) {
      batches.push(batch);
    }
  }

  return batches;
}

/**
 * Executes a single batch with recursive bisection fallback.
 * If translateFn returns an array whose length !== batch.length,
 * recursively bisects the batch into two halves.
 */
async function executeBatchWithBisection(
  batch: BatchItem[],
  translateFn: BatchTranslateFn,
  fallbackFn?: BatchTranslateFn,
  signal?: AbortSignal,
): Promise<string[]> {
  if (batch.length === 0) return [];
  if (signal?.aborted) {
    throw new Error('Batch translation aborted');
  }

  const rawTexts = batch.map(b => b.text);

  // If batch is a single item, try directly
  if (batch.length === 1) {
    try {
      const res = await translateFn(rawTexts, signal);
      if (res && res.length === 1 && typeof res[0] === 'string') {
        return res;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (fallbackFn) {
        try {
          const fbRes = await fallbackFn(rawTexts, signal);
          if (fbRes && fbRes.length === 1) return fbRes;
        } catch {
          // Fall through to returning raw source text on fatal single failure
        }
      }
      return rawTexts; // Safe fallback: preserve original text
    }
    return rawTexts;
  }

  try {
    const results = await translateFn(rawTexts, signal);
    if (Array.isArray(results) && results.length === batch.length) {
      return results;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // On error, fall through to bisection
  }

  // Bisection Fallback: Split batch in half
  const mid = Math.floor(batch.length / 2);
  const leftBatch = batch.slice(0, mid);
  const rightBatch = batch.slice(mid);

  const [leftResults, rightResults] = await Promise.all([
    executeBatchWithBisection(leftBatch, translateFn, fallbackFn, signal),
    executeBatchWithBisection(rightBatch, translateFn, fallbackFn, signal),
  ]);

  return [...leftResults, ...rightResults];
}

/**
 * High-level scheduler that coordinates caching, partitioning, concurrency,
 * and bisection fallback.
 */
export async function scheduleBatchTranslation(
  options: ScheduleOptions,
): Promise<string[]> {
  const { texts, translateFn, fallbackFn, sourceLang, targetLang, engine, model, config } = options;
  if (!texts || texts.length === 0) return [];

  const cache = config?.cache ?? globalCacheManager;
  const signal = config?.signal;
  const concurrency = Math.max(1, config?.concurrency ?? 2);
  const results: string[] = new Array(texts.length).fill('');
  const missItems: BatchItem[] = [];

  let completedCount = 0;

  // 1. Check Cache for all items
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text || !text.trim()) {
      results[i] = text;
      completedCount++;
      continue;
    }

    const cached = await cache.get({
      text,
      sourceLang,
      targetLang,
      engine,
      model,
    });

    if (cached !== null) {
      results[i] = cached;
      completedCount++;
    } else {
      missItems.push({ index: i, text });
    }
  }

  config?.onProgress?.({
    completed: completedCount,
    total: texts.length,
    stage: 'cache-checked',
  });

  if (missItems.length === 0) {
    return results;
  }

  // 2. Partition miss items into batches
  const batches = partitionTextBatches(
    missItems,
    config?.firstBatchMaxCount ?? 4,
    config?.firstBatchMaxChars ?? 1000,
    config?.subsequentBatchMaxCount ?? 15,
    config?.subsequentBatchMaxChars ?? 3000,
  );

  // 3. Concurrency worker queue
  let batchIndex = 0;
  async function worker(): Promise<void> {
    while (batchIndex < batches.length) {
      if (signal?.aborted) return;
      const curBatch = batches[batchIndex++];
      if (!curBatch || curBatch.length === 0) continue;

      const batchTranslations = await executeBatchWithBisection(
        curBatch,
        translateFn,
        fallbackFn,
        signal,
      );

      // Write back results and update cache
      const cacheEntries = [];
      for (let j = 0; j < curBatch.length; j++) {
        const item = curBatch[j];
        const tr = batchTranslations[j] ?? item.text;
        results[item.index] = tr;
        completedCount++;

        if (tr && tr.trim() && tr !== item.text) {
          cacheEntries.push({
            text: item.text,
            translatedText: tr,
            sourceLang,
            targetLang,
            engine,
            model,
          });
        }
      }

      if (cacheEntries.length > 0) {
        void cache.setBatch(cacheEntries);
      }

      config?.onProgress?.({
        completed: completedCount,
        total: texts.length,
        stage: 'translating',
      });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
