import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeTranslation,
  DEFAULT_SETTINGS,
  DEFAULT_LOCAL_SECRETS,
} from '../dist/wuf/index.js';

test('executeTranslation: automatically recovers from Segment count mismatch via bisection fallback', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.webpage.engine = 'openai-compat-local';
  const secrets = structuredClone(DEFAULT_LOCAL_SECRETS);

  // We test translating 4 segments where the mock fetch would simulate upstream LLM merging segments,
  // verifying executeTranslation transparently bisects and returns all 4 segments without throwing mismatch.
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/status') || urlStr.includes('/api/wake')) {
      return new Response(JSON.stringify({ status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    callCount++;
    const body = JSON.parse(init.body);
    const content = body.messages[1].content;
    const parts = content.split('---WUF-SEG---');

    if (parts.length > 1) {
      // Simulate typical small LLM failure: swallowing delimiters and returning only 1 combined line
      return new Response(JSON.stringify({
        choices: [{ message: { content: '合併翻譯輸出（無分隔符）' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Single segment call succeeds
    return new Response(JSON.stringify({
      choices: [{ message: { content: `[譯:${content.trim()}]` } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const inputTexts = ['段落一', '段落二', '段落三', '段落四'];
    const result = await executeTranslation(
      {
        texts: inputTexts,
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
      },
      settings,
      secrets,
    );

    assert.equal(result.translations.length, 4);
    assert.deepEqual(result.translations, [
      '[譯:段落一]',
      '[譯:段落二]',
      '[譯:段落三]',
      '[譯:段落四]',
    ]);
    assert.ok(callCount > 1, 'Bisection fallback must have executed multiple sub-batch retries');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
