import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { DEFAULT_SETTINGS, handleRuntimeMessage, globalCacheManager, runSubtitleDecisionPipeline, buildSubtitleTranslationContext } from '../dist/wuf/index.js';

test('model off retains local sound-tag cleanup and format repair without any classifier request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('the disabled classifier must not be called'); };
  const inputs = [];
  try {
    const result = await runSubtitleDecisionPipeline({ texts: ['[Music]', 'The seat is bolted in [music].'], sourceLanguage: 'en' },
      { subtitles: { decisionMode: 'off', targetLanguage: 'zh-TW' } }, async payload => {
        inputs.push(payload);
        return { ok: true, result: [inputs.length === 1 ? '{"translation":"座椅用螺栓固定"}' : '座椅用螺栓固定'] };
      });
    assert.deepEqual(inputs[0].texts, ['The seat is bolted in  .']);
    assert.equal(inputs[1].skipCache, true);
    assert.deepEqual(result.result, ['', '座椅用螺栓固定']);
    assert.equal(result.decisionReport.modelDecisions, 0);
    assert.equal(result.decisionReport.repaired, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('actual subtitle runtime filters tags, retries malformed output, and caches only approved translations', async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.openccEnabled = false;
  settings.providers.local.model = 'test-translation';
  let malformed = true;
  let calls = 0;
  let filters = 0;
  const prompts = [];
  globalThis.chrome = { storage: {
    sync: { get: async () => ({ wufSettings: settings }) },
    local: { get: async () => ({}) },
  } };
  globalThis.fetch = async (url, init) => {
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('/api/status')) return json({ status: 'running', current_model_id: 'test-translation' });
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/v1/systemone')) {
      if (body.state.task === 'subtitle_filter') filters++;
      return json({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key,
        { type: 'noul', noul: key.startsWith('error_') ? 0.01 : 0.99 },
      ])) });
    }
    calls++;
    prompts.push(body.messages[0].content);
    assert.equal(body.messages[1].content, 'Hello there.');
    const content = malformed ? '```json\n{"translation":"你好"}\n```' : '你好';
    malformed = false;
    return json({ choices: [{ message: { content } }] });
  };
  const request = { texts: ['[Music]', '>> Hello there.'], targetLanguage: 'zh-TW', sourceLanguage: 'en',
    engine: 'openai-compat-local', purpose: 'subtitle' };
  try {
    await globalCacheManager.clear();
    const first = await handleRuntimeMessage({ type: 'wuf:translate-text', request });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual(first.data.translations, ['', '你好']);
    assert.deepEqual(first.data.intentionalEmpty, [0]);
    assert.equal(first.data.decisionReport.repaired, 1);
    assert.equal(calls, 2);
    assert.match(prompts[1], /Retranslate the supplied source faithfully/);
    const second = await handleRuntimeMessage({ type: 'wuf:translate-text', request });
    assert.deepEqual(second.data.translations, ['', '你好']);
    assert.equal(calls, 2, 'approved output must be reused');
    assert.equal(filters, 0, 'Laya per-line validation uses local rules, without classifier calls');
    assert.equal(second.data.decisionReport.repairAttempted, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
    await globalCacheManager.clear();
  }
});

test('YouTube window calls the real boundary message and forwards captured language to translation', async () => {
  const source = fs.readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const windowFn = source.slice(source.indexOf('  const translateWindowByIndex ='), source.indexOf('  let aheadOfTimeWorkerRunning'));
  const messages = [];
  const state = { active: true, sessionGen: 1, rawSegments: [
    { text: 'Hello', startMs: 0, endMs: 500 }, { text: 'there.', startMs: 600, endMs: 1100 },
  ], translatedWindows: new Set(), translatingWindows: new Set(), sourceLanguage: 'en', isAsr: true };
  const ctx = vm.createContext({ state, URL, buildSubtitleTranslationContext,
    normalizeCaptionKey: s => s, appendSentenceCues: () => {},
    heuristicMergeAsr: rows => [{ text: rows.map(s => s.text).join(' '), sourceSegs: rows }],
    refineAsrBoundaries: async (rows, config, request) => {
      const response = await request(rows);
      assert.equal(response.ok, true);
      return rows;
    },
    sendWufRuntimeMessage: async message => {
      messages.push(message);
      if (message.type === 'wuf:get-settings') return { ok: true, data: { runtimeSettings: { subtitles: {
        batchWindowSec: 30, decisionMode: 'custom', engine: 'openai-compat-local', targetLanguage: 'zh-TW',
      } } } };
      if (message.type === 'wuf:evaluate-subtitle-boundaries') return { ok: true, data: { breakBefore: [null, false] } };
      return { ok: true, data: { translations: ['你好'] } };
    },
  });
  vm.runInContext(transformSync(windowFn+'\nglobalThis.run = translateWindowByIndex;', { loader: 'ts' }).code, ctx);
  assert.equal(await ctx.run(0, 1), true);
  assert.ok(messages.some(m => m.type === 'wuf:evaluate-subtitle-boundaries'));
  assert.equal(messages.find(m => m.type === 'wuf:translate-text').request.sourceLanguage, 'en');
});
