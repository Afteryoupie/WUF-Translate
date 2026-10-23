import {
  extractHttpErrorMessage,
  fetchWithTimeoutAndCancel,
  WufProviderError,
} from './errors.ts';

export const GOOGLE_TRANSLATE_ENDPOINT =
  'https://translate.googleapis.com/translate_a/single';

export interface GoogleTranslateOptions {
  texts: string[];
  targetLanguage: string;
  sourceLanguage?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  endpointUrl?: string;
}

function parseGoogleSinglePayload(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new WufProviderError(
      'Google Translate returned unexpected JSON structure',
      {
        code: 'INVALID_RESPONSE',
        provider: 'google-translate',
      },
    );
  }
  const sentences = payload[0] as unknown[];
  const chunks: string[] = [];
  for (const entry of sentences) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new WufProviderError(
        'Google Translate sentence entry is missing translated text',
        {
          code: 'INVALID_RESPONSE',
          provider: 'google-translate',
        },
      );
    }
    chunks.push(entry[0]);
  }
  return chunks.join('');
}

export async function translateWithGoogle(
  options: GoogleTranslateOptions,
): Promise<string[]> {
  const {
    texts,
    targetLanguage,
    sourceLanguage = 'auto',
    timeoutMs = 15000,
    signal,
    endpointUrl = GOOGLE_TRANSLATE_ENDPOINT,
  } = options;

  if (!targetLanguage || !targetLanguage.trim()) {
    throw new WufProviderError('Google Translate requires a targetLanguage', {
      code: 'CONFIG_ERROR',
      provider: 'google-translate',
    });
  }

  if (texts.length === 0) {
    return [];
  }

  const results: string[] = [];
  for (const text of texts) {
    if (!text.trim()) {
      results.push(text);
      continue;
    }

    const url = new URL(endpointUrl);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', sourceLanguage || 'auto');
    url.searchParams.set('tl', targetLanguage.trim());
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', text);

    const response = await fetchWithTimeoutAndCancel(
      url.href,
      { method: 'GET' },
      {
        timeoutMs,
        signal,
        provider: 'google-translate',
      },
    );

    if (!response.ok) {
      const errMsg = await extractHttpErrorMessage(response);
      throw new WufProviderError(errMsg, {
        code: 'HTTP_ERROR',
        provider: 'google-translate',
        status: response.status,
      });
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new WufProviderError('Google Translate returned non-JSON body', {
        code: 'INVALID_RESPONSE',
        provider: 'google-translate',
        cause: err,
      });
    }

    results.push(parseGoogleSinglePayload(json));
  }

  return results;
}
