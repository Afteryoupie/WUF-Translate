import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../dist/wuf/content-webpage.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(text = '') { this.textContent = text; this.children = []; this.childNodes = []; this.attrs = new Map(); const values = new Map(); this.style = {
      getPropertyValue: key => values.get(key)?.value || '',
      getPropertyPriority: key => values.get(key)?.priority || '',
      setProperty: (key, value, priority = '') => values.set(key, { value, priority }),
      removeProperty: key => values.delete(key),
    }; }
  get innerHTML() { return this.textContent; }
  set innerHTML(text) { this.textContent = text; this.children = []; this.childNodes = []; }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  hasAttribute(key) { return this.attrs.has(key); }
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); }
  querySelector() { return null; }
  closest() { return null; }
  appendChild(child) { this.childNodes.push(child); return child; }
  attachShadow() { return new Element(); }
  remove() {}
}

function harness({ delayed = false, auto = false, sticky = false, initialSticky = false, navType = 'reload' } = {}) {
  let listener;
  let resolveTranslation;
  let stickyActive = initialSticky;
  const requests = [], states = [], observers = [], events = new Map();
  const title = new Element('First video');
  let translation = null;
  title.matches = () => true;
  title.insertAdjacentElement = (_position, element) => {
    translation = element;
    element.remove = () => { if (translation === element) translation = null; };
    return element;
  };
  const makeRoot = () => ({ querySelectorAll(selector) {
    if (selector.includes('p, h1')) return [title];
    if (selector === '[data-wuf-injected="true"]') return translation ? [translation] : [];
    if (selector === '[data-wuf-translated]') return title.hasAttribute('data-wuf-translated') ? [title] : [];
    return [];
  } });
  let root = makeRoot();
  const document = { body: root, documentElement: new Element(), querySelector: () => root,
    createElement: () => new Element(), createTextNode: text => ({ textContent: text }) };
  const location = { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=first' };
  const window = { addEventListener: (name, fn) => events.set(name, fn) }; window.top = window;
  const settings = { runtimeSettings: { webpage: { engine: 'openai-compat-local', targetLanguage: 'zh-TW',
    displayMode: 'monolingual', crossTabSticky: sticky, autoTranslateHosts: auto ? ['www.youtube.com'] : [] } }, webpageProvider: { profileType: 'local' } };
  vm.runInNewContext(script, {
    document, window, location, URL, AbortController, console,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    performance: { getEntriesByType: () => [{ type: navType }] },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } }, sendMessage: async message => {
      if (message.type === 'wuf:get-settings') return { ok: true, data: settings };
      if (message.type === 'wuf:set-page-translated') states.push(message.translated);
      if (message.type === 'wuf:sticky-set') { stickyActive = true; return { ok: true, data: { success: true } }; }
      if (message.type === 'wuf:sticky-clear') { stickyActive = false; return { ok: true, data: { success: true } }; }
      if (message.type === 'wuf:sticky-query') return { ok: true, data: { shouldTranslate: sticky && stickyActive } };
      if (message.type === 'wuf:translate-text') {
        requests.push(Array.from(message.request.texts));
        if (delayed) return new Promise(resolve => { resolveTranslation = resolve; });
        return { ok: true, data: { translations: [message.request.texts[0] === 'First video' ? '第一部影片' : '第二部影片'] } };
      }
      return { ok: true, data: {} };
    } } },
  });
  return { title, requests, states, observers,
    isSticky: () => stickyActive,
    visibleTitle: () => title.style.getPropertyValue('display') === 'none' ? translation?.textContent : title.textContent,
    message: message => new Promise(resolve => listener(message, {}, resolve)),
    emit: name => events.get(name)?.(),
    move: () => { location.href = 'https://www.youtube.com/watch?v=second'; root = makeRoot(); title.textContent = 'Second video'; },
    release: () => resolveTranslation({ ok: true, data: { translations: ['第一部影片'] } }),
  };
}

test('YouTube navigation stops the completed translation observer and binds a new root on demand', async () => {
  const h = harness(); await tick();
  await h.message({ type: 'wuf:translate-page' });
  assert.equal(h.visibleTitle(), '第一部影片');
  assert.equal(h.title.textContent, 'First video');
  h.emit('yt-navigate-start'); h.move(); h.emit('yt-navigate-finish'); await tick();
  assert.equal(h.title.textContent, 'Second video');
  assert.equal(h.requests.length, 1, 'crossTabSticky off must not continue translating a new video');
  assert.ok(h.observers.every(observer => observer.disconnected));
  const state = await h.message({ type: 'wuf:get-state' });
  assert.equal(state.translated, false); assert.equal(state.translating, false);
  assert.equal(h.states.at(-1), false);
  await h.message({ type: 'wuf:translate-page' });
  assert.deepEqual(h.requests[1], ['Second video']);
  assert.equal(h.visibleTitle(), '第二部影片');
  assert.equal(h.title.textContent, 'Second video');
  h.emit('yt-navigate-start');
});

test('Finish-only navigation preserves a new title even when old translation attributes survive', async () => {
  const h = harness(); await tick();
  await h.message({ type: 'wuf:translate-page' });
  h.move(); h.emit('yt-navigate-finish'); await tick();
  assert.equal(h.title.textContent, 'Second video');
  assert.equal(h.title.hasAttribute('data-wuf-original'), false);
  assert.equal(h.title.hasAttribute('data-wuf-translated'), false);
  assert.equal(h.requests.length, 1);
});

test('Navigation ignores an in-flight result from the previous video', async () => {
  const h = harness({ delayed: true }); await tick();
  const old = h.message({ type: 'wuf:translate-page' }); await tick();
  h.emit('yt-navigate-start'); h.move(); h.emit('yt-navigate-finish'); await tick();
  h.release(); await old; await tick();
  assert.equal(h.title.textContent, 'Second video');
  assert.equal(h.requests.length, 1);
  const state = await h.message({ type: 'wuf:get-state' });
  assert.equal(state.translated, false); assert.equal(state.progress.totalUnits, 0);
});

test('An explicit auto-translate host still applies after navigation with independent page state', async () => {
  const h = harness({ auto: true }); await tick(); await tick();
  assert.equal(h.visibleTitle(), '第一部影片');
  h.emit('yt-navigate-start'); h.move(); h.emit('yt-navigate-finish'); await tick(); await tick();
  assert.equal(h.visibleTitle(), '第二部影片');
  assert.deepEqual(h.requests, [['First video'], ['Second video']]);
  h.emit('yt-navigate-start');
});

test('crossTabSticky continues translation across SPA navigation and new tabs until user restores original', async () => {
  // 1. New tab opened from a sticky parent tab auto-translates on load
  const newTab = harness({ sticky: true, initialSticky: true, navType: 'navigate' });
  await tick(); await tick(); await tick();
  assert.equal(newTab.visibleTitle(), '第一部影片');
  assert.equal(newTab.isSticky(), true);

  // 2. Navigating to a second video in the sticky tab cleans up the old title and auto-translates the new video
  newTab.emit('yt-navigate-start');
  newTab.move();
  newTab.emit('yt-navigate-finish');
  await tick(); await tick(); await tick();
  assert.equal(newTab.visibleTitle(), '第二部影片');
  assert.equal(newTab.title.textContent, 'Second video');
  assert.equal(newTab.isSticky(), true);
  assert.deepEqual(newTab.requests, [['First video'], ['Second video']]);

  // 3. Explicitly restoring original clears sticky state
  await newTab.message({ type: 'wuf:restore-page' });
  await tick();
  assert.equal(newTab.isSticky(), false);
  assert.equal(newTab.visibleTitle(), 'Second video');
});
