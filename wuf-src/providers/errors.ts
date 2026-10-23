export type WufProviderErrorCode =
  | 'TIMEOUT'
  | 'ABORTED'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'CONFIG_ERROR'
  | 'WATCHDOG_ERROR';

export class WufProviderError extends Error {
  readonly code: WufProviderErrorCode;
  readonly status?: number;
  readonly provider: string;

  constructor(
    message: string,
    options: {
      code: WufProviderErrorCode;
      provider: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'WufProviderError';
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
  }
}

export async function fetchWithTimeoutAndCancel(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    provider: string;
  },
): Promise<Response> {
  const { timeoutMs, signal, provider } = options;
  if (signal?.aborted) {
    throw new WufProviderError('Request was cancelled by caller', {
      code: 'ABORTED',
      provider,
    });
  }

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('TimeoutError', 'TimeoutError'));
      reject(
        new WufProviderError(`Request timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT',
          provider,
        }),
      );
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) return;
    signal.addEventListener(
      'abort',
      () => {
        reject(
          new WufProviderError('Request was cancelled by caller', {
            code: 'ABORTED',
            provider,
          }),
        );
      },
      { once: true },
    );
  });

  try {
    const fetchPromise = fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
  } catch (err) {
    if (err instanceof WufProviderError) {
      throw err;
    }
    if (timedOut) {
      throw new WufProviderError(`Request timed out after ${timeoutMs}ms`, {
        code: 'TIMEOUT',
        provider,
        cause: err,
      });
    }
    if (signal?.aborted) {
      throw new WufProviderError('Request was cancelled by caller', {
        code: 'ABORTED',
        provider,
        cause: err,
      });
    }
    throw new WufProviderError(
      err instanceof Error ? err.message : String(err),
      {
        code: 'HTTP_ERROR',
        provider,
        cause: err,
      },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

export async function extractHttpErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `HTTP ${response.status}`;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        const errField = parsed.error;
        if (typeof errField === 'string' && errField.trim()) {
          return errField.trim();
        }
        if (errField && typeof errField === 'object') {
          const msg = (errField as { message?: unknown }).message;
          if (typeof msg === 'string' && msg.trim()) {
            return msg.trim();
          }
        }
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
          return parsed.message.trim();
        }
      }
    } catch {
      // Not JSON; fall through to plain text preview
    }
    return `HTTP ${response.status}: ${text.slice(0, 240).trim()}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
