export function protectedTextTokens(text: string): string[] {
  return text.match(/⟪WUPAGE\d+⟫/gu) ?? [];
}

// Accept only unambiguous changes to a token's typography. Missing, repeated
// or substituted IDs must never be guessed from their positions in a sentence.
export function normalizeProtectedText(source: string, translation: string): string | undefined {
  const normalized = translation.replace(
    /[⟪《〈<【\[{«「『]+\s*WUPAGE\s*(\d+)\s*[⟫》〉>】\]}»」』]+/giu,
    (_match, id: string) => `⟪WUPAGE${Number(id)}⟫`
  );
  const expected = protectedTextTokens(source).sort();
  const actual = protectedTextTokens(normalized).sort();
  return expected.length === actual.length && expected.every((token, index) => token === actual[index])
    ? normalized
    : undefined;
}
