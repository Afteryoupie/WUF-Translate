import type { DualServiceProviderConfig, ProviderConfig, TranslationApiOptions } from "./types";

export function supportsServiceMode(provider: ProviderConfig): provider is DualServiceProviderConfig {
  return ["microsoft-web-translate", "google-web-translate", "tencent-transmart",
    "yandex-web-translate", "volcengine-web-translate", "mymemory"].includes(provider.type);
}

export function translationApiOptions(provider: DualServiceProviderConfig): TranslationApiOptions {
  const defaults: TranslationApiOptions = provider.type === "microsoft-web-translate"
    ? { endpoint: "https://api.cognitive.microsofttranslator.com", region: "" }
    : provider.type === "tencent-transmart"
      ? { endpoint: "https://tokenhub.tencentmaas.com/v1", model: "hy-mt2-lite" }
      : provider.type === "volcengine-web-translate" ? { region: "cn-north-1" } : {};
  return { ...defaults, ...provider.api };
}

export function normalizeServiceConfig(provider: DualServiceProviderConfig): DualServiceProviderConfig {
  const api: TranslationApiOptions = {};
  if (provider.api && typeof provider.api === "object") {
    for (const name of ["apiKey", "endpoint", "region", "folderId", "accessKeyId", "secretAccessKey", "model"] as const) {
      if (typeof provider.api[name] === "string") api[name] = provider.api[name].trim();
    }
  }
  return { ...provider, serviceMode: provider.serviceMode === "api" ? "api" : "free",
    ...(Object.keys(api).length ? { api } : { api: undefined }) };
}
