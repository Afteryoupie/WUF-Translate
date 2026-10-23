import type {
  WatchdogProbeResult,
  WatchdogStatusResponse,
  WatchdogWakeResponse,
} from '../types.ts';

export const WUF_NATIVE_HOST = 'com.wuf_translate.watchdog';

const startingServers = new Map<string, Promise<void>>();
const startingLaya = new Map<string, Promise<void>>();

export interface WatchdogClientOptions {
  assumeWatchdog?: boolean;
  probeTimeoutMs?: number;
  wakeTimeoutMs?: number;
  startupDeadlineMs?: number;
  pollIntervalMs?: number;
}

export function isLoopbackHostname(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname.toLowerCase());
}

export function parseHttpUrl(rawUrl: string): URL | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

export function isLoopbackUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl);
  return url ? isLoopbackHostname(url.hostname) : false;
}

/**
 * Watchdog management APIs (/api/status, /api/wake, /api/switch, /api/decision/*)
 * must ONLY be called against recognized Watchdog loopback endpoints.
 * Ordinary OpenAI, Ollama, direct llama-server on other ports, LAN, and cloud
 * endpoints must never receive Watchdog management calls.
 */
export function isWatchdogLoopbackUrl(
  rawUrl: string,
  options?: Pick<WatchdogClientOptions, 'assumeWatchdog'>,
): boolean {
  const url = parseHttpUrl(rawUrl);
  if (!url || !isLoopbackHostname(url.hostname)) return false;
  return url.port === '8080' || options?.assumeWatchdog === true;
}

export function resolveModelsEndpointUrl(baseUrl: string): string {
  const trimmed = baseUrl
    .trim()
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

export function isModelPathOrDefaultAlias(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed === 'default') return true;
  if (trimmed.startsWith('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    return true;
  }
  if (/\.(gguf|bin|safetensors)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractUsableModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (isModelPathOrDefaultAlias(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}

export async function fetchLocalModelsCatalog(
  baseUrl: string,
  apiKey: string = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const parsed = parseHttpUrl(baseUrl);
  if (!parsed) {
    throw new Error('Invalid local endpoint URL');
  }
  const modelsUrl = resolveModelsEndpointUrl(parsed.href);
  const headers: Record<string, string> = {};
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  const response = await fetch(modelsUrl, {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to load models from ${modelsUrl}: HTTP ${response.status}`);
  }
  const json: unknown = await response.json();
  return extractUsableModelIds(json);
}

export function requestWatchdogNativeHost(): Promise<unknown> {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendNativeMessage) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    try {
      runtime.sendNativeMessage(WUF_NATIVE_HOST, { action: 'start' }, response => {
        if (runtime.lastError) {
          console.warn(`[wuf] Native host (${WUF_NATIVE_HOST}): ${runtime.lastError.message}`);
        }
        resolve(response ?? null);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[wuf] Native host (${WUF_NATIVE_HOST}): ${message}`);
      resolve(null);
    }
  });
}

function isValidWatchdogStatus(data: unknown): data is WatchdogStatusResponse {
  if (!data || typeof data !== 'object') return false;
  const status = (data as { status?: unknown }).status;
  return typeof status === 'string' && ['sleeping', 'starting', 'running'].includes(status);
}

async function prepareLocalServer(
  url: URL,
  model: string,
  options?: WatchdogClientOptions,
): Promise<void> {
  const watchdog = isWatchdogLoopbackUrl(url.href, options);
  const checkUrl = watchdog
    ? new URL('/api/status', url).href
    : resolveModelsEndpointUrl(url.href);
  const probeTimeoutMs = options?.probeTimeoutMs ?? 2000;
  const wakeTimeoutMs = options?.wakeTimeoutMs ?? 130000;
  const startupDeadlineMs = options?.startupDeadlineMs ?? 15000;
  const pollIntervalMs = options?.pollIntervalMs ?? 600;

  const probe = async (): Promise<WatchdogStatusResponse | null> => {
    try {
      const response = await fetch(checkUrl, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (!response.ok) return null;
      if (!watchdog) {
        return { status: 'running' };
      }
      const json: unknown = await response.json();
      return isValidWatchdogStatus(json) ? json : null;
    } catch {
      return null;
    }
  };

  let status = await probe();
  if (!status) {
    await requestWatchdogNativeHost();
    const deadline = Date.now() + startupDeadlineMs;
    while (!status && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      status = await probe();
    }
    if (!status) {
      throw new Error(
        `無法連線到本機 LLM 服務，請啟動 WUF Watchdog（或註冊 ${WUF_NATIVE_HOST} 自動喚醒）。`,
      );
    }
  }

  if (!watchdog) {
    return;
  }

  const target = status.models?.find(m =>
    [m.id, m.name, m.path].filter(Boolean).includes(model),
  );
  const desiredId = target?.id || model;
  const switchModel = Boolean(
    model && ![status.current_model_id, status.current_model].includes(desiredId),
  );

  if (!switchModel && status.status === 'running') {
    return;
  }

  // /v1/models is a passive catalog and succeeds even while the model sleeps.
  // /api/wake and /api/switch wait for the engine's health check and return JSON.
  const wakeUrl = new URL(switchModel ? '/api/switch' : '/api/wake', url);
  if (switchModel) {
    wakeUrl.searchParams.set('model', model);
  }
  const response = await fetch(wakeUrl.href, {
    method: 'POST',
    signal: AbortSignal.timeout(wakeTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`LLM watchdog 喚醒失敗：HTTP ${response.status}`);
  }
  const result = (await response.json()) as WatchdogWakeResponse;
  if (result.status !== 'ok' || (!switchModel && result.state !== 'running')) {
    throw new Error(
      result.message || 'LLM watchdog 模型載入失敗，請檢查模型與可用記憶體。',
    );
  }
}

export async function ensureLocalLlamaServer(
  baseUrl: string,
  model: string = '',
  options?: WatchdogClientOptions,
): Promise<void> {
  const url = parseHttpUrl(baseUrl);
  if (!url || !isLoopbackHostname(url.hostname)) {
    return;
  }
  const normalizedModel = model === 'default' ? '' : model.trim();
  const key = JSON.stringify([url.origin, normalizedModel]);
  let pending = startingServers.get(key);
  if (!pending) {
    pending = prepareLocalServer(url, normalizedModel, options).finally(() => {
      startingServers.delete(key);
    });
    startingServers.set(key, pending);
  }
  return pending;
}

export async function ensureLocalLayaDecision(
  apiUrl: string = 'http://127.0.0.1:8080/v1/systemone',
  options?: Pick<WatchdogClientOptions, 'assumeWatchdog' | 'wakeTimeoutMs'>,
): Promise<void> {
  const url = parseHttpUrl(apiUrl);
  if (!url || !isWatchdogLoopbackUrl(url.href, options)) {
    return;
  }
  const key = url.origin;
  let pending = startingLaya.get(key);
  if (!pending) {
    const wakeTimeoutMs = options?.wakeTimeoutMs ?? 130000;
    pending = (async () => {
      const wakeUrl = new URL('/api/decision/wake', url).href;
      const response = await fetch(wakeUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(wakeTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Laya 決策模型喚醒失敗：HTTP ${response.status}`);
      }
      const result = (await response.json()) as WatchdogWakeResponse;
      if (result.status !== 'ok') {
        throw new Error(result.message || 'Laya 決策模型載入失敗。');
      }
    })().finally(() => {
      startingLaya.delete(key);
    });
    startingLaya.set(key, pending);
  }
  return pending;
}

export async function probeWatchdogEndpoint(
  baseUrl: string,
  options?: WatchdogClientOptions,
): Promise<WatchdogProbeResult> {
  const url = parseHttpUrl(baseUrl);
  if (!url) {
    return {
      isLoopback: false,
      isWatchdogEndpoint: false,
      reachable: false,
      state: 'offline',
      errorMessage: 'Invalid endpoint URL',
    };
  }
  const loopback = isLoopbackHostname(url.hostname);
  const watchdog = isWatchdogLoopbackUrl(url.href, options);
  if (!watchdog) {
    return {
      isLoopback: loopback,
      isWatchdogEndpoint: false,
      reachable: true,
      state: 'non-watchdog',
    };
  }

  try {
    const statusUrl = new URL('/api/status', url).href;
    const response = await fetch(statusUrl, {
      signal: AbortSignal.timeout(options?.probeTimeoutMs ?? 2000),
    });
    if (!response.ok) {
      return {
        isLoopback: true,
        isWatchdogEndpoint: true,
        reachable: false,
        state: 'offline',
        errorMessage: `HTTP ${response.status}`,
      };
    }
    const json: unknown = await response.json();
    if (!isValidWatchdogStatus(json)) {
      return {
        isLoopback: true,
        isWatchdogEndpoint: false,
        reachable: true,
        state: 'non-watchdog',
      };
    }
    return {
      isLoopback: true,
      isWatchdogEndpoint: true,
      reachable: true,
      state: json.status,
      currentModel: json.current_model,
      currentModelId: json.current_model_id,
      activeRequests: json.active_requests,
      models: json.models?.map(m => m.id).filter(Boolean),
    };
  } catch (err) {
    return {
      isLoopback: true,
      isWatchdogEndpoint: true,
      reachable: false,
      state: 'offline',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function switchLocalModel(
  baseUrl: string,
  model: string,
  options?: WatchdogClientOptions,
): Promise<WatchdogStatusResponse> {
  const url = parseHttpUrl(baseUrl);
  if (!url || !isWatchdogLoopbackUrl(url.href, options)) {
    throw new Error('Not a watchdog loopback endpoint');
  }
  const switchUrl = new URL('/api/switch', url).href;
  const resp = await fetch(switchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(options?.wakeTimeoutMs ?? 130000),
  });
  if (!resp.ok) {
    throw new Error(`切換模型失敗：HTTP ${resp.status}`);
  }
  return (await resp.json()) as WatchdogStatusResponse;
}
