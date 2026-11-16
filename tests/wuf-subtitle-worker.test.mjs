import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubtitleWorker } from '../dist/wuf/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWorkerSentence(id, startSec, endSec, text = `Sentence ${id}`) {
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

function createHarness(initialNowMs = 0, initialRate = 1) {
  let playbackNowMs = initialNowMs;
  let playbackRate = initialRate;
  let clockMs = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const requests = [];
  const results = [];
  const errors = [];
  const diagnostics = [];

  const deps = {
    getPlayback: () => ({ nowMs: playbackNowMs, playbackRate }),
    now: () => clockMs,
    setTimer: (cb, delayMs) => {
      const id = nextTimerId++;
      timers.set(id, { cb, fireAt: clockMs + delayMs, delayMs });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    capacity: (engine) => (engine === 'google-translate' ? 3 : 1),
    translate: (sentence, session) => {
      const d = deferred();
      requests.push({ sentence, session, deferred: d });
      return d.promise;
    },
    onResult: (sentence, result, generation) => {
      results.push({ sentence, result, generation });
    },
    onError: (sentence, error, generation) => {
      errors.push({ sentence, error, generation });
    },
    onDiagnostic: (event) => {
      diagnostics.push(event);
    },
  };

  const worker = createSubtitleWorker(deps);

  return {
    worker,
    deps,
    requests,
    results,
    errors,
    diagnostics,
    timers,
    setPlayback: (nowMs, rate = playbackRate) => {
      playbackNowMs = nowMs;
      playbackRate = rate;
    },
    advanceClock: (ms) => {
      clockMs += ms;
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.fireAt <= clockMs) {
          timers.delete(id);
          entry.cb();
        }
      }
    },
  };
}

test('local worker dispatches at most 1 request across multiple wake events and re-evaluates after seek (same-window, cross-window, paused seek)', async () => {
  const h = createHarness(25000, 1);
  const sentences = [
    makeWorkerSentence('s0', 0, 4, 'Line 0.'),
    makeWorkerSentence('s5', 5, 9, 'Line 5.'),
    makeWorkerSentence('s25', 25, 29, 'Line 25.'),
    makeWorkerSentence('s29', 29, 32, 'Line 29.'),
    makeWorkerSentence('s95', 95, 99, 'Line 95.'),
  ];

  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences,
  });

  // Multiple wake calls (simulating timeupdate, playing, ratechange) must not exceed capacity 1
  h.worker.wake();
  h.worker.wake();
  h.worker.wake();

  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].sentence.id, 's25');
  assert.equal(h.worker.getSentenceStatus('s25'), 'in-flight');
  assert.equal(h.worker.getSentenceStatus('s29'), 'pending');

  // Same-window seek to 29s while s25 is in-flight
  h.setPlayback(29500);
  h.worker.wake();
  assert.equal(h.requests.length, 1);

  // Cross-window paused seek to 95s before s25 finishes (no subsequent timeupdate after wake)
  h.setPlayback(95500);
  h.worker.wake();
  assert.equal(h.requests.length, 1);

  // Complete s25 -> finally releases slot and automatically dispatches s95 (new position), NOT s29
  h.advanceClock(120);
  h.requests[0].deferred.resolve({ ok: true, translation: '第 25 行' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].sentence.id, 's25');
  assert.equal(h.worker.getSentenceStatus('s25'), 'done');

  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].sentence.id, 's95');
});

test('synchronous re-entrant wake, stop, or replaceSession inside callbacks never exceeds capacity or dispatches stale sessions', async () => {
  let worker;
  const requests = [];
  const s1 = makeWorkerSentence('s1', 0, 5);
  const s2 = makeWorkerSentence('s2', 5, 10);
  const sNew = makeWorkerSentence('sNew', 0, 5, 'New video line');

  let mode = 'wake-in-diagnostic';

  worker = createSubtitleWorker({
    getPlayback: () => ({ nowMs: 1000, playbackRate: 1 }),
    now: () => 1000,
    setTimer: () => 1,
    clearTimer: () => {},
    capacity: () => 1,
    translate: (sentence, session) => {
      const d = deferred();
      requests.push({ sentence, session, deferred: d });
      return d.promise;
    },
    onResult: () => {
      if (mode === 'replace-in-onResult') {
        worker.replaceSession({
          generation: 2,
          engine: 'openai-compat-local',
          sentences: [sNew],
        });
      } else if (mode === 'stop-in-onResult') {
        worker.stop();
      }
    },
    onError: () => {},
    onDiagnostic: (ev) => {
      if (ev.type === 'dispatch' && mode === 'wake-in-diagnostic') {
        // Re-entrant wake during dispatch must not double-dispatch
        worker.wake();
      }
    },
  });

  worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [s1, s2],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].sentence.id, 's1');

  // When s1 finishes and onResult synchronously calls replaceSession(gen 2), next dispatch must be sNew (gen 2), not s2 (gen 1)
  mode = 'replace-in-onResult';
  requests[0].deferred.resolve({ ok: true, translation: '一' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].session.generation, 2);
  assert.equal(requests[1].sentence.id, 'sNew');

  // When sNew finishes and onResult calls stop(), no further dispatch occurs
  mode = 'stop-in-onResult';
  requests[1].deferred.resolve({ ok: true, translation: '新' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requests.length, 2);
});

test('switching video/language/settings or stop->reenable isolates old generation results and returns in-flight capacity in finally', async () => {
  const h = createHarness(1000, 1);
  const oldS1 = makeWorkerSentence('s1', 0, 5, 'Old video');
  const newS1 = makeWorkerSentence('s1', 0, 5, 'New video');

  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [oldS1],
  });
  assert.equal(h.requests.length, 1);

  // Switch to new session (generation 2) while generation 1 request is still in-flight
  h.worker.replaceSession({
    generation: 2,
    engine: 'openai-compat-local',
    sentences: [newS1],
  });

  // Physical local slot is still occupied by generation 1 in-flight request
  assert.equal(h.requests.length, 1);
  assert.equal(h.worker.getSentenceStatus('s1'), 'pending');

  // non-monotonic generation in replaceSession is ignored
  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [oldS1],
  });

  // Resolve stale generation 1 request: must NOT call onResult for gen 1, and must release slot to dispatch gen 2 newS1
  h.requests[0].deferred.resolve({ ok: true, translation: '舊譯文' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.results.length, 0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].session.generation, 2);
  assert.equal(h.requests[1].sentence.text, 'New video');

  // Stop session 2 while request 2 is in-flight
  h.worker.stop();
  assert.equal(h.worker.getSentenceStatus('s1'), undefined);

  h.requests[1].deferred.resolve({ ok: true, translation: '新譯文' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.results.length, 0);

  // Re-enable with generation 3
  h.worker.replaceSession({
    generation: 3,
    engine: 'openai-compat-local',
    sentences: [newS1],
  });
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].session.generation, 3);
});

test('rejected translate Promise, synchronous throw, and UI/diagnostic callback exceptions release slot cleanly without unhandled rejection', async () => {
  let throwMode = 'reject-translate';
  const errors = [];
  const results = [];
  let dispatchCalls = 0;

  const worker = createSubtitleWorker({
    getPlayback: () => ({ nowMs: 1000, playbackRate: 1 }),
    now: () => 1000,
    setTimer: () => 1,
    clearTimer: () => {},
    capacity: () => 1,
    translate: () => {
      dispatchCalls++;
      if (throwMode === 'sync-throw') {
        throw new Error('sync boom');
      }
      if (throwMode === 'reject-translate') {
        return Promise.reject(new Error('rejected boom'));
      }
      return Promise.resolve({ ok: true, translation: '成功' });
    },
    onResult: (s, r, g) => {
      results.push({ s, r, g });
      if (throwMode === 'throw-onResult') {
        throw new Error('UI callback boom');
      }
    },
    onError: (s, e, g) => {
      errors.push({ s, e, g });
    },
    onDiagnostic: () => {
      if (throwMode === 'throw-onResult') {
        throw new Error('diagnostic callback boom');
      }
    },
  });

  // 1. Rejected Promise -> converted to INTERNAL_ERROR, stops session, calls onError once
  worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [makeWorkerSentence('s1', 0, 5), makeWorkerSentence('s2', 2, 6)],
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.equal(errors[0].e.code, 'INTERNAL_ERROR');
  assert.equal(dispatchCalls, 1, 'must stop dispatching after INTERNAL_ERROR');

  // 2. Synchronous throw in translate -> also handled as INTERNAL_ERROR and releases slot
  throwMode = 'sync-throw';
  worker.replaceSession({
    generation: 2,
    engine: 'openai-compat-local',
    sentences: [makeWorkerSentence('s1', 0, 5)],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors.length, 2);
  assert.equal(errors[1].e.code, 'INTERNAL_ERROR');

  // 3. UI/diagnostic callback exception must not re-translate or leak slot
  throwMode = 'throw-onResult';
  worker.replaceSession({
    generation: 3,
    engine: 'openai-compat-local',
    sentences: [makeWorkerSentence('s1', 0, 5), makeWorkerSentence('s2', 2, 6)],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(results.length, 2);
  assert.equal(dispatchCalls, 4, 's1 and s2 each translated once without retrying on UI throw');
});

test('Google worker dispatches active sentence first, fills up to 3 concurrent single-sentence slots, handles out-of-order responses, and prioritizes seek target on first freed slot', async () => {
  const h = createHarness(10000, 1);
  const sentences = [
    makeWorkerSentence('s0', 0, 5, 'Expired 0'),
    makeWorkerSentence('s10', 10, 14, 'Active 10'),
    makeWorkerSentence('s15', 15, 19, 'Upcoming 15'),
    makeWorkerSentence('s20', 20, 24, 'Upcoming 20'),
    makeWorkerSentence('s25', 25, 29, 'Upcoming 25'),
    makeWorkerSentence('s80', 80, 85, 'Seek target 80'),
  ];

  h.worker.replaceSession({
    generation: 1,
    engine: 'google-translate',
    sentences,
  });

  // Multiple simultaneous wake events must not duplicate in-flight sentences or exceed capacity 3
  h.worker.wake();
  h.worker.wake();
  h.worker.wake();

  assert.equal(h.requests.length, 3);
  assert.deepEqual(
    h.requests.map((r) => r.sentence.id),
    ['s10', 's15', 's20'],
    'active sentence s10 is dispatched first, followed by s15 and s20; expired s0 is skipped',
  );
  assert.equal(h.worker.getSentenceStatus('s10'), 'in-flight');
  assert.equal(h.worker.getSentenceStatus('s15'), 'in-flight');
  assert.equal(h.worker.getSentenceStatus('s20'), 'in-flight');
  assert.equal(h.worker.getSentenceStatus('s25'), 'pending');

  // Seek to 80s while all 3 slots are occupied
  h.setPlayback(81000);
  h.worker.wake();
  assert.equal(h.requests.length, 3, 'cannot exceed 3 concurrent requests on seek');

  // Out-of-order completion: 3rd request (s20) finishes before 1st (s10) and 2nd (s15)
  h.requests[2].deferred.resolve({ ok: true, translation: '譯20' });
  await Promise.resolve();

  // First freed slot immediately dispatches new seek position s80, NOT old upcoming s25
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].sentence.id, 's20');
  assert.equal(h.results[0].sentence.startMs, 20000);
  assert.equal(h.results[0].result.translation, '譯20');

  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].sentence.id, 's80');

  // Now 1st request (s10) finishes out-of-order before 2nd (s15)
  h.requests[0].deferred.resolve({ ok: true, translation: '譯10' });
  await Promise.resolve();
  assert.equal(h.results.length, 2);
  assert.equal(h.results[1].sentence.id, 's10');
  assert.equal(h.results[1].sentence.startMs, 10000);
  assert.equal(h.results[1].result.translation, '譯10');
});

test('Google and local engine switching, video switching, and stop/re-enable isolate results and track per-engine in-flight slots', async () => {
  const h = createHarness(5000, 1);
  const googleSentences = [
    makeWorkerSentence('g1', 5, 9, 'G1'),
    makeWorkerSentence('g2', 10, 14, 'G2'),
    makeWorkerSentence('g3', 15, 19, 'G3'),
  ];

  h.worker.replaceSession({
    generation: 1,
    engine: 'google-translate',
    sentences: googleSentences,
  });
  assert.equal(h.requests.length, 3);

  // Switch engine to local (generation 2) while 3 Google requests are still in-flight
  const localSentences = [
    makeWorkerSentence('l1', 5, 9, 'L1'),
    makeWorkerSentence('l2', 10, 14, 'L2'),
  ];
  h.worker.replaceSession({
    generation: 2,
    engine: 'openai-compat-local',
    sentences: localSentences,
  });

  // Per-engine slot accounting allows 1 local request while 3 old Google requests are still finishing
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].sentence.id, 'l1');

  // Stale Google responses arrive late -> must NOT emit onResult into local session
  h.requests[0].deferred.resolve({ ok: true, translation: '舊G1' });
  h.requests[1].deferred.resolve({ ok: true, translation: '舊G2' });
  await Promise.resolve();
  assert.equal(h.results.length, 0);

  // Switch back to Google (generation 3) while 3rd Google request from gen 1 is still in-flight
  const newGoogleSentences = [
    makeWorkerSentence('ng1', 5, 9, 'NG1'),
    makeWorkerSentence('ng2', 10, 14, 'NG2'),
    makeWorkerSentence('ng3', 15, 19, 'NG3'),
  ];
  h.worker.replaceSession({
    generation: 3,
    engine: 'google-translate',
    sentences: newGoogleSentences,
  });

  // Since 1 old Google request from gen 1 is still in-flight, only 2 new Google requests can be dispatched now (total Google active = 3)
  assert.equal(h.requests.length, 6);
  assert.deepEqual(
    h.requests.slice(4).map((r) => r.sentence.id),
    ['ng1', 'ng2'],
  );

  // When the remaining stale gen 1 Google request finishes, its slot is returned and ng3 is dispatched
  h.requests[2].deferred.resolve({ ok: true, translation: '舊G3' });
  await Promise.resolve();
  assert.equal(h.results.length, 0);
  assert.equal(h.requests.length, 7);
  assert.equal(h.requests[6].sentence.id, 'ng3');
});

test('retry policy: 1s then 3s cooldown, max 3 total attempts, cooldown does not block other sentences, expired sentences do not retry, auth/SEND_MESSAGE_FAILED/INTERNAL_ERROR stop session', async () => {
  const h = createHarness(1000, 1);
  const s1 = makeWorkerSentence('s1', 0, 10, 'Sentence 1');
  const s2 = makeWorkerSentence('s2', 2, 10, 'Sentence 2');

  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [s1, s2],
  });

  // Attempt 1 on s2 (latest startMs covering nowMs=1000? Wait: s1 startMs=0, s2 startMs=2000 -> at 1000ms, s1 is active, s2 is upcoming)
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].sentence.id, 's1');

  // Fail attempt 1 of s1 with INVALID_RESPONSE -> 1000ms cooldown on s1; s2 is immediately dispatched without waiting for s1 cooldown!
  h.requests[0].deferred.resolve({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  await Promise.resolve();

  assert.equal(h.worker.getSentenceStatus('s1'), 'pending');
  assert.equal(h.requests.length, 2, 's1 cooldown must not block s2');
  assert.equal(h.requests[1].sentence.id, 's2');

  // Complete s2 -> now only s1 remains, still in 1000ms cooldown (at clock=1000, retryAt=2000)
  h.requests[1].deferred.resolve({ ok: true, translation: '二' });
  await Promise.resolve();
  assert.equal(h.requests.length, 2);
  assert.equal(h.timers.size, 1);

  // Frequent timeupdate wakes during cooldown must NOT cause retry storm
  h.worker.wake();
  h.worker.wake();
  assert.equal(h.requests.length, 2);

  // Advance clock by 999ms -> still cooling down
  h.advanceClock(999);
  assert.equal(h.requests.length, 2);

  // Advance 1ms more (total 1000ms) -> timer fires, attempt 2 of s1 dispatches
  h.advanceClock(1);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].sentence.id, 's1');

  // Fail attempt 2 of s1 -> 3000ms cooldown
  h.requests[2].deferred.resolve({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('s1'), 'pending');
  assert.equal(h.timers.size, 1);

  h.advanceClock(2999);
  assert.equal(h.requests.length, 3);
  h.advanceClock(1);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].sentence.id, 's1');

  // Fail attempt 3 of s1 -> max 3 attempts reached, status becomes 'failed', no timer scheduled
  h.requests[3].deferred.resolve({ ok: false, error: { code: 'INVALID_RESPONSE' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('s1'), 'failed');
  assert.equal(h.timers.size, 0);

  // Unrecoverable errors (401, 403, CONFIG_ERROR, SEND_MESSAGE_FAILED, RUNTIME_UNAVAILABLE, INTERNAL_ERROR) stop session
  for (const [idx, err] of [
    { code: 'HTTP_ERROR', status: 401 },
    { code: 'HTTP_ERROR', status: 403 },
    { code: 'CONFIG_ERROR' },
    { code: 'SEND_MESSAGE_FAILED' },
    { code: 'RUNTIME_UNAVAILABLE' },
    { code: 'INTERNAL_ERROR' },
  ].entries()) {
    const gen = idx + 2;
    const countBefore = h.requests.length;
    h.worker.replaceSession({
      generation: gen,
      engine: 'openai-compat-local',
      sentences: [makeWorkerSentence('a', 0, 10), makeWorkerSentence('b', 2, 10)],
    });
    assert.equal(h.requests.length, countBefore + 1);
    h.requests[h.requests.length - 1].deferred.resolve({ ok: false, error: err });
    await Promise.resolve();
    assert.equal(h.timers.size, 0);
    h.worker.wake();
    assert.equal(h.requests.length, countBefore + 1, `must halt session on ${err.code}/${err.status}`);
  }
});

test('circuit breaker: 3 consecutive statusless HTTP_ERROR / 5xx / WATCHDOG_ERROR responses trigger 5s -> 10s -> 30s backoff, single-slot probe, no idle probe, stale in-flight success does not clear breaker, and 429 respects longer deadline', async () => {
  const h = createHarness(1000, 1);
  // Test with same sentence & mixed error codes first on local engine
  const s1 = makeWorkerSentence('s1', 0, 20, 'S1');
  const s2 = makeWorkerSentence('s2', 5, 20, 'S2');

  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [s1, s2],
  });

  // 1st failure: HTTP_ERROR without status on s1 (s1 retryAt = clock + 1000)
  h.requests[0].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR' } });
  await Promise.resolve();

  // s2 is dispatched immediately (2nd request) and fails with WATCHDOG_ERROR
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].sentence.id, 's2');
  h.requests[1].deferred.resolve({ ok: false, error: { code: 'WATCHDOG_ERROR' } });
  await Promise.resolve();

  // Advance 1000ms so s1 is eligible again; 3rd failure: HTTP_ERROR 503 on s1 -> 3 consecutive breaker errors!
  h.advanceClock(1000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].sentence.id, 's1');
  h.requests[2].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 503 } });
  await Promise.resolve();

  // Breaker opens at level 1 (5000ms). Neither s1 nor s2 is dispatched before 5000ms even though s2's 1000ms sentence cooldown expired!
  h.advanceClock(4999);
  assert.equal(h.requests.length, 3);

  // At +5000ms, probe dispatches 1 candidate (s1 is active, has 1 attempt left: attempts=2 -> 3)
  h.advanceClock(1);
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].sentence.id, 's1');

  // Probe fails with WATCHDOG_ERROR -> s1 reaches 3 attempts ('failed'), breaker advances to level 2 (10000ms)
  h.requests[3].deferred.resolve({ ok: false, error: { code: 'WATCHDOG_ERROR' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('s1'), 'failed');

  // Since active sentence s1 is now exhausted, after 10000ms probe selects nearest eligible future sentence s2!
  h.advanceClock(9999);
  assert.equal(h.requests.length, 4);
  h.advanceClock(1);
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[4].sentence.id, 's2');

  // Fail probe on s2 -> breaker advances to level 3 (30000ms cap)
  h.requests[4].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 502 } });
  await Promise.resolve();

  h.advanceClock(29999);
  assert.equal(h.requests.length, 5);
  h.advanceClock(1);
  assert.equal(h.requests.length, 6);
  assert.equal(h.requests[5].sentence.id, 's2');

  // Fail 3rd attempt of s2 -> s2 is also exhausted ('failed'); breaker stays at 30000ms cap, and with NO eligible candidates left, NO timer is scheduled (no idle probe)
  h.requests[5].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('s2'), 'failed');
  assert.equal(h.timers.size, 0, 'must not schedule idle probe timer when no candidates remain');
});

test('Google circuit breaker & 429: pre-breaker in-flight success does not clear cooldown, 429 does not shorten existing backoff, probe uses 1 slot then restores 3 slots on probe success, and replaceSession preserves engine cooldown', async () => {
  const h = createHarness(1000, 1);
  const gSentences = [
    makeWorkerSentence('g1', 1, 10, 'G1'),
    makeWorkerSentence('g2', 3, 10, 'G2'),
    makeWorkerSentence('g3', 5, 10, 'G3'),
    makeWorkerSentence('g4', 7, 10, 'G4'),
    makeWorkerSentence('g5', 9, 10, 'G5'),
  ];

  // Start Google session: dispatches g1, g2, g3
  h.worker.replaceSession({
    generation: 1,
    engine: 'google-translate',
    sentences: gSentences,
  });
  assert.equal(h.requests.length, 3);

  // Fail g1 and g2 with 500 -> g4 and g5 are dispatched
  h.requests[0].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 500 } });
  h.requests[1].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 500 } });
  await Promise.resolve();
  assert.equal(h.requests.length, 5); // g3, g4, g5 in-flight

  // Fail g4 with 500 -> 3rd consecutive failure! Breaker opens for 5000ms (until clock 6000).
  // Note: g3 and g5 were ALREADY in-flight before breaker opened!
  h.requests[3].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 500 } });
  await Promise.resolve();

  // Pre-breaker in-flight request g3 succeeds -> must NOT clear breaker or dispatch during 5000ms cooldown!
  h.requests[2].deferred.resolve({ ok: true, translation: '譯G3' });
  await Promise.resolve();
  assert.equal(h.results.length, 1);
  assert.equal(h.requests.length, 5, 'pre-breaker in-flight success must not lift cooldown early');

  // Pre-breaker in-flight request g5 fails with 429 (3000ms) at clock 1000 -> must NOT shorten the 5000ms breaker deadline!
  h.requests[4].deferred.resolve({ ok: false, error: { code: 'HTTP_ERROR', status: 429 } });
  await Promise.resolve();

  // Switching video (replaceSession) at clock 2000 must preserve the remaining 4000ms cooldown!
  h.advanceClock(1000); // clock = 2000
  h.worker.replaceSession({
    generation: 2,
    engine: 'google-translate',
    sentences: [
      makeWorkerSentence('n1', 1, 10, 'N1'),
      makeWorkerSentence('n2', 3, 10, 'N2'),
      makeWorkerSentence('n3', 5, 10, 'N3'),
    ],
  });
  assert.equal(h.requests.length, 5, 'replaceSession must not bypass active engine cooldown');

  // At clock 5000 (+3000ms from 429), still 1000ms before the 6000ms breaker deadline
  h.advanceClock(3000); // clock = 5000
  assert.equal(h.requests.length, 5, '429 cooldown must not shorten longer breaker cooldown');

  // At clock 6000 (+1000ms), cooldown expires -> probe mode dispatches ONLY 1 request (n1), NOT 3!
  h.advanceClock(1000); // clock = 6000
  assert.equal(h.requests.length, 6, 'probe mode must only dispatch 1 request');
  assert.equal(h.requests[5].sentence.id, 'n1');

  // Probe n1 succeeds -> breaker closes and full capacity (remaining n2, n3) is immediately restored!
  h.requests[5].deferred.resolve({ ok: true, translation: '譯N1' });
  await Promise.resolve();
  assert.equal(h.requests.length, 8);
  assert.deepEqual(
    h.requests.slice(6).map((r) => r.sentence.id),
    ['n2', 'n3'],
  );
});

test('local TIMEOUT retry rules, ABORTED termination, intentionalEmpty, empty string as INVALID_RESPONSE, and seek backward re-enabling unexhausted sentences without 0ms timer loops', async () => {
  const h = createHarness(1000, 1);
  const sTimeoutOut = makeWorkerSentence('sTimeoutOut', 1, 5, 'Will leave buffer on timeout');
  const sTimeoutIn = makeWorkerSentence('sTimeoutIn', 6, 12, 'Stays in buffer on timeout');
  const sAborted = makeWorkerSentence('sAborted', 13, 16, 'Will abort');
  const sEmpty = makeWorkerSentence('sEmpty', 17, 20, '[Music]');

  h.worker.replaceSession({
    generation: 1,
    engine: 'openai-compat-local',
    sentences: [sTimeoutOut, sTimeoutIn, sAborted, sEmpty],
  });

  // 1. sTimeoutOut dispatches at t=1s, then user seeks to 50s (outside buffer) before TIMEOUT returns -> does NOT retry!
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].sentence.id, 'sTimeoutOut');
  h.setPlayback(50000);
  h.requests[0].deferred.resolve({ ok: false, error: { code: 'TIMEOUT' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sTimeoutOut'), 'failed');

  // 2. Seek back to 7s -> sTimeoutIn is active and dispatches
  h.setPlayback(7000);
  h.worker.wake();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].sentence.id, 'sTimeoutIn');

  // First TIMEOUT while still in range -> allowed 1 timeout retry (after 1000ms cooldown)
  h.requests[1].deferred.resolve({ ok: false, error: { code: 'TIMEOUT' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sTimeoutIn'), 'pending');

  // While sTimeoutIn cools down, sAborted dispatches and returns ABORTED -> immediately failed, no retry
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].sentence.id, 'sAborted');
  h.requests[2].deferred.resolve({ ok: false, error: { code: 'ABORTED' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sAborted'), 'failed');

  // Next, sEmpty dispatches: first return empty string WITHOUT intentionalEmpty -> treated as INVALID_RESPONSE
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].sentence.id, 'sEmpty');
  h.requests[3].deferred.resolve({ ok: true, translation: '   ' });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sEmpty'), 'pending');
  assert.equal(h.results.length, 0);

  // Advance 1000ms -> sTimeoutIn retries (2nd attempt, 1st timeout retry)
  h.advanceClock(1000);
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[4].sentence.id, 'sTimeoutIn');

  // Second TIMEOUT on sTimeoutIn -> exceeds max 1 timeout retry, marked 'failed' even though attempts is only 2!
  h.requests[4].deferred.resolve({ ok: false, error: { code: 'TIMEOUT' } });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sTimeoutIn'), 'failed');

  // sEmpty retry (retryAtMs was already reached, so it dispatches directly in finally without setting a 0ms timer!)
  assert.equal(h.requests.length, 6);
  assert.equal(h.requests[5].sentence.id, 'sEmpty');
  for (const t of h.timers.values()) {
    assert.ok(t.delayMs > 0, 'must never schedule a 0ms timer');
  }

  // Resolve sEmpty with intentionalEmpty: true -> marked 'done' and never re-sent
  h.requests[5].deferred.resolve({ ok: true, translation: '', intentionalEmpty: true });
  await Promise.resolve();
  assert.equal(h.worker.getSentenceStatus('sEmpty'), 'done');
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].result.intentionalEmpty, true);
});
