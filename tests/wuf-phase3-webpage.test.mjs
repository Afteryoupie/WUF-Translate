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
