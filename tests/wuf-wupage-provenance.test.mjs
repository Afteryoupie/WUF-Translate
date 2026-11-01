import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('WuPage source modules retain upstream hashes outside documented integration changes', () => {
  const root = new URL('../wuf-src/vendor/wupage/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('UPSTREAM.json', root), 'utf8'));
  const adapted = new Set(['content/dom.ts', 'content/page-translation.ts', 'content/translation-context.ts', 'content/styles.ts', 'background/frame-sessions.ts', 'core/shared/defaults.ts']);
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    assert.ok(existsSync(new URL(file, root)), `Missing imported module: ${file}`);
    if (adapted.has(file)) continue;
    const actual = createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex');
    assert.equal(actual, expected, `${file} must stay identical to WuPage 1.5.5`);
  }
  assert.ok(existsSync(new URL('../dist/wuf/WUPAGE-NOTICE.md', import.meta.url)));
  assert.ok(existsSync(new URL('../dist/wuf/WUPAGE-UPSTREAM.json', import.meta.url)));
});
