/**
 * Clean-Room HybridClient (M03)
 *
 * Provides a unified client supporting both SSE streaming (for real-time
 * single-cue subtitles) and JSON batching (for high-throughput webpage translations).
 * Includes robust reasoning protection to purge <think>...</think> artifacts.
 */

import type { ActiveProviderConfig } from '../types.ts';
import {
  buildChatCompletionRequestBody,
  resolveChatCompletionsUrl,
} from '../providers/openai-compat.ts';
import { extractHttpErrorMessage, WufProviderError } from '../providers/errors.ts';
import { ensureLocalLlamaServer } from './watchdog-client.ts';
import { waitForFreeRequest } from './openrouter-rate-limit.ts';

export interface StreamTranslateOptions {
  provider: ActiveProviderConfig;
  text: string;
  targetLanguage: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: string;
  onChunk?: (delta: string, accumulated: string) => void;
}

export interface StreamTranslateResult {
  translatedText: string;
  effectiveModel: string;
}

/**
 * Strips reasoning tokens (<think>...</think> and dangling open tags)
 * from model outputs.
 */
export function purgeReasoningArtifacts(text: string): string {
  if (!text) return '';
  // Strip complete <think>...</think> blocks
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Strip unclosed <think> tag if output ended mid-thought
  cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');
  return cleaned.trim();
}

/**
 * Translates a single piece of text with SSE streaming for ultra-low latency.
 */
export async function streamTranslateWithOpenAI(
  options: StreamTranslateOptions,
): Promise<StreamTranslateResult> {
  const { provider, text, targetLanguage, signal, onChunk, platform } = options;
  const providerTag =
    provider.profileType === 'local' ? 'openai-compat-local' : 'openai-compat-online';

  const endpointUrl = resolveChatCompletionsUrl(provider.baseUrl);
  const { body, effectiveModel } = buildChatCompletionRequestBody({
    provider,
    texts: [text],
    targetLanguage,
    platform,
  });

  // Enable stream mode
  body.stream = true;

  if (provider.profileType === 'local') {
    await ensureLocalLlamaServer(provider.baseUrl, effectiveModel);
  } else {
    await waitForFreeRequest(
      { baseUrl: provider.baseUrl, model: effectiveModel },
      signal,
    );
  }

  const timeoutMs = options.timeoutMs ?? Math.max(5, provider.fetchTimeoutSec || 60) * 1000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error(`Stream translation timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (provider.apiKey.trim()) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }

  let response: Response;
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errMsg = await extractHttpErrorMessage(response);
    throw new WufProviderError(errMsg, {
      code: 'HTTP_ERROR',
      provider: providerTag,
      status: response.status,
    });
  }

  if (!response.body) {
    throw new WufProviderError('No readable stream body returned from endpoint', {
      code: 'INVALID_RESPONSE',
      provider: providerTag,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulated = '';
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw new WufProviderError('Stream translation was cancelled', {
          code: 'ABORTED',
          provider: providerTag,
        });
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') break;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string') {
            accumulated += delta;
            onChunk?.(delta, purgeReasoningArtifacts(accumulated));
          }
        } catch {
          // Ignore partial or non-JSON SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const finalOutput = purgeReasoningArtifacts(accumulated);
  return {
    translatedText: finalOutput,
    effectiveModel,
  };
}
