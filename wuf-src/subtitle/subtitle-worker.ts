import type { MergedAsrSentence } from './youtube-pipeline.ts';
import {
  computeSubtitleLookaheadMs,
  selectNextSubtitleSentence,
} from './subtitle-scheduler.ts';

export type SubtitleWorkerEngine = 'openai-compat-local' | 'google-translate';

export interface WorkerSentence extends MergedAsrSentence {
  id: string;
}

export interface SubtitleSession {
  generation: number;
  engine: SubtitleWorkerEngine;
  sentences: readonly WorkerSentence[];
  sourceLanguage?: string;
  targetLanguage?: string;
  modelOverride?: string;
}

export type WorkerResult =
  | { ok: true; translation: string; intentionalEmpty?: boolean }
  | { ok: false; error: { code: string; status?: number } };

export interface SubtitleDiagnosticEvent {
  type: 'dispatch' | 'success' | 'failure' | 'first-active-cue' | 'seek-first-cue';
  generation: number;
  sentenceId: string;
  startMs: number;
  attempt: number;
  elapsedMs?: number;
  outcome?: 'translated' | 'intentional-empty' | 'retryable-error' | 'terminal-error';
  errorCode?: string;
  activationToDisplayMs?: number;
  captionsToDisplayMs?: number;
}

export interface SubtitleWorkerDeps {
  getPlayback(): { nowMs: number; playbackRate: number };
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  capacity(engine: string): number;
  translate(sentence: WorkerSentence, session: SubtitleSession): Promise<WorkerResult>;
  onResult(
    sentence: WorkerSentence,
    result: Extract<WorkerResult, { ok: true }>,
    generation: number,
  ): void;
  onError(
    sentence: WorkerSentence,
    error: Extract<WorkerResult, { ok: false }>['error'],
    generation: number,
  ): void;
  onDiagnostic(event: SubtitleDiagnosticEvent): void;
}

export type WorkerSentenceStatus = 'pending' | 'in-flight' | 'done' | 'failed';

export interface SubtitleWorker {
  wake(): void;
  replaceSession(session: SubtitleSession): void;
  stop(): void;
  dispose(): void;
  getSentenceStatus(id: string): WorkerSentenceStatus | undefined;
}

interface InternalSentenceState {
  attempts: number;
  timeoutRetries: number;
  retryAtMs: number;
  status: 'pending' | 'done' | 'failed';
}

interface EngineRuntimeState {
  consecutiveFailures: number;
  backoffLevel: number;
  cooldownUntilMs: number;
  probeMode: boolean;
  breakerEpoch: number;
}

const MAX_SENTENCE_ATTEMPTS = 3;
const RETRY_DELAY_FIRST_MS = 1000;
const RETRY_DELAY_SECOND_MS = 3000;
const RATE_LIMIT_MIN_COOLDOWN_MS = 3000;
const BREAKER_BACKOFF_STEPS_MS = [5000, 10_000, 30_000] as const;

const UNRECOVERABLE_CODES = new Set([
  'CONFIG_ERROR',
  'SEND_MESSAGE_FAILED',
  'RUNTIME_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

function isUnrecoverableError(error: { code: string; status?: number }): boolean {
  if (error.status === 401 || error.status === 403) return true;
  return UNRECOVERABLE_CODES.has(error.code);
}

function isBreakerEligibleError(error: { code: string; status?: number }): boolean {
  if (error.code === 'WATCHDOG_ERROR') return true;
  if (error.code === 'HTTP_ERROR') {
    if (error.status === undefined) return true;
    if (error.status >= 500 && error.status <= 599) return true;
  }
  return false;
}

function getBreakerBackoffMs(level: number): number {
  const idx = Math.max(0, Math.min(BREAKER_BACKOFF_STEPS_MS.length - 1, level - 1));
  return BREAKER_BACKOFF_STEPS_MS[idx];
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // UI or diagnostic callback exceptions must never fail translation or leak slots
  }
}

export function createSubtitleWorker(deps: SubtitleWorkerDeps): SubtitleWorker {
  let currentSession: SubtitleSession | null = null;
  let highestGeneration = 0;
  let disposed = false;
  let haltedForSession = false;

  // Per-session sentence states
  let sentenceStates = new Map<string, InternalSentenceState>();

  // Long-lived across sessions: in-flight work keys (`${generation}:${sentenceId}`), per-engine active counts, and per-engine circuit breaker state
  const inFlightWorkKeys = new Set<string>();
  const activeCountByEngine = new Map<string, number>();
  const engineStates = new Map<string, EngineRuntimeState>();
  const timerByEngine = new Map<string, unknown>();

  let isWaking = false;
  let wakeRequested = false;

  const getEngineState = (engine: string): EngineRuntimeState => {
    let st = engineStates.get(engine);
    if (!st) {
      st = {
        consecutiveFailures: 0,
        backoffLevel: 0,
        cooldownUntilMs: 0,
        probeMode: false,
        breakerEpoch: 0,
      };
      engineStates.set(engine, st);
    }
    return st;
  };

  const clearEngineTimer = (engine: string) => {
    if (timerByEngine.has(engine)) {
      const handle = timerByEngine.get(engine);
      timerByEngine.delete(engine);
      safeCall(() => deps.clearTimer(handle));
    }
  };

  const clearAllTimers = () => {
    for (const engine of [...timerByEngine.keys()]) {
      clearEngineTimer(engine);
    }
  };

  const makeWorkKey = (generation: number, sentenceId: string): string =>
    `${generation}:${sentenceId}`;

  const getActiveCount = (engine: string): number =>
    activeCountByEngine.get(engine) ?? 0;

  const incrementActiveCount = (engine: string): void => {
    activeCountByEngine.set(engine, getActiveCount(engine) + 1);
  };

  const decrementActiveCount = (engine: string): void => {
    const next = Math.max(0, getActiveCount(engine) - 1);
    if (next === 0) {
      activeCountByEngine.delete(engine);
    } else {
      activeCountByEngine.set(engine, next);
    }
  };

  const isSessionActive = (generation: number): boolean =>
    !disposed &&
    !haltedForSession &&
    currentSession !== null &&
    currentSession.generation === generation;

  const getEffectiveCapacity = (engine: string): number => {
    const rawCap = Math.max(0, deps.capacity(engine));
    const engState = getEngineState(engine);
    return engState.probeMode ? Math.min(1, rawCap) : rawCap;
  };

  const scheduleEngineWakeTimer = (session: SubtitleSession): void => {
    const engine = session.engine;
    clearEngineTimer(engine);

    if (disposed || haltedForSession || !currentSession || currentSession.generation !== session.generation) {
      return;
    }

    const effectiveCap = getEffectiveCapacity(engine);
    if (effectiveCap <= 0 || getActiveCount(engine) >= effectiveCap) {
      return;
    }

    const clockNow = deps.now();
    const engState = getEngineState(engine);
    const { nowMs, playbackRate } = deps.getPlayback();
    const currentMs = Number.isFinite(nowMs) ? nowMs : 0;
    const horizonMs = currentMs + computeSubtitleLookaheadMs(playbackRate);

    let earliestReadyAt = Infinity;
    for (const sentence of session.sentences) {
      if (sentence.endMs <= currentMs || sentence.startMs > horizonMs) continue;
      const st = sentenceStates.get(sentence.id);
      if (!st || st.status !== 'pending') continue;
      if (inFlightWorkKeys.has(makeWorkKey(session.generation, sentence.id))) continue;

      const candidateReadyAt = Math.max(st.retryAtMs, engState.cooldownUntilMs);
      if (candidateReadyAt < earliestReadyAt) {
        earliestReadyAt = candidateReadyAt;
      }
    }

    if (!Number.isFinite(earliestReadyAt)) {
      return;
    }

    const delayMs = earliestReadyAt - clockNow;
    if (delayMs <= 0) {
      return;
    }

    const handle = deps.setTimer(() => {
      timerByEngine.delete(engine);
      wake();
    }, delayMs);
    timerByEngine.set(engine, handle);
  };

  const dispatchOne = (session: SubtitleSession, sentence: WorkerSentence): void => {
    const gen = session.generation;
    const engine = session.engine;
    const workKey = makeWorkKey(gen, sentence.id);
    const state = sentenceStates.get(sentence.id);
    if (!state) return;

    const engState = getEngineState(engine);
    const dispatchEpoch = engState.breakerEpoch;
    const wasProbeDispatch = engState.probeMode;

    // Synchronously reserve slot, mark in-flight, and increment attempts BEFORE external calls
    incrementActiveCount(engine);
    inFlightWorkKeys.add(workKey);
    state.attempts += 1;
    const attemptNumber = state.attempts;
    const dispatchTimeMs = deps.now();

    safeCall(() =>
      deps.onDiagnostic({
        type: 'dispatch',
        generation: gen,
        sentenceId: sentence.id,
        startMs: sentence.startMs,
        attempt: attemptNumber,
      }),
    );

    const finishAttempt = (rawResult: WorkerResult) => {
      try {
        if (!isSessionActive(gen)) {
          return;
        }
        const clockNow = deps.now();
        const elapsedMs = Math.max(0, clockNow - dispatchTimeMs);
        const currentState = sentenceStates.get(sentence.id);
        if (!currentState) return;

        let normalizedResult: WorkerResult = rawResult;
        if (
          !rawResult ||
          typeof rawResult !== 'object' ||
          typeof rawResult.ok !== 'boolean'
        ) {
          normalizedResult = { ok: false, error: { code: 'INTERNAL_ERROR' } };
        } else if (rawResult.ok) {
          const trimmed = String(rawResult.translation ?? '').trim();
          if (!rawResult.intentionalEmpty && !trimmed) {
            normalizedResult = { ok: false, error: { code: 'INVALID_RESPONSE' } };
          }
        }

        if (normalizedResult.ok) {
          currentState.status = 'done';
          currentState.retryAtMs = 0;
          inFlightWorkKeys.delete(workKey);

          if (engState.probeMode) {
            if (wasProbeDispatch && dispatchEpoch === engState.breakerEpoch) {
              engState.probeMode = false;
              engState.consecutiveFailures = 0;
              engState.backoffLevel = 0;
            }
          } else if (dispatchEpoch === engState.breakerEpoch) {
            engState.consecutiveFailures = 0;
          }

          safeCall(() =>
            deps.onDiagnostic({
              type: 'success',
              generation: gen,
              sentenceId: sentence.id,
              startMs: sentence.startMs,
              attempt: attemptNumber,
              elapsedMs,
              outcome: normalizedResult.intentionalEmpty ? 'intentional-empty' : 'translated',
            }),
          );
          safeCall(() => deps.onResult(sentence, normalizedResult, gen));
          return;
        }

        const error = normalizedResult.error ?? { code: 'INTERNAL_ERROR' };
        inFlightWorkKeys.delete(workKey);

        if (isUnrecoverableError(error)) {
          currentState.status = 'failed';
          currentState.retryAtMs = 0;
          haltedForSession = true;
          clearAllTimers();
          safeCall(() =>
            deps.onDiagnostic({
              type: 'failure',
              generation: gen,
              sentenceId: sentence.id,
              startMs: sentence.startMs,
              attempt: attemptNumber,
              elapsedMs,
              outcome: 'terminal-error',
              errorCode: error.code,
            }),
          );
          safeCall(() => deps.onError(sentence, error, gen));
          return;
        }

        // Engine-level rate-limit / circuit-breaker transitions
        const advanceBreakerBackoff = () => {
          engState.probeMode = true;
          engState.backoffLevel = Math.min(3, Math.max(1, engState.backoffLevel + 1));
          engState.breakerEpoch += 1;
          engState.cooldownUntilMs = Math.max(
            engState.cooldownUntilMs,
            clockNow + getBreakerBackoffMs(engState.backoffLevel),
          );
        };

        if (error.status === 429) {
          engState.probeMode = true;
          engState.breakerEpoch += 1;
          engState.cooldownUntilMs = Math.max(
            engState.cooldownUntilMs,
            clockNow + RATE_LIMIT_MIN_COOLDOWN_MS,
          );
        } else if (isBreakerEligibleError(error)) {
          if (engState.probeMode) {
            if (wasProbeDispatch && dispatchEpoch === engState.breakerEpoch) {
              advanceBreakerBackoff();
            }
          } else {
            engState.consecutiveFailures += 1;
            if (engState.consecutiveFailures >= 3) {
              advanceBreakerBackoff();
            }
          }
        }

        // Sentence-level retry state transition BEFORE calling onError
        if (error.code === 'ABORTED') {
          currentState.status = 'failed';
          currentState.retryAtMs = 0;
        } else if (error.code === 'TIMEOUT' && session.engine === 'openai-compat-local') {
          const { nowMs, playbackRate } = deps.getPlayback();
          const currentMs = Number.isFinite(nowMs) ? nowMs : 0;
          const horizonMs = currentMs + computeSubtitleLookaheadMs(playbackRate);
          const stillInRange = sentence.endMs > currentMs && sentence.startMs <= horizonMs;
          if (
            stillInRange &&
            currentState.timeoutRetries < 1 &&
            currentState.attempts < MAX_SENTENCE_ATTEMPTS
          ) {
            currentState.timeoutRetries += 1;
            currentState.status = 'pending';
            const delayMs =
              currentState.attempts === 1 ? RETRY_DELAY_FIRST_MS : RETRY_DELAY_SECOND_MS;
            currentState.retryAtMs = clockNow + delayMs;
          } else {
            currentState.status = 'failed';
            currentState.retryAtMs = 0;
          }
        } else if (currentState.attempts < MAX_SENTENCE_ATTEMPTS) {
          currentState.status = 'pending';
          const delayMs =
            currentState.attempts === 1 ? RETRY_DELAY_FIRST_MS : RETRY_DELAY_SECOND_MS;
          currentState.retryAtMs = clockNow + delayMs;
        } else {
          currentState.status = 'failed';
          currentState.retryAtMs = 0;
        }

        safeCall(() =>
          deps.onDiagnostic({
            type: 'failure',
            generation: gen,
            sentenceId: sentence.id,
            startMs: sentence.startMs,
            attempt: attemptNumber,
            elapsedMs,
            outcome: currentState.status === 'failed' ? 'terminal-error' : 'retryable-error',
            errorCode: error.code,
          }),
        );
        safeCall(() => deps.onError(sentence, error, gen));
      } finally {
        inFlightWorkKeys.delete(makeWorkKey(gen, sentence.id));
        decrementActiveCount(engine);
        if (!disposed && !haltedForSession && currentSession !== null) {
          wake();
        }
      }
    };

    try {
      const maybePromise = deps.translate(sentence, session);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(
          (res) => finishAttempt(res),
          () => finishAttempt({ ok: false, error: { code: 'INTERNAL_ERROR' } }),
        );
      } else {
        Promise.resolve().then(() =>
          finishAttempt({ ok: false, error: { code: 'INTERNAL_ERROR' } }),
        );
      }
    } catch {
      Promise.resolve().then(() =>
        finishAttempt({ ok: false, error: { code: 'INTERNAL_ERROR' } }),
      );
    }
  };

  const evaluateLoop = (): void => {
    while (!disposed && !haltedForSession && currentSession !== null) {
      wakeRequested = false;
      const session = currentSession;
      const engine = session.engine;
      const engState = getEngineState(engine);
      const clockNow = deps.now();

      if (clockNow < engState.cooldownUntilMs) {
        break;
      }

      const maxCap = getEffectiveCapacity(engine);
      if (getActiveCount(engine) >= maxCap) {
        break;
      }

      const { nowMs, playbackRate } = deps.getPlayback();

      const nextSentence = selectNextSubtitleSentence(
        session.sentences,
        nowMs,
        playbackRate,
        (candidate) => {
          const st = sentenceStates.get(candidate.id);
          if (!st || st.status !== 'pending') return false;
          if (inFlightWorkKeys.has(makeWorkKey(session.generation, candidate.id))) {
            return false;
          }
          if (st.retryAtMs > clockNow) return false;
          return true;
        },
      );

      if (!nextSentence) {
        break;
      }

      dispatchOne(session, nextSentence);

      if (wakeRequested) {
        continue;
      }
    }

    if (!disposed && !haltedForSession && currentSession !== null) {
      scheduleEngineWakeTimer(currentSession);
    }
  };

  const wake = (): void => {
    if (disposed || haltedForSession || currentSession === null) return;
    if (isWaking) {
      wakeRequested = true;
      return;
    }
    isWaking = true;
    try {
      do {
        wakeRequested = false;
        evaluateLoop();
      } while (wakeRequested && !disposed && !haltedForSession && currentSession !== null);
    } finally {
      isWaking = false;
    }
  };

  const replaceSession = (session: SubtitleSession): void => {
    if (disposed) return;
    if (!session || typeof session.generation !== 'number') return;
    if (session.generation <= highestGeneration) return;

    highestGeneration = session.generation;
    clearAllTimers();
    currentSession = {
      ...session,
      sentences: [...session.sentences],
    };
    haltedForSession = false;
    sentenceStates = new Map<string, InternalSentenceState>();
    for (const s of currentSession.sentences) {
      sentenceStates.set(s.id, {
        attempts: 0,
        timeoutRetries: 0,
        retryAtMs: 0,
        status: 'pending',
      });
    }
    wake();
  };

  const stop = (): void => {
    if (disposed) return;
    clearAllTimers();
    currentSession = null;
    haltedForSession = false;
    sentenceStates.clear();
  };

  const dispose = (): void => {
    if (disposed) return;
    clearAllTimers();
    currentSession = null;
    haltedForSession = true;
    sentenceStates.clear();
    disposed = true;
  };

  const getSentenceStatus = (id: string): WorkerSentenceStatus | undefined => {
    if (disposed || currentSession === null) return undefined;
    const st = sentenceStates.get(id);
    if (!st) return undefined;
    if (inFlightWorkKeys.has(makeWorkKey(currentSession.generation, id))) {
      return 'in-flight';
    }
    return st.status;
  };

  return {
    wake,
    replaceSession,
    stop,
    dispose,
    getSentenceStatus,
  };
}
