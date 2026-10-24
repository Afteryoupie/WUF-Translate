import fs from 'node:fs';
import assert from 'node:assert/strict';
import { handleRuntimeMessage } from '../wuf-src/background/index.ts';
import { DEFAULT_SETTINGS } from '../wuf-src/lib/provider-profiles.ts';
import { globalCacheManager } from '../wuf-src/lib/cache-manager.ts';

const dir = new URL('../outputs/subtitle-context/', import.meta.url);
const samples = JSON.parse(fs.readFileSync(new URL('translation-heldout.json', dir), 'utf8'));
const settings = structuredClone(DEFAULT_SETTINGS);
settings.openccEnabled = false;
settings.providers.local.model = 'apple-intelligence-translation';
settings.providers.local.temperature = 0;
settings.subtitles.decisionMode = 'laya';
// Only browser storage is simulated. Both models use the real local HTTP service.
globalThis.chrome = { storage: { sync: { get: async () => ({ wufSettings: settings }) }, local: { get: async () => ({}) } } };
const report = { rows: [], requests: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  if (String(url).endsWith('/v1/systemone')) report.requests.push({ request: JSON.parse(init.body),
    status: response.status, data: await response.clone().json() });
  return response;
};
await globalCacheManager.clear();
for (const row of samples.rows) {
  const sample = samples.classifications.find(c => c.video === row.video).sample
    .replace(/\[(?:music|applause|laughter|silence)\]/gi, ' ').replace(/(?:^|\s)>>\s*/g, ' ').trim();
  const started = performance.now();
  const response = await handleRuntimeMessage({ type: 'wuf:translate-text', request: {
    engine: 'openai-compat-local', purpose: 'subtitle', texts: [row.source], sourceLanguage: 'en', targetLanguage: 'zh-TW',
    subtitleContext: { videoId: row.video, title: row.context.title, sample },
  } });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.data.contextDecision?.topic, 'topic must actually be adopted');
  assert.equal(response.data.decisionReport.modelDecisions, 0, 'per-line checks must remain local');
  report.rows.push({ sense: row.sense, source: row.source, response, ms: Math.round(performance.now()-started) });
  fs.writeFileSync(new URL('runtime-heldout-minimal.json', dir), JSON.stringify(report, null, 2));
  console.log(row.sense, response.data.contextDecision.topic, response.data.translations[0]);
}
assert.equal(report.requests.length, 6, 'three videos need only two topic passes each');
assert.ok(report.requests.every(r => r.status === 200 && r.request.questions.topic && !r.data.usage.truncated));
console.log('Verified 9 subtitle translations with 6 one-time topic requests, no per-line classifier requests.');
