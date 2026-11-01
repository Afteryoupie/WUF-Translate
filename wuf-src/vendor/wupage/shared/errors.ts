import type { RuntimeResponse } from "./types";

export class ProviderError extends Error {
  constructor(message: string, readonly errorCode: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export function runtimeErrorResponse(error: unknown): Extract<RuntimeResponse, { ok: false }> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ProviderError ? {
      errorCode: error.errorCode,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
    } : {})
  };
}

export function restoreRuntimeError(response: Extract<RuntimeResponse, { ok: false }>): Error {
  return response.errorCode
    ? new ProviderError(response.error, response.errorCode, response.retryAfterMs)
    : new Error(response.error);
}
