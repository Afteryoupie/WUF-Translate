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
        return { ok: true, data: { runtimeSettings: { subtitles: { batchWindowSec: 30, engine: 'google', targetLanguage: 'zh-TW' } } } };
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
  const ccBtn = player.appendChild(new MiniEl('button', '', ['ytp-subtitles-button']));
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
