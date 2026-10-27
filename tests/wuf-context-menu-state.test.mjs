import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRuntimeMessage } from '../dist/wuf/index.js';

test('Content-script completion updates the sender badge and immediately switches the active context menu', async () => {
  const originalChrome = globalThis.chrome;
  const badges = new Map();
  const updates = [];
  const sent = [];
  let activeTab = 101;
  globalThis.chrome = {
    tabs: { query: async () => [{ id: activeTab }] },
    action: {
      setBadgeText: async ({ tabId, text }) => { badges.set(tabId, text); sent.push(tabId); },
      setBadgeBackgroundColor: async () => {},
      getBadgeText: async ({ tabId }) => badges.get(tabId) || '',
    },
    contextMenus: { update: async (_id, props) => updates.push(props.title) },
  };
  try {
    assert.equal((await handleRuntimeMessage({ type: 'wuf:set-page-translated', translated: true }, { tab: { id: 101 } })).ok, true);
    assert.equal(badges.get(101), 'TR');
    assert.equal(updates.at(-1), '顯示原文');
    await handleRuntimeMessage({ type: 'wuf:set-page-translated', translated: false }, { tab: { id: 101 } });
    assert.equal(badges.get(101), '');
    assert.equal(updates.at(-1), '翻譯本頁');
    // Finishing a background tab must not change the active tab's action to restore.
    await handleRuntimeMessage({ type: 'wuf:set-page-translated', translated: true }, { tab: { id: 202 } });
    assert.equal(badges.get(202), 'TR');
    assert.equal(updates.at(-1), '翻譯本頁');
    // Retain explicit tab IDs for extension UI callers without a sender tab.
    await handleRuntimeMessage({ type: 'wuf:set-page-translated', translated: true, tabId: 101 });
    assert.equal(updates.at(-1), '顯示原文');
    assert.deepEqual(sent, [101, 101, 202, 101]);
  } finally { globalThis.chrome = originalChrome; }
});
