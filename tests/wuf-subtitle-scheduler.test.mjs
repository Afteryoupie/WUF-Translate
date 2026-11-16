import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNextSubtitleSentence } from '../dist/wuf/index.js';

function makeSentence(id, startSec, endSec, text = `Sentence ${id}`) {
  const startMs = startSec * 1000;
  const endMs = endSec * 1000;
  return {
    id,
    text,
    startMs,
    endMs,
    sourceSegs: [{ text, startMs, endMs }],
  };
}

test('now=25s skips expired 0s/5s sentences, selects 25s active sentence, then next upcoming sentence, and re-enables past sentences after seeking backward', () => {
  const s0 = makeSentence('s0', 0, 4);
  const s5 = makeSentence('s5', 5, 9);
  const s25 = makeSentence('s25', 25, 29);
  const s30 = makeSentence('s30', 30, 34);
  const sentences = [s0, s5, s25, s30];
  const doneIds = new Set();
  const isPending = (s) => !doneIds.has(s.id);

  // At 25s, s0 and s5 are expired; s25 is current
  const first = selectNextSubtitleSentence(sentences, 25000, 1, isPending);
  assert.equal(first?.id, 's25');

  // Once s25 is no longer pending, s30 is the earliest upcoming sentence in range
  doneIds.add('s25');
  const second = selectNextSubtitleSentence(sentences, 25000, 1, isPending);
  assert.equal(second?.id, 's30');

  // Once s30 is done, expired s0 and s5 must NOT be selected at 25s
  doneIds.add('s30');
  const third = selectNextSubtitleSentence(sentences, 25000, 1, isPending);
  assert.equal(third, undefined);

  // After seeking backward to 2s, s0 becomes current and s5 becomes upcoming
  const afterSeekBack1 = selectNextSubtitleSentence(sentences, 2000, 1, isPending);
  assert.equal(afterSeekBack1?.id, 's0');
  doneIds.add('s0');
  const afterSeekBack2 = selectNextSubtitleSentence(sentences, 2000, 1, isPending);
  assert.equal(afterSeekBack2?.id, 's5');
});

test('handles empty subtitle list, long silence gaps, and completed sentences returning undefined', () => {
  assert.equal(selectNextSubtitleSentence([], 10000, 1, () => true), undefined);

  const s1 = makeSentence('s1', 0, 5);
  const s2 = makeSentence('s2', 60, 65); // 55s silence gap (beyond 30s ahead buffer at 10s)
  assert.equal(selectNextSubtitleSentence([s1, s2], 10000, 1, () => true), undefined);

  // When s2 is within buffer at 35s (35s + 30s = 65s >= 60s), it is selected
  assert.equal(selectNextSubtitleSentence([s1, s2], 35000, 1, () => true)?.id, 's2');

  // If all in-range sentences are not pending, returns undefined
  assert.equal(selectNextSubtitleSentence([s1, s2], 35000, 1, () => false), undefined);
});

test('boundary conditions: endMs === nowMs is expired, startMs === horizonMs is included, startMs > horizonMs is excluded', () => {
  const endingNow = makeSentence('endingNow', 5, 10);
  const atHorizon = makeSentence('atHorizon', 40, 42);
  const beyondHorizon = makeSentence('beyondHorizon', 40.001, 42);

  // At nowMs = 10000, playbackRate = 1 -> horizon is 10000 + 30000 = 40000
  assert.equal(selectNextSubtitleSentence([endingNow], 10000, 1, () => true), undefined);
  assert.equal(selectNextSubtitleSentence([endingNow, atHorizon, beyondHorizon], 10000, 1, () => true)?.id, 'atHorizon');
  assert.equal(selectNextSubtitleSentence([beyondHorizon], 10000, 1, () => true), undefined);
});

test('overlapping active sentences pick latest startMs matching renderYouTubeDisplayCue, preserving list order on tie', () => {
  const early = makeSentence('early', 10, 16);
  const lateFirst = makeSentence('z-late-1', 13, 18);
  const lateSecond = makeSentence('a-late-2', 13, 19);

  // At 14s, all three cover nowMs; latest startMs is 13000, and 'z-late-1' appears first in list
  const picked1 = selectNextSubtitleSentence([early, lateFirst, lateSecond], 14000, 1, () => true);
  assert.equal(picked1?.id, 'z-late-1');

  // When 'z-late-1' is not pending, 'a-late-2' (also at 13000) is picked before 'early' (10000)
  const picked2 = selectNextSubtitleSentence(
    [early, lateFirst, lateSecond],
    14000,
    1,
    (s) => s.id !== 'z-late-1',
  );
  assert.equal(picked2?.id, 'a-late-2');

  // When both 13s sentences are done, 'early' (10s..16s) is still covering 14s and gets picked
  const picked3 = selectNextSubtitleSentence(
    [early, lateFirst, lateSecond],
    14000,
    1,
    (s) => s.id === 'early',
  );
  assert.equal(picked3?.id, 'early');
});

test('upcoming sentences pick earliest startMs and preserve list order on tie', () => {
  const u1 = makeSentence('z-first', 15, 18);
  const u2 = makeSentence('a-second', 15, 19);
  const u3 = makeSentence('later', 20, 22);

  const picked1 = selectNextSubtitleSentence([u3, u1, u2], 10000, 1, () => true);
  assert.equal(picked1?.id, 'z-first');

  const picked2 = selectNextSubtitleSentence([u3, u1, u2], 10000, 1, (s) => s.id !== 'z-first');
  assert.equal(picked2?.id, 'a-second');
});

test('playbackRate scales lookahead buffer with clamp(30000 * rate, 20000, 90000)', () => {
  const at20s = makeSentence('at20s', 20, 22);
  const at21s = makeSentence('at21s', 21, 23);
  const at30s = makeSentence('at30s', 30, 32);
  const at31s = makeSentence('at31s', 31, 33);
  const at60s = makeSentence('at60s', 60, 62);
  const at61s = makeSentence('at61s', 61, 63);
  const at90s = makeSentence('at90s', 90, 92);
  const at91s = makeSentence('at91s', 91, 93);

  // 0.5x rate -> clamp(15000, 20000, 90000) = 20000ms
  assert.equal(selectNextSubtitleSentence([at20s, at21s], 0, 0.5, () => true)?.id, 'at20s');
  assert.equal(selectNextSubtitleSentence([at21s], 0, 0.5, () => true), undefined);

  // 1.0x rate -> 30000ms
  assert.equal(selectNextSubtitleSentence([at30s, at31s], 0, 1.0, () => true)?.id, 'at30s');
  assert.equal(selectNextSubtitleSentence([at31s], 0, 1.0, () => true), undefined);

  // 2.0x rate -> 60000ms
  assert.equal(selectNextSubtitleSentence([at60s, at61s], 0, 2.0, () => true)?.id, 'at60s');
  assert.equal(selectNextSubtitleSentence([at61s], 0, 2.0, () => true), undefined);

  // 4.0x rate -> clamped at 90000ms
  assert.equal(selectNextSubtitleSentence([at90s, at91s], 0, 4.0, () => true)?.id, 'at90s');
  assert.equal(selectNextSubtitleSentence([at91s], 0, 4.0, () => true), undefined);
});
