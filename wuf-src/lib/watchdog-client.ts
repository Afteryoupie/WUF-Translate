import type {
  WatchdogProbeResult,
  WatchdogStatusResponse,
  WatchdogWakeResponse,
} from '../types.ts';
import { WufProviderError } from '../providers/errors.ts';

export const WUF_NATIVE_HOST = 'com.wuf_translate.watchdog';

const startingServers = new Map<string, Promise<void>>();

export interface WatchdogClientOptions {
  assumeWatchdog?: boolean;
  apiKey?: string;
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
 * Watchdog management APIs (/api/status, /api/wake, /api/switch)
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
  const lower = trimmed.toLowerCase();
  // Watchdog exposes model paths, 'default', and Apple Foundation guardrail mode ('permissive') in /v1/models.
  if (!trimmed || lower === 'default' || lower === 'permissive') return true;
  if (trimmed.startsWith('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    return true;
  }
  if (/\.(gguf|bin|safetensors)$/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function extractRawModelIds(payload: unknown): string[] {
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
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push(trimmed);
  }
  return models;
}

export function extractUsableModelIds(payload: unknown): string[] {
  return extractRawModelIds(payload).filter(id => !isModelPathOrDefaultAlias(id));
}

export interface LocalModelEntry {
  id: string;
  name: string;
  aliases?: string[];
  fromWatchdog?: boolean;
}

export function resolveSavedModelId(
  savedModel: string,
  models: LocalModelEntry[],
): { resolved: string; normalizedFromAlias: boolean } {
  const trimmed = savedModel.trim();
  if (!trimmed) {
    return { resolved: '', normalizedFromAlias: false };
  }
  const hasWatchdog = models.some(entry => entry.fromWatchdog);
  if (hasWatchdog) {
    if (trimmed.toLowerCase() === 'default') {
      return { resolved: '', normalizedFromAlias: true };
    }
    for (const entry of models) {
      if (entry.id === trimmed) {
        return { resolved: entry.id, normalizedFromAlias: false };
      }
      if (entry.aliases?.includes(trimmed)) {
        return { resolved: entry.id, normalizedFromAlias: true };
      }
    }
  }
  return { resolved: trimmed, normalizedFromAlias: false };
}

export async function fetchLocalModelEntries(
  baseUrl: string,
  apiKey: string = '',
  signal?: AbortSignal,
  options?: Pick<WatchdogClientOptions, 'assumeWatchdog' | 'probeTimeoutMs'>,
): Promise<LocalModelEntry[]> {
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
  const rawIds = extractRawModelIds(json);

  const nameById = new Map<string, string>();
  const aliasesById = new Map<string, string[]>();
  let confirmedWatchdog = false;
  let filteredIds = rawIds;

  if (isWatchdogLoopbackUrl(parsed.href, options)) {
    try {
      const statusUrl = new URL('/api/status', parsed).href;
      const statusResp = await fetch(statusUrl, {
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        signal: signal ?? AbortSignal.timeout(options?.probeTimeoutMs ?? 2000),
      });
      if (statusResp.ok) {
        const statusJson: unknown = await statusResp.json();
        if (isValidWatchdogStatus(statusJson) && Array.isArray(statusJson.models)) {
          confirmedWatchdog = true;
          const pathAliases = new Set<string>();
          for (const m of statusJson.models) {
            const id = typeof m.id === 'string' ? m.id.trim() : '';
            const name = typeof m.name === 'string' ? m.name.trim() : '';
            const path = typeof m.path === 'string' ? m.path.trim() : '';
            if (id) {
              if (name) nameById.set(id, name);
              const aliases = [path, name].filter(
                (a): a is string => Boolean(a) && a !== id,
              );
              if (aliases.length > 0) {
                aliasesById.set(id, aliases);
              }
            }
            if (path && path !== id) pathAliases.add(path);
          }
          filteredIds = rawIds.filter(
            id => !pathAliases.has(id) && (!isModelPathOrDefaultAlias(id) || aliasesById.has(id) || nameById.has(id)),
          );
        }
      }
    } catch {
      // Fallback to raw model IDs when /api/status is unavailable
    }
  }

  return filteredIds.map(id => {
    const aliases = aliasesById.get(id);
    return {
      id,
      name: nameById.get(id) || id,
      ...(aliases ? { aliases } : {}),
      fromWatchdog: confirmedWatchdog,
    };
  });
}

export async function fetchLocalModelsCatalog(
  baseUrl: string,
  apiKey: string = '',
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await fetchLocalModelEntries(baseUrl, apiKey, signal);
  return entries.map(entry => entry.id);
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
  const authHeaders: Record<string, string> = options?.apiKey?.trim()
    ? { Authorization: `Bearer ${options.apiKey.trim()}` }
    : {};

  type ProbeOutcome =
    | { kind: 'watchdog'; data: WatchdogStatusResponse }
    | { kind: 'non-watchdog' }
    | { kind: 'unreachable' };

  const probe = async (): Promise<ProbeOutcome> => {
    let response: Response;
    try {
      response = await fetch(checkUrl, {
        ...(Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : {}),
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
    } catch {
      return { kind: 'unreachable' };
    }

    if (response.status === 401 || response.status === 403) {
      throw new WufProviderError(`HTTP ${response.status}: Unauthorized`, {
        code: 'HTTP_ERROR',
        provider: 'openai-compat-local',
        status: response.status,
      });
    }

    if (!watchdog) {
      return { kind: 'non-watchdog' };
    }

    if (!response.ok) {
      // An HTTP server is listening on port 8080 without Watchdog's /api/status; treat as non-Watchdog.
      return { kind: 'non-watchdog' };
    }

    try {
      const json: unknown = await response.json();
      if (isValidWatchdogStatus(json)) {
        return { kind: 'watchdog', data: json };
      }
      return { kind: 'non-watchdog' };
    } catch {
      return { kind: 'non-watchdog' };
    }
  };

  let outcome = await probe();
  if (outcome.kind === 'non-watchdog') {
    return;
  }
  if (!watchdog) {
    // Non-Watchdog loopback endpoint is unreachable; let the caller's translation request surface the error without calling Native Host.
    return;
  }

  if (outcome.kind === 'unreachable') {
    await requestWatchdogNativeHost();
    const deadline = Date.now() + startupDeadlineMs;
    while (outcome.kind === 'unreachable' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      outcome = await probe();
    }
    if (outcome.kind === 'non-watchdog') {
      return;
    }
    if (outcome.kind === 'unreachable') {
      throw new Error(
        `無法連線到本機 LLM 服務，請啟動 WUF Watchdog（或註冊 ${WUF_NATIVE_HOST} 自動喚醒）。`,
      );
    }
  }

  const status = outcome.data;

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
  const key = JSON.stringify([url.origin, normalizedModel, options?.apiKey?.trim() || '']);
  let pending = startingServers.get(key);
  if (!pending) {
    pending = prepareLocalServer(url, normalizedModel, options).finally(() => {
      startingServers.delete(key);
    });
    startingServers.set(key, pending);
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
