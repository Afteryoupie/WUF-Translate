import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTranslatableContent,
  mountRestoredNodes,
  applyTranslationToElement,
  restoreTranslatedDom,
} from '../dist/wuf/index.js';

class MockNode {
  constructor(nodeType, textContent = '') {
    this.nodeType = nodeType;
    this.textContent = textContent;
  }
  cloneNode(deep = false) {
    return new MockNode(this.nodeType, this.textContent);
  }
}

class MockElement extends MockNode {
  constructor(tagName, textContent = '') {
    super(1, textContent);
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attributes = new Map();
    this.style = {};
    this.className = '';
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    if (child.nodeType === 1) {
      this.children.push(child);
    }
    return child;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    const elemIdx = this.children.indexOf(child);
    if (elemIdx !== -1) {
      this.children.splice(elemIdx, 1);
    }
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) {
      child.parentNode = null;
    }
    this.childNodes = [];
    this.children = [];
    for (const node of nodes) {
      this.appendChild(node);
    }
  }

  querySelector(selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.childNodes.find(c => c.className === cls) || null;
    }
    if (selector === '[data-wuf-injected="true"]') {
      return this.childNodes.find(c => c.getAttribute?.('data-wuf-injected') === 'true') || null;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      if (node.nodeType === 1) {
        if (selector === '[data-wuf-injected="true"]' && node.getAttribute('data-wuf-injected') === 'true') {
          results.push(node);
        }
        if (selector === '[data-wuf-translated]' && node.hasAttribute('data-wuf-translated')) {
          results.push(node);
        }
      }
      if (node.childNodes) {
        for (const child of node.childNodes) walk(child);
      }
    };
    walk(this);
    return results;
  }

  remove() {
    if (this.parentNode && Array.isArray(this.parentNode.childNodes)) {
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx !== -1) this.parentNode.childNodes.splice(idx, 1);
    }
  }

  cloneNode(deep = false) {
    const clone = new MockElement(this.tagName, this.textContent);
    for (const [k, v] of this.attributes) clone.setAttribute(k, v);
    clone.className = this.className;
    if (deep) {
      for (const child of this.childNodes) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
}

class MockDocument {
  createElement(tag) {
    return new MockElement(tag);
  }
  createTextNode(text) {
    return new MockNode(3, text);
  }
}

test('Blockification: extracts text with inline tag placeholders and restores DOM structure', () => {
  const p = new MockElement('P');
  const t1 = new MockNode(3, 'Please read our ');
  const a = new MockElement('A', 'documentation');
  a.setAttribute('href', 'https://example.com');
  const t2 = new MockNode(3, ' and test ');
  const code = new MockElement('CODE', 'console.log()');
  const t3 = new MockNode(3, ' thoroughly.');

  p.appendChild(t1);
  p.appendChild(a);
  p.appendChild(t2);
  p.appendChild(code);
  p.appendChild(t3);

  const { text, tagsMap } = extractTranslatableContent(p);
  assert.ok(tagsMap, 'Must generate tagsMap for inline tags');
  assert.equal(tagsMap.size, 2);
  assert.match(text, /<<<WUF_TAG_0>>>/);
  assert.match(text, /<<<WUF_TAG_1>>>/);

  // Restore placeholders into a new container
  const doc = new MockDocument();
  const container = new MockElement('DIV');
  const translated = '請閱讀我們的 <<<WUF_TAG_0>>> 並測試 <<<WUF_TAG_1>>>。';
  mountRestoredNodes(container, translated, tagsMap, doc);

  assert.equal(container.childNodes.length, 5);
  const restoredLink = container.childNodes.find(c => c.tagName === 'A');
  assert.ok(restoredLink);
  assert.equal(restoredLink.getAttribute('href'), 'https://example.com');
  assert.equal(restoredLink.textContent, 'documentation');
});

test('Webpage Bilingual Mode: injects distinct block and restores original DOM cleanly', () => {
  const doc = new MockDocument();
  const p = new MockElement('P', 'Original paragraph text.');

  applyTranslationToElement(p, 'Original paragraph text.', '原始段落譯文。', 'bilingual', doc);

  assert.equal(p.getAttribute('data-wuf-translated'), 'bilingual');
  const injected = p.querySelector('.wuf-bilingual-translation');
  assert.ok(injected);
  assert.equal(injected.getAttribute('data-wuf-injected'), 'true');
  assert.equal(injected.textContent, '原始段落譯文。');

  // Verify restore
  const count = restoreTranslatedDom(p);
  assert.ok(count > 0);
  assert.equal(p.hasAttribute('data-wuf-translated'), false);
  assert.equal(p.querySelector('.wuf-bilingual-translation'), null);
});

test('Webpage Monolingual Mode: replaces in-place, records original text and restores cleanly', () => {
  const doc = new MockDocument();
  const p = new MockElement('P', 'English source.');

  applyTranslationToElement(p, 'English source.', '中文譯文。', 'monolingual', doc);

  assert.equal(p.getAttribute('data-wuf-translated'), 'monolingual');
  assert.equal(p.getAttribute('data-wuf-original'), 'English source.');

  // Verify restore
  const count = restoreTranslatedDom(p);
  assert.ok(count > 0);
  assert.equal(p.hasAttribute('data-wuf-translated'), false);
  assert.equal(p.hasAttribute('data-wuf-original'), false);
  assert.equal(p.textContent, 'English source.');
});

test('Inline comment text remains visible to the translator and restores a translated link', () => {
  const p = new MockElement('P');
  const span = new MockElement('SPAN', 'This is a great video');
  p.appendChild(span);
  const { text, tagsMap } = extractTranslatableContent(p);
  assert.equal(text, '<<<WUF_TAG_0>>>This is a great video<<<WUF_END_0>>>');
  const container = new MockElement('DIV');
  mountRestoredNodes(container, '<<<WUF_TAG_0>>>這部影片很棒<<<WUF_END_0>>>', tagsMap, new MockDocument());
  assert.equal(container.children[0].tagName, 'SPAN');
  assert.equal(container.children[0].textContent, '這部影片很棒');
});

test('YouTube legacy and current comment bodies are collected and receive translations', async () => {
  const { collectTranslatableUnits, WufDomTranslator } = await import('../dist/wuf/index.js');
  for (const renderer of ['ytd-comment-renderer', 'ytd-comment-view-model']) {
    const comment = new MockElement('YT-ATTRIBUTED-STRING', 'Great video, thank you!');
    const root = {
      querySelectorAll(selector) {
        return selector.includes(`${renderer} #content-text`) ? [comment] : [];
      },
    };
    assert.equal(collectTranslatableUnits(root).length, 1);
    const progress = [];
    const translator = new WufDomTranslator({
      root, doc: new MockDocument(),
      getConfig: async () => ({ engine: 'google', targetLanguage: 'zh-TW', displayMode: 'bilingual',
        batchConfig: { webConcurrency: 1, webBatchUnits: 10, webBatchChars: 1000, firstBatchUnits: 10, firstBatchChars: 1000 } }),
      translateBatch: async texts => { assert.deepEqual(texts, ['Great video, thank you!']); return ['影片很棒，謝謝！']; },
      onProgress: (...args) => progress.push(args),
    });
    await translator.handleTranslatePreset();
    assert.equal(comment.querySelector('.wuf-bilingual-translation').textContent, '影片很棒，謝謝！');
    assert.deepEqual(progress.at(-1), [1, 1, false]);
    translator.restorePage();
  }
});

test('Empty translation results cannot report completion', async () => {
  const { WufDomTranslator } = await import('../dist/wuf/index.js');
  const p = new MockElement('P', 'English comment');
  const translator = new WufDomTranslator({
    root: { querySelectorAll: () => [p] }, doc: new MockDocument(),
    getConfig: async () => ({ engine: 'google', targetLanguage: 'zh-TW', displayMode: 'bilingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 10, webBatchChars: 1000, firstBatchUnits: 10, firstBatchChars: 1000 } }),
    translateBatch: async () => [''],
  });
  await assert.rejects(translator.handleTranslatePreset(), /空白或不完整/);
  assert.equal(translator.translated, false);
  assert.equal(translator.completedUnits, 0);
});

test('A failed paragraph does not prevent later paragraphs from translating', async () => {
  const { WufDomTranslator } = await import('../dist/wuf/index.js');
  const nodes = ['First', 'Failed', 'Conclusion'].map(text => new MockElement('P', text));
  const translator = new WufDomTranslator({
    root: { querySelectorAll: () => nodes }, doc: new MockDocument(),
    getConfig: async () => ({ engine: 'google-translate', targetLanguage: 'zh-TW', displayMode: 'bilingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 1, webBatchChars: 1000, firstBatchUnits: 1, firstBatchChars: 1000 } }),
    translateBatch: async ([text]) => {
      if (text === 'Failed') throw new Error('request failed');
      return ['中文正文'];
    },
  });
  await assert.rejects(translator.handleTranslatePreset(), /request failed/);
  assert.equal(nodes[2].querySelector('.wuf-bilingual-translation').textContent, '中文正文');
  assert.equal(nodes[1].hasAttribute('data-wuf-translated'), false);
  assert.equal(translator.completedUnits, 2);
  assert.equal(translator.totalUnits, 3);
  assert.equal(translator.translating, false);
});

test('ScienceDirect abstract and body div paragraphs enter the translation queue', async () => {
  const { collectTranslatableUnits } = await import('../dist/wuf/index.js');
  const abstract = new MockElement('DIV', 'Abstract prose');
  const paragraph = new MockElement('DIV', 'Introduction prose');
  const root = { querySelectorAll(selector) {
    const nodes = [];
    if (selector.includes('div.u-margin-s-bottom[id^="abspara"]')) nodes.push(abstract);
    if (selector.includes('div.u-margin-s-bottom[id^="p"]')) nodes.push(paragraph);
    return nodes;
  } };
  assert.deepEqual(collectTranslatableUnits(root).map(unit => unit.sourceText),
    ['Abstract prose', 'Introduction prose']);
});

test('Idle incremental checks leave completion progress alone; new comments resume progress', async () => {
  const { WufDomTranslator } = await import('../dist/wuf/index.js');
  const nodes = [new MockElement('P', 'First comment')];
  const progress = [];
  const requests = [];
  const translator = new WufDomTranslator({
    root: { querySelectorAll: () => nodes }, doc: new MockDocument(),
    getConfig: async () => ({ engine: 'google', targetLanguage: 'zh-TW', displayMode: 'bilingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 10, webBatchChars: 1000, firstBatchUnits: 10, firstBatchChars: 1000 } }),
    translateBatch: async texts => { requests.push(texts); return texts.map(() => '翻譯留言'); },
    onProgress: (...args) => progress.push(args),
  });
  await translator.handleTranslatePreset();
  assert.deepEqual(progress.at(-1), [1, 1, false]);
  const completedProgress = progress.slice();
  for (let i = 0; i < 5; i++) {
    await translator.handleTranslatePreset({ incremental: true, translateOnly: true, force: true });
  }
  assert.deepEqual(progress, completedProgress, 'idle checks must not reset or resurrect the completion toast');
  assert.equal(translator.translating, false);
  assert.equal(requests.length, 1);

  nodes.push(new MockElement('P', 'Second comment'));
  await translator.handleTranslatePreset({ incremental: true, translateOnly: true, force: true });
  assert.deepEqual(progress[completedProgress.length], [1, 2, true]);
  assert.deepEqual(progress.at(-1), [2, 2, false]);
  assert.deepEqual(requests, [['First comment'], ['Second comment']]);
  translator.restorePage();
});

test('YouTube comment wrappers are sent as plain prose without formatting markers', () => {
  const comment = new MockElement('YT-ATTRIBUTED-STRING', 'A thoughtful comment.');
  comment.id = 'content-text';
  comment.appendChild(new MockElement('SPAN', 'A thoughtful comment.'));
  assert.deepEqual(extractTranslatableContent(comment), { text: 'A thoughtful comment.' });
});

test('Incremental translation shares one cancellable queue and reports actual progress', async () => {
  const { WufDomTranslator } = await import('../dist/wuf/index.js');
  const nodes = [new MockElement('P', 'First comment')];
  let release;
  let pendingSignal;
  const progress = [];
  const tr = new WufDomTranslator({
    root: { querySelectorAll: () => nodes }, doc: new MockDocument(),
    getConfig: async () => ({ engine: 'openai-compat-local', targetLanguage: 'zh-TW', displayMode: 'bilingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 1, webBatchChars: 1000, firstBatchUnits: 1, firstBatchChars: 1000 } }),
    translateBatch: async (texts, signal) => {
      if (texts[0] === 'First comment') return ['第一則留言'];
      pendingSignal = signal;
      return new Promise(resolve => { release = resolve; });
    },
    onProgress: (...args) => progress.push(args),
  });
  await tr.handleTranslatePreset();
  const second = new MockElement('P', 'Second comment');
  nodes.push(second);
  const pending = tr.handleTranslatePreset({ incremental: true, translateOnly: true, force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tr.translating, true);
  assert.equal(tr.totalUnits, 2);
  tr.restorePage();
  assert.equal(pendingSignal.aborted, true);
  release(['第二則留言']);
  await pending;
  assert.equal(second.querySelector('.wuf-bilingual-translation'), null);
  assert.deepEqual(progress.at(-1), [0, 0, false]);
});

test('Hidden responsive copies and chapter menus are excluded from translation', async () => {
  const { collectTranslatableUnits } = await import('../dist/wuf/index.js');
  const visible = new MockElement('P', 'Visible comment');
  visible.getClientRects = () => [{}];
  const hidden = new MockElement('P', 'Hidden duplicate');
  hidden.getClientRects = () => [];
  const units = collectTranslatableUnits({ querySelectorAll: () => [visible, hidden] });
  assert.deepEqual(units.map(unit => unit.sourceText), ['Visible comment']);
});

test('Restoring a reused title never overwrites new site content with the previous original', () => {
  const doc = new MockDocument();
  const title = new MockElement('H1', 'First video');
  applyTranslationToElement(title, 'First video', '第一部影片', 'monolingual', doc);
  // Simulate the site reusing the title element before navigation cleanup runs.
  title.textContent = 'Second video';
  // The simple mock stores innerHTML separately; clear it to model the site replacement.
  delete title.innerHTML;
  restoreTranslatedDom(title);
  assert.equal(title.textContent, 'Second video');
  assert.equal(title.hasAttribute('data-wuf-original'), false);
});

test('A late response cannot replace a title that the site reused during inference', async () => {
  const { WufDomTranslator } = await import('../dist/wuf/index.js');
  const title = new MockElement('H1', 'First video');
  let release;
  const translator = new WufDomTranslator({
    root: { querySelectorAll: () => [title] }, doc: new MockDocument(),
    getConfig: async () => ({ engine: 'openai-compat-local', targetLanguage: 'zh-TW', displayMode: 'monolingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 1, webBatchChars: 1000, firstBatchUnits: 1, firstBatchChars: 1000 } }),
    translateBatch: async () => new Promise(resolve => { release = resolve; }),
  });
  const running = translator.handleTranslatePreset();
  await new Promise(resolve => setImmediate(resolve));
  title.textContent = 'Second video';
  release(['第一部影片']);
  await running;
  assert.equal(title.textContent, 'Second video');
  assert.equal(translator.translated, false);
  assert.equal(translator.completedUnits, 0);
  assert.equal(translator.totalUnits, 0, 'replaced content must leave no phantom pending unit');
});

test('YouTube title translation preserves the live custom element in both display modes', () => {
  for (const mode of ['monolingual', 'bilingual']) {
    const parent = new MockElement('DIV');
    const title = new MockElement('H1', 'First video');
    const component = new MockElement('YT-FORMATTED-STRING', 'First video');
    title.appendChild(component); parent.appendChild(title);
    const values = new Map([['display', { value: 'flex', priority: '' }]]);
    title.style = {
      getPropertyValue: key => values.get(key)?.value || '',
      getPropertyPriority: key => values.get(key)?.priority || '',
      setProperty: (key, value, priority = '') => values.set(key, { value, priority }),
      removeProperty: key => values.delete(key),
    };
    title.matches = selector => selector.includes('ytd-watch-metadata h1');
    title.insertAdjacentElement = (_position, element) => parent.appendChild(element);
    title.querySelector = selector => selector === 'yt-formatted-string' ? component : null;
    const doc = new MockDocument();
    doc.defaultView = { getComputedStyle: target => {
      assert.equal(target, component);
      return { font: '', fontSize: '20px', fontWeight: '700', lineHeight: '28px', color: 'rgb(241, 241, 241)', fontFamily: 'Roboto, Arial, sans-serif' };
    } };
    applyTranslationToElement(title, 'First video', '第一部影片', mode, doc);
    const rendered = parent.querySelector('[data-wuf-injected="true"]');
    assert.equal(rendered.style.fontSize, '20px');
    assert.equal(rendered.style.fontWeight, '700');
    assert.equal(rendered.style.lineHeight, '28px');
    assert.equal(rendered.style.color, 'rgb(241, 241, 241)');
    assert.equal(title.childNodes[0], component, 'framework component identity must be unchanged');
    assert.equal(component.textContent, 'First video');
    assert.equal(title.hasAttribute('data-wuf-original'), false);
    assert.equal(parent.querySelector('[data-wuf-injected="true"]').textContent, '第一部影片');
    assert.equal(title.style.getPropertyValue('display'), mode === 'monolingual' ? 'none' : 'flex');
    // A framework update targets the exact original component, even while hidden.
    component.textContent = 'Second video'; title.textContent = 'Second video';
    restoreTranslatedDom(parent);
    assert.equal(title.childNodes[0], component);
    assert.equal(component.textContent, 'Second video');
    assert.equal(title.textContent, 'Second video');
    assert.equal(title.style.getPropertyValue('display'), 'flex');
    assert.equal(parent.querySelector('[data-wuf-injected="true"]'), null);
  }
});

test('Multi-unit translation activates sticky state on first batch and stays translated if a later node mutates', async () => {
  const { WufDomTranslator, handleRuntimeMessage } = await import('../dist/wuf/index.js');
  const first = new MockElement('P', 'First paragraph');
  const second = new MockElement('P', 'Second paragraph');
  const states = [];
  let releaseSecond;
  const translator = new WufDomTranslator({
    root: { querySelectorAll: () => [first, second] },
    doc: new MockDocument(),
    onStateChange: state => states.push(state),
    getConfig: async () => ({
      engine: 'openai-compat-local',
      targetLanguage: 'zh-TW',
      displayMode: 'monolingual',
      batchConfig: { webConcurrency: 1, webBatchUnits: 1, webBatchChars: 1000, firstBatchUnits: 1, firstBatchChars: 1000 },
    }),
    translateBatch: async texts => {
      if (texts[0] === 'First paragraph') return ['第一段'];
      return new Promise(resolve => { releaseSecond = resolve; });
    },
  });

  const running = translator.handleTranslatePreset();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(translator.translated, true);
  assert.deepEqual(states, [true], 'state must become true as soon as the first batch applies');

  // Mutate the second paragraph while its request is in flight
  second.textContent = 'Updated second paragraph';
  releaseSecond(['第二段']);
  await running;

  assert.equal(translator.translated, true, 'page stays translated when at least one unit succeeded');
  assert.equal(states.at(-1), true);

  // Verify background sticky-query inherits sticky state from openerTabId
  const syncStore = {};
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      sync: {
        get: async key => (typeof key === 'string' ? { [key]: syncStore[key] } : syncStore),
        set: async items => Object.assign(syncStore, items),
      },
    },
  };
  try {
    await handleRuntimeMessage({
      type: 'wuf:save-settings',
      settings: { webpage: { engine: 'openai-compat-local', targetLanguage: 'zh-TW', displayMode: 'bilingual', customModelOverride: '', autoTranslateHosts: [], crossTabSticky: true } },
    });
    await handleRuntimeMessage({ type: 'wuf:sticky-set', tabId: 101 });
    const stickyResp = await handleRuntimeMessage(
      { type: 'wuf:sticky-query' },
      { tab: { id: 202, openerTabId: 101 } },
    );
    assert.equal(stickyResp.ok, true);
    assert.equal(stickyResp.data.shouldTranslate, true);
  } finally {
    globalThis.chrome = prevChrome;
  }
});

test('Webpage Monolingual Mode preserves nested inline formatting inside links and restores original child elements', () => {
  const doc = new MockDocument();
  const root = new MockElement('DIV');
  const p = new MockElement('P');
  const leadText = new MockNode(3, 'Check ');
  const a = new MockElement('A', 'Read guide');
  a.setAttribute('href', '/guide');
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener');
  const strong = new MockElement('STRONG', 'Read guide');
  a.appendChild(strong);
  const trailText = new MockNode(3, ' carefully.');
  p.appendChild(leadText);
  p.appendChild(a);
  p.appendChild(trailText);
  root.appendChild(p);

  const { text, tagsMap } = extractTranslatableContent(p);
  assert.ok(tagsMap);
  assert.match(text, /<<<WUF_TAG_0>>>Read guide<<<WUF_END_0>>>/);

  applyTranslationToElement(p, text, '請仔細查看 <<<WUF_TAG_0>>>閱讀指南<<<WUF_END_0>>>。', 'monolingual', doc, tagsMap);
  const restoredA = p.childNodes.find(n => n.tagName === 'A');
  assert.ok(restoredA, 'Link element must be preserved in monolingual mode');
  assert.equal(restoredA.getAttribute('href'), '/guide');
  assert.equal(restoredA.getAttribute('target'), '_blank');
  assert.equal(restoredA.getAttribute('rel'), 'noopener');
  const restoredStrong = restoredA.childNodes.find(n => n.tagName === 'STRONG');
  assert.ok(restoredStrong, 'Inner <strong> wrapper must remain inside translated link');
  assert.equal(restoredStrong.textContent, '閱讀指南');

  restoreTranslatedDom(root);
  const origA = p.childNodes.find(n => n.tagName === 'A');
  assert.ok(origA, 'Original <a> element must be restored on restoreTranslatedDom');
  assert.equal(origA.getAttribute('href'), '/guide');
  const origStrong = origA.childNodes.find(n => n.tagName === 'STRONG');
  assert.ok(origStrong, 'Original inner <strong> must be restored cleanly');
  assert.equal(origStrong.textContent, 'Read guide');
});
