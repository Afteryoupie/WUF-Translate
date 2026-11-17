import test from 'node:test';
import assert from 'node:assert/strict';
import { translateWithOpenAICompat, DEFAULT_LOCAL_PROFILE, createSubtitleWorker } from '../dist/wuf/index.js';

test('explicit model guardrail rejection is distinct from server outage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "The model's safety guardrails were triggered." } }), { status: 500 });
  try {
    await assert.rejects(translateWithOpenAICompat({
      provider: { ...DEFAULT_LOCAL_PROFILE, profileType: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: '', effectiveModel: 'test' },
      texts: ['The other teams would eventually protested and that would end up in court in Paris.'], targetLanguage: 'zh-TW',
    }), e => e.code === 'CONTENT_REJECTED' && e.status === 500);
  } finally { globalThis.fetch = originalFetch; }
});

test('three rejected sentences neither retry nor block the following subtitle', async () => {
  const calls = [], timers = [], results = [];
  const sentences = Array.from({ length: 4 }, (_, i) => ({ id: String(i), text: 'Dialogue', startMs: i * 1000, endMs: (i + 1) * 1000, sourceSegs: [] }));
  const worker = createSubtitleWorker({
    getPlayback: () => ({ nowMs: 0, playbackRate: 1 }), now: () => 0,
    setTimer: (cb, ms) => { timers.push(ms); return 1; }, clearTimer: () => {}, capacity: () => 1,
    translate: async s => { calls.push(s.id); return s.id === '3' ? { ok: true, translation: '下一句' } : { ok: false, error: { code: 'CONTENT_REJECTED', status: 500 } }; },
    onResult: (s, r) => results.push(r.translation), onError: () => {}, onDiagnostic: () => {},
  });
  worker.replaceSession({ generation: 1, engine: 'openai-compat-local', sentences });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['0', '1', '2', '3']);
  assert.deepEqual(results, ['下一句']);
  assert.equal(worker.getSentenceStatus('0'), 'failed');
  assert.deepEqual(timers, []);
  worker.dispose();
});

test('failed sentence renders source text locally, without showing a failure badge or calling another provider', async () => {
  const { readFileSync } = await import('node:fs');
  const { transformSync } = await import('esbuild');
  const vm = await import('node:vm');
  const source = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('  const handleWorkerError ='), source.indexOf('  const handleWorkerDiagnostic ='));
  for (const code of ['CONTENT_REJECTED', 'HTTP_ERROR', 'INVALID_RESPONSE', 'TIMEOUT']) {
    const cues = [], badges = [], deferredWorkerCallbacks = [];
    const context = vm.createContext({ state: { active: true, sessionGen: 1 }, settingsSynchronizing: false, deferredWorkerCallbacks,
      subtitleWorker: { getSentenceStatus: () => 'failed' },
      appendSentenceCues: (sentence, text) => cues.push({ sentence, text }),
      clearWaitingStatusTimer: () => {}, showCaptionStatus: text => badges.push(text),
      getActiveVideo: () => ({ currentTime: 1007 }), findActiveSentenceAt: () => ({ id: 's1' }),
    });
    vm.runInContext(transformSync(handler + '\nglobalThis.handleError = handleWorkerError;', { loader: 'ts' }).code, context);
    const sentence = { id: 's1', text: 'The other teams would eventually protested and that would end up in court in Paris.', startMs: 1007000, endMs: 1015000 };
    context.handleError(sentence, { code, status: 500 }, 1);
    assert.deepEqual(cues, [{ sentence, text: sentence.text }]);
    assert.deepEqual(badges, []);
    context.handleError(sentence, { code }, 0);
    assert.equal(cues.length, 1, 'stale failures must not render');
    context.settingsSynchronizing = true;
    context.handleError(sentence, { code, status: 500 }, 1);
    assert.equal(cues.length, 1);
    assert.equal(deferredWorkerCallbacks.length, 1);
    context.settingsSynchronizing = false;
    deferredWorkerCallbacks.shift()();
    assert.equal(cues.length, 2, 'same-session failure must render after settings sync');
  }
});

test('ordinary HTTP 500 remains a retryable infrastructure error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"backend unavailable"}}', { status: 500 });
  try {
    await assert.rejects(translateWithOpenAICompat({
      provider: { ...DEFAULT_LOCAL_PROFILE, profileType: 'local', baseUrl: 'http://localhost:11434/v1', apiKey: '', effectiveModel: 'test' },
      texts: ['Hello'], targetLanguage: 'zh-TW',
    }), e => e.code === 'HTTP_ERROR' && e.status === 500);
  } finally { globalThis.fetch = originalFetch; }
});
