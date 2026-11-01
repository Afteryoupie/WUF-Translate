// WUF transport adapter. The engine keeps WuPage's protocol internally.
import type { RuntimeRequest } from '../shared/types';

type Transport = (request: RuntimeRequest, signal?: AbortSignal) => Promise<unknown>;
let transport: Transport | undefined;
export function configureRuntimeTransport(value: Transport): void { transport = value; }
export async function sendRuntimeRequest<T>(request: RuntimeRequest, signal?: AbortSignal): Promise<T> {
  if (!transport) throw new Error('WuPage transport is not configured.');
  signal?.throwIfAborted();
  return await transport(request, signal) as T;
}
