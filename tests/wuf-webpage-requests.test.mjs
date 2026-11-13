import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatCompletionRequestBody, DEFAULT_SETTINGS, handleRuntimeMessage } from '../dist/wuf/index.js';

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

test('WuPage forwards custom temperature, thinkingLevel, extraBodyJson, and fetchTimeoutSec matching subtitle requests', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  try {
    // 1. Customized temperature=0.7, thinkingLevel='off', extraBodyJson={"max_tokens":123}
    const settings = storage();
    settings.providers.online.baseUrl = 'https://translation.example/v1';
    settings.providers.online.model = 'custom-model';
    settings.providers.online.temperature = 0.7;
    settings.providers.online.thinkingLevel = 'off';
    settings.providers.online.extraBodyJson = '{"max_tokens":123}';
    settings.fetchTimeoutSec = 30;
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const res = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-online',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(res.ok, true);
    assert.equal(capturedBody.temperature, 0.7);
    assert.deepEqual(capturedBody.reasoning, { enabled: false, exclude: true });
    assert.equal(capturedBody.max_tokens, 123);

    const { body: subtitleBody } = buildChatCompletionRequestBody({
      texts: ['Hello'],
      targetLanguage: 'zh-TW',
      provider: {
        profileType: 'online',
        baseUrl: settings.providers.online.baseUrl,
        apiKey: '',
        model: settings.providers.online.model,
        effectiveModel: settings.providers.online.model,
        systemPrompt: '',
        temperature: settings.providers.online.temperature,
        thinkingLevel: settings.providers.online.thinkingLevel,
        routingSort: settings.providers.online.routingSort,
        allowFallbacks: settings.providers.online.allowFallbacks,
        extraBodyJson: settings.providers.online.extraBodyJson,
        webConcurrency: 4,
        webBatchChars: 3000,
        subtitleBatchSize: 10,
        fetchTimeoutSec: settings.fetchTimeoutSec,
        isOpenRouterFree: false,
      },
    });
    assert.equal(capturedBody.temperature, subtitleBody.temperature);
    assert.deepEqual(capturedBody.reasoning, subtitleBody.reasoning);
    assert.equal(capturedBody.max_tokens, subtitleBody.max_tokens);

    // 2. temperature=null omits temperature field from request body
    const nullTempSettings = storage();
    nullTempSettings.providers.online.baseUrl = 'https://translation.example/v1';
    nullTempSettings.providers.online.model = 'custom-model';
    nullTempSettings.providers.online.temperature = null;
    capturedBody = null;
    const resNullTemp = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-online',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(resNullTemp.ok, true);
    assert.equal('temperature' in capturedBody, false);

    // 3. Custom fetchTimeoutSec on provider profile schedules custom abort timer (5000ms) and aborts cleanly
    const timeoutSettings = storage();
    timeoutSettings.providers.online.baseUrl = 'https://translation.example/v1';
    timeoutSettings.providers.online.model = 'custom-model';
    timeoutSettings.providers.online.fetchTimeoutSec = 5;
    const realSetTimeout = globalThis.setTimeout;
    const scheduledTimeouts = [];
    globalThis.setTimeout = (fn, ms, ...args) => {
      scheduledTimeouts.push(ms);
      if (ms === 5000) {
        return realSetTimeout(fn, 20, ...args);
      }
      return realSetTimeout(fn, ms, ...args);
    };
    globalThis.fetch = async (_url, init) => {
      return await new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason || new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal.reason || new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    };
    try {
      const timeoutRes = await handleRuntimeMessage({
        type: 'wuf:wupage-translate',
        request: {
          texts: ['Hello'],
          targetLanguage: 'zh-TW',
          engine: 'openai-compat-online',
          purpose: 'webpage',
          preservePlaceholders: true,
        },
      });
      assert.equal(timeoutRes.ok, false);
      assert.equal(scheduledTimeouts.includes(5000), true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});

test('WuPage handles authenticated local servers without misreporting WATCHDOG_ERROR or waking Native Host', async () => {
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  try {
    let nativeCalls = 0;
    const seen = [];
    const installAuthStorage = (baseUrl, apiKey) => {
      const s = storage();
      s.providers.local.baseUrl = baseUrl;
      s.providers.local.model = 'auth-model';
      if (apiKey) {
        const localData = globalThis.chrome.storage.local;
        const origGet = localData.get;
        localData.get = async keys => ({
          ...(await origGet(keys)),
          wufSecrets: { providerApiKeys: { online: '', local: apiKey } },
        });
      }
      globalThis.chrome.runtime = {
        sendNativeMessage(_host, _msg, cb) {
          nativeCalls++;
          cb(null);
        },
      };
    };

    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers || {});
      const auth = headers.get('authorization') || '';
      seen.push({ url: String(url), auth });
      if (auth !== 'Bearer secret-key') {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'auth-model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    // Unauthenticated port 8080 reports auth error and never calls Native Host
    installAuthStorage('http://127.0.0.1:8080/v1', '');
    const unauthRes = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(unauthRes.ok, false);
    assert.equal(unauthRes.error?.code, 'HTTP_ERROR');
    assert.equal(unauthRes.error?.status, 401);
    assert.match(String(unauthRes.error?.message || ''), /401|Unauthorized|authentication/i);
    assert.equal(nativeCalls, 0);

    // Non-Watchdog local server with valid key sends Bearer header directly and succeeds
    seen.length = 0;
    installAuthStorage('http://127.0.0.1:18081/v1', 'secret-key');
    const authRes = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: ['Hello'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(authRes.ok, true);
    assert.equal(nativeCalls, 0);
    assert.equal(seen.some(item => item.url.includes('/api/wake') || item.url.includes('/api/status')), false);
    assert.equal(seen.some(item => item.auth === 'Bearer secret-key'), true);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});
