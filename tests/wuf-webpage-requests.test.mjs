import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, handleRuntimeMessage } from '../dist/wuf/index.js';

function storage(settings = structuredClone(DEFAULT_SETTINGS)) {
  const area = data => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(data)).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)),
  });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
  return settings;
}

test('Webpage cancellation reaches fetch and is scoped to the sending document', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  storage();
  let started; let fetchSignal;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    fetchSignal = init.signal; started();
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };
  const sender = { tab: { id: 71 }, frameId: 0, documentId: 'current-document' };
  try {
    const running = handleRuntimeMessage({ type: 'wuf:wupage-translate', requestId: 'request-one',
      request: { texts: ['Cancel this paragraph'], engine: 'google-translate', targetLanguage: 'zh-TW', purpose: 'webpage', preservePlaceholders: true } }, sender);
    await ready;
    await handleRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId: 'request-one' }, { ...sender, documentId: 'other-document' });
    assert.equal(fetchSignal.aborted, false, 'Another document must not cancel this request');
    await handleRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId: 'request-one' }, sender);
    assert.equal(fetchSignal.aborted, true);
    assert.equal((await running).ok, false);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('Stopping during the initial settings read prevents the provider request', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  storage();
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Provider must not run'); };
  const sender = { tab: { id: 72 }, frameId: 0, documentId: 'settings-pending' };
  try {
    const running = handleRuntimeMessage({ type: 'wuf:wupage-translate', requestId: 'request-two',
      request: { texts: ['Not yet sent'], engine: 'google-translate', targetLanguage: 'zh-TW', purpose: 'webpage', preservePlaceholders: true } }, sender);
    await handleRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId: 'request-two' }, sender);
    assert.equal((await running).ok, false);
    assert.equal(calls, 0);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('Webpage cache invalidates when model, prompt, context or endpoint changes', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  const settings = storage();
  settings.openccEnabled = false;
  settings.providers.online.baseUrl = 'https://translation.example/v1';
  settings.providers.online.model = 'model-one';
  let calls = 0;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    calls++; prompts.push(JSON.parse(JSON.parse(init.body).messages.at(-1).content).context);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([`譯文 ${calls}`]) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const request = { texts: ['A repeated article sentence'], engine: 'openai-compat-online', targetLanguage: 'zh-TW', purpose: 'webpage', webpageContext: 'Physics article', preservePlaceholders: true };
  const translate = () => handleRuntimeMessage({ type: 'wuf:wupage-translate', request });
  try {
    assert.equal((await translate()).ok, true);
    assert.equal((await translate()).ok, true);
    assert.equal(calls, 1, 'Identical settings should use cache');
    for (const change of [
      () => { settings.providers.online.model = 'model-two'; },
      () => { settings.providers.online.systemPrompt += '\nUse a formal register.'; },
      () => { request.webpageContext = 'Biology article'; },
      () => { settings.providers.online.baseUrl = 'https://another-translation.example/v1'; },
    ]) {
      change(); const before = calls;
      assert.equal((await translate()).ok, true);
      assert.equal(calls, before + 1, 'Changed configuration reused stale translation');
    }
    assert.match(prompts[0], /Physics article/);
    assert.match(prompts.at(-1), /Biology article/);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('WuPage protected text repairs incorrect marker IDs before caching', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  const settings = storage(); settings.openccEnabled = false;
  settings.providers.online.baseUrl = 'https://translation.example/v1'; settings.providers.online.model = 'protected-model';
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); const [text] = JSON.parse(body.messages.at(-1).content).texts;
    calls.push(text);
    assert.match(body.messages[0].content, /into zh-TW/);
    const translation = text.includes('⟪WUPAGE0⟫') ? '錯誤 ⟪WUPAGE1⟫' : `譯文 ${text}`;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([translation]) } }] }));
  };
  const request = { texts: ['Read ⟪WUPAGE0⟫ carefully.'], targetLanguage: 'zh-TW', engine: 'openai-compat-online',
    purpose: 'webpage', webpageContext: 'API documentation', preservePlaceholders: true };
  try {
    const response = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request });
    assert.equal(response.ok, true);
    assert.match(response.data.translations[0], /⟪WUPAGE0⟫/);
    assert.doesNotMatch(response.data.translations[0], /WUPAGE1/);
    assert.ok(calls.some(text => !text.includes('WUPAGE') && text.includes('Read')), 'Recovery must translate prose with protected content withheld');
    const before = calls.length;
    const cached = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request });
    assert.deepEqual(cached.data.translations, response.data.translations);
    assert.equal(calls.length, before, 'Validated protected translation was not cached');
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('WuPage protected-text recovery does not multiply authentication failures', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  const settings = storage(); settings.providers.online.baseUrl = 'https://translation.example/v1';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('Unauthorized', { status: 401 }); };
  try {
    const response = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
      texts: ['Use ⟪WUPAGE0⟫ safely.'], targetLanguage: 'zh-TW', engine: 'openai-compat-online', purpose: 'webpage', preservePlaceholders: true,
    } });
    assert.equal(response.ok, false); assert.equal(calls, 1);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
