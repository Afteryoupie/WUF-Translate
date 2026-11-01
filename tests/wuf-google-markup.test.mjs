import test from 'node:test';
import assert from 'node:assert/strict';
import { translateWithGoogle } from '../dist/wuf/index.js';

test('Google never receives DOM placeholders and returns them intact around translated prose', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async url => {
    const text = new URL(url).searchParams.get('q');
    requests.push(text);
    return new Response(JSON.stringify([[[`譯文:${text}`]]]), { status: 200 });
  };
  try {
    const result = await translateWithGoogle({
      texts: ['See <<<WUF_TAG_0>>>Introduction<<<WUF_END_0>>>.'],
      targetLanguage: 'zh-TW',
    });
    assert.deepEqual(requests, ['See ', 'Introduction', '.']);
    assert.deepEqual(result, ['譯文:See <<<WUF_TAG_0>>>譯文:Introduction<<<WUF_END_0>>>譯文:.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
