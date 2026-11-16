import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import {
  areCaptionSegmentsEqual,
  buildChatCompletionRequestBody,
  DEFAULT_LOCAL_PROFILE,
  DEFAULT_SETTINGS,
  findPrepaintSnapMs,
  getCurrentWatchVideoId,
  globalCacheManager,
  handleRuntimeMessage,
  heuristicMergeAsr,
  parseYouTubeTimedTextJson3,
  runSubtitleDecisionPipeline,
  splitLongSubtitleCue,
  translateWithGoogle,
} from '../dist/wuf/index.js';
import * as wufBundle from '../dist/wuf/index.js';

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

test('public activation immediately renders cached cues while the video is paused without waiting for warmup', async () => {
  const rendered = [];
  let resolveWarmup;
  const warmupPromise = new Promise(r => { resolveWarmup = r; });
  const noop = () => {};
  const ctx = vm.createContext({ state: { active: false, rawSegments: [{}] },
    document: { querySelector: () => ({ currentTime: 20, paused: true }) },
    window: { dispatchEvent: noop }, CustomEvent: class {},
    toggleSubtitlesActiveClasses: noop, ensureNativeCaptionsEnabled: noop,
    showCaptionStatus: noop, ensureOverlayElement: noop, bindVideoListeners: noop,
    updatePlayerButtonState: noop, warmupSubtitleModel: () => warmupPromise,
    updateActiveCues: time => rendered.push(time),
    requestSubtitleWork: noop,
    triggerAheadOfTimeWorker: async () => {},
  });
  const activate = source.slice(source.indexOf('  const translateYouTubeSubtitles ='), source.indexOf('  const wufNs:'));
  vm.runInContext(transformSync(activate + '\nglobalThis.activate = translateYouTubeSubtitles;', { loader: 'ts' }).code, ctx);
  const actPromise = ctx.activate();
  assert.deepEqual(rendered, [20], 'cached cues must render before warmup resolves');
  resolveWarmup();
  await actPromise;
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
        batchWindowSec: 30, engine: 'openai-compat-online', targetLanguage: 'zh-TW',
      } } } };
      return { ok: true, data: { translations: ['你好'] } };
    },
  });
  vm.runInContext(transformSync(windowFn+'\nglobalThis.run = translateWindowByIndex;', { loader: 'ts' }).code, ctx);
  assert.equal(await ctx.run(0, 1), true);
  assert.equal(messages.find(m => m.type === 'wuf:translate-text').request.sourceLanguage, 'en');
});

test('isTimedTextUrl rejects different-video preview captions and getCurrentWatchVideoId parses watch/shorts URLs', () => {
  assert.equal(getCurrentWatchVideoId({ search: '?v=abc123&t=42s', pathname: '/watch' }), 'abc123');
  assert.equal(getCurrentWatchVideoId({ search: '', pathname: '/shorts/short99' }), 'short99');
  assert.equal(getCurrentWatchVideoId({ search: '', pathname: '/embed/emb55' }), 'emb55');
  assert.equal(getCurrentWatchVideoId({ search: '', pathname: '/' }), '');

  const interceptorSrc = readFileSync(new URL('../wuf-src/content/youtube-main-interceptor.ts', import.meta.url), 'utf8');
  const fnSlice = interceptorSrc.slice(
    interceptorSrc.indexOf('export function isTimedTextUrl('),
    interceptorSrc.indexOf('function dispatchTimedTextPayload('),
  );
  const ctx = vm.createContext({ module: { exports: {} }, URL, getCurrentWatchVideoId, location: { origin: 'https://www.youtube.com', search: '?v=vidA', pathname: '/watch' } });
  vm.runInContext(transformSync(fnSlice, { loader: 'ts', format: 'cjs' }).code, ctx);
  const isTimedTextUrl = ctx.module.exports.isTimedTextUrl;

  assert.equal(isTimedTextUrl('https://www.youtube.com/api/timedtext?v=vidA&lang=en', 'vidA'), true);
  assert.equal(isTimedTextUrl('https://www.youtube.com/api/timedtext?v=hoverPreview&lang=en', 'vidA'), false);
  assert.equal(isTimedTextUrl('https://www.youtube.com/api/timedtext?lang=en', 'vidA'), true);
  assert.equal(isTimedTextUrl('https://www.youtube.com/youtubei/v1/player?v=vidA', 'vidA'), false);
});

test('parseYouTubeTimedTextJson3 sorts events chronologically, areCaptionSegmentsEqual compares diffs, and findPrepaintSnapMs snaps within lead window', () => {
  const sorted = parseYouTubeTimedTextJson3({
    events: [
      { tStartMs: 5000, dDurationMs: 1200, segs: [{ utf8: 'Third' }] },
      { tStartMs: 1000, dDurationMs: 1200, segs: [{ utf8: 'First' }] },
      { tStartMs: 3000, dDurationMs: 1200, segs: [{ utf8: 'Second' }] },
    ],
  });
  assert.deepEqual(sorted.map(s => s.text), ['First', 'Second', 'Third']);
  assert.deepEqual(sorted.map(s => s.startMs), [1000, 3000, 5000]);

  const copy = sorted.map(s => ({ ...s }));
  assert.equal(areCaptionSegmentsEqual(sorted, copy), true);
  copy[1].text = 'Changed';
  assert.equal(areCaptionSegmentsEqual(sorted, copy), false);

  const cues = [{ startMs: 10000, endMs: 12000 }, { startMs: 15000, endMs: 17000 }];
  assert.equal(findPrepaintSnapMs(cues, 9880, 150), 10000);
  assert.equal(findPrepaintSnapMs(cues, 9700, 150), null);
  assert.equal(findPrepaintSnapMs(cues, 10500, 150), null);
});

test('translateWithGoogle preserves input ordering under out-of-order concurrent fetches', async () => {
  const originalFetch = globalThis.fetch;
  const delays = [35, 5, 20, 1];
  globalThis.fetch = async (url) => {
    const q = new URL(String(url)).searchParams.get('q') || '';
    const idx = Number(q.split('-')[1] || 0);
    await new Promise(r => setTimeout(r, delays[idx] ?? 5));
    return new Response(JSON.stringify([[[`譯文-${idx}`, q]]]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const res = await translateWithGoogle({
      texts: ['item-0', 'item-1', 'item-2', 'item-3'],
      targetLanguage: 'zh-TW',
      sourceLanguage: 'en',
    });
    assert.deepEqual(res, ['譯文-0', '譯文-1', '譯文-2', '譯文-3']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Cross-window heuristicMergeAsr translates complete sentences across 30s boundaries without gaps or duplicate requests', async () => {
  const ytSource = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const windowFn = ytSource.slice(ytSource.indexOf('  const translateWindowByIndex ='), ytSource.indexOf('  let aheadOfTimeWorkerRunning'));
  const sentBatches = [];
  const state = {
    active: true,
    sessionGen: 1,
    rawSegments: [
      { text: 'We can fix', startMs: 28000, endMs: 29000 },
      { text: 'cross boundary', startMs: 29100, endMs: 29900 },
      { text: 'subtitles cleanly.', startMs: 30050, endMs: 31400 },
      { text: 'Next complete line.', startMs: 33000, endMs: 35000 },
    ],
    displayCues: [],
    translatedWindows: new Set(),
    translatingWindows: new Set(),
    sourceLanguage: 'en',
    isAsr: true,
  };
  const ctx = vm.createContext({
    state,
    URL,
    normalizeCaptionKey: s => s,
    appendSentenceCues: (sentence, translation) => {
      state.displayCues.push({ startMs: sentence.startMs, endMs: sentence.endMs, text: translation, sourceText: sentence.text });
    },
    heuristicMergeAsr,
    sendWufRuntimeMessage: async message => {
      if (message.type === 'wuf:get-settings') {
        return { ok: true, data: { runtimeSettings: { subtitles: { batchWindowSec: 30, engine: 'openai-compat-online', targetLanguage: 'zh-TW' } } } };
      }
      sentBatches.push(message.request.texts);
      return { ok: true, data: { translations: message.request.texts.map(t => `T:${t}`) } };
    },
  });
  vm.runInContext(transformSync(windowFn + '\nglobalThis.run = translateWindowByIndex;', { loader: 'ts' }).code, ctx);
  assert.equal(await ctx.run(0, 1), true);
  assert.equal(await ctx.run(1, 1), true);
  assert.deepEqual(sentBatches, [
    ['We can fix cross boundary subtitles cleanly.'],
    ['Next complete line.'],
  ]);
  assert.equal(state.displayCues[0].startMs, 28000);
  assert.ok(state.displayCues[0].endMs >= 31400 && state.displayCues[0].endMs <= 33000);
});

test('content-youtube deduplicates identical captions, ignores noop tracks, snaps on pre-paint mutation, and resets on SPA navigation', async () => {
  class MiniClassList {
    constructor() { this.set = new Set(); }
    add(...cls) { cls.forEach(c => this.set.add(c)); }
    remove(...cls) { cls.forEach(c => this.set.delete(c)); }
    toggle(c, force) {
      if (force === undefined) {
        if (this.set.has(c)) { this.set.delete(c); return false; }
        this.set.add(c); return true;
      }
      if (force) this.set.add(c); else this.set.delete(c);
      return force;
    }
    contains(c) { return this.set.has(c); }
  }
  class MiniEl {
    constructor(tag, id = '', classes = []) {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.classList = new MiniClassList();
      classes.forEach(c => this.classList.add(c));
      this.children = [];
      this.parentNode = null;
      this.parentElement = null;
      this.style = { setProperty() {} };
      this.attrs = {};
      this.listeners = new Map();
      this._textContent = '';
    }
    get textContent() { return this._textContent || this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._textContent = String(v ?? ''); }
    get className() { return [...this.classList.set].join(' '); }
    set className(v) { this.classList = new MiniClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    appendChild(child) { child.parentNode = this; child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child) { return this.appendChild(child); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    click() {
      const next = this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
      this.setAttribute('aria-pressed', next);
    }
    getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 30 }; }
    closest(sel) {
      if (sel.startsWith('#') && this.id === sel.slice(1)) return this;
      return this.parentElement ? this.parentElement.closest(sel) : null;
    }
    _all() { return [this, ...this.children.flatMap(c => c._all())]; }
    _matches(sel) {
      return sel.split(',').map(s => s.trim()).some(part => {
        if (part.includes(':not(')) {
          const [base, neg] = part.split(':not(');
          const negSel = neg.replace(/\)$/, '');
          if (this._matches(negSel)) return false;
          return base ? this._matches(base) : true;
        }
        const tokens = part.split(/\s+/);
        const last = tokens[tokens.length - 1];
        const hit =
          (last.startsWith('#') && this.id === last.slice(1)) ||
          (last.startsWith('.') && this.classList.contains(last.slice(1))) ||
          this.tagName === last.toUpperCase();
        if (!hit) return false;
        if (tokens.length === 1) return true;
        let p = this.parentElement;
        while (p) { if (p._matches(tokens[0])) return true; p = p.parentElement; }
        return false;
      });
    }
    querySelector(sel) { return this._all().slice(1).find(el => el._matches(sel)) || null; }
    querySelectorAll(sel) { return this._all().slice(1).filter(el => el._matches(sel)); }
  }

  const root = new MiniEl('html');
  const head = root.appendChild(new MiniEl('head'));
  const body = root.appendChild(new MiniEl('body'));
  const player = body.appendChild(new MiniEl('div', 'movie_player', ['html5-video-player']));
  const video = player.appendChild(new MiniEl('video'));
  video.currentTime = 9.9;
  video.paused = false;
  video.playbackRate = 1;
  const captionContainer = player.appendChild(new MiniEl('div', 'ytp-caption-window-container', ['ytp-caption-window-container']));
  const rightControls = player.appendChild(new MiniEl('div', '', ['ytp-right-controls']));
  const ccBtn = rightControls.appendChild(new MiniEl('button', '', ['ytp-subtitles-button']));
  ccBtn.setAttribute('aria-pressed', 'false');

  const observers = [];
  class MockMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() {}
  }

  const winListeners = new Map();
  const dispatched = [];
  const win = {
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
    dispatchEvent(ev) {
      dispatched.push({ type: ev.type, detail: ev.detail });
      for (const fn of winListeners.get(ev.type) || []) fn(ev);
      return true;
    },
  };
  const doc = {
    body,
    head,
    documentElement: root,
    readyState: 'complete',
    addEventListener() {},
    createElement(tag) { return new MiniEl(tag); },
    getElementById(id) { return root._all().find(el => el.id === id) || null; },
    querySelector(sel) { return root._all().find(el => el._matches(sel)) || null; },
    querySelectorAll(sel) { return root._all().filter(el => el._matches(sel)); },
  };
  class MockCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }

  const loc = { origin: 'https://www.youtube.com', hostname: 'www.youtube.com', search: '?v=vidA', pathname: '/watch', href: 'https://www.youtube.com/watch?v=vidA' };
  const ytSource = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const cjs = transformSync(ytSource, { loader: 'ts', format: 'cjs' }).code;
  const ctx = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id.includes('youtube-pipeline')) {
        return {
          ...wufBundle,
          getCurrentWatchVideoId: (passedLoc = loc) => wufBundle.getCurrentWatchVideoId(passedLoc),
        };
      }
      if (id.includes('runtime-client')) {
        return {
          sendWufRuntimeMessage: async (msg) => {
            if (msg.type === 'wuf:get-settings') {
              return { ok: true, data: { runtimeSettings: { subtitles: { batchWindowSec: 30, engine: 'google', targetLanguage: 'ja' } } } };
            }
            if (msg.type === 'wuf:translate-text') {
              return { ok: true, data: { translations: msg.request.texts.map(t => `JP:${t}`) } };
            }
            return { ok: true, data: {} };
          },
        };
      }
      return {};
    },
    window: win,
    document: doc,
    location: loc,
    CustomEvent: MockCustomEvent,
    Element: MiniEl,
    HTMLElement: MiniEl,
    MutationObserver: MockMutationObserver,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  ctx.globalThis = ctx;
  vm.runInContext(cjs, ctx);
  const wuf = win.__WUF;
  try {
    await wuf.translateYouTubeSubtitles();
    assert.equal(wuf.YT.targetLanguage, 'ja');

    const json3Payload = JSON.stringify({
      events: [{ tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] }],
    });
    win.dispatchEvent(new MockCustomEvent('wuf-timedtext-captured', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en&kind=asr', rawText: json3Payload },
    }));
    for (let i = 0; i < 40 && wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(wuf.YT.displayCues.length, 1);
    const genAfterLoad = wuf.YT.sessionGen;

    // Duplicate identical timedtext capture & mismatched preview video must not clear displayCues
    win.dispatchEvent(new MockCustomEvent('wuf-timedtext-captured', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en&kind=asr', rawText: json3Payload },
    }));
    win.dispatchEvent(new MockCustomEvent('wuf-timedtext-captured', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=otherPreview&lang=en', rawText: json3Payload },
    }));
    assert.equal(wuf.YT.displayCues.length, 1);
    assert.equal(wuf.YT.sessionGen, genAfterLoad);

    // Pre-paint MutationObserver snaps within 150ms of 10000ms cue at t=9.9s
    const seg = new MiniEl('span', '', ['ytp-caption-segment']);
    seg.textContent = 'Hello world';
    captionContainer.appendChild(seg);
    for (const obs of observers) {
      if (obs.target === captionContainer) {
        obs.cb([{ target: captionContainer, addedNodes: [seg], removedNodes: [] }]);
      }
    }
    assert.equal(player.classList.contains('wuf-translated-cue-visible'), true);

    // Track choice: noop must NOT dispatch wuf-yt-set-track; switch must use state.targetLanguage ('ja')
    dispatched.length = 0;
    const enTrack = { languageCode: 'en', kind: 'asr' };
    win.dispatchEvent(new MockCustomEvent('wuf-yt-tracks-response', {
      detail: { tracks: [enTrack], activeTrack: enTrack },
    }));
    assert.equal(dispatched.some(e => e.type === 'wuf-yt-set-track'), false);

    const jaTrack = { languageCode: 'ja' };
    win.dispatchEvent(new MockCustomEvent('wuf-yt-tracks-response', {
      detail: { tracks: [enTrack, jaTrack], activeTrack: enTrack },
    }));
    const setTrackEv = dispatched.find(e => e.type === 'wuf-yt-set-track');
    assert.equal(setTrackEv?.detail?.languageCode, 'ja');

    // SPA navigation to another video resets buffered cues and sessionGen
    loc.search = '?v=vidB';
    loc.href = 'https://www.youtube.com/watch?v=vidB';
    win.dispatchEvent(new MockCustomEvent('yt-navigate-finish'));
    assert.equal(wuf.YT.rawSegments.length, 0);
    assert.equal(wuf.YT.displayCues.length, 0);
    assert.equal(player.classList.contains('wuf-translated-cue-visible'), false);
    assert.ok(wuf.YT.sessionGen > genAfterLoad);
  } finally {
    wuf.destroy?.();
  }
});

function createYouTubeContentTestEnv(options = {}) {
  class MiniClassList {
    constructor() { this.set = new Set(); }
    add(...cls) { cls.forEach(c => this.set.add(c)); }
    remove(...cls) { cls.forEach(c => this.set.delete(c)); }
    toggle(c, force) {
      if (force === undefined) {
        if (this.set.has(c)) { this.set.delete(c); return false; }
        this.set.add(c); return true;
      }
      if (force) this.set.add(c); else this.set.delete(c);
      return force;
    }
    contains(c) { return this.set.has(c); }
  }
  class MiniEl {
    constructor(tag, id = '', classes = []) {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.classList = new MiniClassList();
      classes.forEach(c => this.classList.add(c));
      this.children = [];
      this.parentNode = null;
      this.parentElement = null;
      this.style = { setProperty() {} };
      this.attrs = {};
      this.listeners = new Map();
      this._textContent = '';
    }
    get textContent() { return this._textContent || this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this._textContent = String(v ?? ''); }
    get className() { return [...this.classList.set].join(' '); }
    set className(v) { this.classList = new MiniClassList(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    appendChild(child) { child.parentNode = this; child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child) { return this.appendChild(child); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    dispatchEvent(ev) {
      for (const fn of this.listeners.get(ev.type) || []) fn(ev);
      return true;
    }
    click() {
      const next = this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true';
      this.setAttribute('aria-pressed', next);
    }
    getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 30 }; }
    closest(sel) {
      if (sel.startsWith('#') && this.id === sel.slice(1)) return this;
      return this.parentElement ? this.parentElement.closest(sel) : null;
    }
    _all() { return [this, ...this.children.flatMap(c => c._all())]; }
    _matches(sel) {
      return sel.split(',').map(s => s.trim()).some(part => {
        if (part.includes(':not(')) {
          const [base, neg] = part.split(':not(');
          const negSel = neg.replace(/\)$/, '');
          if (this._matches(negSel)) return false;
          return base ? this._matches(base) : true;
        }
        const tokens = part.split(/\s+/);
        const last = tokens[tokens.length - 1];
        const hit =
          (last.startsWith('#') && this.id === last.slice(1)) ||
          (last.startsWith('.') && this.classList.contains(last.slice(1))) ||
          this.tagName === last.toUpperCase();
        if (!hit) return false;
        if (tokens.length === 1) return true;
        let p = this.parentElement;
        while (p) { if (p._matches(tokens[0])) return true; p = p.parentElement; }
        return false;
      });
    }
    querySelector(sel) { return this._all().slice(1).find(el => el._matches(sel)) || null; }
    querySelectorAll(sel) { return this._all().slice(1).filter(el => el._matches(sel)); }
  }

  const root = new MiniEl('html');
  const head = root.appendChild(new MiniEl('head'));
  const body = root.appendChild(new MiniEl('body'));
  const player = body.appendChild(new MiniEl('div', 'movie_player', ['html5-video-player']));
  const video = player.appendChild(new MiniEl('video'));
  video.currentTime = options.initialTimeSec ?? 0;
  video.paused = options.paused ?? false;
  video.playbackRate = options.playbackRate ?? 1;
  const captionContainer = player.appendChild(new MiniEl('div', 'ytp-caption-window-container', ['ytp-caption-window-container']));
  const rightControls = player.appendChild(new MiniEl('div', '', ['ytp-right-controls']));
  const ccBtn = rightControls.appendChild(new MiniEl('button', '', ['ytp-subtitles-button']));
  ccBtn.setAttribute('aria-pressed', 'false');

  const storageListeners = new Set();
  const chromeMock = {
    storage: {
      onChanged: {
        addListener(fn) { storageListeners.add(fn); },
        removeListener(fn) { storageListeners.delete(fn); },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
    },
  };

  const winListeners = new Map();
  const win = {
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
    removeEventListener(type, fn) {
      const arr = winListeners.get(type);
      if (arr) winListeners.set(type, arr.filter(f => f !== fn));
    },
    dispatchEvent(ev) {
      for (const fn of winListeners.get(ev.type) || []) fn(ev);
      return true;
    },
  };
  const doc = {
    body,
    head,
    documentElement: root,
    readyState: 'complete',
    addEventListener() {},
    createElement(tag) { return new MiniEl(tag); },
    getElementById(id) { return root._all().find(el => el.id === id) || null; },
    querySelector(sel) { return root._all().find(el => el._matches(sel)) || null; },
    querySelectorAll(sel) { return root._all().filter(el => el._matches(sel)); },
  };
  class MockCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }

  const loc = {
    origin: 'https://www.youtube.com',
    hostname: 'www.youtube.com',
    search: '?v=vidA',
    pathname: '/watch',
    href: 'https://www.youtube.com/watch?v=vidA',
  };

  let currentSettings = {
    runtimeSettings: {
      theme: 'dark',
      subtitles: {
        batchWindowSec: 30,
        engine: options.engine ?? 'openai-compat-local',
        targetLanguage: options.targetLanguage ?? 'zh-TW',
        customModelOverride: '',
        systemPrompt: '',
        prefetchLeadSec: 10,
      },
    },
    subtitleProvider: {
      profileType: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local-model',
      effectiveModel: 'local-model',
      systemPrompt: 'prompt',
      apiKey: '',
      temperature: 0.1,
      fetchTimeoutSec: 30,
      thinkingLevel: 'off',
      routingSort: 'auto',
      allowFallbacks: true,
      extraBodyJson: '',
      webConcurrency: 1,
      webBatchUnits: 1,
      webBatchChars: 1000,
      runtimeFallbackApplied: false,
    },
  };

  const defaultOnMessage = async (msg) => {
    if (msg.type === 'wuf:get-settings') {
      return { ok: true, data: structuredClone(currentSettings) };
    }
    if (msg.type === 'wuf:translate-text') {
      return { ok: true, data: { translations: msg.request.texts.map(t => `譯:${t}`) } };
    }
    return { ok: true, data: {} };
  };

  const ytSource = readFileSync(new URL('../wuf-src/content/content-youtube.ts', import.meta.url), 'utf8');
  const cjs = transformSync(ytSource, { loader: 'ts', format: 'cjs' }).code;
  const ctx = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (id.includes('youtube-pipeline') || id.includes('subtitle-worker') || id.includes('subtitle-scheduler')) {
        return {
          ...wufBundle,
          getCurrentWatchVideoId: (passedLoc = loc) => wufBundle.getCurrentWatchVideoId(passedLoc),
        };
      }
      if (id.includes('runtime-client')) {
        return {
          sendWufRuntimeMessage: (msg) => (options.onMessage ?? defaultOnMessage)(msg, defaultOnMessage),
        };
      }
      return {};
    },
    window: win,
    document: doc,
    location: loc,
    chrome: chromeMock,
    CustomEvent: MockCustomEvent,
    Element: MiniEl,
    HTMLElement: MiniEl,
    URL,
    performance: options.performance ?? { now: () => Date.now() },
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout: options.clearTimeout ?? clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  });
  ctx.globalThis = ctx;
  vm.runInContext(cjs, ctx);

  return {
    wuf: win.__WUF,
    win,
    doc,
    player,
    video,
    captionContainer,
    loc,
    storageListeners,
    MockCustomEvent,
    getSettings: () => currentSettings,
    setSettings: (updater) => { updater(currentSettings); },
    emitTimedText: (events, url = 'https://www.youtube.com/api/timedtext?v=vidA&lang=en&kind=asr') => {
      win.dispatchEvent(new MockCustomEvent('wuf-timedtext-captured', {
        detail: { url, rawText: JSON.stringify({ events }) },
      }));
    },
  };
}

test('local subtitles prioritize playback, merge ASR and forward sourceLanguage, and re-schedule immediately after seeking without running window batches', async () => {
  const calls = [];
  let pendingResolve = null;
  let env;

  env = createYouTubeContentTestEnv({
    initialTimeSec: 25,
    paused: true,
    engine: 'openai-compat-local',
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:translate-text') {
        calls.push(msg.request);
        if (calls.length === 1) {
          // While first request (at 25s) is in-flight, user seeks while paused to 95s
          return await new Promise((resolve) => {
            pendingResolve = () => resolve({ ok: true, data: { translations: ['第25秒譯文'] } });
          });
        }
        return { ok: true, data: { translations: [`譯:${msg.request.texts[0]}`] } };
      }
      return fallback(msg);
    },
  });

  try {
    await env.wuf.translateYouTubeSubtitles();
    env.emitTimedText([
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Line 0.' }] },
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'Line 5.' }] },
      { tStartMs: 25000, dDurationMs: 1000, segs: [{ utf8: 'Line' }] },
      { tStartMs: 26100, dDurationMs: 1500, segs: [{ utf8: '25.' }] },
      { tStartMs: 29000, dDurationMs: 2000, segs: [{ utf8: 'Line 29.' }] },
      { tStartMs: 95000, dDurationMs: 3000, segs: [{ utf8: 'Line 95.' }] },
    ]);

    for (let i = 0; i < 20 && calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].texts], ['Line 25.']);
    assert.equal(calls[0].sourceLanguage, 'en');
    assert.equal(env.wuf.YT.translatedWindows.size, 0, 'local session must not mark window batches');

    // Seek to 95s while paused (no subsequent timeupdate)
    env.video.currentTime = 95;
    env.video.dispatchEvent({ type: 'seeked' });

    // Finish first request -> worker must immediately dispatch Line 95. (not Line 29.)
    pendingResolve();
    for (let i = 0; i < 20 && calls.length < 2; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    assert.equal(calls.length, 2);
    assert.deepEqual([...calls[1].texts], ['Line 95.']);
    assert.equal(env.wuf.YT.translatedWindows.size, 0, 'triggerAheadOfTimeWorker/translateWindowByIndex must be no-op for local engine');
  } finally {
    env.wuf.destroy?.();
  }
});

test('openai-compat-online still uses legacy window path while local engine ignores translateWindowAt', async () => {
  const onlineCalls = [];
  const onlineEnv = createYouTubeContentTestEnv({
    initialTimeSec: 5,
    engine: 'openai-compat-online',
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:translate-text') {
        onlineCalls.push([...msg.request.texts]);
        return {
          ok: true,
          data: {
            translations: ['第一句', ''],
            intentionalEmpty: [1],
          },
        };
      }
      return fallback(msg);
    },
  });

  try {
    await onlineEnv.wuf.translateYouTubeSubtitles();
    onlineEnv.emitTimedText([
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'First sentence.' }] },
      { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: '[Music].' }] },
    ]);
    for (let i = 0; i < 20 && onlineCalls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.deepEqual(onlineCalls[0], ['First sentence.', '[Music].']);
    assert.equal(onlineEnv.wuf.YT.translatedWindows.has(0), true);
    await new Promise(r => setTimeout(r, 350));
    assert.equal(
      onlineEnv.doc.getElementById('__wuf_yt_caption_status')?.textContent ?? null,
      null,
      'legacy window engine intentionalEmpty sentence must not show waiting badge after 300ms',
    );
  } finally {
    onlineEnv.wuf.destroy?.();
  }
});

test('content adapter handles storage.onChanged: theme-only preserves generation & cues, subtitle config change increments generation, out-of-order snapshots and cache events are ignored, dispose removes listener', async () => {
  const snapshotResolvers = [];
  let interceptSnapshots = false;

  const env = createYouTubeContentTestEnv({
    initialTimeSec: 1,
    engine: 'openai-compat-local',
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:get-settings' && interceptSnapshots) {
        return await new Promise((resolve) => {
          snapshotResolvers.push(resolve);
        });
      }
      return fallback(msg);
    },
  });

  try {
    assert.equal(env.storageListeners.size, 1);
    const listener = [...env.storageListeners][0];

    await env.wuf.translateYouTubeSubtitles();
    env.emitTimedText([
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'Hello world.' }] },
    ]);
    for (let i = 0; i < 20 && env.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(env.wuf.YT.displayCues.length, 1);
    const genInitial = env.wuf.YT.sessionGen;

    // 1. Translation cache or unrelated storage keys must be ignored without even reading settings
    interceptSnapshots = true;
    listener({ wufTranslationCache: { newValue: {} } }, 'local');
    assert.equal(snapshotResolvers.length, 0);
    assert.equal(env.wuf.YT.sessionGen, genInitial);
    assert.equal(env.wuf.YT.displayCues.length, 1);

    // 2. Theme-only change in wufSettings: snapshot has identical [subtitles, subtitleProvider] -> does NOT increment generation or clear displayCues
    interceptSnapshots = false;
    env.setSettings((s) => { s.runtimeSettings.theme = 'light'; });
    listener({ wufSettings: { newValue: { theme: 'light' } } }, 'sync');
    await new Promise(r => setTimeout(r, 15));
    assert.equal(env.wuf.YT.sessionGen, genInitial);
    assert.equal(env.wuf.YT.displayCues.length, 1);

    // 3. Out-of-order snapshot responses: first read resolves AFTER second read -> stale first read is discarded
    interceptSnapshots = true;
    listener({ wufSettings: { newValue: {} } }, 'sync');
    listener({ wufSecrets: { newValue: {} } }, 'local'); // including deletion/change of wufSecrets
    assert.equal(snapshotResolvers.length, 2);

    const snap1 = structuredClone(env.getSettings());
    snap1.runtimeSettings.subtitles.targetLanguage = 'fr';
    const snap2 = structuredClone(env.getSettings());
    snap2.runtimeSettings.subtitles.targetLanguage = 'de';

    // Resolve second snapshot ('de') first, then first snapshot ('fr')
    snapshotResolvers[1]({ ok: true, data: snap2 });
    await new Promise(r => setTimeout(r, 15));
    const genAfterSnap2 = env.wuf.YT.sessionGen;
    assert.ok(genAfterSnap2 > genInitial);
    assert.equal(env.wuf.YT.targetLanguage, 'de');

    snapshotResolvers[0]({ ok: true, data: snap1 });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(env.wuf.YT.sessionGen, genAfterSnap2, 'out-of-order stale snapshot must be ignored');
    assert.equal(env.wuf.YT.targetLanguage, 'de');

    // 4. Disabling while settings read is in-flight does not re-enable
    snapshotResolvers.length = 0;
    listener({ wufSettings: {} }, 'sync');
    assert.equal(snapshotResolvers.length, 1);
    env.wuf.YT.active = false;
    const snap3 = structuredClone(env.getSettings());
    snap3.runtimeSettings.subtitles.targetLanguage = 'es';
    snapshotResolvers[0]({ ok: true, data: snap3 });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(env.wuf.YT.active, false);

    // 5. destroy/dispose removes storage listener
    env.wuf.destroy?.();
    assert.equal(env.storageListeners.size, 0);
  } finally {
    env.wuf.destroy?.();
  }
});

test('caption timeline updates (changed endMs/sourceSegs or duplicate timestamp insertion/removal) increment generation, drop stale in-flight writes, and rebuild displayCues with new timeline', async () => {
  const pending = [];
  const env = createYouTubeContentTestEnv({
    initialTimeSec: 1,
    engine: 'openai-compat-local',
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:translate-text') {
        return await new Promise((resolve) => {
          pending.push({ text: msg.request.texts[0], resolve });
        });
      }
      return fallback(msg);
    },
  });

  try {
    await env.wuf.translateYouTubeSubtitles();
    // Initial caption: startMs=1000, dur=2000 (endMs=3000)
    env.emitTimedText([
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Same text.' }] },
    ]);
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(pending.length, 1);
    const gen1 = env.wuf.YT.sessionGen;

    // Update caption: same startMs (1000) and same text, but dDurationMs=5000 (endMs=6000) + duplicate timestamp segments at 10000ms
    env.emitTimedText([
      { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'Same text.' }] },
      { tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: 'Duplicate at 10s.' }] },
      { tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: 'Second duplicate at 10s.' }] },
    ]);
    const gen2 = env.wuf.YT.sessionGen;
    assert.ok(gen2 > gen1, 'changed endMs or inserted segment at same ms must increment generation');

    // Resolve stale gen1 request -> must NOT write old endMs=3000 into displayCues, and must trigger gen2 request
    pending[0].resolve({ ok: true, data: { translations: ['舊時間軸譯文'] } });
    for (let i = 0; i < 20 && pending.length < 2; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(env.wuf.YT.displayCues.length, 0, 'stale generation result must not write to new session');

    // Resolve new gen2 request -> uses new timeline (1000..6000)
    pending[1].resolve({ ok: true, data: { translations: ['新時間軸譯文'] } });
    for (let i = 0; i < 20 && env.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(env.wuf.YT.displayCues.length, 1);
    assert.equal(env.wuf.YT.displayCues[0].startMs, 1000);
    assert.equal(env.wuf.YT.displayCues[0].endMs, 6000);
  } finally {
    env.wuf.destroy?.();
  }
});

test('Google subtitle session uses single-sentence worker (up to 3 concurrent), updates displayCues immediately per sentence, handles cross-30s boundary without gaps, and disables legacy window path', async () => {
  const inFlight = [];
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const env = createYouTubeContentTestEnv({
    initialTimeSec: 27,
    engine: 'google-translate',
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:translate-text') {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        return await new Promise((resolve) => {
          inFlight.push({
            texts: [...msg.request.texts],
            resolve: (translations) => {
              currentConcurrent -= 1;
              resolve({ ok: true, data: { translations } });
            },
          });
        });
      }
      return fallback(msg);
    },
  });

  try {
    await env.wuf.translateYouTubeSubtitles();
    env.emitTimedText([
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Expired line.' }] },
      { tStartMs: 27000, dDurationMs: 1500, segs: [{ utf8: 'We can fix' }] },
      { tStartMs: 28600, dDurationMs: 1200, segs: [{ utf8: 'cross boundary' }] },
      { tStartMs: 30050, dDurationMs: 1400, segs: [{ utf8: 'subtitles cleanly.' }] },
      { tStartMs: 33000, dDurationMs: 2000, segs: [{ utf8: 'Second line.' }] },
      { tStartMs: 36000, dDurationMs: 2000, segs: [{ utf8: 'Third line.' }] },
      { tStartMs: 40000, dDurationMs: 2000, segs: [{ utf8: 'Fourth line.' }] },
    ]);

    for (let i = 0; i < 20 && inFlight.length < 3; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    // Peak concurrency is 3, each request has 1 sentence, active cross-boundary sentence is first
    assert.equal(inFlight.length, 3);
    assert.equal(maxConcurrent, 3);
    assert.deepEqual(inFlight[0].texts, ['We can fix cross boundary subtitles cleanly.']);
    assert.deepEqual(inFlight[1].texts, ['Second line.']);
    assert.deepEqual(inFlight[2].texts, ['Third line.']);
    assert.equal(env.wuf.YT.translatedWindows.size, 0, 'Google session must not run legacy window batches');

    // Legacy translateWindowAt on Google session routes to worker without adding window batches
    await env.wuf.translateWindowAt(27);
    assert.equal(env.wuf.YT.translatedWindows.size, 0);
    assert.equal(maxConcurrent, 3);

    // Active sentence finishes first while the other two remain pending -> displayCues updates immediately
    inFlight[0].resolve(['我們可以乾淨地修復跨邊界字幕']);
    for (let i = 0; i < 20 && env.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(env.wuf.YT.displayCues.length >= 1, 'active translation must be added immediately without waiting for other 2 requests');
    assert.equal(env.wuf.YT.displayCues[0].startMs, 27000);
    assert.ok(env.wuf.YT.displayCues[env.wuf.YT.displayCues.length - 1].endMs >= 31450);

    // Freed slot dispatches Fourth line.
    for (let i = 0; i < 20 && inFlight.length < 4; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(inFlight.length, 4);
    assert.deepEqual(inFlight[3].texts, ['Fourth line.']);

    // Out-of-order completion of 3rd request ('Third line.') before 2nd ('Second line.') preserves exact timestamps
    inFlight[2].resolve(['第三句']);
    inFlight[1].resolve(['第二句']);
    inFlight[3].resolve(['第四句']);
    for (let i = 0; i < 20 && !env.wuf.YT.displayCues.some(c => c.text === '第四句'); i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    const cue2 = env.wuf.YT.displayCues.find(c => c.text === '第二句');
    const cue3 = env.wuf.YT.displayCues.find(c => c.text === '第三句');
    assert.equal(cue2?.startMs, 33000);
    assert.equal(cue3?.startMs, 36000);
  } finally {
    env.wuf.destroy?.();
  }
});

test('microsoft-translate and unknown engine strings still use legacy window batch path', async () => {
  for (const engine of ['microsoft-translate', 'google']) {
    const batchCalls = [];
    const env = createYouTubeContentTestEnv({
      initialTimeSec: 2,
      engine,
      onMessage: async (msg, fallback) => {
        if (msg.type === 'wuf:translate-text') {
          batchCalls.push([...msg.request.texts]);
        }
        return fallback(msg);
      },
    });
    try {
      await env.wuf.translateYouTubeSubtitles();
      env.emitTimedText([
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Line A.' }] },
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Line B.' }] },
      ]);
      for (let i = 0; i < 20 && batchCalls.length === 0; i++) {
        await new Promise(r => setTimeout(r, 5));
      }
      assert.deepEqual(batchCalls[0], ['Line A.', 'Line B.']);
      assert.equal(env.wuf.YT.translatedWindows.has(0), true);
    } finally {
      env.wuf.destroy?.();
    }
  }
});

test('Google single-sentence failure does not block the other 2 concurrent requests, 429 triggers engine cooldown + single-slot probe, and repeated/same-ms sentences have independent generation+id status', async () => {
  const inFlight = [];
  let fakeNowMs = 1000;
  let nextTimerId = 1;
  const timers = new Map();

  const env = createYouTubeContentTestEnv({
    initialTimeSec: 1,
    engine: 'google-translate',
    performance: { now: () => fakeNowMs },
    setTimeout: (cb, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { cb, fireAt: fakeNowMs + delayMs, delayMs });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    onMessage: async (msg, fallback) => {
      if (msg.type === 'wuf:translate-text') {
        return await new Promise((resolve) => {
          inFlight.push({
            text: msg.request.texts[0],
            resolve,
          });
        });
      }
      return fallback(msg);
    },
  });

  const advanceTime = (ms) => {
    fakeNowMs += ms;
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.fireAt <= fakeNowMs) {
        timers.delete(id);
        entry.cb();
      }
    }
  };

  try {
    await env.wuf.translateYouTubeSubtitles();
    // Repeated dialogue at 1s and 5s, plus another sentence at 3s and 8s
    env.emitTimedText([
      { tStartMs: 1000, dDurationMs: 1500, segs: [{ utf8: 'Repeat me.' }] },
      { tStartMs: 3000, dDurationMs: 1500, segs: [{ utf8: 'Middle line.' }] },
      { tStartMs: 5000, dDurationMs: 1500, segs: [{ utf8: 'Repeat me.' }] },
      { tStartMs: 8000, dDurationMs: 1500, segs: [{ utf8: 'Fourth line.' }] },
    ]);

    for (let i = 0; i < 10 && inFlight.length < 3; i++) {
      await Promise.resolve();
    }
    assert.equal(inFlight.length, 3);

    const flush = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };

    // 1st fails with 500, while 2nd and 3rd succeed -> 2nd and 3rd immediately appear in displayCues!
    inFlight[0].resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 500, message: 'err' } });
    inFlight[1].resolve({ ok: true, data: { translations: ['中間行'] } });
    inFlight[2].resolve({ ok: true, data: { translations: ['重複句'] } });
    await flush();

    assert.equal(env.wuf.YT.displayCues.length, 2, '2 successful requests must be immediately usable despite 1 failure');
    assert.equal(env.wuf.YT.displayCues.some(c => c.startMs === 3000 && c.text === '中間行'), true);
    assert.equal(env.wuf.YT.displayCues.some(c => c.startMs === 5000 && c.text === '重複句'), true);
    // Notice 1st ('Repeat me.' at 1000ms) failed and is independent of 3rd ('Repeat me.' at 5000ms)!
    assert.equal(env.wuf.YT.displayCues.some(c => c.startMs === 1000), false);

    // 4th sentence ('Fourth line.') was dispatched when slots freed; fail it with 429 -> triggers 3000ms engine cooldown + single-slot probe
    assert.equal(inFlight.length, 4);
    inFlight[3].resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 429, message: 'rate limit' } });
    await flush();

    // Advance 1000ms (1st sentence retryAtMs expires, but 429 engine cooldown still has 2000ms left)
    advanceTime(1000);
    await flush();
    assert.equal(inFlight.length, 4, 'must respect 3000ms 429 engine cooldown');

    // Advance remaining 2000ms -> 429 cooldown expires, dispatches ONLY 1 probe request (active 1000ms 'Repeat me.'), NOT both 1000ms and 8000ms!
    advanceTime(2000);
    await flush();
    assert.equal(inFlight.length, 5, 'after 429 cooldown, must probe with a single request first');
    assert.equal(inFlight[4].text, 'Repeat me.');

    // Probe succeeds -> restores capacity and immediately dispatches remaining 'Fourth line.'
    inFlight[4].resolve({ ok: true, data: { translations: ['第一句重複'] } });
    await flush();
    assert.equal(env.wuf.YT.displayCues.some(c => c.startMs === 1000 && c.text === '第一句重複'), true);
    assert.equal(inFlight.length, 6);
    assert.equal(inFlight[5].text, 'Fourth line.');
  } finally {
    env.wuf.destroy?.();
  }
});

test('status badge & diagnostics (local and Google): <300ms no waiting badge, >=300ms shows badge even when paused, timeupdate does not reset 300ms timer, clears on translation/silence/intentionalEmpty/disable, retryable error does not show premature failure, unrecoverable shows once, and diagnostics cap at 200 without sensitive text', async () => {
  for (const engine of ['openai-compat-local', 'google-translate']) {
    const inFlight = [];
    let fakeNowMs = 1000;
    let nextTimerId = 1;
    const timers = new Map();

    const env = createYouTubeContentTestEnv({
      initialTimeSec: 2,
      paused: true,
      engine,
      performance: { now: () => fakeNowMs },
      setTimeout: (cb, delayMs) => {
        const id = nextTimerId++;
        timers.set(id, { cb, fireAt: fakeNowMs + delayMs, delayMs });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      onMessage: async (msg, fallback) => {
        if (msg.type === 'wuf:translate-text') {
          return await new Promise((resolve) => {
            inFlight.push({
              text: msg.request.texts[0],
              resolve,
            });
          });
        }
        return fallback(msg);
      },
    });

    const advanceTime = (ms) => {
      fakeNowMs += ms;
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.fireAt <= fakeNowMs) {
          timers.delete(id);
          entry.cb();
        }
      }
    };
    const flush = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    const getBadgeText = () => env.doc.getElementById('__wuf_yt_caption_status')?.textContent ?? null;

    try {
      await env.wuf.translateYouTubeSubtitles();
      // Emit captions: active sentence at 1s..4s, silence gap 4s..10s, future sentence at 10s..14s, intentionalEmpty at 18s..21s, auth error sentence at 26s..30s
      env.emitTimedText([
        { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'Secret source sentence one.' }] },
        { tStartMs: 10000, dDurationMs: 4000, segs: [{ utf8: 'Future sentence two.' }] },
        { tStartMs: 18000, dDurationMs: 3000, segs: [{ utf8: '[Music]' }] },
        { tStartMs: 26000, dDurationMs: 4000, segs: [{ utf8: 'Auth check line.' }] },
      ]);
      await flush();

      // 1. Waiting < 300ms must NOT show '翻譯中...' badge
      assert.equal(getBadgeText(), null, `[${engine}] <300ms must not show waiting status badge`);

      // Advance 200ms and fire timeupdate -> must NOT reset the 300ms timer!
      advanceTime(200);
      env.video.dispatchEvent({ type: 'timeupdate' });
      assert.equal(getBadgeText(), null, `[${engine}] at 200ms badge still hidden`);

      // Advance 100ms more (total 300ms since sentence wait started) while video is PAUSED -> badge appears automatically!
      advanceTime(100);
      assert.equal(getBadgeText(), '翻譯中...', `[${engine}] >=300ms must show waiting status badge even when paused`);

      // Verify badge is mounted outside .ytp-caption-window-container so hiding native captions never hides the badge
      const badgeEl = env.doc.getElementById('__wuf_yt_caption_status');
      assert.equal(badgeEl?.parentElement, env.player);

      // 2. First retryable failure (attempt 1 of 3) must NOT prematurely display '翻譯暫時失敗'
      inFlight[0].resolve({ ok: false, error: { code: 'INVALID_RESPONSE', message: 'bad' } });
      await flush();
      assert.equal(getBadgeText(), '翻譯中...', `[${engine}] retryable failure must keep waiting state, not show terminal failure`);

      // 3. Move to silence gap (6s) -> waiting badge disappears immediately; late timer or stale cue never misreports silence
      env.video.currentTime = 6;
      env.video.dispatchEvent({ type: 'timeupdate' });
      assert.equal(getBadgeText(), null, `[${engine}] silence interval must clear waiting badge`);

      // Seek back to 2s and let retry succeed -> translation appears and waiting badge disappears
      env.video.currentTime = 2;
      env.video.dispatchEvent({ type: 'seeked' });
      advanceTime(300);
      assert.equal(getBadgeText(), '翻譯中...');
      advanceTime(700); // total 1000ms retry cooldown
      // If local engine (capacity 1) dispatched a lookahead sentence while sentence one was cooling down, resolve it to free the slot
      for (const req of inFlight) {
        if (req.text === 'Future sentence two.') {
          req.resolve({ ok: true, data: { translations: ['未來句二'] } });
        }
      }
      await flush();
      const retryReq = inFlight.find((r, idx) => idx > 0 && r.text === 'Secret source sentence one.');
      assert.ok(retryReq, `[${engine}] should have dispatched retry for sentence one`);
      retryReq.resolve({ ok: true, data: { translations: ['機密譯文一'] } });
      await flush();
      assert.equal(getBadgeText(), null, `[${engine}] completed translation must clear status badge`);

      // 4. intentionalEmpty sentence at 19s: when resolved with intentionalEmpty, does not show waiting or failure badge
      env.video.currentTime = 19;
      env.video.dispatchEvent({ type: 'seeked' });
      await flush();
      const musicReq = inFlight.find(r => r.text === '[Music]');
      assert.ok(musicReq);
      musicReq.resolve({ ok: true, data: { translations: [''], intentionalEmpty: [0] } });
      await flush();
      advanceTime(500);
      assert.equal(getBadgeText(), null, `[${engine}] intentionalEmpty sentence must not show waiting or error badge`);

      // 5. Unrecoverable auth error (401) shows explicit connection/auth error once; manual disable clears it without showing error
      env.video.currentTime = 27;
      env.video.dispatchEvent({ type: 'seeked' });
      await flush();
      const authReq = inFlight.filter(r => r.text === 'Auth check line.').pop();
      assert.ok(authReq);
      authReq.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 401, message: 'Unauthorized' } });
      await flush();
      assert.match(getBadgeText() ?? '', /設定|認證/, `[${engine}] 401 must show auth/settings error prompt`);

      // Manual disable clears status badge and does not show error
      env.doc.getElementById('__wuf_yt_trans_btn')?.dispatchEvent({
        type: 'click',
        stopPropagation() {},
        preventDefault() {},
      });
      assert.equal(env.wuf.YT.active, false);
      assert.equal(getBadgeText(), null, `[${engine}] manual disable must clear status badge`);

      // 6. Diagnostics privacy & 200-entry cap check
      for (let i = 0; i < 250; i++) {
        env.wuf.YT.diagnostics.push({
          type: 'dispatch',
          generation: 1,
          sentenceId: `extra-${i}`,
          startMs: i * 1000,
          attempt: 1,
        });
      }
      // Trigger one more worker session to exercise adapter diagnostic ring buffer trimming
      await env.wuf.translateYouTubeSubtitles();
      env.emitTimedText([
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Another secret line.' }] },
      ]);
      await flush();
      assert.ok(env.wuf.YT.diagnostics.length <= 200, `[${engine}] diagnostics must cap at 200 entries`);
      const serializedDiag = JSON.stringify(env.wuf.YT.diagnostics);
      assert.equal(serializedDiag.includes('Secret source'), false, 'diagnostics must never contain source text');
      assert.equal(serializedDiag.includes('機密譯文'), false, 'diagnostics must never contain translated text');
    } finally {
      env.wuf.destroy?.();
    }
  }
});
