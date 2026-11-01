import { getLocalRoute, normalizeLocalLanguage } from "../local/models";
import type { RuntimeResponse, TranslateBatchRequest } from "../shared/types";
import { ensureOffscreenDocument } from "./offscreen";
import { detectSourceLanguage } from "./source-language";

export async function requestLocal<T>(action: string, data?: unknown): Promise<T> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "bergamot-offscreen", action, data }) as RuntimeResponse;
  if (!response?.ok) throw new Error(response?.error ?? "本地翻译未能启动，请重新加载扩展。");
  return response.data as T;
}

export async function translateLocally(request: TranslateBatchRequest, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (!request.texts.length) return [];
  let source = request.sourceLang ?? "auto";
  if (source === "auto") {
    const detected = await detectSourceLanguage(request.texts, signal);
    if (!detected) {
      throw new Error("本地翻译无法可靠识别源语言，请在翻译设置中手动选择源语言。");
    }
    source = detected;
  }
  const route = getLocalRoute(source, request.targetLang);
  if (!route.length) return [...request.texts];
  signal?.throwIfAborted();
  return requestLocal<string[]>("translate", { ...request, sourceLang: normalizeLocalLanguage(source) });
}
