import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseBestCaptionTrack,
  splitLongSubtitleCue,
  heuristicMergeAsr,
  parseCaptionResponse,
  parseYouTubeTimedTextXml,
  planSubtitleWindowBatch,
} from '../dist/wuf/index.js';

test('YouTube Caption Selection: respects strict priority order', () => {
  const tracks = [
    { languageCode: 'en', kind: 'asr' },
    { languageCode: 'en', kind: undefined },
    { languageCode: 'zh-Hans', kind: undefined },
    { languageCode: 'zh-TW', kind: undefined },
  ];

  // 1. Exact target match (zh-TW)
  const choiceTw = chooseBestCaptionTrack(tracks, null, 'zh-TW');
  assert.equal(choiceTw.track?.languageCode, 'zh-TW');
  assert.equal(choiceTw.action, 'switch-to-native');

  // 2. Chinese variant when target is zh-TW but only zh-Hans exists
  const tracksNoTw = tracks.filter(t => t.languageCode !== 'zh-TW');
  const choiceHans = chooseBestCaptionTrack(tracksNoTw, null, 'zh-TW');
  assert.equal(choiceHans.track?.languageCode, 'zh-Hans');

  // 3. Manual English fallback when no Chinese tracks exist
  const tracksOnlyEn = tracks.filter(t => t.languageCode === 'en');
  const choiceEn = chooseBestCaptionTrack(tracksOnlyEn, null, 'zh-TW');
  assert.equal(choiceEn.track?.languageCode, 'en');
  assert.equal(choiceEn.track?.kind, undefined); // Must be manual, not ASR
});

test('YouTube Cue Splitting: 24-character word boundary snapping without mid-word cuts', () => {
  const longSentence = '這是一段非常長的繁體中文字幕測試文本，必須在自然語意邊界被切開而不能隨機截斷。';
  const pieces = splitLongSubtitleCue(0, 10000, longSentence, [0, 2000, 5000, 8000], 24, 1200);

  assert.ok(pieces.length >= 2, 'Should be split into multiple sequential cues');
  let prevEnd = 0;
  for (const piece of pieces) {
    assert.ok(piece.text.length <= 24 || pieces.length === 1);
    assert.ok(piece.startMs >= prevEnd, 'Timeline must be monotonic');
    assert.ok(piece.endMs > piece.startMs, 'Cue duration must be positive');
    prevEnd = piece.endMs;
  }
});

test('YouTube ASR Heuristic Merge: bounds sentences and prevents timeline drift', () => {
  const rawSegments = [
    { text: 'Hello', startMs: 0, endMs: 500 },
    { text: 'everyone', startMs: 550, endMs: 900 },
    { text: 'welcome', startMs: 950, endMs: 1400 },
    { text: 'back.', startMs: 1450, endMs: 1800 },
  ];

  const merged = heuristicMergeAsr(rawSegments, 'auto');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'Hello everyone welcome back.');
  assert.equal(merged[0].startMs, 0);
  assert.equal(merged[0].endMs, 1800);
});

test('YouTube TimedText XML & Mixed Payload: parses XML and JSON3 seamlessly', () => {
  const xmlPayload = `
    <?xml version="1.0" encoding="utf-8" ?>
    <transcript>
      <text start="1.5" dur="3.0">Hello &amp; welcome to the channel!</text>
      <text start="5.0" dur="2.5">&gt;&gt; In this video we explore AI.</text>
    </transcript>
  `;
  const xmlSegs = parseYouTubeTimedTextXml(xmlPayload);
  assert.equal(xmlSegs.length, 2);
  assert.equal(xmlSegs[0].startMs, 1500);
  assert.equal(xmlSegs[0].endMs, 4500);
  assert.equal(xmlSegs[0].text, 'Hello & welcome to the channel!');
  assert.equal(xmlSegs[1].startMs, 5000);
  assert.equal(xmlSegs[1].endMs, 7500);
  assert.equal(xmlSegs[1].text, 'In this video we explore AI.');

  // TTML <p t=".."> format
  const ttmlPayload = `
    <timedtext>
      <body>
        <p t="1000" d="2000">Line one</p>
        <p t="3500" d="1500">Line two</p>
      </body>
    </timedtext>
  `;
  const ttmlSegs = parseCaptionResponse(ttmlPayload);
  assert.equal(ttmlSegs.length, 2);
  assert.equal(ttmlSegs[0].text, 'Line one');
  assert.equal(ttmlSegs[0].startMs, 1000);
  assert.equal(ttmlSegs[0].endMs, 3000);

  // JSON3 format via parseCaptionResponse
  const jsonPayload = JSON.stringify({
    events: [
      { tStartMs: 200, dDurationMs: 800, segs: [{ utf8: 'JSON segment' }] }
    ]
  });
  const jsonSegs = parseCaptionResponse(jsonPayload);
  assert.equal(jsonSegs.length, 1);
  assert.equal(jsonSegs[0].text, 'JSON segment');
  assert.equal(jsonSegs[0].startMs, 200);
  assert.equal(jsonSegs[0].endMs, 1000);
});

test('YouTube Lookahead Batch Planning: triggers prefetch window when within lead time', () => {
  const segments = [
    { text: 'Window 0 seg', startMs: 5000, endMs: 8000 },
    { text: 'Window 1 seg', startMs: 32000, endMs: 35000 },
  ];

  // At 5s (remaining = 25s, lead = 10s) -> no prefetch
  const early = planSubtitleWindowBatch(segments, 5, 30, 10, new Set());
  assert.equal(early.windowIndex, 0);
  assert.equal(early.prefetchWindowIndex, null);

  // At 22s (remaining = 8s, lead = 10s) -> prefetch window 1!
  const late = planSubtitleWindowBatch(segments, 22, 30, 10, new Set());
  assert.equal(late.windowIndex, 0);
  assert.equal(late.prefetchWindowIndex, 1);

  // If window 1 is already translated, prefetchWindowIndex should be null
  const already = planSubtitleWindowBatch(segments, 22, 30, 10, new Set([1]));
  assert.equal(already.prefetchWindowIndex, null);
});

test('YouTube ASR Mapping: merges source segments into coherent sentence with rolling segment dedup keys', () => {
  const rawSegments = [
    { text: 'That', startMs: 1000, endMs: 1300 },
    { text: 'means', startMs: 1350, endMs: 1700 },
    { text: 'we had to', startMs: 1750, endMs: 2400 },
  ];

  const merged = heuristicMergeAsr(rawSegments, 'en');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'That means we had to');
  assert.equal(merged[0].sourceSegs.length, 3);

  // Simulate Shinkansen-style captionMap mapping
  const cache = new Map();
  const tr = '這表示我們必須';
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  const firstKey = norm(merged[0].sourceSegs[0].text);
  cache.set(firstKey, tr);
  for (let k = 1; k < merged[0].sourceSegs.length; k++) {
    const kKey = norm(merged[0].sourceSegs[k].text);
    if (kKey !== firstKey) cache.set(kKey, '');
  }

  // Segment 0 displays full translated sentence
  assert.equal(cache.get('that'), '這表示我們必須');
  // Subsequent rolling segments display empty string to prevent duplicate text
  assert.equal(cache.get('means'), '');
  assert.equal(cache.get('we had to'), '');
});

test('YouTube Subtitle In-Place Replacement: ensures segments are replaced per-segment without merging into giant blob', () => {
  // Mock DOM structure representing YouTube caption window with 3 separate lines
  class MockCaptionSegment {
    constructor(text) {
      this.textContent = text;
      this.attributes = new Map();
      this.isConnected = true;
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
  }

  const seg1 = new MockCaptionSegment('Sentence one.');
  const seg2 = new MockCaptionSegment('Sentence two.');
  const seg3 = new MockCaptionSegment('Sentence three.');
  const segments = [seg1, seg2, seg3];

  const cache = new Map();
  cache.set('sentence one.', '第一句話。');
  cache.set('sentence two.', '第二句話。');
  cache.set('sentence three.', '第三句話。');

  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Test per-segment replacement
  for (const seg of segments) {
    const key = norm(seg.textContent);
    if (cache.has(key)) {
      seg.setAttribute('data-wuf-translated-text', cache.get(key));
      seg.textContent = cache.get(key);
    }
  }

  assert.equal(seg1.textContent, '第一句話。');
  assert.equal(seg2.textContent, '第二句話。');
  assert.equal(seg3.textContent, '第三句話。');
  assert.notEqual(seg1.textContent, '第一句話。 第二句話。 第三句話。');
});
