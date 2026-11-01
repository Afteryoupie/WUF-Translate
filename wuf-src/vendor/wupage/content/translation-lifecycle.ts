let revision = 0;
export const documentTranslationRevision = (): number => revision;
export function invalidatePendingDocumentTranslations(): void { revision++; }
