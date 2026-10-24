# Laya 真實 YouTube 字幕測試

測試日期：2026-10-25，macOS M3／PyTorch MPS。結論：本次樣本**未證明 Laya 能提升翻譯語意品質**。它不是翻譯模型，也沒有比較原文和譯文的語意。相同清理規則下，多數輸出完全相同，額外推論會增加等待時間。建議把 Laya 視為可選的字幕結構實驗功能；追求速度時可關閉，確定性的清理與格式保護仍會執行。

## 修正前的問題

1. 已安裝 Watchdog 的 `launch.json` 指向搬家前的 `translation_tools/WUF-Watchdog/.../python3`，實際不存在。已備份設定、更新為 `/Users/linjiade/LLM/WUF-Watchdog/watchdog/.venv/bin/python3`、重新簽署原生 app 並重新啟動；實際 `/api/decision/status` 已確認 MPS 運行。
2. YouTube window 沒有呼叫既有 `refineAsrBoundaries`；背景 `wuf:translate-text` 沒有呼叫既有字幕決策管線。設定選 Laya 並不代表該路徑真的使用模型。現在已接通。
3. 關閉 Laya 時也一併略過音效清理及格式檢查，會把規則清理的效果誤算成模型效果。現在兩種模式共用本地保護，僅模型判斷不同。

## 資料與方法

| 影片 | 字幕來源 | 用途 |
| --- | --- | --- |
| [Plants for Boys](https://www.youtube.com/watch?v=IBJjyjGq3zI) | 本次直接從 YouTube 下載英文人工字幕 json3 與 metadata | 一般口語 |
| [$2000 VS $10,000 Camera](https://www.youtube.com/watch?v=EmbBr3aeZh0) | 工作區既有 DownSub 英文自動字幕 SRT；本次即時自動字幕下載遭 HTTP 429，未冒稱新下載 | 技術、型號、品牌 |
| [I went drifting as a total noob](https://www.youtube.com/watch?v=IJlb2oRqpHM) | 從使用者實際開啟的 YouTube 分頁匯出英文自動字幕；時間精確至秒 | 第三支影片及瀏覽器驗證 |

- 翻譯均用實際本機 Apple Foundation Models 後端，`temperature: 0`，同一字幕 prompt；Laya 為本機真實模型 HTTP 推論，未使用模擬模型輸出。
- 保留原始字幕、SHA256、原始 API 決策、逐段譯文與耗時。來源原文可能含 ASR 誤辨，未人工改成較容易翻譯的句子。
- 開發：前兩支影片 0–60 秒。初次驗證：三支影片 120–180 秒。修正完成後確認：三支影片 240–300 秒，這批片段事先未用來調整模型或門檻。
- 使用正式斷句函式及背景 `handleRuntimeMessage`，本機翻譯逐句依序執行，兩組之間清空快取。人工字幕不執行 ASR 邊界推論。
- 原始比較的 `off` 沒有本地保護，不能用來推論 Laya 模型效果；以 `runtime-isolated-heldout.json` 及 `runtime-final-confirmation.json` 的共用保護比較為準。
- 模型機率不是品質分數。本次沒有獨立人工評審、多語言參考譯文或標準化語意評分；因此不宣稱統計上的品質提升或品質等價。

## 最後確認：同樣本地保護，僅 Laya 開關不同

| 影片片段 | 原始字幕段數 | 關閉／啟用譯文組數 | 關閉耗時 | 啟用耗時 |
| --- | ---: | ---: | ---: | ---: |
| Plants 240–270 秒 | 18 | 4／4 | 3.582 秒 | 3.653 秒 |
| Plants 270–300 秒 | 15 | 4／4 | 3.801 秒 | 4.227 秒 |
| Camera 240–270 秒 | 14 | 6／6 | 3.275 秒 | 4.336 秒 |
| Camera 270–300 秒 | 9 | 5／5 | 2.587 秒 | 3.262 秒 |
| Drifting 240–270 秒 | 13 | 4／4 | 3.472 秒 | 4.427 秒 |
| Drifting 270–300 秒 | 11 | 4／4 | 3.311 秒 | 4.056 秒 |
| 合計 | **80** | **27／27** | **20.028 秒** | **23.961 秒** |

同一批 3 分鐘字幕，啟用多耗時約 **3.933 秒（19.6%）**。這是字幕批次處理時間，並非每秒播放的固定延遲；樣本小、順序固定且沒有重複隨機化測量，比例只能代表本次執行。Laya 的 58 次 HTTP 決策共約 3.920 秒。

25 組輸入分組及輸出逐字相同；另外 2 組因 Laya 改變 Camera 的片段邊界而無法逐組直接比較。檢視結果未發現可確認的語意修正，不能把分組不同當作更準確。這批模型過濾／保留／修復觸發均為 0，沒有刪除正常對話或出現未解決的格式錯誤。其他決策多落在保留本地規則的區間。

這也有明確的能力限制：ASR 原文中的品牌誤辨仍會傳入翻譯；Laya 的格式分類不會修正品牌、專有名詞或譯文語意。僅看到格式分類接受譯文，不能稱為翻譯品質通過。

## 已驗證的實際改善

- 在相同 120–180 秒片段重跑，關閉模型時，譯文中 `[music]`／`[音樂]` 殘留由 **3 組降為 0 組**。這項改善來自本地清理，不依賴 Laya。
- 正常對話保留，獨立音效列保留時間邊界；被刻意清空的字幕不再讓整個 window 判定失敗並反覆重試。
- 格式錯誤只重譯失敗的部分一次，重試繞過快取，通過檢查的結果才寫入快取。整合測試用刻意損壞的 JSON／程式碼區塊驗證此行為；這是故障注入測試，並非聲稱真實影片產生過同樣錯誤。
- 快取識別包含翻譯端點、模型、prompt 及 OpenCC 設定，避免改模型／提示後繼續顯示舊譯文。
- 從 timedtext URL 傳遞實際來源語言與 ASR 類型，只有 ASR 才呼叫模型斷句。
- 使用者重載最後一版後，已在實際 Drifting 播放分頁啟用字幕：無 benchmark 程序同時運行，Laya log 新增 **20 筆 HTTP 200**；YouTube 約 1:56 顯示繁體字幕，截圖保存於輸出目錄。這證明實際播放管線接通，不是語意品質提升的證明。

## 重現與證據

在 `/Users/linjiade/LLM/WUF-Translate` 執行：

```sh
npm run typecheck
npm test
node scripts/benchmark-laya-youtube.mjs runtime-final confirmation
```

benchmark 使用 `outputs/laya-youtube` 的來源檔案，依序執行，避免同時播放翻譯影片或啟動其他模型測試造成耗時競爭。重新取得人工字幕：

```sh
/opt/homebrew/bin/yt-dlp --skip-download --write-subs --sub-langs en --sub-format json3 --write-info-json -o '/Users/linjiade/LLM/WUF-Translate/outputs/laya-youtube/IBJjyjGq3zI.manual.%(ext)s' 'https://www.youtube.com/watch?v=IBJjyjGq3zI'
```

原始證據在 `outputs/laya-youtube/`（已在既有 `.gitignore` 中排除）：`before-development.json`、`runtime-heldout.json`、`runtime-isolated-heldout.json`、`runtime-final-confirmation.json`、`browser-before-status.json`、`browser-after-status.json`、`browser-new-model.log`、`browser-final.png`、`tests-final.log`。

TypeScript typecheck、41 項測試、`git diff --check` 均通過。已依 code-review-skill 檢視資料流、錯誤重試與快取；ponytail-review 未發現需要另加框架或依賴，重用既有決策管線。未修改技能、未提交或推送 Git，工作區原有其他改動保留。
