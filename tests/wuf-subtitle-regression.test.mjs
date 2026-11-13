import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import {
  buildChatCompletionRequestBody,
  DEFAULT_LOCAL_PROFILE,
  DEFAULT_SETTINGS,
  globalCacheManager,
  handleRuntimeMessage,
  runSubtitleDecisionPipeline,
  splitLongSubtitleCue,
} from '../dist/wuf/index.js';

test('Riva receives exactly one translation instruction, including server-default model routing', () => {
  for (const model of ['Riva-Translate-test', '']) {
    const { body } = buildChatCompletionRequestBody({
      provider: { ...DEFAULT_LOCAL_PROFILE, profileType: 'local', apiKey: '', model },
      texts: ['Surprise, it is pretty good.'], targetLanguage: 'zh-TW', platform: 'Win32',
    });
    const user = body.messages.find(m => m.role === 'user').content;
    const upstream = (body.shinkansen_target_language ? `Translate this into ${body.shinkansen_target_language}: ` : '') + user;
    assert.equal(upstream, 'Translate this into Traditional Chinese: Surprise, it is pretty good.');
    assert.equal(Boolean(body.model), Boolean(model));
  }
});

const source = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
const renderSource = source.slice(source.indexOf('export function renderYouTubeDisplayCue('), source.indexOf('export function bindOverlayMethods('));
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(transformSync(renderSource, { loader: 'ts', format: 'cjs' }).code, context);
const render = context.module.exports.renderYouTubeDisplayCue;

function displayHarness() {
  const classes = new Set();
  const player = { classList: { toggle: (key, active) => active ? classes.add(key) : classes.delete(key) } };
  const overlay = { text: '', scale: 0, setCue(text, scale) { this.text = text; this.scale = scale; }, clear() { this.text = ''; } };
  return { player, overlay, hidden: () => classes.has('wuf-translated-cue-visible') };
}

test('only the current timed cue is displayed; original rolling captions are never rewritten', () => {
  const h = displayHarness();
  const cues = [{ startMs: 17000, endMs: 19000, text: '一些 BFG Goodrich 輪胎' }, { startMs: 19000, endMs: 23000, text: '出乎意料，效果很好' }];
  render(h.player, h.overlay, cues, 20000, true, 1.25);
  assert.equal(h.overlay.text, '出乎意料，效果很好');
  assert.equal(h.overlay.scale, 1.25);
  assert.equal(h.hidden(), true);
});

test('unready translations, cue gaps, cue end and disabled translation reveal native captions', () => {
  const cues = [{ startMs: 17000, endMs: 23000, text: '譯文' }];
  for (const [time, active] of [[16000, true], [23000, true], [20000, false]]) {
    const h = displayHarness();
    render(h.player, h.overlay, cues, 20000, true, 1);
    render(h.player, h.overlay, cues, time, active, 1);
    assert.equal(h.hidden(), false);
    assert.equal(h.overlay.text, '');
  }
});

test('seeking backward and overlapping window tails select one cue at the correct timestamp', () => {
  const h = displayHarness();
  const cues = [{ startMs: 10000, endMs: 14000, text: '前句' }, { startMs: 13000, endMs: 16000, text: '後句' }];
  render(h.player, h.overlay, cues, 13500, true, 1);
  assert.equal(h.overlay.text, '後句');
  render(h.player, h.overlay, cues, 11000, true, 1);
  assert.equal(h.overlay.text, '前句');
});

test('cached repeated dialogue receives cues at each occurrence without duplicating window retries', () => {
  const state = { displayCues: [] };
  const ctx = vm.createContext({ state, subtitleTranslationCache: new Map(),
    normalizeCaptionKey: s => s.toLowerCase(), splitLongSubtitleCue });
  const appendSource = source.slice(source.indexOf('  const appendSentenceCues ='), source.indexOf('  const translateWindowByIndex ='));
  vm.runInContext(transformSync(appendSource + '\nglobalThis.append = appendSentenceCues;', { loader: 'ts' }).code, ctx);
  for (const startMs of [1000, 1000, 9000]) {
    ctx.append({ startMs, endMs: startMs + 2000, text: 'Start up.', sourceSegs: [{ startMs, text: 'Start up.' }] }, '啟動');
  }
  assert.deepEqual(state.displayCues.map(c => c.startMs), [1000, 9000]);
});

test('public activation immediately renders cached cues while the video is paused', async () => {
  const rendered = [];
  const noop = () => {};
  const ctx = vm.createContext({ state: { active: false, rawSegments: [{}] },
    document: { querySelector: () => ({ currentTime: 20, paused: true }) },
    window: { dispatchEvent: noop }, CustomEvent: class {},
    toggleSubtitlesActiveClasses: noop, ensureNativeCaptionsEnabled: noop,
    showCaptionStatus: noop, ensureOverlayElement: noop, bindVideoListeners: noop,
    updatePlayerButtonState: noop, warmupSubtitleModel: async () => {},
    updateActiveCues: time => rendered.push(time), triggerAheadOfTimeWorker: async () => {},
  });
  const activate = source.slice(source.indexOf('  const translateYouTubeSubtitles ='), source.indexOf('  const wufNs:'));
  vm.runInContext(transformSync(activate + '\nglobalThis.activate = translateYouTubeSubtitles;', { loader: 'ts' }).code, ctx);
  await ctx.activate();
  assert.deepEqual(rendered, [20]);
});

test('local subtitle pipeline retains sound-tag cleanup and format repair without any classifier request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('unexpected external classifier call'); };
  const inputs = [];
  try {
    const result = await runSubtitleDecisionPipeline({ texts: ['[Music]', 'The seat is bolted in [music].'], sourceLanguage: 'en' },
      { subtitles: { targetLanguage: 'zh-TW' } }, async payload => {
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
  const prompts = [];
  globalThis.chrome = { storage: {
    sync: { get: async () => ({ wufSettings: settings }) },
    local: { get: async () => ({}) },
  } };
  globalThis.fetch = async (url, init) => {
    const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('/api/status')) return json({ status: 'running', current_model_id: 'test-translation' });
    const body = JSON.parse(init.body);
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
    assert.equal(second.data.decisionReport.repairAttempted, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
    await globalCacheManager.clear();
  }
});

test('YouTube window merges ASR locally and forwards captured language to translation', async () => {
  const ytSource = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const windowFn = ytSource.slice(ytSource.indexOf('  const translateWindowByIndex ='), ytSource.indexOf('  let aheadOfTimeWorkerRunning'));
  const messages = [];
  const state = { active: true, sessionGen: 1, rawSegments: [
    { text: 'Hello', startMs: 0, endMs: 500 }, { text: 'there.', startMs: 600, endMs: 1100 },
  ], translatedWindows: new Set(), translatingWindows: new Set(), sourceLanguage: 'en', isAsr: true };
  const ctx = vm.createContext({ state, URL,
    normalizeCaptionKey: s => s, appendSentenceCues: () => {},
    heuristicMergeAsr: rows => [{ text: rows.map(s => s.text).join(' '), sourceSegs: rows }],
    sendWufRuntimeMessage: async message => {
      messages.push(message);
      if (message.type === 'wuf:get-settings') return { ok: true, data: { runtimeSettings: { subtitles: {
        batchWindowSec: 30, engine: 'openai-compat-local', targetLanguage: 'zh-TW',
      } } } };
      return { ok: true, data: { translations: ['你好'] } };
    },
  });
  vm.runInContext(transformSync(windowFn+'\nglobalThis.run = translateWindowByIndex;', { loader: 'ts' }).code, ctx);
  assert.equal(await ctx.run(0, 1), true);
  assert.equal(messages.find(m => m.type === 'wuf:translate-text').request.sourceLanguage, 'en');
});
