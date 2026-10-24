import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LayaDecisionEngine } from '../wuf-src/subtitle/decision-engine.ts';
import { subtitleContextPrompt } from '../wuf-src/subtitle/translation-context.ts';
import { heuristicMergeAsr, parseCaptionResponse } from '../wuf-src/subtitle/youtube-pipeline.ts';
import { buildChatCompletionRequestBody } from '../wuf-src/providers/openai-compat.ts';
import { DEFAULT_LOCAL_PROFILE, DEFAULT_SUBTITLE_SYSTEM_PROMPT } from '../wuf-src/lib/provider-profiles.ts';

const dir = path.resolve(import.meta.dirname, '../outputs/subtitle-context');
fs.mkdirSync(dir, { recursive: true });
const split = process.argv[2] || 'development';
if (!['development', 'heldout'].includes(split)) throw Error('Unknown split');
const output = path.join(dir, `translation-${split}.json`);
const sources = JSON.parse(fs.readFileSync(path.resolve(dir, '../laya-youtube/runtime-final-confirmation.json'), 'utf8')).sources;
const ms = t => { const [h,m,s,f] = t.split(/[:,.]/).map(Number); return ((h*60+m)*60+s)*1000+f; };
function load(source) {
  const raw = fs.readFileSync(source.file, 'utf8');
  source.sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  if (source.format === 'json3') return parseCaptionResponse(raw);
  if (source.format === 'srt') return raw.trim().split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/), times = lines[1].split(' --> ');
    return { startMs: ms(times[0]), endMs: ms(times[1]), text: lines.slice(2).join(' ') };
  });
  const rows = [...raw.matchAll(/^\[(\d+):(\d+)\] (.+)$/gm)].map(m => ({ startMs: (+m[1]*60 + +m[2])*1000, text: m[3] }));
  return rows.map((s,i) => ({ ...s, endMs: rows[i+1]?.startMs ?? s.startMs+1500 }));
}
// Fixed, source-selected semantic probes; not a holistic translation score.
// Development and held-out selections are declared before inspecting translations.
const probes = {
  development: [
    ['IBJjyjGq3zI','pot', /Get a pot/i, /盆/],
    ['IBJjyjGq3zI','snake plant', /^Snake plant, aka/i, /虎[尾皮]蘭/],
    ['IBJjyjGq3zI','jade plant', /^Jade plant$/i, /玉樹|燕子掌|翡翠木|景天/],
    ['EmbBr3aeZh0','camera body', /by the body alone/i, /機身|相機本體/],
    ['EmbBr3aeZh0','lens mount', /held by the mount/i, /卡口|接環|接座|鏡頭座|安裝座/],
    ['EmbBr3aeZh0','strobe', /This is a wireless strobe/i, /閃光燈|閃燈/],
    ['IJlb2oRqpHM','safety harness', /finish doing our harness/i, /安全帶|多點式|束帶|固定帶/],
    ['IJlb2oRqpHM','racing track', /track, especially in a drift car/i, /賽道|跑道|賽車場|賽場/],
    ['IJlb2oRqpHM','donut maneuver', /even done a donut before/i, /甩尾|繞圈|定圓|畫圈|打轉|原地.*(?:圈|轉)/],
  ],
  heldout: [
    ['IBJjyjGq3zI','root ball', /^ball gets water/i, /根[球團]|土[球團]/],
    ['IBJjyjGq3zI','root rot', /you're going to get root rot/i, /爛根|根腐|根部腐爛|根.*腐爛/],
    ['IBJjyjGq3zI','potting mix', /it's potting mix or compost/i, /培養土|盆栽土|盆栽.*(?:介質|混合)|栽培.*(?:介質|混合)|培土|混合土/],
    ['EmbBr3aeZh0','exposure stop', /light closer and turn it up one stop/i, /一[級檔格階擋]|1[級檔格階擋]|曝光|亮度.*倍/],
    ['EmbBr3aeZh0','camera body in comparison', /this \[music\] body to an R1/i, /機身|相機本體/],
    ['EmbBr3aeZh0','shooting with strobes', /shoot with strobes back/i, /(?:拍攝|攝影|拍照).*閃|閃.*(?:拍攝|攝影|拍照)/],
    ['IJlb2oRqpHM','seat time', /I'm getting like no seat time/i, /駕駛|練[習車]|開車|上場|賽道/],
    ['IJlb2oRqpHM','donut to the left', /doing a donut to the left/i, /甩尾|繞圈|定圓|畫圈|打轉|原地.*(?:圈|轉)/],
    ['IJlb2oRqpHM','seat rails', /grab a couple of proper seat rails/i, /滑軌|座椅.*軌|椅.*導軌|座椅軌/],
  ],
};
const report = { date: new Date().toISOString(), split,
  method: 'Real YouTube timed captions, actual production 30-second-window merge groups, paired Apple translation, temperature 0. Sense patterns fixed before outputs; proxy scores, no independent human quality rating.',
  sources, classifications: [], rows: [], http: [] };
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const started = performance.now();
  const response = await fetchReal(url, init);
  if (String(url).endsWith('/v1/systemone')) report.http.push({ request: JSON.parse(init.body), status: response.status,
    ms: Math.round(performance.now()-started), response: await response.clone().json() });
  return response;
};
for (const source of sources) {
  const segments = load(source);
  const sample = segments.filter(s => s.startMs < 60000).map(s => s.text).join(' ').slice(0,1500);
  const engine = new LayaDecisionEngine({ mode: 'laya' });
  const started = performance.now();
  const classification = await engine.classifyTopic(source.title, sample);
  report.classifications.push({ video: source.id, sample, classification, ms: Math.round(performance.now()-started) });
  if (engine.lastError) throw Error(engine.lastError);
  const expectedTopic = source.id === 'IBJjyjGq3zI' ? 'gardening' : source.id === 'EmbBr3aeZh0' ? 'photography' : 'automotive';
  for (const [,sense,pattern,accept] of probes[split].filter(p => p[0] === source.id)) {
    const rawIndex = segments.findIndex(s => pattern.test(s.text));
    if (rawIndex < 0) throw Error(`Probe not found: ${sense}`);
    const raw = segments[rawIndex];
    const windowStart = Math.floor(raw.startMs/30000)*30000;
    const groups = heuristicMergeAsr(segments.filter(s => s.startMs >= windowStart && s.startMs < windowStart+30000), 'en');
    const group = groups.find(g => g.sourceSegs.some(s => s.startMs === raw.startMs));
    const startIndex = segments.findIndex(s => s.startMs === group.sourceSegs[0].startMs);
    const endIndex = startIndex + group.sourceSegs.length;
    const clean = s => s.replace(/\[(?:music|applause|laughter|silence)\]/gi,' ').replace(/^\s*>>\s*/,'').trim();
    const context = { title: source.title, previous: clean(segments.slice(Math.max(0,startIndex-2),startIndex).map(s=>s.text).join(' ')),
      next: clean(segments.slice(endIndex,endIndex+2).map(s=>s.text).join(' ')) };
    const row = { video: source.id, sense, startMs: group.startMs, source: clean(group.text), context, accept: accept.source, variants: [] };
    report.rows.push(row);
    // Rotate order by probe to reduce a systematic first-arm latency advantage.
    const variants = [ ['baseline', undefined], ['metadata', context],
      ['laya-topic', { ...context, topic: classification.topic ?? undefined }], ['reference-topic', { ...context, topic: expectedTopic }] ];
    const offset = report.rows.length % variants.length;
    for (const [variant,background] of [...variants.slice(offset),...variants.slice(0,offset)]) {
      const { body } = buildChatCompletionRequestBody({ provider: { ...DEFAULT_LOCAL_PROFILE, model: 'apple-intelligence-translation', temperature: 0,
        systemPrompt: subtitleContextPrompt(DEFAULT_SUBTITLE_SYSTEM_PROMPT, background, [row.source]) }, texts: [row.source], targetLanguage:'zh-TW', platform:'MacIntel' });
      const started = performance.now();
      const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', { method:'POST',headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),signal:AbortSignal.timeout(120000) });
      const json = await response.json();
      if (!response.ok || !json.choices?.[0]) throw Error(JSON.stringify(json));
      const translation = json.choices[0].message.content;
      row.variants.push({ variant, translation, matchesSense: accept.test(translation), ms: Math.round(performance.now()-started), request: body });
      fs.writeFileSync(output, JSON.stringify(report,null,2));
      console.log(JSON.stringify({sense,variant,translation,matchesSense:accept.test(translation)}));
    }
  }
}
console.log(`Saved ${output}`);
