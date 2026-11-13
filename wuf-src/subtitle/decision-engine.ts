export interface SubtitleFilterVerdict {
  is_valid: boolean;
  needs_translation: boolean;
  detected_lang: string;
  confidence: number;
  source: 'fallback';
}

export interface SubtitleFormatVerdict {
  needs_repair: boolean;
  reason: 'format' | null;
  source: 'fallback';
}

export class SubtitleDecisionEngine {
  lastError: string | null = null;

  static HALLUCINATION_PATTERNS: readonly RegExp[] = [
    /^\[(音楽|拍手|笑い|歓声|music|applause|laughter|silence)\]$/i,
    /^[♪♫♩♬\s.,!?:;_\-]+$/,
  ];

  async evaluateBatch(
    texts: string[],
    targetLang: string = 'zh-TW',
    sourceLanguage: string = 'auto',
  ): Promise<SubtitleFilterVerdict[]> {
    this.lastError = null;
    if (!Array.isArray(texts)) return [];
    return texts.map(text => this.fallbackEvaluate(text, targetLang, sourceLanguage));
  }

  async reviewFormatBatch(
    texts: string[],
    translations: Array<string | null | undefined>,
  ): Promise<SubtitleFormatVerdict[]> {
    this.lastError = null;
    return texts.map((_, i) => this.fallbackReviewFormat(translations[i]));
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

  fallbackEvaluate(
    text: string,
    targetLang: string = 'zh-TW',
    sourceLanguage: string = 'auto',
  ): SubtitleFilterVerdict {
    const t = (text || '').trim();
    const is_valid =
      t.length > 0 &&
      !SubtitleDecisionEngine.HALLUCINATION_PATTERNS.some(pattern => pattern.test(t));
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
