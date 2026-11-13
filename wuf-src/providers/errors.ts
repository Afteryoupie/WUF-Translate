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
  let callerAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let rejectTermination!: (err: WufProviderError) => void;
  const terminationPromise = new Promise<never>((_, reject) => {
    rejectTermination = reject;
  });
  // Prevent unhandledRejection when termination occurs outside an active race.
  terminationPromise.catch(() => {});

  let listenerAttached = false;
  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (listenerAttached && signal) {
      listenerAttached = false;
      signal.removeEventListener('abort', onCallerAbort);
    }
  };

  const onCallerAbort = () => {
    if (callerAborted || timedOut) return;
    callerAborted = true;
    controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    cleanup();
    rejectTermination(
      new WufProviderError('Request was cancelled by caller', {
        code: 'ABORTED',
        provider,
      }),
    );
  };
  if (signal) {
    listenerAttached = true;
    signal.addEventListener('abort', onCallerAbort);
  }

  timer = setTimeout(() => {
    if (callerAborted || timedOut) return;
    timedOut = true;
    controller.abort(new DOMException('TimeoutError', 'TimeoutError'));
    cleanup();
    rejectTermination(
      new WufProviderError(`Request timed out after ${timeoutMs}ms`, {
        code: 'TIMEOUT',
        provider,
      }),
    );
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  const mapTerminatedError = (err: unknown): WufProviderError => {
    if (err instanceof WufProviderError) return err;
    if (timedOut) {
      return new WufProviderError(`Request timed out after ${timeoutMs}ms`, {
        code: 'TIMEOUT',
        provider,
        cause: err,
      });
    }
    if (callerAborted || signal?.aborted) {
      return new WufProviderError('Request was cancelled by caller', {
        code: 'ABORTED',
        provider,
        cause: err,
      });
    }
    return new WufProviderError(
      err instanceof Error ? err.message : String(err),
      {
        code: 'HTTP_ERROR',
        provider,
        cause: err,
      },
    );
  };

  const wrapBodyReader = <T>(originalFn: () => Promise<T>): (() => Promise<T>) => {
    return async (): Promise<T> => {
      if (timedOut) {
        throw new WufProviderError(`Request timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT',
          provider,
        });
      }
      if (callerAborted || signal?.aborted) {
        throw new WufProviderError('Request was cancelled by caller', {
          code: 'ABORTED',
          provider,
        });
      }
      try {
        return await Promise.race([originalFn(), terminationPromise]);
      } catch (err) {
        if (err instanceof WufProviderError || timedOut || callerAborted || signal?.aborted) {
          throw mapTerminatedError(err);
        }
        throw err;
      } finally {
        cleanup();
      }
    };
  };

  let response: Response;
  try {
    const fetchPromise = fetch(url, {
      ...init,
      signal: controller.signal,
    });
    response = await Promise.race([fetchPromise, terminationPromise]);
  } catch (err) {
    cleanup();
    throw mapTerminatedError(err);
  }

  Object.defineProperty(response, 'json', {
    value: wrapBodyReader(response.json.bind(response)),
    configurable: true,
  });
  Object.defineProperty(response, 'text', {
    value: wrapBodyReader(response.text.bind(response)),
    configurable: true,
  });
  Object.defineProperty(response, 'arrayBuffer', {
    value: wrapBodyReader(response.arrayBuffer.bind(response)),
    configurable: true,
  });
  if (response.body && typeof response.body.cancel === 'function') {
    const originalCancel = response.body.cancel.bind(response.body);
    Object.defineProperty(response.body, 'cancel', {
      value: (reason?: unknown) => {
        cleanup();
        return originalCancel(reason);
      },
      configurable: true,
    });
  }
  return response;
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
  } catch (err) {
    if (err instanceof WufProviderError && (err.code === 'TIMEOUT' || err.code === 'ABORTED')) {
      throw err;
    }
    return `HTTP ${response.status}`;
  }
}
