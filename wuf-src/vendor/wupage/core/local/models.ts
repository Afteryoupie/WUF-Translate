import catalog from "./catalog.json";

export interface ModelFile {
  role: string;
  name: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface LocalModel {
  id: string;
  from: string;
  to: string;
  label: string;
  version: string;
  files: ModelFile[];
}

// Pinned Mozilla Remote Settings records. No registry request is needed at runtime.
export const LOCAL_MODELS: LocalModel[] = catalog;
export const LOCAL_MODEL_CACHE = "wupage.bergamot.models.v1";
export const LOCAL_RESOURCE_NOTICE = "首次使用需额外下载所需语言模型（每个方向约 35–55 MB，以列表为准），并占用相应磁盘空间。翻译使用本机 CPU，可能增加耗电、发热，运行内存可能达数百 MB，实际取决于设备和文本。默认单线程，空闲 60 秒后释放运行内存。模型准备好后可离线翻译，文本不会发送到在线翻译服务。";

export interface LocalModelState {
  id: string;
  state: "missing" | "partial" | "ready" | "downloading" | "error";
  downloaded: number;
  total: number;
  error?: string;
}

export interface LocalModelStatus {
  models: LocalModelState[];
  downloading?: string;
}

export function modelBytes(model: LocalModel): number {
  return model.files.reduce((sum, file) => sum + file.bytes, 0);
}

export function getLocalModel(id: string): LocalModel {
  const model = LOCAL_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error("未找到该本地语言模型。");
  return model;
}

export function normalizeLocalLanguage(language: string): string {
  const normalized = language.toLowerCase().replaceAll("_", "-");
  if (["zh", "zh-cn", "zh-sg", "zh-hans", "zh-hans-cn"].includes(normalized)) return "zh-Hans";
  if (normalized.startsWith("zh")) return normalized;
  return normalized.split("-")[0];
}

export function getLocalRoute(source: string, target: string): LocalModel[] {
  const from = normalizeLocalLanguage(source);
  const to = normalizeLocalLanguage(target);
  const supported = new Set(LOCAL_MODELS.flatMap((model) => [model.from, model.to]));
  if (!supported.has(from) || !supported.has(to)) {
    throw new Error("本地实验服务支持英语、简体中文、日语、德语、法语、西班牙语和俄语。请更换语言或翻译服务。");
  }
  if (from === to) return [];
  const direct = LOCAL_MODELS.find((model) => model.from === from && model.to === to);
  if (direct) return [direct];
  return [getLocalModel(`${from}-en`), getLocalModel(`en-${to}`)];
}
