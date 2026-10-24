import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LayaDecisionEngine } from '../wuf-src/subtitle/decision-engine.ts';
import { heuristicMergeAsr, parseCaptionResponse } from '../wuf-src/subtitle/youtube-pipeline.ts';
import { runSubtitleDecisionPipeline, subtitleRepairPrompt } from '../wuf-src/subtitle/subtitle-decisions.ts';
import { buildChatCompletionRequestBody } from '../wuf-src/providers/openai-compat.ts';
import { DEFAULT_LOCAL_PROFILE, DEFAULT_SUBTITLE_SYSTEM_PROMPT } from '../wuf-src/lib/provider-profiles.ts';
import { DEFAULT_SETTINGS } from '../wuf-src/lib/provider-profiles.ts';
import { handleRuntimeMessage } from '../wuf-src/background/index.ts';
import { globalCacheManager } from '../wuf-src/lib/cache-manager.ts';

// Replays real timed captions through production functions and real HTTP models.
// No generated references or classifier probabilities are treated as quality scores.
const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'outputs/laya-youtube');
fs.mkdirSync(dir, { recursive: true });
const phase = process.argv[2] || 'before';
const split = process.argv[3] || 'development';
if (!['development', 'heldout', 'confirmation'].includes(split)) throw Error('Unknown split');
const sources = [
  { id: 'IBJjyjGq3zI', title: 'Plants for Boys', kind: 'manual',
    file: path.join(dir, 'IBJjyjGq3zI.manual.en.json3'), format: 'json3', provenance: 'Downloaded from YouTube 2026-10-25' },
  { id: 'EmbBr3aeZh0', title: '$2000 VS $10,000 Camera - Can you even tell the difference?', kind: 'asr',
    file: path.resolve(root, '../translation_tools/test-sub/[English (auto-generated)] $2000 VS $10,000 Camera - Can you even tell the difference [DownSub.com].srt'),
    format: 'srt', provenance: 'Existing user-provided DownSub export; live ASR download returned HTTP 429' },
];
if (split !== 'development') sources.push({ id: 'IJlb2oRqpHM', title: 'I went drifting as a total noob', kind: 'asr',
  file: path.join(dir, 'IJlb2oRqpHM.en.txt'), format: 'transcript', provenance: 'Exported from the live YouTube tab 2026-10-25; timestamps rounded to seconds' });
function readSegments(source) {
  const raw = fs.readFileSync(source.file, 'utf8');
  source.sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  if (source.format === 'json3') return parseCaptionResponse(raw);
  if (source.format === 'transcript') {
    const rows = [...raw.matchAll(/^\[(\d+):(\d+)\] (.+)$/gm)].map(m => ({ startMs: (+m[1]*60 + +m[2])*1000, text: m[3] }));
    return rows.map((s,i) => ({ ...s, endMs: rows[i+1]?.startMs ?? s.startMs+1500 }));
  }
  const ms = t => { const [h,m,s,f] = t.split(/[:,.]/).map(Number); return ((h*60+m)*60+s)*1000+f; };
  return raw.trim().split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    const times = lines[1].split(' --> ');
    return { startMs: ms(times[0]), endMs: ms(times[1]), text: lines.slice(2).join(' ') };
  });
}
const startWindows = split === 'development' ? [0, 30] : split === 'heldout' ? [120, 150] : [240, 270];
const report = { phase, split, date: new Date().toISOString(),
  method: 'Paired timed-caption replay; same Apple translation backend, temperature 0; baseline off, candidate on. No browser playback assertion.',
  status: await (await fetch('http://127.0.0.1:8080/api/status')).json(), sources, windows: [], requests: [] };
const output = path.join(dir, `${phase}-${split}.json`);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const started = performance.now();
  const response = await realFetch(url, options);
  if (String(url).endsWith('/v1/systemone')) {
    report.requests.push({ task: JSON.parse(options.body).state, status: response.status,
      ms: Math.round(performance.now() - started), response: await response.clone().json() });
  }
  return response;
};
async function translate(payload) {
  const result = [];
  for (const text of payload.texts) {
    const { body } = buildChatCompletionRequestBody({ provider: {
      ...DEFAULT_LOCAL_PROFILE, model: 'apple-intelligence-translation', temperature: 0,
      systemPrompt: subtitleRepairPrompt(DEFAULT_SUBTITLE_SYSTEM_PROMPT, payload),
    }, texts: [text], targetLanguage: 'zh-TW', platform: 'MacIntel' });
    const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    const json = await response.json();
    if (!response.ok || !json.choices?.[0]) throw Error(JSON.stringify(json));
    result.push(json.choices[0].message.content);
  }
  return { ok: true, result };
}
for (const source of sources) {
  const segments = readSegments(source);
  for (const start of startWindows) {
    const raw = segments.filter(s => s.startMs >= start*1000 && s.startMs < (start+30)*1000);
    if (!raw.length) throw Error('Empty sample');
    const window = { video: source.id, kind: source.kind, start, raw, variants: [] };
    report.windows.push(window);
    for (const mode of ['off', 'laya']) {
      const engine = new LayaDecisionEngine({ mode });
      const requestOffset = report.requests.length;
      const started = performance.now();
      // Manual captions do not require ASR sentence-boundary inference.
      const boundary = source.kind === 'asr' ? await engine.evaluateBoundaries(raw) : null;
      const hints = raw.map((s,i) => ({ ...s, jevBreakBefore: boundary?.breakBefore[i] }));
      const merged = heuristicMergeAsr(hints, 'en');
      let response;
      if (phase.startsWith('runtime')) {
        const settings = structuredClone(DEFAULT_SETTINGS);
        settings.openccEnabled = false;
        settings.providers.local.model = 'apple-intelligence-translation';
        settings.providers.local.temperature = 0;
        settings.subtitles.decisionMode = mode;
        globalThis.chrome = { storage: { sync: { get: async () => ({ wufSettings: settings }) }, local: { get: async () => ({}) } } };
        await globalCacheManager.clear();
        const outputs = [];
        const reports = [];
        for (const sentence of merged) {
          const r = await handleRuntimeMessage({ type: 'wuf:translate-text', request: {
            texts: [sentence.text], sourceLanguage: 'en', targetLanguage: 'zh-TW',
            engine: 'openai-compat-local', purpose: 'subtitle',
          } });
          if (!r.ok) throw Error(JSON.stringify(r));
          outputs.push(r.data.translations[0]);
          if (r.data.decisionReport) reports.push(r.data.decisionReport);
        }
        response = { ok: true, result: outputs, reports };
      } else {
        response = await runSubtitleDecisionPipeline({ texts: merged.map(s => s.text), sourceLanguage: 'en' },
          { subtitles: { decisionMode: mode, targetLanguage: 'zh-TW' } }, translate, { engine });
      }
      const variant = { mode, ms: Math.round(performance.now()-started), boundary, merged, ...response };
      const classifierRequests = report.requests.slice(requestOffset);
      variant.classifierRequests = classifierRequests.length;
      if (mode === 'laya' && (!classifierRequests.length || classifierRequests.some(r => r.status !== 200) ||
          (response.reports || [response.decisionReport]).some(r => r?.errors?.length))) {
        throw Error('Invalid Laya comparison: classifier unavailable or falling back after an error');
      }
      window.variants.push(variant);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ video: source.id, start, mode, groups: merged.length, ms: variant.ms,
        decisions: response.decisionReport, result: response.result }));
    }
  }
}
console.log(`Saved ${output}`);
