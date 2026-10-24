export const SUBTITLE_TOPICS = [
  { id: 'photography', description: 'Photography and cameras: lenses, exposure, lighting, taking photographs.' },
  { id: 'automotive', description: 'Cars and motorsport: engines, repairs, tires, racing and drifting.' },
  { id: 'gardening', description: 'Plants and gardening: growing, watering and caring for houseplants.' },
  { id: 'cooking', description: 'Cooking and food: ingredients, recipes and preparing meals.' },
  { id: 'computing', description: 'Computing and software: programming, applications and digital technology.' },
  { id: 'finance', description: 'Business and finance: investing, economics, money and markets.' },
  { id: 'health', description: 'Health and fitness: exercise, medicine, symptoms and wellness.' },
  { id: 'other', description: 'Other, mixed subjects or insufficient information.' },
] as const;

export type SubtitleTopicId = typeof SUBTITLE_TOPICS[number]['id'];

export interface SubtitleTranslationContext {
  videoId?: string;
  title?: string;
  sample?: string;
  topic?: SubtitleTopicId;
}

export interface SubtitleTopicDecision {
  topic: SubtitleTopicId | null;
  confidence: number | null;
  reason: string;
}

export function sanitizeSubtitleContext(value?: SubtitleTranslationContext): SubtitleTranslationContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const clip = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  // Caller-supplied topic labels are ignored; the background owns classification.
  const context = { videoId: clip(value.videoId, 32), title: clip(value.title, 200), sample: clip(value.sample, 1500) };
  return Object.values(context).some(Boolean) ? context : undefined;
}

export function buildSubtitleTranslationContext(
  segments: Array<{ text: string; startMs: number }>,
  title: string, videoId: string,
): SubtitleTranslationContext {
  const join = (rows: Array<{ text: string }>) => rows.map(s => s.text).join(' ')
    .replace(/\[(?:music|applause|laughter|silence)\]/gi, ' ').replace(/(?:^|\s)>>\s*/g, ' ').trim();
  return sanitizeSubtitleContext({ videoId, title,
    sample: join(segments.filter(s => s.startMs < (segments[0]?.startMs || 0) + 60000)),
  }) || {};
}

const terminology: Partial<Record<SubtitleTopicId, Array<[RegExp, string]>>> = {
  photography: [
    [/\bbody\b/i, 'body=機身'], [/\bmount\b/i, 'mount=鏡頭接環'],
    [/\bmonopod\b/i, 'monopod=單腳架'], [/\bstrobes?\b/i, 'strobe=閃光燈'],
    [/\bone stop\b/i, 'one stop=一級曝光'],
  ],
  gardening: [
    [/\bsnake plant\b/i, 'snake plant=虎尾蘭'],
    [/\bjade plant\b|\b(?:kill|water|overwater|grow|repot)\b.{0,16}\bjade\b/i, 'jade plant=玉樹'],
    [/\broot ball\b/i, 'root ball=根團'], [/\broot rot\b/i, 'root rot=根腐病'],
    [/\bpotting mix\b/i, 'potting mix=盆栽培養土'], [/\bpots?\b/i, 'pot=花盆'],
  ],
  automotive: [
    [/\b(?:do|doing|done|did|attempt\w*)\b.{0,24}\bdonuts?\b|\bdonuts?\b.{0,20}\b(?:left|right|drift|car)\b/i, 'donut=定圓甩尾'],
    [/\bseat time\b/i, 'seat time=駕駛練習時間'], [/\bharness\b/i, 'harness=賽車安全帶'],
    [/\bseat rails?\b/i, 'seat rails=座椅滑軌'],
    [/\bon (?:the |a )?track\b|\b(?:race|racing|drift) track\b/i, 'track=賽道'],
  ],
};

export function subtitleContextPrompt(prompt: string, context?: SubtitleTranslationContext,
  sourceTexts: string[] = [], targetLanguage: string = 'zh-TW'): string {
  if (!context?.topic || !/^zh(?:-|$)/i.test(targetLanguage)) return prompt;
  const source = sourceTexts.join(' ');
  const hints = (terminology[context.topic] || [])
    .filter(([pattern]) => pattern.test(source)).map(([,hint]) => hint).slice(0, 4);
  // ponytail: title/sample stay in the one-time classifier; only used senses reach translation.
  return hints.length ? `${prompt}\n參考詞義（適用時）：${hints.join('；')}` : prompt;
}
