import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatCompletionRequestBody,
  DEFAULT_SETTINGS,
  extractProtectedLinkPairs,
  handleRuntimeMessage,
  reassembleParagraphChunks,
  repairProtectedWebpageText,
  splitParagraphIntoSentenceChunks,
  toWuPageSettings,
  validateProtectedWebpageText,
} from '../dist/wuf/index.js';

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

test('Local LLM webpage flow uses single concurrency, plain text, and cold-start wake before translating', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const settings = storage();
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-local';
  settings.providers.local.baseUrl = 'http://127.0.0.1:8080/v1';
  settings.providers.local.model = '';

  const wuLocal = toWuPageSettings({
    savedSettings: settings,
    runtimeSettings: settings,
    apiKeys: { online: '', local: '' },
    activeProvider: { ...settings.providers.local, profileType: 'local', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
    webpageProvider: { ...settings.providers.local, profileType: 'local', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
    subtitleProvider: { ...settings.providers.online, profileType: 'online', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
  });
  assert.equal(wuLocal.concurrency, 1);
  assert.equal(wuLocal.chunkSize, 1);
  assert.equal(wuLocal.providers[0].concurrency, 1);
  assert.equal(wuLocal.providers[0].chunkSize, 1);

  settings.webpage.engine = 'openai-compat-online';
  const wuOnline = toWuPageSettings({
    savedSettings: settings,
    runtimeSettings: settings,
    apiKeys: { online: '', local: '' },
    activeProvider: { ...settings.providers.online, profileType: 'online', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
    webpageProvider: { ...settings.providers.online, profileType: 'online', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
    subtitleProvider: { ...settings.providers.online, profileType: 'online', apiKey: '', effectiveModel: '', runtimeFallbackApplied: false },
  });
  assert.equal(wuOnline.providers[0].concurrency, 3);
  assert.equal(wuOnline.providers[0].chunkSize, 3200);
  settings.webpage.engine = 'openai-compat-local';

  const events = [];
  let awake = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    events.push(u);
    if (u.endsWith('/api/status')) {
      return Response.json({ status: awake ? 'running' : 'sleeping', current_model_id: 'apple-intelligence-translation' });
    }
    if (u.endsWith('/api/wake')) {
      awake = true;
      return Response.json({ status: 'ok', state: 'running', current_model: 'apple-intelligence-translation' });
    }
    if (u.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init.body));
      assert.equal(awake, true, 'Watchdog must be woken before sending /v1/chat/completions');
      assert.equal(body.stream, false);
      assert.equal(body.model, 'apple-intelligence-translation');
      const sys = body.messages[0].content;
      const usr = body.messages.at(-1).content;
      assert.doesNotMatch(sys, /JSON array|---WUF-SEG---/i);
      assert.doesNotMatch(usr, /^\{.*"texts"/);
      return Response.json({ choices: [{ message: { content: `翻譯:${usr}` } }] });
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  try {
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    const res = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: ['First paragraph.', 'Second paragraph.'],
        paragraphIds: ['p-1', 'p-2'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.data.translations, ['翻譯:First paragraph.', '翻譯:Second paragraph.']);
    const wakeIdx = events.findIndex(u => u.endsWith('/api/wake'));
    const inferIdx = events.findIndex(u => u.endsWith('/v1/chat/completions'));
    assert.ok(wakeIdx >= 0 && inferIdx > wakeIdx, `Expected wake before inference: ${JSON.stringify(events)}`);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});

test('Local LLM splits long paragraphs on sentence boundaries and reassembles by paragraph ID with marker recovery', async () => {
  const longParagraph = [
    'Modern local language models process short paragraphs quickly when context stays bounded and clear.',
    'However, when a single web paragraph stretches past several hundred characters with inline code like ⟪WUPAGE0⟫, sending the entire block together risks slow latency or dropped markers.',
    'Splitting along natural sentence boundaries lets each piece translate reliably in plain text.',
    'Finally, code reassembles every translated sentence in exact paragraph order using the original paragraph ID.',
  ].join(' ');

  const chunks = splitParagraphIntoSentenceChunks(longParagraph, { paragraphId: 'para-42', maxChunkChars: 160 });
  assert.ok(chunks.length >= 3, `Expected >= 3 sentence chunks, got ${chunks.length}`);
  assert.ok(chunks.every(chunk => chunk.paragraphId === 'para-42'));
  assert.equal(
    chunks.some(chunk => chunk.coreText.includes('⟪WUPAGE0⟫')),
    true,
    'Protected placeholder must never be split across sentence chunks',
  );
  assert.equal(
    chunks.map(c => c.prefix + c.coreText + c.suffix).join(''),
    longParagraph,
    'Chunk offsets must preserve exact paragraph boundaries',
  );
  assert.throws(
    () => reassembleParagraphChunks('wrong-id', chunks, chunks.map(c => c.coreText)),
    /alignment mismatch/,
  );

  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const settings = storage();
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-local';
  settings.providers.local.baseUrl = 'http://127.0.0.1:18090/v1';
  settings.providers.local.model = 'local-sentence-model';

  const seenRequests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/v1/models')) {
      return Response.json({ object: 'list', data: [{ id: 'local-sentence-model' }] });
    }
    if (String(url).endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init.body));
      const usr = body.messages.at(-1).content;
      seenRequests.push(usr);
      // Simulate the local model dropping ⟪WUPAGE0⟫ on the chunk containing it, then succeeding on prose fragments.
      if (usr.includes('⟪WUPAGE0⟫')) {
        return Response.json({ choices: [{ message: { content: '遺漏標記的整句翻譯' } }] });
      }
      return Response.json({ choices: [{ message: { content: `中(${usr})` } }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    const res = await handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      request: {
        texts: [longParagraph],
        paragraphIds: ['para-42'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.data.translations.length, 1);
    assert.match(res.data.translations[0], /⟪WUPAGE0⟫/);
    assert.ok(seenRequests.length >= 3, 'Expected multi-chunk plain-text requests plus fragment recovery');
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});

test('Local LLM webpage cache isolates by endpoint, model, language, prompt, and context without losing completed paragraphs on partial failure', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const settings = storage();
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-local';
  settings.providers.local.baseUrl = 'http://127.0.0.1:18091/v1';
  settings.providers.local.model = 'local-cache-v1';

  let calls = 0;
  let failSecond = true;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/v1/models')) {
      return Response.json({ object: 'list', data: [{ id: 'local-cache-v1' }] });
    }
    if (String(url).endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init.body));
      const usr = body.messages.at(-1).content;
      if (usr === 'Bad second paragraph' && failSecond) {
        return new Response('Internal server error', { status: 500 });
      }
      calls++;
      return Response.json({ choices: [{ message: { content: `譯${calls}:${usr}` } }] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    const reqOne = { texts: ['Good first paragraph'], paragraphIds: ['p-1'], targetLanguage: 'zh-TW', engine: 'openai-compat-local', purpose: 'webpage', preservePlaceholders: true };
    const reqTwo = { texts: ['Bad second paragraph'], paragraphIds: ['p-2'], targetLanguage: 'zh-TW', engine: 'openai-compat-local', purpose: 'webpage', preservePlaceholders: true };

    const okFirst = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: reqOne });
    const badSecond = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: reqTwo });
    assert.equal(okFirst.ok, true);
    assert.equal(badSecond.ok, false);

    // Retry both: paragraph 1 comes from cache (calls stays unchanged), paragraph 2 now succeeds.
    failSecond = false;
    const callsBeforeRetry = calls;
    const retryFirst = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: reqOne });
    const retrySecond = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: reqTwo });
    assert.equal(retryFirst.ok, true);
    assert.equal(retryFirst.data.cached, 1);
    assert.equal(retrySecond.ok, true);
    assert.equal(calls, callsBeforeRetry + 1);

    // Changing endpoint, model, targetLanguage, sourceLanguage, or systemPrompt must invalidate cache.
    for (const mutate of [
      () => { settings.providers.local.model = 'local-cache-v2'; },
      () => { settings.providers.local.systemPrompt = 'Use concise technical Chinese.'; },
      () => { reqOne.targetLanguage = 'ja'; },
      () => { reqOne.sourceLanguage = 'en'; },
      () => { settings.providers.local.baseUrl = 'http://127.0.0.1:18092/v1'; },
    ]) {
      mutate();
      const before = calls;
      const r = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: reqOne });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(calls, before + 1);
    }
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});

test('Local LLM webpage translation cancels cleanly during cold start and mid-paragraph sentence chunks', async () => {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const settings = storage();
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-local';
  settings.providers.local.baseUrl = 'http://127.0.0.1:8080/v1';
  settings.providers.local.model = 'cold-model';

  const sender = { tab: { id: 91 }, frameId: 0, documentId: 'local-doc-1' };
  try {
    // 1. Cancel during cold-start wake
    let wakeStarted;
    let releaseWake;
    const wakeReady = new Promise(resolve => { wakeStarted = resolve; });
    let inferenceCalls = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return Response.json({ status: 'sleeping' });
      }
      if (u.includes('/api/wake') || u.includes('/api/switch')) {
        wakeStarted();
        return new Promise((resolve, reject) => {
          releaseWake = () => resolve(Response.json({ status: 'ok', state: 'running' }));
          init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      inferenceCalls++;
      return Response.json({ choices: [{ message: { content: 'unexpected' } }] });
    };

    const wakeReq = handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      requestId: 'cold-cancel',
      request: { texts: ['Wake test'], targetLanguage: 'zh-TW', engine: 'openai-compat-local', purpose: 'webpage', preservePlaceholders: true },
    }, sender);
    await wakeReady;
    await handleRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId: 'cold-cancel' }, sender);
    const wakeRes = await wakeReq;
    assert.equal(wakeRes.ok, false);
    assert.equal(inferenceCalls, 0);
    releaseWake?.();
    await new Promise(resolve => setTimeout(resolve, 10));

    // 2. Cancel on second chunk of a long paragraph
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    let chunkTwoStarted;
    const chunkTwoReady = new Promise(resolve => { chunkTwoStarted = resolve; });
    let chunkTwoSignal;
    let completionCount = 0;
    const twoChunkText = `${'First long sentence fills more than half of the threshold for splitting into pieces. '.repeat(5)}Second long sentence arrives right after the boundary and blocks in flight.`;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return Response.json({ status: 'running', current_model_id: 'cold-model' });
      }
      if (u.endsWith('/v1/chat/completions')) {
        completionCount++;
        if (completionCount === 1) {
          return Response.json({ choices: [{ message: { content: '第一句譯文。' } }] });
        }
        chunkTwoSignal = init.signal;
        chunkTwoStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const midReq = handleRuntimeMessage({
      type: 'wuf:wupage-translate',
      requestId: 'mid-cancel',
      request: { texts: [twoChunkText], paragraphIds: ['p-mid'], targetLanguage: 'zh-TW', engine: 'openai-compat-local', purpose: 'webpage', preservePlaceholders: true },
    }, sender);
    await chunkTwoReady;
    await handleRuntimeMessage({ type: 'wuf:cancel-webpage-request', requestId: 'mid-cancel' }, sender);
    assert.equal(chunkTwoSignal.aborted, true);
    const midRes = await midReq;
    assert.equal(midRes.ok, false);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});

test('Local LLM webpage flow preserves paired link markers, validates edge cases, repairs dropped markers, and hits cache', async () => {
  const singleLinkSource = 'See ⟪WUPAGE0⟫the guide⟪WUPAGE1⟫ to finish setup.';
  const multiLinkSource = 'Compare ⟪WUPAGE0⟫Read more⟪WUPAGE1⟫ and ⟪WUPAGE2⟫Read more⟪WUPAGE3⟫ alongside ⟪WUPAGE4⟫.';

  assert.deepEqual(
    extractProtectedLinkPairs(singleLinkSource).map(p => [p.openMarker, p.closeMarker]),
    [['⟪WUPAGE0⟫', '⟪WUPAGE1⟫']],
  );
  assert.deepEqual(
    extractProtectedLinkPairs(multiLinkSource).map(p => [p.openMarker, p.closeMarker]),
    [['⟪WUPAGE0⟫', '⟪WUPAGE1⟫'], ['⟪WUPAGE2⟫', '⟪WUPAGE3⟫']],
  );
  assert.deepEqual(extractProtectedLinkPairs('Run ⟪WUPAGE0⟫ and ⟪WUPAGE1⟫ now.'), []);

  // Validation rejects dropped, swapped, emptied, and prose-swallowing links
  assert.equal(validateProtectedWebpageText(singleLinkSource, '請參閱 ⟪WUPAGE0⟫官方指南 以完成設定。'), undefined);
  assert.equal(validateProtectedWebpageText(singleLinkSource, '請參閱 ⟪WUPAGE1⟫官方指南⟪WUPAGE0⟫ 以完成設定。'), undefined);
  assert.equal(validateProtectedWebpageText(singleLinkSource, '請參閱 ⟪WUPAGE0⟫   ⟪WUPAGE1⟫ 以完成設定。'), undefined);
  assert.equal(validateProtectedWebpageText(singleLinkSource, '⟪WUPAGE0⟫請參閱官方指南以完成設定⟪WUPAGE1⟫'), undefined);
  assert.equal(
    validateProtectedWebpageText(singleLinkSource, '請參閱 ⟪WUPAGE0⟫指南⟪WUPAGE1⟫ 以完成設定。'),
    '請參閱 ⟪WUPAGE0⟫指南⟪WUPAGE1⟫ 以完成設定。',
  );

  // Repair restores dropped link markers cleanly in prose + link fragments
  const repaired = await repairProtectedWebpageText(singleLinkSource, async fragment => {
    if (fragment === 'See') return '請參閱';
    if (fragment === 'the guide') return '指南';
    if (fragment === 'to finish setup.') return '以完成設定。';
    return fragment;
  });
  assert.equal(repaired, '請參閱 ⟪WUPAGE0⟫指南⟪WUPAGE1⟫ 以完成設定。');

  // Sentence splitter keeps each paired link sentence separate rather than merging multiple link sentences
  const twoLinkSentences = 'First sentence checks ⟪WUPAGE0⟫Website⟪WUPAGE1⟫ for info. Second sentence checks ⟪WUPAGE2⟫Releases⟪WUPAGE3⟫ today.';
  const chunks = splitParagraphIntoSentenceChunks(twoLinkSentences, { paragraphId: 'p-links', maxChunkChars: 350 });
  assert.equal(chunks.length, 2);

  // End-to-end runtime message flow: dropped marker triggers fragment repair and second run hits cache
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  storage(structuredClone(DEFAULT_SETTINGS));
  const sender = { tab: { id: 88 }, frameId: 0, documentId: 'doc-links' };
  let completionCalls = 0;

  try {
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    const readmeSource = '⟪WUPAGE0⟫Recipe Lab Studio⟪WUPAGE1⟫ on iPhone handles the full camera workflow.';
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return Response.json({ status: 'running', current_model_id: 'link-test-model' });
      }
      if (u.endsWith('/v1/chat/completions')) {
        completionCalls++;
        const body = JSON.parse(String(init.body || '{}'));
        const userText = String(body.messages.at(-1)?.content ?? '');
        if (userText.includes('⟪WUPAGE1⟫') && userText.includes('handles the full camera workflow')) {
          // Simulate model dropping closing marker ⟪WUPAGE1⟫
          return Response.json({ choices: [{ message: { content: '⟪WUPAGE0⟫Recipe Lab Studio在iPhone上處理完整相機流程。' } }] });
        }
        if (userText === 'Recipe Lab Studio') {
          return Response.json({ choices: [{ message: { content: '配方實驗室工作室' } }] });
        }
        return Response.json({ choices: [{ message: { content: '在 iPhone 上處理完整的相機工作流程。' } }] });
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const req = {
      type: 'wuf:wupage-translate',
      requestId: 'links-first',
      request: {
        texts: [readmeSource],
        paragraphIds: ['p-readme'],
        targetLanguage: 'zh-TW',
        engine: 'openai-compat-local',
        purpose: 'webpage',
        preservePlaceholders: true,
      },
    };
    const res1 = await handleRuntimeMessage(req, sender);
    assert.equal(res1.ok, true, JSON.stringify(res1));
    assert.equal(res1.data.translations[0], '⟪WUPAGE0⟫配方實驗室工作室⟪WUPAGE1⟫ 在 iPhone 上處理完整的相機工作流程。');
    assert.equal(completionCalls, 3);

    const callsAfterFirst = completionCalls;
    const res2 = await handleRuntimeMessage({ ...req, requestId: 'links-cached' }, sender);
    assert.equal(res2.ok, true);
    assert.equal(res2.data.cached, 1);
    assert.equal(res2.data.translations[0], res1.data.translations[0]);
    assert.equal(completionCalls, callsAfterFirst);
  } finally {
    globalThis.chrome = oldChrome;
    globalThis.fetch = oldFetch;
  }
});
