import type { SubtitleDecisionMode } from '../types.ts';
import { resolveChatCompletionsUrl } from '../providers/openai-compat.ts';

export const LAYA_API_URL = 'http://127.0.0.1:8080/v1/systemone';

export interface LayaAnswer {
  type?: string;
  noul?: number;
  action?: {
    act_probability?: number;
  };
}

export interface SubtitleFilterVerdict {
  is_valid: boolean;
  needs_translation: boolean;
  detected_lang: string;
  confidence: number;
  source: 'fallback' | 'laya' | 'custom';
}

export interface SubtitleFormatVerdict {
  needs_repair: boolean;
  reason: 'format' | null;
  source: 'fallback' | 'laya' | 'custom';
}

export interface SubtitleBoundarySegment {
  text: string;
  normText?: string;
  startMs?: number;
  endMs?: number;
  jevBreakBefore?: boolean | null;
}

export interface LayaDecisionEngineOptions {
  enabled?: boolean;
  mode?: SubtitleDecisionMode;
  apiUrl?: string;
  apiKey?: string;
  customModel?: string;
  customBaseUrl?: string;
  timeoutMs?: number;
  confidenceThreshold?: number;
}

export class LayaDecisionEngine {
  enabled: boolean;
  mode: SubtitleDecisionMode;
  apiUrl: string;
  apiKey: string;
  customModel: string;
  customBaseUrl: string;
  timeoutMs: number;
  confidenceThreshold: number;
  lastError: string | null;

  static HALLUCINATION_PATTERNS: readonly RegExp[] = [
    /^\[(音楽|拍手|笑い|歓声|music|applause|laughter|silence)\]$/i,
    /^[♪♫♩♬\s.,!?:;_\-]+$/,
  ];

  constructor(options: LayaDecisionEngineOptions = {}) {
    const mode = options.mode ?? (options.enabled ? 'laya' : 'off');
    this.mode = mode;
    this.enabled = options.enabled ?? mode !== 'off';
    this.apiUrl = options.apiUrl || LAYA_API_URL;
    this.apiKey = options.apiKey || '';
    this.customModel = (options.customModel || '').trim();
    this.customBaseUrl = (options.customBaseUrl || '').trim();
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.8;
    this.lastError = null;
  }

  _decision(answer: LayaAnswer | undefined, threshold: number = this.confidenceThreshold): boolean | null {
    if (
      answer?.action?.act_probability !== undefined &&
      answer.action.act_probability < 0.5
    ) {
      return null;
    }
    const p = answer?.noul;
    if (
      answer?.type !== 'noul' ||
      typeof p !== 'number' ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 1
    ) {
      return null;
    }
    if (p >= threshold) return true;
    if (p <= 1 - threshold) return false;
    return null;
  }

  async _request(
    state: Record<string, unknown>,
    questions: Record<string, { type: string; instructions: string }>,
  ): Promise<Record<string, LayaAnswer> | null> {
    if (this.mode === 'custom' && (this.customModel || this.customBaseUrl)) {
      return this._requestCustomModel(state, questions);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
          controller.abort();
        }, this.timeoutMs);
      });
      const request = (async () => {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: 'laya-multilingual', state, questions }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { answers?: unknown };
        if (
          !data?.answers ||
          typeof data.answers !== 'object' ||
          Array.isArray(data.answers)
        ) {
          throw new Error('invalid answers');
        }
        return data.answers as Record<string, LayaAnswer>;
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      this.lastError = controller.signal.aborted
        ? 'timeout'
        : error instanceof Error
          ? error.message
          : String(error);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  /**
   * Executes typed boolean/probability decisions against a custom OpenAI-compatible
   * chat completions model when the user configures `decisionMode: 'custom'`.
   */
  async _requestCustomModel(
    state: Record<string, unknown>,
    questions: Record<string, { type: string; instructions: string }>,
  ): Promise<Record<string, LayaAnswer> | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const endpoint = resolveChatCompletionsUrl(
      this.customBaseUrl || 'http://127.0.0.1:8080/v1',
    );
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('timeout'));
          controller.abort();
        }, this.timeoutMs);
      });
      const request = (async () => {
        const systemContent =
          'You are a typed subtitle decision classifier. Return ONLY a JSON object mapping each question key to a boolean (true/false) or number in [0,1]. Do not include markdown or explanations.';
        const body: Record<string, unknown> = {
          messages: [
            { role: 'system', content: systemContent },
            {
              role: 'user',
              content: JSON.stringify({ state, questions }),
            },
          ],
          temperature: 0,
        };
        if (this.customModel && this.customModel !== 'default') {
          body.model = this.customModel;
        }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          answers?: Record<string, LayaAnswer>;
        };
        if (data?.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)) {
          return data.answers;
        }
        const rawText = (data?.choices?.[0]?.message?.content || '')
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '');
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('invalid answers');
        }
        const normalized: Record<string, LayaAnswer> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'boolean') {
            normalized[k] = { type: 'noul', noul: v ? 1 : 0 };
          } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) {
            normalized[k] = { type: 'noul', noul: v };
          } else if (v && typeof v === 'object' && 'noul' in (v as Record<string, unknown>)) {
            normalized[k] = v as LayaAnswer;
          }
        }
        return normalized;
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      this.lastError = controller.signal.aborted
        ? 'timeout'
        : error instanceof Error
          ? error.message
          : String(error);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  private get decisionSourceLabel(): 'laya' | 'custom' {
    return this.mode === 'custom' && (this.customModel || this.customBaseUrl)
      ? 'custom'
      : 'laya';
  }

  async evaluateBatch(
    texts: string[],
    targetLang: string = 'zh-TW',
    sourceLanguage: string = 'auto',
  ): Promise<SubtitleFilterVerdict[]> {
    this.lastError = null;
    if (!Array.isArray(texts)) return [];
    const verdicts = texts.map(text =>
      this.fallbackEvaluate(text, targetLang, sourceLanguage),
    );
    if (!this.enabled) return verdicts;

    for (let offset = 0; offset < texts.length; offset += 16) {
      const batch = texts.slice(offset, offset + 16);
      if (
        verdicts
          .slice(offset, offset + 16)
          .every(verdict => !verdict.is_valid || !verdict.needs_translation)
      ) {
        continue;
      }
      const questions: Record<string, { type: string; instructions: string }> = {};
      batch.forEach((_, i) => {
        questions[`valid_${i}`] = {
          type: 'noul',
          instructions: `Is texts[${i}] human dialogue rather than a sound-effect tag or transcription noise? Preserve greetings and repeated speech.`,
        };
        questions[`needs_${i}`] = {
          type: 'noul',
          instructions: `Does texts[${i}] need translation to ${targetLang}? Pure Han characters alone do not establish that Japanese text is Chinese.`,
        };
      });
      if (batch.some(text => typeof text !== 'string' || text.length > 1000)) {
        continue;
      }
      const answers = await this._request(
        { task: 'subtitle_filter', texts: batch, targetLanguage: targetLang, sourceLanguage },
        questions,
      );
      if (!answers) break;
      batch.forEach((_, i) => {
        let valid = this._decision(answers[`valid_${i}`], 0.95);
        let needs = this._decision(answers[`needs_${i}`], 0.95);
        if (
          /^zh/.test(targetLang) &&
          /[\u3400-\u9fff]/.test(batch[i]) &&
          /^(auto|ja)/.test(sourceLanguage) &&
          !/[\u3040-\u30ff\uac00-\ud7afA-Za-z]/.test(batch[i])
        ) {
          needs = true;
        }
        if (
          valid === false &&
          /[\p{L}\p{N}]/u.test(batch[i]) &&
          !/^\[[^\]]+\]$/.test(batch[i])
        ) {
          valid = true;
        }
        if (valid === null) {
          const answer = answers[`valid_${i}`];
          const wellFormed =
            answer?.type === 'noul' &&
            typeof answer.noul === 'number' &&
            Number.isFinite(answer.noul) &&
            answer.noul >= 0 &&
            answer.noul <= 1 &&
            !(answer.action?.act_probability !== undefined && answer.action.act_probability < 0.5);
          if (needs !== false || !wellFormed) return;
          valid = true;
        }
        const fallback = verdicts[offset + i];
        verdicts[offset + i] = {
          ...fallback,
          is_valid: fallback.is_valid && valid,
          needs_translation:
            fallback.is_valid && valid && fallback.needs_translation && (needs ?? true),
          source: this.decisionSourceLabel,
        };
      });
    }
    return verdicts;
  }

  async reviewFormatBatch(
    texts: string[],
    translations: Array<string | null | undefined>,
    targetLanguage: string = 'zh-TW',
    sourceLanguage: string = 'auto',
  ): Promise<SubtitleFormatVerdict[]> {
    this.lastError = null;
    const verdicts = texts.map((_, i) => this.fallbackReviewFormat(translations[i]));
    if (!this.enabled) return verdicts;
    for (let offset = 0; offset < texts.length; offset += 32) {
      const pairs = texts.slice(offset, offset + 32).map((source, i) => ({
        source,
        translation: translations[offset + i],
      }));
      const eligible = pairs.flatMap((pair, i) =>
        !verdicts[offset + i].needs_repair &&
        typeof pair.translation === 'string' &&
        pair.translation.trim() &&
        pair.source.length <= 1000 &&
        pair.translation.length <= 1000
          ? [i]
          : [],
      );
      if (!eligible.length) continue;
      const questions = Object.fromEntries(
        eligible.map((_, i) => [
          `error_${i}`,
          {
            type: 'noul',
            instructions:
              'Is this output malformed for a plain single-line subtitle? Check format only, not meaning or translation quality.',
          },
        ]),
      );
      const answers = await this._request(
        {
          task: 'subtitle_format',
          pairs: eligible.map(i => pairs[i]),
          targetLanguage,
          sourceLanguage,
        },
        questions,
      );
      if (!answers) break;
      eligible.forEach((index, i) => {
        const answer = answers[`error_${i}`];
        const error = this._decision(answer, 0.9);
        if (error !== null) {
          verdicts[offset + index] = {
            needs_repair: error,
            reason: 'format',
            source: this.decisionSourceLabel,
          };
        }
      });
    }
    return verdicts;
  }

  fallbackReviewFormat(translation: unknown): SubtitleFormatVerdict {
    const invalid =
      typeof translation !== 'string' ||
      !translation.trim() ||
      /[\r\n]|```|\[SEG_?\d+\]/i.test(translation) ||
      /^\s*(?:\{[\s\S]*\}|\[\s*["{])/.test(translation);
    return {
      needs_repair: invalid,
      reason: invalid ? 'format' : null,
      source: 'fallback',
    };
  }

  async evaluateBoundaries(
    segments: SubtitleBoundarySegment[],
  ): Promise<{ breakBefore: Array<boolean | null>; source: 'fallback' | 'laya' | 'custom' }> {
    this.lastError = null;
    if (!Array.isArray(segments)) segments = [];
    const breakBefore: Array<boolean | null> = Array(segments.length).fill(null);
    let source: 'fallback' | 'laya' | 'custom' = 'fallback';
    if (!this.enabled) return { breakBefore, source };
    const count = Math.min(segments.length - 1, 128);
    for (let offset = 0; offset < count; offset += 32) {
      const boundaries: Array<{ left: string; right: string }> = [];
      const questions: Record<string, { type: string; instructions: string }> = {};
      for (let i = 0; i < Math.min(32, count - offset); i++) {
        const index = offset + i + 1;
        boundaries.push({
          left: segments[index - 1].text,
          right: segments[index].text,
        });
        questions[`boundary_${i}`] = {
          type: 'noul',
          instructions: `Does boundaries[${i}].right begin a new sentence rather than continue boundaries[${i}].left?`,
        };
      }
      const answers = await this._request({ boundaries }, questions);
      if (!answers) break;
      boundaries.forEach((_, i) => {
        const decision = this._decision(answers[`boundary_${i}`]);
        if (decision !== null) {
          breakBefore[offset + i + 1] = decision;
          source = this.decisionSourceLabel;
        }
      });
    }
    return { breakBefore, source };
  }

  fallbackEvaluate(
    text: string,
    targetLang: string = 'zh-TW',
    sourceLanguage: string = 'auto',
  ): SubtitleFilterVerdict {
    const t = (text || '').trim();
    const is_valid =
      t.length > 0 &&
      !LayaDecisionEngine.HALLUCINATION_PATTERNS.some(pattern => pattern.test(t));
    const detected_lang = /[\u3040-\u30ff]/.test(t)
      ? 'ja'
      : /[\uac00-\ud7af]/.test(t)
        ? 'ko'
        : /[\u4e00-\u9fff]/.test(t)
          ? 'auto'
          : 'en';
    const words = t.match(/[A-Za-z]+/g) || [];
    const identifier =
      /\b[A-Z][A-Z0-9-]*\d[A-Za-z0-9-]*\b/.test(t) &&
      words.length <= 3 &&
      !/\b(?:i|you|we|they|he|she|it|is|are|was|were|have|has|will|can|could|should)\b/i.test(t);
    const base = (language: string) => language.split('-')[0];
    const sameLanguage =
      sourceLanguage !== 'auto' &&
      base(sourceLanguage) === base(targetLang) &&
      (!/^zh/.test(targetLang) ||
        sourceLanguage.toLowerCase() === targetLang.toLowerCase());
    const matchesScript = /^zh/.test(targetLang)
      ? /[\u3400-\u9fff]/.test(t) && !/[\u3040-\u30ff\uac00-\ud7af]/.test(t)
      : /^ja/.test(targetLang)
        ? /[\u3040-\u30ff\u3400-\u9fff]/.test(t)
        : /^ko/.test(targetLang)
          ? /[\uac00-\ud7af]/.test(t)
          : /[A-Za-z]/.test(t) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t);

    return {
      is_valid,
      needs_translation: is_valid && !identifier && !(sameLanguage && matchesScript),
      detected_lang,
      confidence: 0.85,
      source: 'fallback',
    };
  }
}

export { LayaDecisionEngine as JevDecisionEngine };
