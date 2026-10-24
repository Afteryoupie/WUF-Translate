import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LayaDecisionEngine, DEFAULT_SETTINGS, handleRuntimeMessage, globalCacheManager,
  buildSubtitleTranslationContext, sanitizeSubtitleContext, subtitleContextPrompt,
} from '../dist/wuf/index.js';

const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const choice = (question, domain) => {
  const key = Object.keys(question.criteria).find(k => question.criteria[k].startsWith(domain));
  return { type: 'choice', choice: key, probabilities: Object.fromEntries(
    Object.keys(question.criteria).map(k => [k, k === key ? 0.99 : 0.01/7]),
  ) };
};

test('video evidence stays bounded and ignores caller topic claims', () => {
  const segments = [
    { startMs: 0, text: 'A camera review' }, { startMs: 1000, text: 'Hold the body' },
    { startMs: 2000, text: 'Use a monopod' }, { startMs: 3000, text: 'Keep the lens safe' },
  ];
  const context = buildSubtitleTranslationContext(segments, 'Review', 'video');
  assert.equal(context.title, 'Review');
  assert.match(context.sample, /camera review/);
  const bounded = sanitizeSubtitleContext({ title: 'x'.repeat(10000), sample: 'x'.repeat(10000), topic: 'photography' });
  assert.equal(bounded.title.length, 200);
  assert.equal(bounded.sample.length, 1500);
  assert.equal(bounded.topic, undefined);
});

test('terminology is source-specific and does not force literal jade, food, verbs or non-Chinese targets', () => {
  assert.match(subtitleContextPrompt('Translate', { topic: 'photography' }, ['hold the body']), /機身/);
  assert.match(subtitleContextPrompt('Translate', { topic: 'automotive' }, ['doing a donut']), /定圓甩尾/);
  assert.doesNotMatch(subtitleContextPrompt('Translate', { topic: 'automotive' }, ['eat a donut']), /定圓甩尾/);
  assert.doesNotMatch(subtitleContextPrompt('Translate', { topic: 'gardening' }, ['a jade necklace']), /玉樹/);
  assert.doesNotMatch(subtitleContextPrompt('Translate', { topic: 'automotive' }, ['track my package']), /賽道/);
  assert.doesNotMatch(subtitleContextPrompt('Translate', { topic: 'photography' }, ['body'], 'ja'), /機身/);
  assert.equal(subtitleContextPrompt('Translate', undefined), 'Translate');
});

test('topic classifier requires stable strong choices and rejects truncated or failed model requests', async () => {
  const original = globalThis.fetch;
  let scenario = 'stable', calls = 0;
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body);
    calls++;
    if (scenario === 'failed') return json({ error: 'unavailable' });
    const answer = choice(body.questions.topic, scenario === 'disagree' && calls % 2 === 0 ? 'Plants' : 'Photography');
    if (scenario === 'weak') answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(k => [k, 1/8]));
    return json({ answers: { topic: answer }, usage: { truncated: scenario === 'truncated' } });
  };
  try {
    const engine = new LayaDecisionEngine({ mode: 'laya' });
    assert.equal((await engine.classifyTopic('Review', 'A camera and a lens')).topic, 'photography');
    assert.equal(calls, 2);
    scenario = 'disagree'; calls = 0;
    assert.equal((await engine.classifyTopic('Review', 'A camera and a lens')).topic, null);
    scenario = 'weak';
    assert.equal((await engine.classifyTopic('Review', 'A camera and a lens')).topic, null);
    scenario = 'truncated';
    assert.equal((await engine.classifyTopic('Review', 'A camera and a lens')).topic, null);
    assert.equal(engine.lastError, 'decision context truncated');
    scenario = 'failed';
    assert.equal((await engine.classifyTopic('Review', 'A camera and a lens')).topic, null);
    const before = calls;
    assert.equal((await new LayaDecisionEngine({ mode: 'off' }).classifyTopic('Review', 'Camera')).topic, null);
    assert.equal(calls, before);
  } finally { globalThis.fetch = original; }
});

test('runtime classifies once per video and sends only used hints to translation', async () => {
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome;
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.openccEnabled = false;
  settings.providers.local.model = 'context-test';
  const requests = [];
  globalThis.chrome = { storage: {
    sync: { get: async () => ({ wufSettings: settings }) }, local: { get: async () => ({}) },
  } };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/status')) return json({ status: 'running', current_model_id: 'context-test' });
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.questions?.topic) return json({ answers: { topic: choice(body.questions.topic, 'Photography') } });
    if (body.questions) return json({ answers: Object.fromEntries(Object.keys(body.questions).map(k => [k,
      { type: 'noul', noul: k.startsWith('error_') ? 0.01 : 0.99 },
    ])) });
    assert.match(body.messages[0].content, /機身/);
    assert.doesNotMatch(body.messages[0].content, /Camera review|Reviewing a camera/);
    assert.equal(body.messages[1].content, 'Hold the body.');
    return json({ choices: [{ message: { content: '握著機身' } }] });
  };
  try {
    await globalCacheManager.clear();
    const request = { engine: 'openai-compat-local', purpose: 'subtitle', targetLanguage: 'zh-TW', sourceLanguage: 'en',
      texts: ['Hold the body.'], subtitleContext: { videoId: 'context-unit-test', title: 'Camera review',
        sample: 'Reviewing a camera and lens.', topic: 'automotive' } };
    const first = await handleRuntimeMessage({ type: 'wuf:translate-text', request });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.contextDecision.topic, 'photography');
    await handleRuntimeMessage({ type: 'wuf:translate-text', request });
    assert.equal(requests.filter(r => r.messages).length, 1, 'identical context can reuse approved translation');
    assert.equal(requests.filter(r => r.questions?.topic).length, 2, 'only one pair of topic calls per video');
  } finally {
    globalThis.fetch = originalFetch; globalThis.chrome = originalChrome;
    await globalCacheManager.clear();
  }
});
