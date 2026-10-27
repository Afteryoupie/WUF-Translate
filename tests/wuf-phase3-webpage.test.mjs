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
