import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  computeSubtitleLookaheadMs, createSubtitleWorker, DEFAULT_SETTINGS, executeTranslation,
  heuristicMergeAsr, runSubtitleDecisionPipeline,
} from '../dist/wuf/index.js';

// Opt-in live test: exported YouTube transcript -> real local provider -> worker.
// Never run from npm test: requires a running local model; no cloud fallback.
const [transcriptPath, startSec = '0', endSec = '180'] = process.argv.slice(2);
const startMs = Number(startSec) * 1000;
const endMs = Number(endSec) * 1000;
if (!transcriptPath || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || startMs >= endMs) {
  throw new Error('Usage: node scripts/test-subtitle-video.mjs transcript.txt [startSec] [endSec]');
}
const transcript = readFileSync(transcriptPath, 'utf8');
const segments = [...transcript.matchAll(/^\[(\d+):(\d+)\] (.+)$/gm)]
  .map(m => ({ startMs: (+m[1] * 60 + +m[2]) * 1000, text: m[3] }));
segments.forEach((s, i) => { s.endMs = segments[i + 1]?.startMs ?? s.startMs + 2000; });
const sentences = heuristicMergeAsr(segments, 'en')
  .filter(s => s.endMs > startMs && s.startMs < endMs)
  .map((s, i) => ({ ...s, id: String(i) }));
if (!sentences.length) throw new Error('No captions in requested range');
let nowMs = startMs;
let playbackRate = 1;
const rows = new Map();
const diagnostics = [];
const samples = [];
const durationMs = endMs - startMs;
const passes = [
  { from: startMs, to: startMs + durationMs * 0.55, rate: 1 },
  { from: startMs + durationMs * 0.6, to: endMs, rate: 2 },
  { from: startMs, to: startMs + Math.min(durationMs * 0.4, 15_000), rate: 1 },
];
const settings = structuredClone(DEFAULT_SETTINGS);
const secrets = { providerApiKeys: { local: '', online: '' } };
const record = (sentence, outcome) => rows.set(sentence.id, { startMs: sentence.startMs, ...outcome });
const worker = createSubtitleWorker({
  getPlayback: () => ({ nowMs, playbackRate }), now: () => performance.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: clearTimeout, capacity: () => 1,
  translate: async sentence => {
    try {
      const result = await runSubtitleDecisionPipeline({ texts: [sentence.text], sourceLanguage: 'en' }, settings, async p => {
        const response = await executeTranslation({ texts: p.texts, sourceLanguage: 'en', targetLanguage: 'zh-TW', purpose: 'subtitle', engine: 'openai-compat-local' }, settings, secrets, { subtitleRepair: p.decisionRepair });
        return { ok: true, result: response.translations };
      });
      return { ok: true, translation: result.result?.[0] ?? '', intentionalEmpty: result.intentionalEmpty?.includes(0) };
    } catch (error) {
      return { ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', status: error.status } };
    }
  },
  onResult: (s, r) => record(s, { translation: r.translation, intentionalEmpty: r.intentionalEmpty }),
  onError: (s, error) => {
    if (worker.getSentenceStatus(s.id) === 'failed') record(s, { fallbackSource: true, error });
  },
  onDiagnostic: event => diagnostics.push({ ...event, playbackMs: Math.round(nowMs), playbackRate }),
});
try {
  worker.replaceSession({ generation: 1, engine: 'openai-compat-local', sentences });
  for (const [index, { from, to, rate }] of passes.entries()) {
    playbackRate = rate;
    const startedAt = performance.now();
    while (true) {
      nowMs = from + (performance.now() - startedAt) * rate;
      if (nowMs >= to) break;
      worker.wake();
      const upcoming = sentences.filter(s => s.endMs > nowMs);
      const horizonMs = Math.min(endMs, nowMs + computeSubtitleLookaheadMs(rate));
      const firstPending = upcoming.find(s => s.startMs < horizonMs && !rows.has(s.id));
      const active = upcoming.findLast(s => s.startMs <= nowMs);
      const row = active && rows.get(active.id);
      const outcome = !active ? 'no-source' : row?.fallbackSource ? 'source-fallback' :
        row?.intentionalEmpty ? 'intentional-empty' : row?.translation ? 'translated' : 'blank';
      const readyThroughMs = firstPending?.startMs ?? horizonMs;
      samples.push({ pass: index + 1, nowMs: Math.round(nowMs), outcome, sentenceId: active?.id,
        readySeconds: Number((Math.max(0, readyThroughMs - nowMs) / 1000).toFixed(2)) });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
} finally {
  worker.dispose();
}
const attempts = diagnostics.filter(d => d.type === 'dispatch');
const summary = {
  video: transcript.match(/Video ID: (\S+)/)?.[1],
  translated: [...rows.values()].filter(r => r.translation).length,
  sourceFallback: [...rows.values()].filter(r => r.fallbackSource).length,
  attempts: attempts.length,
  repeatedRejections: diagnostics.filter(d => d.errorCode === 'CONTENT_REJECTED' &&
    attempts.filter(a => a.sentenceId === d.sentenceId).length > 1).length,
  blankSentences: new Set(samples.filter(s => s.outcome === 'blank').map(s => s.sentenceId)).size,
  passes: passes.map(({ from, to, rate }, index) => {
    const playbackSamples = samples.filter(s => s.pass === index + 1);
    return { from: from / 1000, to: to / 1000, rate,
      outcomes: Object.fromEntries(Object.entries(Object.groupBy(playbackSamples, s => s.outcome)).map(([outcome, entries]) => [outcome, entries.length])),
      maxReadySeconds: Math.max(...playbackSamples.map(s => s.readySeconds)),
    };
  }),
};
mkdirSync('outputs/subtitle-video-debug', { recursive: true });
writeFileSync('outputs/subtitle-video-debug/playback.json', JSON.stringify({ summary, rows: [...rows.values()], diagnostics, samples }, null, 2));
console.log(JSON.stringify(summary));
if (summary.repeatedRejections) process.exitCode = 1;
