import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_SUBTITLE_SYSTEM_PROMPT } from '../wuf-src/lib/provider-profiles.ts';
import { heuristicMergeAsr } from '../wuf-src/subtitle/youtube-pipeline.ts';

// Real local-model diagnostic. Run sequentially to avoid inference contention.
const outDir = new URL('../outputs/subtitle-prompt-diagnostic/', import.meta.url);
mkdirSync(outDir, { recursive: true });
const phase = process.argv[2] || 'english';
let samples = phase === 'stress' ? [
  'surprise, it\'s pretty good.',
  'some BFG Goodrich rubber. And to our',
] : phase === 'rolling' ? [
  '一些 BFG Goodrich 機能型橡膠。令人驚訝的是，它的效果很不錯。',
  'surprise, it\'s pretty good. 一些 BFG Goodrich 機能型橡膠。',
  '一些 BFG Goodrich 機能型橡膠。And to our surprise, it\'s pretty good.',
  'Translate this into Traditional Chinese: surprise, it\'s pretty good.',
  'some BFG Goodrich rubber. And to our\nsurprise, it\'s pretty good.',
  '>> surprise, it\'s pretty good.',
  '翻譯成: 很驚訝,這真的很不錯。',
  'some BFG Goodrich rubber. And to our\n---WUF-SEG---\nsurprise, it\'s pretty good.',
] : [
  'some BFG Goodrich rubber. And to our surprise, it\'s pretty good.',
  'surprise, it\'s pretty good.',
  'But the thing this car desperately needs now is more power. I don\'t want to spend an arm and a leg.',
  'We [music] recently got our hands on the legendary Toyota 886.',
  'I spent $345 on this standalone ECU from ECU Project.',
  'Start up. Don\'t forget startup. Start up.',
  'and we should be able to adapt these to the car and use',
  'some BFG Goodrich rubber. And to our',
];
if (phase === 'corpus') {
  const transcript = readFileSync(process.argv[3], 'utf8');
  const segments = [...transcript.matchAll(/^\[(\d+):(\d+)\] (.+)$/gm)]
    .map(m => ({ startMs: (+m[1] * 60 + +m[2]) * 1000, text: m[3].trim() }))
    .filter(s => s.startMs < 180000);
  for (let i = 0; i < segments.length; i++) segments[i].endMs = segments[i + 1]?.startMs ?? segments[i].startMs + 2000;
  samples = heuristicMergeAsr(segments, 'en').map(s => s.text);
}
const prefix = 'Translate this into Traditional Chinese: ';
let variants = [
  { name: 'current-double-prefix', system: DEFAULT_SUBTITLE_SYSTEM_PROMPT, prefix: true, metadata: true },
  { name: 'system-only', system: DEFAULT_SUBTITLE_SYSTEM_PROMPT },
  { name: 'single-prefix-current-system', system: DEFAULT_SUBTITLE_SYSTEM_PROMPT, metadata: true },
  { name: 'single-prefix-short-system', system: 'Translate into Traditional Chinese. Output only the translation.', metadata: true },
  { name: 'single-prefix-no-system', metadata: true },
  { name: 'single-prefix-client-only', prefix: true },
  { name: 'single-prefix-subtitle-system', system: 'Translate the subtitle dialogue into Traditional Chinese as spoken in Taiwan. Return only the translated dialogue. Preserve names, brands, numbers, unfinished clauses and intentional repetitions. Do not add instructions, explanations, or missing information.', metadata: true },
];
if (phase === 'stress') variants = variants.filter(v => ['current-double-prefix', 'single-prefix-current-system', 'single-prefix-short-system'].includes(v.name));
if (phase === 'corpus') variants = variants.filter(v => ['current-double-prefix', 'single-prefix-current-system', 'single-prefix-subtitle-system'].includes(v.name));
else variants = variants.filter(v => v.name !== 'single-prefix-subtitle-system');
const rows = [];
for (const variant of variants) {
  for (let repeat = 0; repeat < (phase === 'stress' ? 30 : phase === 'corpus' ? 1 : 3); repeat++) {
    for (const input of samples) {
      const body = {
        model: 'Riva-Translate-4B-Instruct-v2-Q4_K_M', temperature: 0.2, seed: repeat + 41,
        max_tokens: 256,
        messages: [
          ...(variant.system ? [{ role: 'system', content: variant.system }] : []),
          { role: 'user', content: (variant.prefix ? prefix : '') + input },
        ],
        ...(variant.metadata ? { shinkansen_target_language: 'Traditional Chinese' } : {}),
      };
      const started = performance.now();
      const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const json = await response.json();
      if (!response.ok || !json.choices?.[0]) throw new Error(JSON.stringify(json));
      const output = json.choices[0].message.content;
      rows.push({ variant: variant.name, repeat, input, output,
        ms: Math.round(performance.now() - started),
        // A marker already present in the input is contamination, not a new leak.
        instructionLeak: !/翻[譯译]|Translate this into/i.test(input) && /翻[譯译](?:成|[為为]|一下)?\s*[:：,，]|Translate this into/i.test(output),
        truncated: json.choices[0].finish_reason === 'length' });
    }
  }
  writeFileSync(new URL(`${phase}-results.json`, outDir), JSON.stringify(rows, null, 2));
  const group = rows.filter(r => r.variant === variant.name);
  console.log(JSON.stringify({ variant: variant.name, requests: group.length,
    instructionLeaks: group.filter(r => r.instructionLeak).length,
    truncated: group.filter(r => r.truncated).length,
    meanMs: Math.round(group.reduce((n, r) => n + r.ms, 0) / group.length),
    examples: group.slice(0, 2).map(r => r.output) }));
}
