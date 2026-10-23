import { isFreeProvider } from './provider-performance.ts';

let nextFreeRequestAt = 0;

export function resetFreeRequestLimiter(): void {
  nextFreeRequestAt = 0;
}

export function reserveFreeRequest(
  provider?: { baseUrl?: string; model?: string } | null,
  now: number = Date.now(),
): number {
  if (!isFreeProvider(provider)) return 0;
  const start = Math.max(now, nextFreeRequestAt);
  nextFreeRequestAt = start + 3100;
  return start - now;
}

export async function waitForFreeRequest(
  provider?: { baseUrl?: string; model?: string } | null,
  signal?: AbortSignal,
): Promise<void> {
  const delay = reserveFreeRequest(provider);
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
