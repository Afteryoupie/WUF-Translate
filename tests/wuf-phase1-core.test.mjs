import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CacheManager,
  computeCacheKey,
  partitionTextBatches,
  scheduleBatchTranslation,
  purgeReasoningArtifacts,
  translateWithOpenCC,
} from '../dist/wuf/index.js';

test('CacheManager: computes consistent SHA-256 keys and respects LRU + TTL', async () => {
  const key1 = await computeCacheKey({
    text: 'Hello world',
    sourceLang: 'en',
    targetLang: 'zh-TW',
    engine: 'openai-compat-online',
    model: 'gpt-4o-mini',
  });
  const key2 = await computeCacheKey({
    text: 'Hello world',
    sourceLang: 'en',
    targetLang: 'zh-TW',
    engine: 'openai-compat-online',
    model: 'gpt-4o-mini',
  });
  assert.equal(key1, key2);
  assert.equal(key1.length, 64); // SHA-256 hex length

  // Small capacity cache for LRU testing
  const cache = new CacheManager(2);

  await cache.set({
    text: 'One',
    translatedText: '一',
    targetLang: 'zh-TW',
    engine: 'test',
  });
  await cache.set({
    text: 'Two',
    translatedText: '二',
    targetLang: 'zh-TW',
    engine: 'test',
  });

  assert.equal(await cache.get({ text: 'One', targetLang: 'zh-TW', engine: 'test' }), '一');

  // Adding third item should evict 'Two' because 'One' was touched above
  await cache.set({
    text: 'Three',
    translatedText: '三',
    targetLang: 'zh-TW',
    engine: 'test',
  });

  assert.equal(await cache.get({ text: 'One', targetLang: 'zh-TW', engine: 'test' }), '一');
  assert.equal(await cache.get({ text: 'Two', targetLang: 'zh-TW', engine: 'test' }), null);
  assert.equal(await cache.get({ text: 'Three', targetLang: 'zh-TW', engine: 'test' }), '三');

  // TTL expiration testing
  await cache.set({
    text: 'Expiring',
    translatedText: '過期',
    targetLang: 'zh-TW',
    engine: 'test',
    ttlMs: 10, // 10ms TTL
  });

  await new Promise(r => setTimeout(r, 25));
  assert.equal(await cache.get({ text: 'Expiring', targetLang: 'zh-TW', engine: 'test' }), null);

  const stats = cache.getStats();
  assert.ok(stats.hits > 0);
  assert.ok(stats.misses > 0);

  await cache.clear();
  assert.equal(cache.getStats().memorySize, 0);
});

test('BatchScheduler: partitions first-batch with fast limits and subsequent batches with standard limits', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    index: i,
    text: `Paragraph ${i}: Some sample text to translate into traditional Chinese.`,
  }));

  const batches = partitionTextBatches(items, 4, 1000, 10, 3000);
  assert.ok(batches.length >= 3);
  // First batch should have at most 4 items
  assert.equal(batches[0].length, 4);
  // Subsequent batches can have up to 10 items
  assert.ok(batches[1].length <= 10);
});

test('BatchScheduler: schedules translation with automatic bisection fallback when segment count mismatches', async () => {
  const cache = new CacheManager(50);
  const inputTexts = ['Apple', 'Banana', 'Cherry', 'Date'];

  // Simulate an upstream engine that fails when given all 4 items at once (returns 1 item),
  // but succeeds when bisected into 2 items or 1 item.
  let callCount = 0;
  const mockTranslateFn = async (texts) => {
    callCount++;
    if (texts.length === 4) {
      // Bad output: returns merged string instead of 4 segments
      return ['蘋果 香蕉 櫻桃 棗子'];
    }
    // Sub-batches succeed
    return texts.map(t => `[TR:${t}]`);
  };

  const results = await scheduleBatchTranslation({
    texts: inputTexts,
    translateFn: mockTranslateFn,
    targetLang: 'zh-TW',
    engine: 'test-llm',
    config: {
      firstBatchMaxCount: 4,
      concurrency: 1,
      cache,
    },
  });

  assert.equal(results.length, 4);
  assert.deepEqual(results, [
    '[TR:Apple]',
    '[TR:Banana]',
    '[TR:Cherry]',
    '[TR:Date]',
  ]);
  assert.ok(callCount > 1, 'Should have triggered bisection retry calls');

  // Verify items got saved to cache
  const cachedApple = await cache.get({ text: 'Apple', targetLang: 'zh-TW', engine: 'test-llm' });
  assert.equal(cachedApple, '[TR:Apple]');
});

test('HybridClient: purges thinking/reasoning tags completely from model output', () => {
  const rawWithThinking = '<think>\nFirst, let me analyze the tone and context of this sentence.\nThe user wants traditional Chinese.\n</think>這是一句乾淨的譯文。';
  assert.equal(purgeReasoningArtifacts(rawWithThinking), '這是一句乾淨的譯文。');

  const unclosedThinking = '<think>I was thinking but the output stream cut off mid-thought...';
  assert.equal(purgeReasoningArtifacts(unclosedThinking), '');

  const cleanText = '正常的譯文內容';
  assert.equal(purgeReasoningArtifacts(cleanText), '正常的譯文內容');
});

test('OpenCC: converts Simplified to Traditional Taiwan phrasing offline', async () => {
  const simplified = ['内存', '信息', '网络', '硬盘'];
  const twp = await translateWithOpenCC(simplified, 's2twp');
  assert.deepEqual(twp, ['記憶體', '資訊', '網路', '硬碟']);

  const backToCn = await translateWithOpenCC(twp, 'tw2sp');
  assert.deepEqual(backToCn, ['内存', '信息', '网络', '硬盘']);
});
