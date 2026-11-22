import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as wufBundle from '../dist/wuf/index.js';

const CAPTION_PREF_KEY = 'yt-player-caption-language-preferences';

function createMemoryStorage(initial = {}, options = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(k) {
      if (options.throwOnAccess) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (options.throwOnAccess) throw new Error('SecurityError');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (options.throwOnAccess) throw new Error('SecurityError');
      map.delete(k);
    },
    _map: map,
  };
}

function createInterceptorEnv(options = {}) {
  const winListeners = new Map();
  const dispatched = [];
  const timers = [];
  let nextTimerId = 1;

  const win = {
    ytInitialPlayerResponse: options.ytInitialPlayerResponse,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      dispatched.push({ type: ev.type, detail: ev.detail });
      for (const fn of winListeners.get(ev.type) || []) fn(ev);
      return true;
    },
  };

  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  const setOptionCalls = [];
  const loadModuleCalls = [];
  let currentTrack = options.initialTrack ?? {};

  const player = {
    loadModule(name) {
      loadModuleCalls.push(name);
    },
    getOption(mod, opt) {
      if (mod === 'captions' && opt === 'track') return currentTrack;
      if (mod === 'captions' && opt === 'tracklist') return options.tracklist ?? [];
      return null;
    },
    setOption(mod, opt, val) {
      setOptionCalls.push({ mod, opt, val });
      if (mod === 'captions' && opt === 'track') {
        currentTrack = val && typeof val === 'object' ? { ...val } : {};
      }
      options.onSetOption?.(mod, opt, val);
    },
    getPlayerResponse() {
      return options.playerResponse ?? null;
    },
  };

  const doc = {
    querySelector(sel) {
      if (sel === '#movie_player' || sel === '.html5-video-player') return player;
      return null;
    },
  };

  const loc = {
    origin: 'https://www.youtube.com',
    hostname: 'www.youtube.com',
    pathname: options.pathname ?? '/watch',
    search: options.search ?? '?v=vidA',
    href: `https://www.youtube.com${options.pathname ?? '/watch'}${options.search ?? '?v=vidA'}`,
  };

  const localStorage = options.localStorage ?? createMemoryStorage(options.initialLocal);
  const sessionStorage = options.sessionStorage ?? createMemoryStorage(options.initialSession);

  const src = readFileSync(new URL('../wuf-src/content/youtube-main-interceptor.ts', import.meta.url), 'utf8');
  const cjs = transformSync(src, { loader: 'ts', format: 'cjs' }).code;

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
      return {};
    },
    window: win,
    document: doc,
    location: loc,
    localStorage,
    sessionStorage,
    CustomEvent: MockCustomEvent,
    URL,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.find(item => item.id === id);
      if (t) t.cleared = true;
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(cjs, ctx);

  return {
    win,
    loc,
    player,
    localStorage,
    sessionStorage,
    dispatched,
    setOptionCalls,
    loadModuleCalls,
    MockCustomEvent,
    getCurrentTrack: () => currentTrack,
    flushTimers: () => {
      const pending = timers.splice(0);
      for (const t of pending) {
        if (!t.cleared) t.fn();
      }
    },
  };
}

test('wuf-yt-set-track restores yt-player-caption-language-preferences on synchronous mutation (existing & null)', () => {
  const existingPref = JSON.stringify({ data: JSON.stringify({ languageCode: 'zh-TW' }), creation: 1 });
  let env;
  env = createInterceptorEnv({
    initialLocal: { [CAPTION_PREF_KEY]: existingPref },
    initialSession: { [CAPTION_PREF_KEY]: existingPref },
    onSetOption: (_mod, _opt, val) => {
      if (val?.languageCode) {
        const poisoned = JSON.stringify({ data: JSON.stringify({ languageCode: val.languageCode }) });
        env.localStorage.setItem(CAPTION_PREF_KEY, poisoned);
        env.sessionStorage.setItem(CAPTION_PREF_KEY, poisoned);
      }
    },
  });

  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));

  assert.equal(env.setOptionCalls.length, 1);
  assert.equal(env.localStorage.getItem(CAPTION_PREF_KEY), existingPref);
  assert.equal(env.sessionStorage.getItem(CAPTION_PREF_KEY), existingPref);

  // Also verify removal when no prior preference existed
  let nullEnv;
  nullEnv = createInterceptorEnv({
    onSetOption: (_mod, _opt, val) => {
      if (val?.languageCode) {
        nullEnv.localStorage.setItem(CAPTION_PREF_KEY, JSON.stringify({ languageCode: val.languageCode }));
      }
    },
  });
  nullEnv.win.dispatchEvent(new nullEnv.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));
  assert.equal(nullEnv.localStorage.getItem(CAPTION_PREF_KEY), null);
});

test('wuf-yt-set-track restores asynchronous YouTube preference mutation without clobbering manual user selection', () => {
  const origPref = JSON.stringify({ data: JSON.stringify({ languageCode: 'zh-TW' }) });
  const env = createInterceptorEnv({
    initialLocal: { [CAPTION_PREF_KEY]: origPref },
  });

  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));

  // Simulate YouTube asynchronously persisting forced 'en'
  env.localStorage.setItem(CAPTION_PREF_KEY, JSON.stringify({ data: JSON.stringify({ languageCode: 'en' }) }));
  env.flushTimers();
  assert.equal(env.localStorage.getItem(CAPTION_PREF_KEY), origPref);

  // Now simulate a manual user selection ('ja') during the deferred window
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));
  const manualJaPref = JSON.stringify({ data: JSON.stringify({ languageCode: 'ja' }) });
  env.localStorage.setItem(CAPTION_PREF_KEY, manualJaPref);
  env.flushTimers();
  assert.equal(env.localStorage.getItem(CAPTION_PREF_KEY), manualJaPref);
});

test('wuf-yt-set-track handles Storage exceptions safely', () => {
  const throwingStorage = createMemoryStorage({}, { throwOnAccess: true });
  const env = createInterceptorEnv({
    localStorage: throwingStorage,
    sessionStorage: throwingStorage,
  });

  assert.doesNotThrow(() => {
    env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
      detail: { languageCode: 'en', kind: '' },
    }));
    env.flushTimers();
  });
  assert.equal(env.setOptionCalls.length, 1);
  assert.equal(env.setOptionCalls[0].val.languageCode, 'en');
});

test('wuf-yt-set-caption-state (enabled: true) loads captions module without blindly forcing tracks[0]', () => {
  const env = createInterceptorEnv({
    initialTrack: {},
    tracklist: [{ languageCode: 'en', kind: '' }, { languageCode: 'zh-TW', kind: '' }],
    playerResponse: {
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'en', kind: '' }],
        },
      },
    },
  });

  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: false },
  }));

  assert.deepEqual(env.loadModuleCalls, ['captions']);
  assert.equal(env.setOptionCalls.length, 0);
});

test('wuf-yt-set-caption-state restores pre-WUF native track and preference on disable, preserves manual selection, and ignores disable when inactive', () => {
  const origPref = JSON.stringify({ languageCode: 'zh-TW' });
  let env;
  env = createInterceptorEnv({
    initialTrack: { languageCode: 'zh-TW', kind: '' },
    initialLocal: { [CAPTION_PREF_KEY]: origPref },
    onSetOption: (_mod, _opt, val) => {
      if (val?.languageCode) {
        env.localStorage.setItem(CAPTION_PREF_KEY, JSON.stringify({ languageCode: val.languageCode }));
      }
    },
  });

  // 0. Disabling when never enabled must NOT turn off native CC
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: false },
  }));
  assert.equal(env.setOptionCalls.length, 0);
  assert.deepEqual(env.getCurrentTrack(), { languageCode: 'zh-TW', kind: '' });

  // 1. WUF enables while native CC (zh-TW) is already ON
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: true },
  }));
  // 2. WUF switches to en and YT asynchronously poisons localStorage
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));
  env.localStorage.setItem(CAPTION_PREF_KEY, JSON.stringify({ languageCode: 'en' }));

  // 3. WUF disables -> should restore zh-TW track and zh-TW preference
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: false },
  }));
  assert.deepEqual(env.getCurrentTrack(), { languageCode: 'zh-TW', kind: '' });
  assert.equal(env.localStorage.getItem(CAPTION_PREF_KEY), origPref);

  // 4. Manual user selection ('ja') while WUF is active must NOT be clobbered on disable
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: true },
  }));
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'en', kind: '' },
  }));
  const manualJaPref = JSON.stringify({ languageCode: 'ja' });
  env.localStorage.setItem(CAPTION_PREF_KEY, manualJaPref);
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: false },
  }));
  env.flushTimers();
  assert.equal(env.localStorage.getItem(CAPTION_PREF_KEY), manualJaPref);
});

test('SPA navigation ordering: videoId-scoped snapshot survives same-video yt-navigate-finish and resets on new video', () => {
  const env = createInterceptorEnv({
    search: '?v=vidA',
    initialTrack: {},
  });

  // Capture on vidA
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: true },
  }));

  // Navigate to vidB (native CC off): yt-page-data-updated fires BEFORE yt-navigate-finish and enables on vidB
  env.loc.search = '?v=vidB';
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: false },
  }));
  // Late yt-navigate-finish for vidB must NOT wipe vidB's fresh snapshot
  env.win.dispatchEvent(new env.MockCustomEvent('yt-navigate-finish'));

  env.setOptionCalls.length = 0;
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: false },
  }));
  assert.deepEqual(env.getCurrentTrack(), {});
  assert.equal(env.setOptionCalls.length, 1);

  // Navigate to vidC while snapshot was on vidB -> yt-navigate-finish clears stale snapshot
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: true, wasNativeCcEnabled: false },
  }));
  env.loc.search = '?v=vidC';
  env.win.dispatchEvent(new env.MockCustomEvent('yt-navigate-finish'));
  env.setOptionCalls.length = 0;
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-caption-state', {
    detail: { enabled: false },
  }));
  assert.equal(env.setOptionCalls.length, 0);
});

test('wuf-yt-request-tracks ignores stale ytInitialPlayerResponse when videoId mismatches watch/shorts URL', () => {
  const staleResp = {
    videoDetails: { videoId: 'vidA' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ languageCode: 'en' }],
      },
    },
  };

  // Mismatched /watch?v=vidB -> must ignore stale ytInitialPlayerResponse
  const env = createInterceptorEnv({
    pathname: '/watch',
    search: '?v=vidB',
    playerResponse: null,
    ytInitialPlayerResponse: staleResp,
  });
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-request-tracks'));
  const respMismatch = env.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.equal(respMismatch?.detail?.tracks, null);

  // Mismatched /shorts/vidC -> must also ignore stale ytInitialPlayerResponse
  env.dispatched.length = 0;
  env.loc.pathname = '/shorts/vidC';
  env.loc.search = '';
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-request-tracks'));
  const respShortsMismatch = env.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.equal(respShortsMismatch?.detail?.tracks, null);

  // Matching /watch?v=vidA -> allowed
  env.dispatched.length = 0;
  env.loc.pathname = '/watch';
  env.loc.search = '?v=vidA';
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-request-tracks'));
  const respMatch = env.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.deepEqual(respMatch?.detail?.tracks, [{ languageCode: 'en' }]);

  // Non-video page (no videoId) -> allowed
  env.dispatched.length = 0;
  env.loc.pathname = '/';
  env.loc.search = '';
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-request-tracks'));
  const respNonWatch = env.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.deepEqual(respNonWatch?.detail?.tracks, [{ languageCode: 'en' }]);
});

test('content-youtube ignores wuf-yt-tracks-response when inactive, deduplicates track requests, and preserves native CC on disable', async () => {
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
  video.currentTime = 0;
  video.paused = true;
  video.playbackRate = 1;
  player.appendChild(new MiniEl('div', 'ytp-caption-window-container', ['ytp-caption-window-container']));
  const rightControls = player.appendChild(new MiniEl('div', '', ['ytp-right-controls']));
  const ccBtn = rightControls.appendChild(new MiniEl('button', '', ['ytp-subtitles-button']));
  ccBtn.setAttribute('aria-pressed', 'true');

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

  let onRuntimeMessage = null;
  const chromeMock = {
    runtime: {
      onMessage: { addListener(fn) { onRuntimeMessage = fn; } },
    },
  };

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
              return { ok: true, data: { runtimeSettings: { subtitles: { batchWindowSec: 30, engine: 'google', targetLanguage: 'zh-TW' } } } };
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
    chrome: chromeMock,
    CustomEvent: MockCustomEvent,
    Element: MiniEl,
    HTMLElement: MiniEl,
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
    // 0. Disabling WUF when it was never enabled must NOT turn off native CC or dispatch caption state
    assert.equal(wuf.YT.active, false);
    dispatched.length = 0;
    onRuntimeMessage({ type: 'wuf:set-youtube-subtitle-state', payload: { enabled: false } }, {}, () => {});
    assert.equal(ccBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(dispatched.some(e => e.type === 'wuf-yt-set-caption-state'), false);

    // 1. When WUF is inactive, wuf-yt-tracks-response must NOT dispatch wuf-yt-set-track
    assert.equal(wuf.YT.active, false);
    dispatched.length = 0;
    win.dispatchEvent(new MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'en' }, { languageCode: 'ja', kind: 'asr' }],
        activeTrack: { languageCode: 'ja', kind: 'asr' },
      },
    }));
    assert.equal(dispatched.some(e => e.type === 'wuf-yt-set-track'), false);

    // 2. Activating with rawSegments empty dispatches wuf-yt-request-tracks exactly ONCE
    dispatched.length = 0;
    await wuf.translateYouTubeSubtitles();
    const requestTracksCount = dispatched.filter(e => e.type === 'wuf-yt-request-tracks').length;
    assert.equal(requestTracksCount, 1);

    // 3. Native CC was originally ON -> disabling WUF keeps ccBtn aria-pressed='true'
    const captionStateEnableEv = dispatched.find(e => e.type === 'wuf-yt-set-caption-state' && e.detail?.enabled === true);
    assert.equal(captionStateEnableEv?.detail?.wasNativeCcEnabled, true);

    onRuntimeMessage({ type: 'wuf:set-youtube-subtitle-state', payload: { enabled: false } }, {}, () => {});
    assert.equal(wuf.YT.active, false);
    assert.equal(ccBtn.getAttribute('aria-pressed'), 'true');
  } finally {
    wuf.destroy?.();
  }
});

test('wuf-yt-request-tracks extracts originalAudioLang and defaultCaptionTrackIndex; wuf-yt-set-track forwards vssId and clears translationLanguage', () => {
  const env = createInterceptorEnv({
    initialTrack: {
      languageCode: 'en',
      kind: '',
      vssId: '.en',
      translationLanguage: { languageCode: 'zh-Hant', languageName: { simpleText: 'Chinese' } },
    },
    playerResponse: {
      videoDetails: { videoId: 'vidA' },
      streamingData: {
        adaptiveFormats: [
          { audioTrack: { id: 'en-US.3', displayName: 'English', audioIsDefault: false } },
          { audioTrack: { id: 'ja-JP.4', displayName: 'Japanese (original)', audioIsDefault: true } },
        ],
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: 'en', vssId: '.en' },
            { languageCode: 'ja', vssId: '.ja' },
          ],
          audioTracks: [
            { defaultCaptionTrackIndex: 0 },
            { defaultCaptionTrackIndex: 1 },
          ],
          defaultAudioTrackIndex: 1,
        },
      },
    },
  });

  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-request-tracks'));
  const tracksResp = env.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.equal(tracksResp?.detail?.originalAudioLang, 'ja-JP');
  assert.equal(tracksResp?.detail?.defaultCaptionTrackIndex, 1);

  // Setting track when activeTrack has translationLanguage must pass vssId and explicitly clear translationLanguage in 1 call
  env.win.dispatchEvent(new env.MockCustomEvent('wuf-yt-set-track', {
    detail: { languageCode: 'ja', kind: '', vssId: '.ja' },
  }));
  assert.equal(env.setOptionCalls.length, 1);
  assert.equal(env.setOptionCalls[0].val.languageCode, 'ja');
  assert.equal(env.setOptionCalls[0].val.vssId, '.ja');
  assert.equal('translationLanguage' in env.setOptionCalls[0].val, true);
  assert.equal(env.setOptionCalls[0].val.translationLanguage, undefined);

  // Fallback originalAudioLang from formats when no audioIsDefault is true
  const fallbackEnv = createInterceptorEnv({
    playerResponse: {
      videoDetails: { videoId: 'vidA' },
      streamingData: {
        formats: [{ audioTrack: { id: 'ko.1' } }],
      },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ languageCode: 'ko', kind: 'asr' }],
          audioTracks: [{ defaultCaptionTrackIndex: 0 }],
        },
      },
    },
  });
  fallbackEnv.win.dispatchEvent(new fallbackEnv.MockCustomEvent('wuf-yt-request-tracks'));
  const fbResp = fallbackEnv.dispatched.find(e => e.type === 'wuf-yt-tracks-response');
  assert.equal(fbResp?.detail?.originalAudioLang, 'ko');
  assert.equal(fbResp?.detail?.defaultCaptionTrackIndex, 0);
});

test('content-youtube blocks tlang payloads, handles native Chinese passthrough and local OpenCC-only mode without calling LLM', async () => {
  function createContentHarness({
    openccEnabled = true,
    openccVariant = 's2twp',
    engine = 'google-translate',
    targetLanguage = 'zh-TW',
    deferSettings = false,
  } = {}) {
    let resolveDeferredSettings = null;
    const deferredSettingsPromise = deferSettings
      ? new Promise(resolve => { resolveDeferredSettings = resolve; })
      : null;
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
    video.currentTime = 1;
    video.paused = true;
    video.playbackRate = 1;
    player.appendChild(new MiniEl('div', 'ytp-caption-window-container', ['ytp-caption-window-container']));
    const rightControls = player.appendChild(new MiniEl('div', '', ['ytp-right-controls']));
    const ccBtn = rightControls.appendChild(new MiniEl('button', '', ['ytp-subtitles-button']));
    ccBtn.setAttribute('aria-pressed', 'true');

    const winListeners = new Map();
    const dispatched = [];
    const runtimeMessages = [];
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
              runtimeMessages.push(msg);
              if (msg.type === 'wuf:get-settings') {
                if (deferredSettingsPromise) {
                  await deferredSettingsPromise;
                }
                return {
                  ok: true,
                  data: {
                    runtimeSettings: {
                      openccEnabled,
                      openccVariant,
                      subtitles: { batchWindowSec: 30, engine, targetLanguage },
                    },
                    subtitleProvider: { baseUrl: '', effectiveModel: '' },
                  },
                };
              }
              if (msg.type === 'wuf:convert-opencc') {
                return {
                  ok: true,
                  data: {
                    variant: msg.request.variant || 's2twp',
                    conversions: msg.request.texts.map(t => `TW:${t}`),
                  },
                };
              }
              if (msg.type === 'wuf:translate-text') {
                return {
                  ok: true,
                  data: { translations: msg.request.texts.map(t => `LLM:${t}`) },
                };
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
      URL,
      setTimeout,
      clearTimeout,
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
      body,
      loc,
      dispatched,
      runtimeMessages,
      MockCustomEvent,
      releaseSettings: () => resolveDeferredSettings?.(),
    };
  }

  // Case 1: tlang timedtext payload is ignored and triggers guarded wuf-yt-request-tracks once
  const h1 = createContentHarness({ openccEnabled: true });
  try {
    await h1.wuf.translateYouTubeSubtitles();
    h1.dispatched.length = 0;
    h1.runtimeMessages.length = 0;
    const tlangJson = JSON.stringify({
      events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: 'YT自動翻譯' }] }],
    });
    h1.win.dispatchEvent(new h1.MockCustomEvent('wuf-timedtext-captured', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en&tlang=zh-Hant', rawText: tlangJson },
    }));
    // Repeated identical tlang capture must NOT re-dispatch wuf-yt-request-tracks
    h1.win.dispatchEvent(new h1.MockCustomEvent('wuf-timedtext-captured', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en&tlang=zh-Hant', rawText: tlangJson },
    }));
    assert.equal(h1.wuf.YT.rawSegments.length, 0);
    assert.equal(h1.dispatched.filter(e => e.type === 'wuf-yt-request-tracks').length, 1);
    assert.equal(h1.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
  } finally {
    h1.wuf.destroy?.();
  }

  // Case 2: Pure Native Passthrough (zh-TW manual -> unhide native YT captions, no LLM, no OpenCC, shows brief notice)
  const h2 = createContentHarness({ openccEnabled: true });
  try {
    await h2.wuf.translateYouTubeSubtitles();
    h2.runtimeMessages.length = 0;
    h2.win.dispatchEvent(new h2.MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'en' }, { languageCode: 'zh-TW', vssId: '.zh-TW' }],
        activeTrack: { languageCode: 'zh-TW', vssId: '.zh-TW' },
      },
    }));
    assert.equal(h2.wuf.YT.nativePassthrough, true);
    assert.equal(h2.wuf.YT.openccOnly, false);
    assert.equal(h2.player.classList.contains('wuf-subtitles-active'), false);
    assert.equal(h2.body.classList.contains('wuf-subtitles-active'), false);
    const statusBadge = h2.doc.getElementById('__wuf_yt_caption_status');
    assert.ok(statusBadge?.textContent?.includes('原生'));

    // Timedtext for zh-TW arrives -> must NOT translate or call OpenCC
    h2.win.dispatchEvent(new h2.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=zh-TW',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: '繁體原生字幕' }] }] }),
      },
    }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h2.wuf.YT.nativePassthrough, true);
    assert.equal(h2.wuf.YT.displayCues.length, 0);
    assert.equal(h2.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
    assert.equal(h2.runtimeMessages.some(m => m.type === 'wuf:convert-opencc'), false);

    // SPA navigation resets nativePassthrough
    h2.loc.search = '?v=vidB';
    h2.win.dispatchEvent(new h2.MockCustomEvent('yt-navigate-finish'));
    assert.equal(h2.wuf.YT.nativePassthrough, false);
  } finally {
    h2.wuf.destroy?.();
  }

  // Case 3: Simplified Chinese manual with openccEnabled=true -> Local OpenCC-only (s2twp), ZERO LLM calls
  const h3 = createContentHarness({ openccEnabled: true });
  try {
    await h3.wuf.translateYouTubeSubtitles();
    h3.runtimeMessages.length = 0;
    h3.win.dispatchEvent(new h3.MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'zh-CN', vssId: '.zh-CN' }],
        activeTrack: { languageCode: 'zh-CN', vssId: '.zh-CN' },
      },
    }));
    assert.equal(h3.wuf.YT.openccOnly, true);
    assert.equal(h3.wuf.YT.nativePassthrough, false);
    h3.win.dispatchEvent(new h3.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=zh-CN',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: '简体中文字幕' }] }] }),
      },
    }));
    for (let i = 0; i < 20 && h3.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(h3.wuf.YT.displayCues.length, 1);
    assert.equal(h3.wuf.YT.displayCues[0].text, 'TW:简体中文字幕');
    const openccCall = h3.runtimeMessages.find(m => m.type === 'wuf:convert-opencc');
    assert.ok(openccCall);
    assert.equal(openccCall.request.variant, 's2twp');
    assert.equal(h3.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
  } finally {
    h3.wuf.destroy?.();
  }

  // Case 4: Simplified Chinese ASR with openccEnabled=false -> Pure native passthrough (no LLM, no OpenCC)
  const h4 = createContentHarness({ openccEnabled: false });
  try {
    await h4.wuf.translateYouTubeSubtitles();
    h4.runtimeMessages.length = 0;
    h4.win.dispatchEvent(new h4.MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'zh-Hans', kind: 'asr', vssId: 'a.zh-Hans' }],
        activeTrack: { languageCode: 'zh-Hans', kind: 'asr', vssId: 'a.zh-Hans' },
      },
    }));
    assert.equal(h4.wuf.YT.nativePassthrough, true);
    assert.equal(h4.wuf.YT.openccOnly, false);
    assert.equal(h4.player.classList.contains('wuf-subtitles-active'), false);
    assert.equal(h4.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
    assert.equal(h4.runtimeMessages.some(m => m.type === 'wuf:convert-opencc'), false);
  } finally {
    h4.wuf.destroy?.();
  }

  // Case 5: Cold-start race where zh-CN timedtext arrives BEFORE wuf:get-settings resolves
  // Must block LLM translation & local warmup, respect openccVariant='s2t', and convert via OpenCC once settings resolve
  const h5 = createContentHarness({
    openccEnabled: true,
    openccVariant: 's2t',
    engine: 'openai-compat-local',
    deferSettings: true,
  });
  try {
    const activatePromise = h5.wuf.translateYouTubeSubtitles();
    // Tracks response arrives while wuf:get-settings is still pending
    h5.win.dispatchEvent(new h5.MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'en' }, { languageCode: 'zh-CN', vssId: '.zh-CN' }],
        activeTrack: { languageCode: 'en' },
      },
    }));
    // zh-CN timedtext arrives BEFORE settings resolve
    h5.win.dispatchEvent(new h5.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=zh_CN',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: '冷启动简体' }] }] }),
      },
    }));
    await new Promise(r => setTimeout(r, 20));
    // While settings are pending, NO LLM translation and NO warmup may fire
    assert.equal(h5.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
    assert.equal(h5.runtimeMessages.some(m => m.type === 'wuf:warmup-youtube'), false);

    // Release deferred settings -> enters openccOnly and converts with s2t
    h5.releaseSettings();
    await activatePromise;
    for (let i = 0; i < 20 && h5.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(h5.wuf.YT.openccOnly, true);
    assert.equal(h5.wuf.YT.displayCues.length, 1);
    assert.equal(h5.wuf.YT.displayCues[0].text, 'TW:冷启动简体');
    const openccCall = h5.runtimeMessages.find(m => m.type === 'wuf:convert-opencc');
    assert.equal(openccCall?.request?.variant, 's2t');
    assert.equal(h5.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);
    assert.equal(h5.runtimeMessages.some(m => m.type === 'wuf:warmup-youtube'), false);
  } finally {
    h5.wuf.destroy?.();
  }

  // Case 6: Stale pre-switch `en` timedtext arriving right after switch-to-native (`en` -> `zh-TW`)
  // Must be ignored without clearing nativeTrackLock; later manual switch to `en` exits nativePassthrough
  const h6 = createContentHarness({ openccEnabled: true });
  try {
    await h6.wuf.translateYouTubeSubtitles();
    h6.runtimeMessages.length = 0;
    h6.win.dispatchEvent(new h6.MockCustomEvent('wuf-yt-tracks-response', {
      detail: {
        tracks: [{ languageCode: 'en' }, { languageCode: 'zh-TW', vssId: '.zh-TW' }],
        activeTrack: { languageCode: 'en' },
      },
    }));
    assert.equal(h6.wuf.YT.nativePassthrough, true);

    // Stale in-flight `en` timedtext arrives before `zh-TW`
    h6.win.dispatchEvent(new h6.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: 'Stale English' }] }] }),
      },
    }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h6.wuf.YT.nativePassthrough, true);
    assert.equal(h6.wuf.YT.rawSegments.length, 0);
    assert.equal(h6.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);

    // Switched `zh-TW` arrives -> lock marked received, stays in nativePassthrough
    h6.win.dispatchEvent(new h6.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=zh-TW',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: '繁體字幕' }] }] }),
      },
    }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h6.wuf.YT.nativePassthrough, true);
    assert.equal(h6.runtimeMessages.some(m => m.type === 'wuf:translate-text'), false);

    // Later manual switch to `en` -> exits nativePassthrough and translates `en`
    h6.win.dispatchEvent(new h6.MockCustomEvent('wuf-timedtext-captured', {
      detail: {
        url: 'https://www.youtube.com/api/timedtext?v=vidA&lang=en',
        rawText: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 2000, segs: [{ utf8: 'Manual English' }] }] }),
      },
    }));
    for (let i = 0; i < 20 && h6.wuf.YT.displayCues.length === 0; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(h6.wuf.YT.nativePassthrough, false);
    assert.equal(h6.wuf.YT.displayCues[0]?.text, 'LLM:Manual English');
  } finally {
    h6.wuf.destroy?.();
  }
});
