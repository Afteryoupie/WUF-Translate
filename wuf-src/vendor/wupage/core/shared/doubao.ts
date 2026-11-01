export const DOUBAO_PROTOCOL_VERSION = 1;
export const DOUBAO_TARGET_LANGUAGES: Readonly<Record<string, string>> = {
  "zh-CN": "zh", en: "en", ja: "ja", ko: "ko", fr: "fr", de: "de", es: "es", ru: "ru"
};

export function isDoubaoBrowserSupported(): boolean {
  try {
    return typeof chrome !== "undefined"
      && new URL(chrome.runtime.getURL("/")).protocol === "chrome-extension:";
  } catch {
    return false;
  }
}
