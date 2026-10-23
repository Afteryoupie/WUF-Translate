import * as OpenCC from 'opencc-js';
import { OPENCC_VARIANTS, type OpenCCVariant } from '../types.ts';
import { WufProviderError } from './errors.ts';

const converterCache = new Map<OpenCCVariant, (text: string) => string>();

const VARIANT_MAP: Readonly<Record<OpenCCVariant, { from: string; to: string }>> = {
  s2twp: { from: 'cn', to: 'twp' },
  tw2sp: { from: 'twp', to: 'cn' },
  s2t: { from: 'cn', to: 't' },
  t2s: { from: 't', to: 'cn' },
};

function getConverter(variant: OpenCCVariant): (text: string) => string {
  if (!(OPENCC_VARIANTS as readonly string[]).includes(variant)) {
    throw new WufProviderError(`Unsupported OpenCC variant: ${String(variant)}`, {
      code: 'CONFIG_ERROR',
      provider: 'opencc',
    });
  }
  let fn = converterCache.get(variant);
  if (!fn) {
    const pair = VARIANT_MAP[variant];
    fn = OpenCC.Converter(pair);
    converterCache.set(variant, fn);
  }
  return fn;
}

export async function translateWithOpenCC(
  texts: string[],
  variant: OpenCCVariant = 's2twp',
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) {
    throw new WufProviderError('OpenCC conversion was cancelled', {
      code: 'ABORTED',
      provider: 'opencc',
    });
  }
  if (!Array.isArray(texts)) {
    throw new WufProviderError('OpenCC input texts must be an array of strings', {
      code: 'CONFIG_ERROR',
      provider: 'opencc',
    });
  }
  const convert = getConverter(variant);
  return texts.map(item => {
    if (typeof item !== 'string') {
      throw new WufProviderError('OpenCC input segment must be a string', {
        code: 'CONFIG_ERROR',
        provider: 'opencc',
      });
    }
    return convert(item);
  });
}
