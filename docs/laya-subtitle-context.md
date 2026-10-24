# Laya 主題分類與最小詞義提示

2026-10-25。已實作並以真實 YouTube 字幕、實際 Laya／Apple 翻譯 API 與瀏覽器播放驗證。Laya 適合當領域選擇器；詞義改善來自它選中的人工定義詞義對照，並非模型自行產生詞典或驗證譯文。

## 最終路徑

1. 影片標題及開頭一分鐘字幕送給 Laya，最多 200／1500 字元。八類主題含「其他」，以兩種選項順序確認；每次最高機率至少 0.65、與第二名差至少 0.25，且類別一致才採用。這些是實驗性拒答門檻，不是準確率保證。
2. 分類結果每支影片快取，最多保留 32 支；服務工作者重啟後會重算。請求失敗不永久快取。不明確時使用原翻譯 prompt。
3. 每句只附上原文命中的詞義，最多四組，例如 `參考詞義（適用時）：body=機身；monopod=單腳架`。不把標題、樣本文字、前後文、長篇規則或完整詞典送給翻譯模型。無命中時新增字元為 0。
4. Laya 模式的斷句、音效清理、格式檢查與錯誤重試使用本地規則，不再逐句呼叫分類模型。自訂決策模型模式保留原流程。

目前有詞義對照的領域是攝影、汽車與園藝，目標為中文；其他領域／目標語言不強加中文詞義。翻譯快取包含實際 prompt，避免詞義提示改變後沿用舊譯文。播放端移除只按原文字串查詢的重複快取，統一由背景管理。

## 研究依據

使用 Exa 檢索 15 筆候選，涵蓋模型限制、字幕 metadata 與情境評估三個方向，再查核主要來源：

- [Laya 官方模型卡](https://huggingface.co/convaiinnovations/laya-multilingual)與[官方限制說明](https://nandhakishorm.github.io/laya/benchmarks/)：可作結構化分類，但機率、選項順序與新任務表現需要實測；不能把高信心當成正確率。
- [ACL 2025：電影 metadata 與字幕翻譯](https://aclanthology.org/2025.acl-srw.22/)：支持測試片名、類型等資訊的價值，但不代表 Apple 模型或本實作必然受益。
- [EMNLP 2023：Video-Helpful Multimodal Machine Translation](https://aclanthology.org/2023.emnlp-main.260/)：情境評估應針對實際歧義。這裡僅使用文字，沒有讓 Laya 看影像，因此不能宣稱理解畫面內容。

## 真實影片及詞義驗證

沿用已保存且有 SHA256 的三支影片字幕：[Plants for Boys](https://www.youtube.com/watch?v=IBJjyjGq3zI)、[Camera comparison](https://www.youtube.com/watch?v=EmbBr3aeZh0)、[Drifting](https://www.youtube.com/watch?v=IJlb2oRqpHM)。第一支為本次下載人工字幕，第二支為工作區既有 DownSub 自動字幕，第三支從使用者開啟的真實分頁匯出。

9 個開發案例與 9 個保留案例按原文多義詞預先選取，使用正式 30 秒 window 合併函式，不改寫原文。對照同一 Apple 後端、temperature 0，保存完整輸入與輸出。精簡版本重跑的是先前版本已使用過的保留集，不是全新盲測；同片段相關性高，不代表一般影片準確率。

| 原文詞義 | 原本譯法 | 精簡提示後 |
| --- | --- | --- |
| camera body | 身體 | 機身 |
| seat time | 座位時間 | 駕駛練習時間 |
| doing a donut | 做一個甜甜圈 | 定圓甩尾 |
| seat rails | 車架 | 座椅滑軌 |

逐項詞義複核由本助手判讀：原本 4/9、精簡版 8/9 符合目標詞義；不是獨立人工評審或整句品質評分。預先寫下的 regex 得分為 2/9、7/9，因未收錄「一個檔位」「種植土」「盆栽養土」等合理變體而有假陰性，不能直接稱為翻譯準確率。

仍未解決的例子是跨 window 的 `root ball`：本句只剩 `ball`，最小詞義提示未命中，因此仍譯為球體。另一限制是其他語意可能仍錯，例如 `fabrication efforts` 仍被譯為捏造／虛假說法，精簡版該句還把 `pop down` 譯成「飛往」；詞義命中不代表整句品質全面改善。本次不宣稱修正所有語意。

長版曾出現背景混入及子句漏譯，已捨棄。反例測試確認最終版能保留「吃甜甜圈」「身體痛」「玉項鍊」「追蹤包裹」四種字面意思；其中玉項鍊曾被過廣的 jade 規則誤導，現已縮限規則。

## 即時成本

相同 9 段字幕，原本翻譯 API 合計 **6.446 秒**，最小提示 **6.689 秒**（本次約 +3.8%，平均每段約 +27 ms）。這是一次暖機後的小樣本執行，不是普遍延遲保證，與輸出長度也有關。

最小版新增 prompt 長度為 `0, 23, 28, 24, 18, 21, 27, 21, 26` 字元，平均 **20.9 字元**；長版平均新增 652.7 字元，減少 **96.8%**。這是字元數，不冒稱 Apple tokenizer 的 token 數；該 API 未回傳 token 使用量。

每支影片的兩次主題判斷在這次暖機實測約 **188–197 ms**，冷啟動另計。本機真正背景管線驗證：三支影片、9 句翻譯共 **6 次**主題請求，**0 次**逐句分類請求，全部 HTTP 200、未截斷。實際 Edge 播放另確認兩次 Laya 請求後持續翻譯、沒有隨逐句翻譯增加分類次數，並在約 15:35 顯示「駕駛練習時間」。

## 重現與證據

在 `/Users/linjiade/LLM/WUF-Translate` 執行：

```sh
npm run typecheck
npm test
node scripts/benchmark-subtitle-context.mjs heldout
node scripts/verify-subtitle-context-runtime.mjs
```

需要上一輪保存的 `outputs/laya-youtube` 來源檔案。`outputs/subtitle-context/` 保存長版與最小版逐句輸出、API request、主題概率、反例、runtime 驗證、測試記錄及 `browser-minimal.png`。`translation-heldout.json` 為最小版；其 metadata 對照組不帶 topic，故等同無額外提示。舊長版在 `translation-heldout-long.json`。

TypeScript、45 項測試、diff 空白檢查及腳本語法檢查通過。依 code-review-skill、ponytail-review 檢查了快取、拒答、失敗退回、欄位長度與精簡流程；沒有新增套件或修改技能，沒有提交／推送 Git。
