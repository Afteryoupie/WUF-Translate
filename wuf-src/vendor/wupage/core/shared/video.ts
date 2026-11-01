export interface VideoTranslationSettings {
  enabled: boolean;
  showOriginal: boolean;
  fontSize: 18 | 22 | 26;
  background: "soft" | "none";
  preferredSource: string;
  enabledSites: string[];
}

/** Playback breaks close size ties without allowing a small autoplay ad to win. */
export function videoPriority(area: number, playing: boolean): number { return area * (playing ? 1.5 : 1); }

export function normalizeVideoTranslation(value: unknown): VideoTranslationSettings {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: data.enabled !== false,
    showOriginal: data.showOriginal !== false,
    fontSize: data.fontSize === 18 || data.fontSize === 26 ? data.fontSize : 22,
    background: data.background === "none" ? "none" : "soft",
    preferredSource: typeof data.preferredSource === "string" && /^[\w-]{1,32}$/u.test(data.preferredSource) ? data.preferredSource : "auto",
    enabledSites: Array.isArray(data.enabledSites) ? [...new Set(data.enabledSites.filter((site): site is string => typeof site === "string" && /^[\w.-]{1,200}$/u.test(site)))].slice(0, 100) : []
  };
}

export function sameVideoLanguage(a: string, b: string): boolean {
  const family = (value: string) => {
    const normalized = value.toLowerCase().replaceAll("_", "-");
    if (/^zh(?:-(?:tw|hk|mo|hant))/.test(normalized)) return "zh-Hant";
    if (/^zh(?:-|$)/.test(normalized)) return "zh-Hans";
    return normalized.split("-")[0];
  };
  return a !== "auto" && b !== "auto" && family(a) === family(b);
}
