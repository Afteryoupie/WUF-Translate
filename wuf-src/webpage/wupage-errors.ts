import { ProviderError } from '../vendor/wupage/shared/errors';

export function toWuPageError(error: { code: string; message: string; status?: number; retryAfterMs?: number }): Error {
  const code = error.status === 401 ? 'login-required' : error.status === 403 ? 'permission-required'
    : error.status === 429 ? 'rate-limited' : error.code;
  return ['login-required', 'permission-required', 'rate-limited', 'service-rejected', 'protocol-changed', 'unsupported-browser', 'unsupported-language'].includes(code)
    ? new ProviderError(error.message, code, error.retryAfterMs) : new Error(error.message);
}
