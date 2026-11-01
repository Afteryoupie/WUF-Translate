import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS, handleRuntimeMessage } from '../dist/wuf/index.js';

// Run the actual original source as an independent oracle. WUPAGE_SOURCE permits
// testing a separately provisioned, identical WuPage 1.5.5 checkout.
const upstream = resolve(process.env.WUPAGE_SOURCE || '../wupage-1.5.5');
const source = resolve(upstream, 'src/background/translation.ts');
async function loadModule(file) {
  const result = await build({ entryPoints: [file], bundle: true, platform: 'browser', format: 'esm', write: false,
    define: { 'import.meta.env.MODE': '"production"' }, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

test('ordinary webpage sends WuPage 1.5.5 batch request and accepts its JSON array response', { skip: !existsSync(source) }, async () => {
  const [{ translateWithSettings }, { DEFAULT_SETTINGS: wuDefaults }] = await Promise.all([
    loadModule(source), loadModule(resolve(upstream, 'src/shared/defaults.ts')),
  ]);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-online';
  settings.providers.online.baseUrl = 'https://translation.example/v1';
  settings.providers.online.model = 'apple-test-model';
  const wu = structuredClone(wuDefaults);
  const config = wu.providers.find(item => item.id === 'openai-compatible');
  Object.assign(config, { baseURL: settings.providers.online.baseUrl, model: 'apple-test-model', apiKey: '', ollamaCompatibility: false });
  wu.activeProviderId = config.id;
  wu.cacheEnabled = false;
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const area = data => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(data)).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)),
  });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '["第一段","第二段"]' } }] }), { status: 200 });
  };
  const texts = ['First paragraph', 'Second paragraph'];
  try {
    const expected = await translateWithSettings(wu, { texts, sourceLang: 'auto', targetLang: 'zh-TW', context: 'README', providerId: config.id, preservePlaceholders: true });
    const baselineCalls = calls.splice(0);
    const actual = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
      texts, sourceLanguage: 'auto', targetLanguage: 'zh-TW', webpageContext: 'README', engine: 'openai-compat-online', purpose: 'webpage', preservePlaceholders: true,
    } });
    assert.deepEqual(calls, baselineCalls, 'endpoint, system prompt, JSON input, model parameters and batch must match upstream');
    assert.equal(actual.ok, true);
    assert.deepEqual(actual.data.translations, expected.translations);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

for (const [engine, upstreamId] of [['google-translate', 'google-web-translate'], ['microsoft-translate', 'microsoft-web-translate']]) {
  test(`${engine} uses the original WuPage web service`, { skip: !existsSync(source) }, async () => {
    const [{ translateWithSettings }, { DEFAULT_SETTINGS: wuDefaults }] = await Promise.all([
      loadModule(source), loadModule(resolve(upstream, 'src/shared/defaults.ts')),
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.webpage.engine = engine;
    settings.openccEnabled = true;
    const wu = structuredClone(wuDefaults);
    wu.activeProviderId = upstreamId; wu.cacheEnabled = false;
    const originalChrome = globalThis.chrome; const originalFetch = globalThis.fetch;
    const area = data => ({
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(data)).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values)),
    });
    globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
      if (String(url).includes('translate.googleapis.com')) return new Response(JSON.stringify([[['翻譯結果']]]));
      if (String(url).includes('edge.microsoft.com')) return new Response(JSON.stringify([{ translations: [{ text: '翻譯結果' }] }]));
      throw new Error(`Unexpected endpoint ${url}`);
    };
    try {
      const request = { texts: ['A sample sentence'], sourceLang: 'auto', targetLang: 'zh-TW', preservePlaceholders: true };
      const expected = await translateWithSettings(wu, request);
      const baselineCalls = calls.splice(0);
      const snapshot = await handleRuntimeMessage({ type: 'wuf:get-settings' });
      assert.equal(snapshot.data.savedSettings.webpage.engine, engine, 'selected service must survive settings loading');
      const actual = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
        texts: request.texts, sourceLanguage: 'auto', targetLanguage: 'zh-TW', engine, purpose: 'webpage', preservePlaceholders: true,
      } });
      assert.deepEqual(calls, baselineCalls);
      assert.equal(actual.ok, true, JSON.stringify(actual));
      assert.deepEqual(actual.data.translations, expected.translations);
    } finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
  });
}

test('an unchanged Watchdog server-default model resolves to the active Apple model', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.openccEnabled = false;
  settings.webpage.engine = 'openai-compat-local';
  settings.providers.local.baseUrl = 'http://127.0.0.1:8080/v1';
  settings.providers.local.model = '';
  const originalChrome = globalThis.chrome; const originalFetch = globalThis.fetch;
  const area = data => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(data)).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)),
  });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
  let requestBody;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/api/status')) return Response.json({ status: 'running', current_model_id: 'apple-intelligence-translation' });
    if (String(url).endsWith('/v1/chat/completions')) {
      requestBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: '["第一段"]' } }] });
    }
    throw new Error(`Unexpected endpoint ${url}`);
  };
  try {
    const result = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
      texts: ['First paragraph'], sourceLanguage: 'auto', targetLanguage: 'zh-TW', engine: 'openai-compat-local', purpose: 'webpage', preservePlaceholders: true,
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(requestBody.model, 'apple-intelligence-translation');
    assert.deepEqual(result.data.translations, ['第一段']);
  } finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
});

test('WuPage webpage cache handles multi-item hits and WUF cache controls', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.webpage.engine = 'openai-compat-online';
  settings.providers.online.baseUrl = 'https://cache.example/v1';
  settings.providers.online.model = 'cache-model';
  const originalChrome = globalThis.chrome; const originalFetch = globalThis.fetch;
  const data = {};
  const area = values => ({
    get: async keys => keys === null ? structuredClone(values) : Object.fromEntries((typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(values)).filter(key => key in values).map(key => [key, structuredClone(values[key])])),
    set: async update => Object.assign(values, structuredClone(update)),
    remove: async keys => { for (const key of keys) delete values[key]; },
  });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area(data) } };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ choices: [{ message: { content: '["甲","乙"]' } }] }); };
  const request = { texts: ['cache first', 'cache second'], targetLanguage: 'zh-TW', sourceLanguage: 'auto',
    engine: 'openai-compat-online', purpose: 'webpage', preservePlaceholders: true };
  try {
    const first = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request });
    const second = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request });
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(calls, 1); assert.equal(second.data.cached, 2);
    const stats = await handleRuntimeMessage({ type: 'wuf:get-cache-stats' });
    assert.equal(stats.data.count, 2);
    await handleRuntimeMessage({ type: 'wuf:clear-cache' });
    assert.equal(Object.keys(data).filter(key => key.startsWith('wuf.wupage.page.v1.')).length, 0);
  } finally { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; }
});

test('an existing root OpenAI-compatible base URL keeps its WUF v1 endpoint', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.webpage.engine = 'openai-compat-online';
  settings.providers.online.baseUrl = 'https://root.example';
  settings.providers.online.model = 'root-model';
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  const area = data => ({ get: async () => data, set: async () => {} });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
  let url;
  globalThis.fetch = async (input) => { url = String(input); return Response.json({ choices: [{ message: { content: '["測試"]' } }] }); };
  try {
    const result = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
      texts: ['A root endpoint test'], targetLanguage: 'zh-TW', engine: 'openai-compat-online', purpose: 'webpage', preservePlaceholders: true,
    } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(url, 'https://root.example/v1/chat/completions');
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});

test('17 LLM items use the same upstream batch boundaries and JSON parsing', { skip: !existsSync(source) }, async () => {
  const [{ translateWithSettings }, { DEFAULT_SETTINGS: wuDefaults }] = await Promise.all([
    loadModule(source), loadModule(resolve(upstream, 'src/shared/defaults.ts')),
  ]);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.webpage.engine = 'openai-compat-online';
  settings.providers.online.baseUrl = 'https://batch.example/v1'; settings.providers.online.model = 'batch-model';
  const wu = structuredClone(wuDefaults); const provider = wu.providers.find(entry => entry.id === 'openai-compatible');
  Object.assign(provider, { baseURL: settings.providers.online.baseUrl, model: 'batch-model', apiKey: '', ollamaCompatibility: false });
  wu.activeProviderId = provider.id; wu.cacheEnabled = false;
  const oldChrome = globalThis.chrome; const oldFetch = globalThis.fetch;
  const area = data => ({ get: async () => data, set: async () => {} });
  globalThis.chrome = { storage: { sync: area({ wufSettings: settings }), local: area({}) } };
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); const input = JSON.parse(body.messages.at(-1).content);
    calls.push(input.texts);
    return Response.json({ choices: [{ message: { content: JSON.stringify(input.texts.map(text => `譯:${text}`)) } }] });
  };
  const texts = Array.from({ length: 17 }, (_, index) => `Item ${String(index).padStart(2, '0')}`);
  try {
    const expected = await translateWithSettings(wu, { texts, sourceLang: 'auto', targetLang: 'zh-TW', preservePlaceholders: true });
    const originalBatches = calls.splice(0).sort((a, b) => a[0].localeCompare(b[0]));
    const actual = await handleRuntimeMessage({ type: 'wuf:wupage-translate', request: {
      texts, sourceLanguage: 'auto', targetLanguage: 'zh-TW', engine: 'openai-compat-online', purpose: 'webpage', preservePlaceholders: true,
    } });
    assert.deepEqual(originalBatches.map(batch => batch.length), [16, 1]);
    assert.deepEqual(calls.sort((a, b) => a[0].localeCompare(b[0])), originalBatches);
    assert.equal(actual.ok, true); assert.deepEqual(actual.data.translations, expected.translations);
  } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
});
