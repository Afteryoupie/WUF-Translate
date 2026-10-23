import type {
  ActiveProviderConfig,
  RoutingSort,
  ThinkingLevel,
} from '../types.ts';
import { waitForFreeRequest } from '../lib/openrouter-rate-limit.ts';
import { isOpenRouter } from '../lib/provider-performance.ts';
import { localModelForPlatform } from '../lib/provider-profiles.ts';
import {
  ensureLocalLlamaServer,
  parseHttpUrl,
  type WatchdogClientOptions,
} from '../lib/watchdog-client.ts';
import {
  extractHttpErrorMessage,
  fetchWithTimeoutAndCancel,
  WufProviderError,
} from './errors.ts';

export const SEGMENT_DELIMITER = '\n---WUF-SEG---\n';
export const STRONG_SEGMENT_DELIMITER = '\n<<<WUF_SEGMENT_BOUNDARY>>>\n';

export interface ThinkingPayloadInput {
  baseUrl?: string;
  model?: string;
  level?: ThinkingLevel;
  routingSort?: RoutingSort;
  allowFallbacks?: boolean;
  extraBodyRaw?: string;
}

export function buildThinkingPayload(input: ThinkingPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const level = input.level ?? 'auto';
  const openRouter = isOpenRouter(input.baseUrl);

  let extra: Record<string, unknown> = {};
  if (input.extraBodyRaw && input.extraBodyRaw.trim()) {
    try {
      const parsed: unknown = JSON.parse(input.extraBodyRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extra = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Ignore invalid JSON here; validation warns at settings layer
    }
  }

  Object.assign(payload, extra);

  if (openRouter) {
    if (level === 'off') {
      payload.reasoning = { enabled: false, exclude: true };
    } else if (level !== 'auto') {
      payload.reasoning = { effort: level, exclude: true };
    }

    const existingProvider =
      extra.provider && typeof extra.provider === 'object' && !Array.isArray(extra.provider)
        ? (extra.provider as Record<string, unknown>)
        : {};
    const sort =
      input.routingSort && input.routingSort !== 'auto'
        ? input.routingSort
        : 'throughput';
    const allowFallbacks =
      typeof input.allowFallbacks === 'boolean' ? input.allowFallbacks : true;

    payload.provider = {
      ...existingProvider,
      sort,
      allow_fallbacks: allowFallbacks,
    };
  }

  return payload;
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const parsed = parseHttpUrl(baseUrl);
  if (!parsed) {
    throw new WufProviderError(`Invalid OpenAI-compatible baseUrl: ${baseUrl}`, {
      code: 'CONFIG_ERROR',
      provider: 'openai-compat',
    });
  }
  const trimmed = parsed.href.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

export function buildSystemPrompt(
  targetLanguage: string,
  customPrompt: string,
  useStrongMarker: boolean,
  segmentCount: number,
): string {
  if (customPrompt.trim()) {
    return customPrompt.trim();
  }
  const markerInstruction =
    segmentCount > 1
      ? ` Keep the exact segment delimiter ${useStrongMarker ? '<<<WUF_SEGMENT_BOUNDARY>>>' : '---WUF-SEG---'} between the ${segmentCount} segments.`
      : '';
  return `You are a precise translation engine. Translate the user text into ${targetLanguage}. Output only the translation without commentary.${markerInstruction}`;
}

export interface ChatCompletionBuildOptions {
  provider: ActiveProviderConfig;
  texts: string[];
  targetLanguage: string;
  platform?: string;
}

export function buildChatCompletionRequestBody(
  options: ChatCompletionBuildOptions,
): { body: Record<string, unknown>; effectiveModel: string; delimiter: string } {
  const { provider, texts, targetLanguage, platform } = options;
  const rawModel = (provider.effectiveModel ?? provider.model ?? '').trim();
  const normalizedModel = rawModel === 'default' ? '' : rawModel;
  const effectiveModel =
    provider.profileType === 'local'
      ? localModelForPlatform(normalizedModel, provider.baseUrl, platform)
      : normalizedModel;

  const delimiter = provider.useStrongSegMarker
    ? STRONG_SEGMENT_DELIMITER
    : SEGMENT_DELIMITER;
  const systemContent = buildSystemPrompt(
    targetLanguage,
    provider.systemPrompt,
    provider.useStrongSegMarker,
    texts.length,
  );
  const userContent = texts.join(delimiter);

  const extraAndThinking = buildThinkingPayload({
    baseUrl: provider.baseUrl,
    model: effectiveModel,
    level: provider.thinkingLevel,
    routingSort: provider.routingSort,
    allowFallbacks: provider.allowFallbacks,
    extraBodyRaw: provider.extraBodyJson,
  });

  const targetLangDesc =
    targetLanguage === 'zh-TW' || /^zh/i.test(targetLanguage)
      ? 'Traditional Chinese'
      : targetLanguage;

  const isRiva =
    effectiveModel.toLowerCase().includes('riva') ||
    (provider.model && provider.model.toLowerCase().includes('riva'));
  const finalUserContent =
    isRiva && !userContent.startsWith('Translate this into')
      ? `Translate this into ${targetLangDesc}: ${userContent}`
      : userContent;

  const body: Record<string, unknown> = {
    ...extraAndThinking,
    target_language: targetLangDesc,
    // Known Riva requests already contain the instruction. WUF's core adds it
    // only when a server-selected model needs the target-language hint.
    ...(!isRiva ? { shinkansen_target_language: targetLangDesc } : {}),
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: finalUserContent },
    ],
  };

  if (typeof provider.temperature === 'number' && Number.isFinite(provider.temperature)) {
    body.temperature = provider.temperature;
  }

  // Requirement 4: When effective model is empty, omit body.model completely.
  if (effectiveModel !== '') {
    body.model = effectiveModel;
  } else {
    delete body.model;
  }

  return { body, effectiveModel, delimiter };
}

export interface OpenAICompatRequestOptions {
  provider: ActiveProviderConfig;
  texts: string[];
  targetLanguage: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: string;
  watchdogOptions?: WatchdogClientOptions;
}

export async function translateWithOpenAICompat(
  options: OpenAICompatRequestOptions,
): Promise<{ translations: string[]; effectiveModel: string }> {
  const { provider, texts, targetLanguage, signal, platform, watchdogOptions } = options;
  const providerTag =
    provider.profileType === 'local' ? 'openai-compat-local' : 'openai-compat-online';

  if (texts.length === 0) {
    return { translations: [], effectiveModel: '' };
  }

  const endpointUrl = resolveChatCompletionsUrl(provider.baseUrl);
  const { body, effectiveModel, delimiter } = buildChatCompletionRequestBody({
    provider,
    texts,
    targetLanguage,
    platform,
  });

  if (provider.profileType === 'local') {
    try {
      await ensureLocalLlamaServer(provider.baseUrl, effectiveModel, watchdogOptions);
    } catch (err) {
      throw new WufProviderError(
        err instanceof Error ? err.message : String(err),
        {
          code: 'WATCHDOG_ERROR',
          provider: providerTag,
          cause: err,
        },
      );
    }
  } else {
    await waitForFreeRequest(
      { baseUrl: provider.baseUrl, model: effectiveModel },
      signal,
    );
  }

  const timeoutMs =
    options.timeoutMs ?? Math.max(5, provider.fetchTimeoutSec || 60) * 1000;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (provider.apiKey.trim()) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }

  const response = await fetchWithTimeoutAndCancel(
    endpointUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    {
      timeoutMs,
      signal,
      provider: providerTag,
    },
  );

  if (!response.ok) {
    const errMsg = await extractHttpErrorMessage(response);
    throw new WufProviderError(errMsg, {
      code: 'HTTP_ERROR',
      provider: providerTag,
      status: response.status,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new WufProviderError('OpenAI-compatible endpoint returned non-JSON body', {
      code: 'INVALID_RESPONSE',
      provider: providerTag,
      cause: err,
    });
  }

  if (!json || typeof json !== 'object') {
    throw new WufProviderError('OpenAI-compatible endpoint returned empty payload', {
      code: 'INVALID_RESPONSE',
      provider: providerTag,
    });
  }

  const record = json as Record<string, unknown>;
  if (record.error) {
    const errObj = record.error;
    const msg =
      typeof errObj === 'string'
        ? errObj
        : errObj && typeof errObj === 'object' && typeof (errObj as { message?: unknown }).message === 'string'
          ? ((errObj as { message: string }).message)
          : 'Upstream model returned an error object';
    throw new WufProviderError(msg, {
      code: 'HTTP_ERROR',
      provider: providerTag,
    });
  }

  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new WufProviderError('OpenAI-compatible response is missing choices[]', {
      code: 'INVALID_RESPONSE',
      provider: providerTag,
    });
  }

  const firstChoice = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = firstChoice?.message?.content;
  if (typeof content !== 'string') {
    throw new WufProviderError('OpenAI-compatible choice is missing string message.content', {
      code: 'INVALID_RESPONSE',
      provider: providerTag,
    });
  }

  if (texts.length === 1) {
    return {
      translations: [content.trim()],
      effectiveModel,
    };
  }

  const splitMarker = delimiter.trim();
  let parts = content.split(splitMarker).map(s => s.trim());
  if (parts.length !== texts.length) {
    // Tolerant regex fallback for minor whitespace/marker variations by local LLMs
    const flexiblePattern = /\s*(?:---+\s*WUF-SEG\s*---+|<<<+\s*WUF_SEGMENT_BOUNDARY\s*>>>+)\s*/gi;
    const regexParts = content.split(flexiblePattern).map(s => s.trim());
    if (regexParts.length === texts.length) {
      parts = regexParts;
    }
  }

  if (parts.length !== texts.length) {
    throw new WufProviderError(
      `Segment count mismatch: expected ${texts.length}, received ${parts.length}`,
      {
        code: 'INVALID_RESPONSE',
        provider: providerTag,
      },
    );
  }

  return {
    translations: parts,
    effectiveModel,
  };
}
