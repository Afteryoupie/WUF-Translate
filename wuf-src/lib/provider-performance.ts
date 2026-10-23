import type { ProviderPerformanceConfig, ProviderProfileType } from '../types.ts';

export const PERFORMANCE_FIELDS: Readonly<Record<'webConcurrency' | 'webBatchUnits' | 'webBatchChars', readonly [number, number]>> = {
  webConcurrency: [1, 50],
  webBatchUnits: [1, 100],
  webBatchChars: [500, 20000],
};

export function isOpenRouter(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'].includes(host);
  } catch {
    return false;
  }
}

export function isFreeProvider(provider?: { baseUrl?: string; model?: string } | null): boolean {
  if (!provider) return false;
  return isOpenRouter(provider.baseUrl) && /:free$/.test(provider.model || '');
}

export function inferProviderType(baseUrl?: string): ProviderProfileType {
  if (!baseUrl) return 'local';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    const isPrivateOrLocal =
      ['localhost', '[::1]'].includes(host) ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      host.endsWith('.local');
    return isPrivateOrLocal ? 'local' : 'online';
  } catch {
    return 'local';
  }
}

export function resolvePerformanceConfig(
  provider: Partial<Record<'webConcurrency' | 'webBatchUnits' | 'webBatchChars' | 'baseUrl' | 'model', unknown>> = {},
  type: ProviderProfileType = 'online',
): ProviderPerformanceConfig {
  const local = type === 'local';
  const free =
    !local &&
    isFreeProvider({
      baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined,
      model: typeof provider.model === 'string' ? provider.model : undefined,
    });

  const values: ProviderPerformanceConfig = {
    webConcurrency: local ? 1 : free ? 2 : 6,
    webBatchUnits: local || free ? 40 : 20,
    webBatchChars: local || free ? 7000 : 3500,
    firstBatchUnits: local ? 4 : 6,
    firstBatchChars: local ? 1000 : 1200,
  };

  for (const [key, [min, max]] of Object.entries(PERFORMANCE_FIELDS) as Array<
    ['webConcurrency' | 'webBatchUnits' | 'webBatchChars', readonly [number, number]]
  >) {
    const rawVal = provider[key];
    if (typeof rawVal === 'number' && Number.isInteger(rawVal) && rawVal >= min && rawVal <= max) {
      values[key] = rawVal;
    }
  }

  if (free) {
    values.webConcurrency = Math.min(values.webConcurrency, 2);
  }
  values.firstBatchUnits = Math.min(values.firstBatchUnits, values.webBatchUnits);
  values.firstBatchChars = Math.min(values.firstBatchChars, values.webBatchChars);
  return values;
}

export const WUFProviderPerformance = {
  isOpenRouter,
  isFreeProvider,
  inferType: inferProviderType,
  config: resolvePerformanceConfig,
  fields: PERFORMANCE_FIELDS,
};

declare global {
  // eslint-disable-next-line no-var
  var __WUFProviderPerformance: typeof WUFProviderPerformance | undefined;
}

globalThis.__WUFProviderPerformance = WUFProviderPerformance;
