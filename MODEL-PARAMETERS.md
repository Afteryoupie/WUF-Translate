# 模型參數文件對照

查核日期：2026-10-24。以下是官方文件與目前 WUF 原始碼的對照，不代表已對所有供應商或本機版本完成實測。本次只整理研究，沒有變更請求行為。

## 適合放入設定頁的欄位

| 欄位 | API 名稱 | 建議呈現方式 |
| --- | --- | --- |
| 隨機性 | `temperature` | 保留；可以留空，表示不送出、由服務決定。支援與限制應依模型顯示。 |
| 輸出 token 上限 | `max_tokens` 或 `max_completion_tokens` | 優先新增；整數、可留空。依服務選用其支援的欄位，不同時送兩個。這是整批請求的輸出上限，不是每個段落的字數。 |
| Top P | `top_p` | 優先新增；0–1，可留空。避免自動替每個模型灌入同一組採樣設定。 |
| 隨機種子 | `seed` | 可選整數，可留空；用途是重現測試，不能承諾跨供應商完全一致。 |
| 思考設定 | OpenRouter `reasoning`；本機依後端映射 | 保留並修正實際送出邏輯；只顯示模型支援的選項。 |
| 重複控制 | `frequency_penalty`、`presence_penalty` | 次優先；有支援才啟用。翻譯應忠實保留原文重複，不建議預設提高懲罰。 |
| 停止字串 | `stop` | 可選清單，預設不送。不能預設使用 WUF 分段標記，否則可能只翻完第一段便停止。 |

參數語義與一般範圍見 [OpenRouter Parameters](https://openrouter.ai/docs/api_reference/parameters)。翻譯適用性與優先順序是針對 WUF 的設計判斷，並非供應商保證的最佳值。

## 線上服務：OpenRouter

除了目前已有的排序與備援，可考慮：

- `provider.only`、`provider.ignore`、`provider.order`：限制或排列實際推論供應商。
- `provider.require_parameters`：只路由到支援所指定參數的供應商；也可能因此找不到可用端點。
- `provider.max_price.prompt`、`provider.max_price.completion`：輸入／輸出價格上限，單位為美元／百萬 tokens；這不是每次請求的總金額上限。
- `provider.preferred_max_latency`、`provider.preferred_min_throughput`：效能偏好，不是延遲或速度保證。較適合保留在 Extra Body。

上述為 OpenRouter 專屬功能，不能套用到所有 OpenAI 相容服務。參考 [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)。

OpenRouter 的 [Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) 回傳 `supported_parameters`，可作為欄位可用性的依據；還需注意實際路由端點的支援差異。不認識的自訂服務應標示「支援度未知」，不能假裝已偵測。

思考選項可讀取模型的 `reasoning.supported_efforts`、`default_effort`、`mandatory`。不能一律顯示相同的 low/medium/high/off；部分模型不允許關閉。`reasoning.exclude` 只是隱藏回傳的思考文字，不是關閉推論計算。多數服務的輸出 token 額度也包含思考 tokens，額度太小可能沒有可見譯文。參考 [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。

## 本機服務

| 後端 | 文件可參考的參數 | WUF 的處理建議 |
| --- | --- | --- |
| llama.cpp | `top_k`、`min_p`、`repeat_penalty`、`repeat_last_n`；依模型模板使用 `reasoning_effort`、`chat_template_kwargs` | 後端專屬欄位或 Extra Body；不要把 OpenRouter 的 `repetition_penalty` 名稱直接照搬。 |
| Ollama OpenAI 相容 API | `top_p`、`max_tokens`、`seed`、`frequency_penalty`、`presence_penalty`、`stop`、思考相關欄位 | 使用相容 API 的參數名稱；不能直接把原生 `/api/chat` 的 `options` 物件當成 `/v1/chat/completions` 規格。 |

參考 [llama.cpp Server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) 與 [Ollama OpenAI Compatibility](https://docs.ollama.com/api/openai-compatibility)。本機安裝版本可能落後於目前文件，仍需實測所選後端與模型。

Context size、GPU layers、KV cache 等載入／伺服器參數應由 Watchdog 或後端管理，不適合當成通用翻譯請求欄位。Ollama 文件也明確指出，其 OpenAI 相容 API 不能直接設定 context size。

## 目前 WUF 的實際行為

檢查位置：`wuf-src/providers/openai-compat.ts` 的 `buildThinkingPayload` 與 `buildChatCompletionRequestBody`。

1. Extra Body 會被攤平成請求最外層。因此填 `{"top_p":0.9}`，不是再包一層 `{"extra_body":{"top_p":0.9}}`。
2. 表單的 Temperature 非空時會覆蓋 Extra Body 的 `temperature`。
3. 表單決定 `messages` 與 `model`；不要在 Extra Body 重複指定。
4. OpenRouter 的 Thinking 非 auto 時，會整個覆蓋 Extra Body 的 `reasoning`。auto 才保留該物件。
5. OpenRouter 的 `provider.sort` 與 `provider.allow_fallbacks` 會被表單值覆蓋；其他 provider 欄位仍保留。排序 auto 目前實際會送 throughput，未真正交還服務預設。
6. 本機 Thinking 表單目前沒有映射成任何請求欄位，不能宣稱選項已生效。本機端可先透過 Extra Body 明確提供後端支援的欄位，但仍須驗證模型模板。
7. Go Watchdog 的 `inference`／`AdaptPayload` 會轉送一般 JSON 欄位並調整模型與 WUF 語言提示；這不等於後端接受所有額外欄位。

下列是 Extra Body 語法示意，不是測得的最佳翻譯參數；是否支援與 token 額度應依所選模型、批次大小調整：

```json
{
  "max_tokens": 4096,
  "top_p": 0.9,
  "seed": 42
}
```

## 建議的頁面分組

全部直接顯示，不使用折疊選單：

1. 模型生成：Temperature、輸出上限、Top P、Seed、思考設定。
2. 服務專屬：OpenRouter 路由，或已確認的本機採樣參數。
3. WUF 翻譯排程：逾時、並行數、每批段落與字元上限、強化分段標記。
4. 提示詞與額外請求：System Prompt、Extra Body，以及實際生效參數預覽／覆蓋提示。

並行數、每批段落、每批字元與強化分段標記都是 WUF 的客戶端行為，並非供應商採樣參數。

不建議直接新增 `tools`、`response_format`、`stream`、多候選輸出等通用開關：目前翻譯解析流程依賴純文字與分段契約，這些選項需要配套的請求及回應處理，不能只增加輸入框。
