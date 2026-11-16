# YouTube 本機與 Google 字幕改善 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans，逐項實作並依 Checkbox 驗收。此文件是規劃，未代表功能已完成。

**Goal:** 縮短當前首句與跳轉後等待時間，消除過期字幕工作對播放與跳轉的阻塞；預期可提高準時率，但本版不量測、不宣稱（見文末）。

**Architecture:** 保留既有字幕攔截、規則合句、翻譯服務與快取。本機與 Google 字幕共用全片句子排程器，取代固定區段完成制，並分別採單路與最多 3 路單句請求；每完成一個請求便重新依播放位置選取下一句。顯示仍由影片時間軸決定。

**Tech Stack:** TypeScript、Chrome extension runtime messaging、Node test、esbuild；不新增相依套件。

**Spec:** 本文件以下「行為規格」為此次設計依據。

## 已查證事實（2026-11-16，依現有程式碼）

- `WufProviderError`（`wuf-src/providers/errors.ts`）有 `code`（TIMEOUT／ABORTED／HTTP_ERROR／INVALID_RESPONSE／CONFIG_ERROR／WATCHDOG_ERROR）與 `status?: number`；background 回傳 `{ ok:false, error:{ code, message, status } }`；Google provider 將 `response.status` 放入錯誤，故 429／401／403 可由 `error.status` 判斷，**不需擴充協定**。`retryAfterMs` 僅出現在網頁翻譯錯誤路徑，字幕路徑不會有，不予使用。
- `background/index.ts` 與 `providers/` 皆無自動重試，外層重試不會疊加；但背景格式修復最多多 1 次模型呼叫，一次嘗試最壞為 2 次推論。
- 目前字幕請求未接入背景的網頁取消控制器；ABORTED 非正常字幕控制流程，但仍依下列規則防禦處理，不假設永遠不會發生。
- 本機服務斷線／準備失敗可能來自不同路徑：HTTP 請求可回傳無 status 的 HTTP_ERROR，ensureLocalLlamaServer 的非 WufProviderError 例外則會被包成 WATCHDOG_ERROR（openai-compat.ts）；它在每次本機翻譯請求前執行；失敗可能經過 Native Host 喚醒、輪詢或模型載入等待，不能假設會快速返回，WATCHDOG_ERROR 仍納入斷路計數。不可將所有斷線等同單一錯誤碼；擴充功能重新載入後 `runtime-client.ts` 回傳 `SEND_MESSAGE_FAILED`／`RUNTIME_UNAVAILABLE`；背景未分類例外回傳 `INTERNAL_ERROR`（`background/index.ts` catch-all）。
- 現有 regression「Cross-window heuristicMergeAsr…」使用 `engine: 'google'`，不是合法 engine id，實際走的是非本機的整批分支；路由只認精確 id，`'google'` 不會進新 worker。
- 字幕引擎共四種（`types.ts` 的 `TRANSLATION_ENGINES`）：本計畫只改 `openai-compat-local`（容量 1）與 `google-translate`（容量 3）；`openai-compat-online`、`microsoft-translate` 保留既有區段路徑。
- 顯示端 `renderYouTubeDisplayCue` 在重疊時取 startMs 最晚且文字非空的 cue。
- 目前未提交補丁（`content-youtube.ts` 本機分支）：失敗時 `return false` 會讓整個視窗停止；以「跨視窗」判斷跳轉會把正常播放跨界誤判為跳轉。兩者皆由本計畫取代。

## Global Constraints

- 改善本機與 Google 的 YouTube 字幕；不改網頁翻譯排程。
- 本機字幕最多一個尚未結束的翻譯請求；不假設多路並行會加速。
- 不自動暫停影片、不以舊中文遮住新英文、不自動改用外部服務。
- 保留完整句子與原始時間戳，不為追求首句速度截斷當前句子。
- 不移除格式修復、快取隔離、字幕去重與跨影片過期結果檢查。
- 選句純函式不依賴 DOM；非同步 worker 負責容量、重試與生命週期，兩者分開測試。只實作此次 YouTube 字幕需要的介面，不建立通用引擎框架。
- 此輪不新增設定介面、自動調參、串流翻譯或跨程序取消協定。
- 原先補丁保留到新排程測試通過，切換後刪除被取代的本機與 Google 區段分支。依 session 引擎二選一：本機／Google 走新 worker，其他兩種引擎走既有區段路徑；同一 session 不得同時運作兩套排程，`triggerAheadOfTimeWorker`／seek 觸發的 `translateWindowByIndex` 須對本機與 Google 直接返回（本機自 Task 2 起、Google 自 Task 2G 起；Task 2 與 2G 之間 Google 仍走舊路徑）。

## 行為規格

### 1. 啟動與準備

1. 開啟翻譯時讀取設定、取得字幕；只有本機引擎需要確認本機服務可用，Google 不等待本機預熱。既有預熱僅代表服務準備，不宣稱已完成模型推論暖機。
2. 重複設定讀取／預熱沿用進行中的工作；不得新增一個阻擋已有快取顯示的等待關卡。
3. 原始字幕以時間排序，沿用 heuristicMergeAsr 產生翻譯句子；相同字幕不重建排程。
4. 先更新當前畫面，再啟動排程。當前句已有譯文時立即顯示。

### 2. 句子選取

使用影片 currentTime，而非牆鐘時間決定優先順序：

1. 選取 startMs <= nowMs < endMs、尚未完成且未在冷卻中的當前句；多句重疊時取 startMs 最晚者，與 renderYouTubeDisplayCue 的顯示優先順序一致；同值保留清單原有順序（不依字串 id 排序）。
2. 若沒有當前待翻句，選取預先翻譯範圍內 startMs 最早的未完成句。
3. endMs <= nowMs 的句子不發送新翻譯請求；日後倒轉時再重新成為候選。
4. 每次回應、seeked、timeupdate、playing、ratechange、字幕更新及重試計時器觸發時重新評估。
5. 單一 worker 實例依引擎容量派送：本機名額已滿時只記錄需要重新評估；Google 補滿最多 3 個名額。finally 釋放名額並重新評估，防止漏掉喚醒。
6. 沒有工作就停止迴圈，依事件或重試時間喚醒，不忙等、不以 50ms 固定延遲拖慢成功路徑。

### 3. 緩衝

- 全程只有一個 `session.generation`：字幕內容／時間軸變更與翻譯設定變更都遞增它。句子身分限定於一個 generation：合句後按順序指派 id；工作鍵為 generation + id。相同原始字幕不重建 generation，內容或時間軸變更則遞增 generation，不以同毫秒同文字的序號跨版本推斷身分。
- 字幕更新時可重用相同文字且翻譯設定相同的合格翻譯內容，但不得直接保留舊句子的完成狀態或 displayCues。必須以新的 startMs、endMs 與 sourceSegs 重新建立顯示字幕；舊在途結果不能寫入新 generation。
- 不新增持久化快取；優先沿用現有背景翻譯快取。即使重新請求命中快取，時間軸仍由新句子決定。

- 第一版固定目標為「前方 30 秒實際播放時間」；媒體時間範圍為 nowMs + clamp(30000 * playbackRate, 20000, 90000)ms（0.5 倍速仍至少緩衝 20 秒）。
- 1 倍速處理前方 30 秒，2 倍速處理前方 60 秒。這是待實測的起始值，不是速度保證。
- 以範圍內待翻句是否全部處理完成判定緩衝，不以最遠一筆譯文時間代表中間都已就緒。
- 字幕空白區間不視為翻譯缺口；intentionalEmpty 視為已完成。
- 暫停時仍可補足有限緩衝，達標即停止。停用翻譯後不再發送工作。

### 4. 跳轉、設定與影片生命週期

- 同區段或跨區段跳轉一律重排，不再依 30 秒邊界決定是否停止舊工作。
- 已送出的單句允許完成；它仍屬於同一影片、字幕與設定時，可保存正確時間戳的結果，但只顯示當下時間匹配的字幕。
- 請求完成後先處理新位置，不繼續消耗舊的待翻清單。
- 更換影片、字幕來源、來源語言、目標語言、端點、模型或翻譯相關設定時增加 generation，清除不適用的顯示結果與句子狀態。
- 設定變更入口：content adapter 監聽 chrome.storage.onChanged 的 sync/wufSettings 與 local/wufSecrets（含刪除），忽略翻譯快取與其他儲存事件。設定事件先暫停派送並使舊結果失效，再重新取得設定快照；讀取完成後僅在字幕仍啟用、影片未再次變更時建立更大的 generation 並喚醒。使用設定讀取序號丟棄反序回應；停用期間只更新設定，不自動重新啟用。讀到新快照後，以 `JSON.stringify([runtimeSettings.subtitles, subtitleProvider])` 與目前 session 綁定的值比較（僅存記憶體、不記錄、不寫診斷）；相同則恢復派送、不遞增 generation，避免主題等無關設定（popup 的 `saveSettings({ theme })` 也寫入 wufSettings）清空字幕；不同才重建。storage 事件的 newValue／oldValue（含 wufSecrets）只作觸發，不讀取內容、不保存。不另建差異框架；dispose 移除監聽。設定讀取失敗保留停止狀態並顯示錯誤。
- 所有非同步結果在寫入前驗證 generation。舊請求收尾不可清除新 session 的狀態。
- 暫不實作真正的服務端取消；瀏覽器中止 HTTP 不一定會停止本機推論，因此不將取消當作性能承諾。

### 5. 快取與失敗處理

- 沿用背景服務快取身分：來源／目標語言、引擎、端點、模型、提示詞及 OpenCC 設定。
- 相同文字的每次出現保留各自時間戳；只共享翻譯內容。
- 單句格式修復沿用既有一次修復流程，不新增正常句子的模型判斷呼叫。
- 外層每句總嘗試最多 3 次（即重試 2 次），冷卻分別 1 秒、3 秒；冷卻期間允許處理其他句子，禁止 timeupdate 造成重試風暴。
- 已過期句不重試。依 `error.status`／`error.code` 分類，不靠錯誤文字判斷：
  - **不可恢復**（呼叫 `stop()`、顯示明確錯誤）：401／403、`CONFIG_ERROR`、`SEND_MESSAGE_FAILED`、`RUNTIME_UNAVAILABLE`、`INTERNAL_ERROR`（含 adapter 將未分類例外轉成的同碼）。
  - **引擎級暫停**：每個已派送請求都計入句子總嘗試次數（包括 429、網路錯誤及探測）；等待計時器本身不計次數。429 冷卻至少 3000ms；正常派送模式下成功回應會重設連續失敗計數；依回應完成順序連續 3 次 HTTP_ERROR 無 status、5xx 或 WATCHDOG_ERROR（可為同一句），開啟 5s → 10s → 30s 上限退避。冷卻到期只派送一個仍可嘗試的當前句；沒有當前候選時選最近的範圍內未來句。沒有候選則停止，等待播放／跳轉事件，不建立空轉探測。探測成功才關閉斷路並重設退避；符合斷路條件的探測失敗則進入下一級冷卻，429 仍至少等待 3000ms。非斷路類失敗依各自規則處理，保留單路探測模式。進入斷路前已在途請求的成功不能提前解除冷卻。所有暫停期限合併取較晚者，不能被較短冷卻覆蓋；每引擎只保留一個喚醒計時器。
  - **逾時**（`TIMEOUT`）：本機僅在該句仍為當前句或位於緩衝範圍內時重試，且最多允許 1 次逾時後重試，同時不超過每句 3 次總嘗試；Google 依一般重試規則。`WATCHDOG_ERROR` 只走上方斷路規則與每句 3 次上限，不另設逾時重試。
  - **`ABORTED`**：視為該句終止，不重試，不另設規則。
  - 其餘（`INVALID_RESPONSE` 等）依一般重試規則。
- 回應驗證：intentionalEmpty 為 true 時可將空字串視為 done，且不產生 displayCue；其他成功回應必須有非空白 translation，否則轉為 INVALID_RESPONSE。intentionalEmpty 的當前句不顯示等待或失敗提示，沿用原生字幕回退規則。
- 成功、intentionalEmpty、冷卻、終止失敗分開記錄；失敗不得被標為成功或污染快取。
- 本輪達重試上限保留失敗狀態；使用者重新啟用翻譯可重設重試次數並沿用成功快取。

### 6. 畫面

- 譯文有效：顯示中文並隱藏原生字幕。
- 有當前待翻句但尚未就緒：保留原文，等待超過 300ms 顯示「翻譯中…」。
- 沒有對應字幕：清除譯文與等待提示，不將正常靜音誤報為延遲。
- 終止錯誤：顯示「翻譯暫時失敗」；認證錯誤提示檢查連線設定。
- 狀態提示放在不會被原生字幕隱藏規則一起隱藏的位置；切換影片、停用與銷毀時清除計時器。
- 不保留上一句中文冒充當前譯文，也不單靠永久隱藏英文掩蓋跟不上的問題。

### 7. 量測

用 performance.now 記錄事件耗時，影片 currentTime 記錄播放位置：

- 啟用至第一個當前有效譯文顯示的時間；另記字幕資料可用至顯示時間，區分字幕取得與翻譯等待。
- 每句發送至回應耗時、重試次數、跳轉後首句等待。
- 準時率與未覆蓋秒數列為第二版：背景分頁 timeupdate 被節流會使數據失真；若做，須以 currentTime 差值計算並排除暫停與背景分頁。
- 僅在記憶體保留最近 200 筆診斷事件，不記字幕全文、提示詞或金鑰，不新增遙測服務。
- 不預設「首句一定小於 1 秒」；本機推論時間決定可達上限。

## Review Focus

- 暫停時跳轉，沒有後續 timeupdate，仍應自動啟動新位置工作（Task 2）。
- 舊影片請求在新影片載入後才完成，不得污染畫面或鎖住 worker（Task 2）。
- 長靜音、intentionalEmpty 與重複對白不能造成假缺口或錯誤時間軸（Tasks 1、3）。
- 連續失敗不得請求暴增，也不能一個壞句永久擋住後面字幕（Task 3）。
- 播放倍速改變與背景分頁計時器延遲不能依牆鐘顯示錯句（Tasks 1、4）。

## 實作任務與驗收

### Task 1：可測試的句子選取函式

Files: 新增 `wuf-src/subtitle/subtitle-scheduler.ts`、`tests/wuf-subtitle-scheduler.test.mjs`；更新 `wuf-src/index.ts` 匯出。

Interface（純函式，僅選句；容量與重試由 worker 管理，isPending 排除完成、在途、冷卻與終止失敗句）: `selectNextSubtitleSentence<T extends MergedAsrSentence>(sentences: readonly T[], nowMs: number, playbackRate: number, isPending: (sentence: T) => boolean): T | undefined`。

- [x] 寫失敗測試：now=25s 時不選 0／5 秒過期句；選 25 秒當前句，再選下一句；倒轉後過去句重新可選。
- [x] 加入無字幕、長靜音、邊界 endMs、重疊句取最晚且與顯示選句一致、0.5／1／2 倍速範圍（含 20s 下限）與已完成句測試。
- [x] 執行 `npm run build && node --test tests/wuf-subtitle-scheduler.test.mjs`，確認因未實作而失敗。
- [x] 用排序後句子清單的線性掃描實作，不加優先佇列套件；範圍採上述精確常數。
- [x] 重跑測試至通過。

### Task 2：單一 worker 與生命週期

Files: 新增 `wuf-src/subtitle/subtitle-worker.ts`、`tests/wuf-subtitle-worker.test.mjs`，修改 `wuf-src/index.ts`、`wuf-src/content/content-youtube.ts`、`tests/wuf-subtitle-regression.test.mjs`。

Interface: content script 內統一使用 requestSubtitleWork(): void，從 Task 2 起即採最終名稱。新增 wuf-src/subtitle/subtitle-worker.ts 並由 wuf-src/index.ts 匯出 createSubtitleWorker(deps: SubtitleWorkerDeps): SubtitleWorker。

- SubtitleWorker 提供 wake(): void、replaceSession(session: SubtitleSession): void、stop(): void、dispose(): void；replaceSession 不重設實體在途名額，stop 停止派送、清除計時器並禁止當前 session 後續結果／錯誤寫入；舊請求仍在 finally 歸還名額。重新啟用須 replaceSession 使用更大的 generation。dispose 永久停止該實例，不可重新啟用。
- SubtitleSession 包含 generation: number、engine: 'openai-compat-local' | 'google-translate'、sentences: readonly WorkerSentence[]（停用改呼叫 stop，不另設 enabled 旗標）；WorkerSentence 為 MergedAsrSentence 加 id: string。replaceSession 只接受單調增加的 generation，跳轉使用 wake。content adapter 在建立 session 時綁定不可變的翻譯設定快照（來源／目標語言、引擎、模型覆寫等），派送時不得讀取後來變更的可變設定。既有背景協定仍使用其設定讀取方式；設定變動後收到的舊 generation 結果一律不顯示。
- SubtitleWorkerDeps 包含 getPlayback(): { nowMs: number; playbackRate: number }、now(): number、setTimer(callback: () => void, delayMs: number): unknown、clearTimer(handle: unknown): void、capacity(engine: string): number，以及下列 translate、onResult、onError、onDiagnostic；全部經 deps 注入，worker 不 import runtime 或 DOM 模組。
- 翻譯依賴為 translate(sentence: WorkerSentence, session: SubtitleSession): Promise<WorkerResult>；WorkerResult 是 { ok: true; translation: string; intentionalEmpty?: boolean } 或 { ok: false; error: { code: string; status?: number } }。content adapter 轉換現有 runtime 回應，不改通訊協定。
- 成功回呼 onResult(sentence: WorkerSentence, result: Extract<WorkerResult, { ok: true }>, generation: number): void 只對有效 session 觸發；onError(sentence: WorkerSentence, error: Extract<WorkerResult, { ok: false }>['error'], generation: number): void 回報當前 session 的錯誤。onError 只回報本次嘗試的錯誤，不代表句子已終止；worker 先完成狀態轉移，adapter 再以 getSentenceStatus(sentence.id) 判斷是否顯示失敗；單句錯誤只有該句涵蓋當前播放時間才顯示，預先翻譯的未來句錯誤不覆蓋當前字幕。引擎級不可恢復錯誤則顯示全域提示。不可恢復錯誤先鎖住派送、清除計時器，再為觸發它的有效 generation 呼叫一次 onError，使 adapter 能顯示錯誤；之後禁止其他回呼寫入。手動 stop 不產生錯誤提示。回呼不直接存取 DOM，由 content adapter 更新畫面。
- worker 另提供 getSentenceStatus(id: string): 'pending' | 'in-flight' | 'done' | 'failed' | undefined，僅查詢目前 session；content adapter 用它區分等待與終止失敗，不複製排程狀態。stop 後不得重新啟動等待提示。診斷透過 deps.onDiagnostic(event: { type: 'dispatch' | 'success' | 'failure'; generation: number; sentenceId: string; startMs: number; attempt: number; elapsedMs?: number }): void 傳出，由 adapter 保留 200 筆上限，不讓 worker 持有另一份日誌。
- translate 若拋出或 Promise reject，由 adapter 轉為 WorkerResult；已知 runtime 錯誤碼保留，未分類例外轉為 INTERNAL_ERROR 並停止本輪派送。worker 邊界也必須捕捉 translate 的同步例外與 rejected Promise（即使 adapter 正常應已轉換），依相同 INTERNAL_ERROR 規則處理。無論成功、失敗或回呼拋錯，finally 都必須釋放名額；UI／診斷回呼例外不得被當作模型失敗而重新翻譯，也不得產生未處理的 Promise rejection；新增對應拒絕 Promise 測試。舊 generation 回應只歸還名額，不更動目前句子狀態、連續失敗計數或 UI。
- 派送前先同步保留名額、加入在途工作鍵並增加 attempts，再呼叫外部 translate／診斷回呼；wake 必須防止同步重入。回呼若觸發 stop 或 replaceSession，填充下一個名額前重新驗證 session，不能繼續派送舊清單。
- 測試直接 import 真實 worker，注入可控制 Promise、播放位置與假時鐘，斷言實際請求與回呼；不複製 worker 實作，不以字串擷取閉包。

- [x] 以可控制的 Promise 寫失敗測試：多事件只發一個請求，同區段／跨區段／暫停跳轉後下一請求都是新位置句；同步回呼重入 wake、stop 或 replaceSession 也不得超額或派送舊 session。
- [x] 補測新影片、換目標語言、來源語言變更、停用再啟用，以及舊請求完成時新 session 仍能繼續工作、名額正確歸還。
- [x] 用實際 content adapter 的 storage 事件測試設定更新／刪除、快照反序回應、讀取途中切影片或停用、快取事件不觸發重建、只改主題時快照相同不遞增 generation 且 displayCues 保留、dispose 移除監聽；不得只直接呼叫 worker.replaceSession 代替設定整合驗證。
- [x] 盤點全部以字串切片擷取 translateWindowByIndex 的既有測試，包括本機優先排序、ASR 合句／來源語言與跨視窗去重；受新路徑影響者改由 worker／content adapter 整合測試保留相同斷言，不只遷移最後新增的一項，也不直接刪除行為覆蓋；另加一條 regression：本機 session 下 triggerAheadOfTimeWorker 不發送區段請求，openai-compat-online 仍走既有路徑。Google 的停用舊路徑測試及切換留到 Task 2G，一起啟用新派送，避免中間階段完全沒有 Google 字幕。
- [x] 補測字幕文字與 startMs 不變但 endMs／sourceSegs 改變，以及同毫秒重複字幕插入／移除：舊回應不得寫入，新譯文使用新時間軸。
- [x] 執行 build、subtitle-worker 與 subtitle regression 測試確認失敗。
- [x] 接入單一 worker、generation 驗證及完成後重新選句；移除被取代的本機 window 排程分支，Google 路徑於 Task 2G 接入相同選句規則；其他引擎保留既有路徑。
- [x] 驗證快取命中時不等待預熱才顯示，以及無後續播放事件仍會處理被喚醒的工作。
- [x] 執行 npm run build，再執行 node --test tests/wuf-subtitle-scheduler.test.mjs tests/wuf-subtitle-worker.test.mjs tests/wuf-subtitle-regression.test.mjs，確認全部通過。

### Task 3：有界重試與快取完整性

Files: `wuf-src/subtitle/subtitle-worker.ts`、`tests/wuf-subtitle-worker.test.mjs`、`wuf-src/content/content-youtube.ts`、`tests/wuf-subtitle-regression.test.mjs`；必要時讀取 `wuf-src/lib/runtime-client.ts` 的既有錯誤格式，不擴充協定除非測試證明必要。

Interface: worker 內句子狀態包含 `attempts: number`、`timeoutRetries: number`、`retryAtMs: number`、`status: 'pending' | 'done' | 'failed'`；`in-flight` 由在途工作鍵集合推導，不另存於句子狀態（`getSentenceStatus` 合併兩者回傳）。使用單調時間表示重試期限。

- [x] 寫失敗測試：1／3 秒冷卻、最多 3 次總嘗試、冷卻不阻塞其他句、過期不重試、認證錯誤、`SEND_MESSAGE_FAILED` 與 `INTERNAL_ERROR` 停止。
- [x] 寫斷路測試：連續 3 個無 status 或 WATCHDOG_ERROR 失敗回應後暫停（含同一句、含兩者混合）、5→10→30s 退避、計時等待不增加嘗試而探測計次；當前句已用完次數或處於靜音時，改探測最近的合格未來句；無候選不空轉。測試舊在途成功不提前解除冷卻、探測成功恢復容量、429 不縮短既有期限及每句最多 3 次。
- [x] 補測過期 retryAtMs 不造成 0ms 迴圈、名額全滿時不忙等、倒轉後可重試未耗盡次數的句子，以及 intentionalEmpty 不顯示等待提示、空白非 intentionalEmpty 回應視為 INVALID_RESPONSE。
- [x] 寫本機逾時測試：已離開緩衝範圍的逾時句不重試；範圍內最多再試 1 次。
- [x] 補測 intentionalEmpty 不重送、重複對白與同毫秒句子以 generation + id 獨立、失敗不快取、ABORTED 不重試。
- [x] 執行測試確認失敗，再實作每引擎一個喚醒計時器，整合句子 retryAtMs 與引擎冷卻期限，派送須同時滿足兩者；計時器只考慮目前 generation、範圍內、非在途且仍有剩餘嘗試的候選。沒有候選或名額全滿時不設立即重試計時器，等待事件或請求 finally 喚醒；期限已到且符合派送條件時直接派送，禁止反覆設定 0ms timer。倒轉時可重新選取未耗盡嘗試的過去句。stop／replaceSession／dispose 清除舊計時器。replaceSession 保留該引擎尚未到期的冷卻期限並重新排定喚醒，不能藉切影片繞過限流。
- [x] 驗證不在本機 worker 複製背景服務的快取或格式修復邏輯。
- [x] 重跑字幕測試至通過。

### Task 4：顯示狀態與診斷

Files: `wuf-src/content/content-youtube.ts`、`tests/wuf-subtitle-regression.test.mjs`。

Interface: 沿用 `updateActiveCues` 與 status badge API；診斷記錄僅含事件類型、句子時間戳、generation、耗時與結果分類。

- [x] 寫失敗測試：等待 <300ms 不提示、超過才提示；譯文完成／空白區間／停用後提示消失。
- [x] 補測過期譯文不覆蓋當前畫面、倍速與晚到計時器以 currentTime 重算；同一句等待計時不得被 timeupdate 反覆重設，300ms 到期須自行更新，暫停時也能出現提示。
- [x] 補測診斷上限 200 筆、不得包含原文與機密；不可恢復錯誤仍顯示一次明確提示、一般可重試失敗不提前顯示終止錯誤、手動停用不顯示錯誤。
- [x] 執行測試確認失敗，再實作狀態轉移與診斷收集。
- [x] 重跑測試確認通過。

### Task 5：整體驗收與交付

- [x] 執行 `npm test`、`npm run typecheck`、`git diff --check`，必須全部成功。
- [x] 依 code-review-skill 與 ponytail-review 審查：無重複 worker、無失效的本機 window 狀態、無新增依賴與不必要抽象。
- [x] 在實作前保留目前補丁版本為量測基準並記錄 commit 與未提交 diff；實作後用同一影片、位置、模型、倍速與設定比較。分開記錄模型冷／暖與翻譯快取命中／未命中，不把快取命中算成模型加速。模型冷啟動各 3 次、暖啟動但翻譯快取未命中各 5 次；無安全的快取隔離方式就標示未完成對照，不清除使用者全部資料。Google 只比較明確記錄的翻譯快取條件，不宣稱可控制 Google 服務端冷啟動。
- [x] 瀏覽器實測正常連播、密集對白、1／2 倍速、前後跳轉、暫停跳轉、切影片、斷線恢復（停止本機服務 → 重啟，有剩餘嘗試的當前／未來候選時自動恢復；所有候選已耗盡時顯示失敗，重新啟用後才重試）、重新載入擴充功能後舊頁面不再發請求。
- [x] 確認過期新請求為 0、單一播放 session 的本機請求並行峰值為 1、錯誤有界重試符合規格。
- [x] 比較首句／跳轉等待時間；若實測退步則定位原因，不以測試通過宣稱效能改善。
- [x] 更新使用說明與建置產物；是否提交、推送及發布依使用者後續指示執行。

## 分階段完成標準

第一階段（Tasks 1–2）交付正確優先順序與跳轉行為；Google 階段（Task 2G）交付單句並行與獨立顯示；第二階段（Tasks 3–4）交付失敗處理與可觀察狀態；第三階段（Task 5）取得真實模型數據。若單路推論持續慢於對白產生速度，再另案評估較快模型、句子批次或使用者選擇的暫停緩衝，不在此次承諾消除所有英文回退。

## Google 執行規格（納入此次必要範圍）

以下與上述共用規格一起執行；本機單路限制僅適用本機引擎。網頁翻譯不在範圍內。

### 請求與優先順序

- Google 使用同一個句子選取函式、generation、快取身分、時間軸與重試規則。
- 字幕端最多同時 3 個 Google 邏輯請求，每個請求只包含一句 `texts: [sentence.text]`；不新增另一層批次並行，也不修改 provider 的全域並行設定。
- 當前句先派送，之後用空閒名額派送最近的後續句。每個回應獨立加入 displayCues 並立即更新畫面，不等待其餘請求。
- 初版採單句請求以沿用背景服務既有單句快取，避免再新增批次拆分及進度回報協定。
- 維護 in-flight 句子身分集合，選取下一句時排除已送出句，避免填滿 3 個名額時重複派送同一句。
- 同一影片中相同文字、不同時間的句子仍為不同顯示項目；完成後各自套用正確時間戳。
- 跳轉時不再派送舊位置工作；已在途請求允許完成。第一個名額釋放後，優先派送新位置當前句。
- 不承諾跳轉可以立即搶占已在途的 3 個請求，也不建立額外的第 4 個緊急請求。
- 在途計數器與 in-flight 工作鍵集合放在單一長存 worker 實例內、session 之外（依引擎分開；content script 不另存一份計數），generation 更新不得重置；每個請求在自己的 finally 歸還所屬引擎的名額，避免超額派送或名額洩漏；跨 session 的舊請求仍計入本分頁活動請求上限直到完成。
- 本機與 Google 引擎切換後，舊引擎結果不得加入新 session。上限以每分頁每引擎計，不宣稱跨分頁全域限流。

### Google 錯誤處理

- 單句失敗不阻塞另外兩路；每句最多 3 次總嘗試，沿用 1／3 秒重試冷卻。
- 429 走共用引擎冷卻（至少 3000ms，不縮短其他退避期限），停止新 Google 派送後重新評估當前位置；多個 429 不得產生多個計時器。不擴充錯誤協定。
- 認證錯誤停止本輪引擎排程；以 `error.status`（401／403）與 `error.code` 判斷，結構已於「已查證事實」確認。

### Task 2G：Google 單句並行與獨立顯示（Task 2 後執行）

Files: `wuf-src/subtitle/subtitle-worker.ts`、`tests/wuf-subtitle-worker.test.mjs`、`wuf-src/content/content-youtube.ts`、`tests/wuf-subtitle-regression.test.mjs`；閱讀但原則上不修改 `wuf-src/providers/google-translate.ts`、`wuf-src/background/index.ts`。

Interface: 沿用 Task 2 的 requestSubtitleWork 與 createSubtitleWorker；capacity 對 `openai-compat-local` 回傳 1、`google-translate` 回傳 3。Google adapter 將單句 runtime 回應轉為 WorkerResult，不另建 worker framework。

- [x] 寫可控制 Promise 的失敗測試：當前句為第一個請求；3 個請求均為單句，峰值不超過 3。
- [x] 模擬當前句先完成、另外兩句仍懸而未決，斷言當前譯文已加入 displayCues，畫面無需等待整批完成。
- [x] 模擬回應反序，斷言每個翻譯對應原句與時間戳，沒有按完成順序錯配。
- [x] 模擬同時多事件觸發，斷言沒有重複 in-flight 句子、沒有超過容量。
- [x] 模擬 3 路在途時跳轉；釋放任一路後，下一請求為新位置當前句，而非舊位置後續句。
- [x] 模擬停用再啟用、換影片、換引擎與舊請求晚到；斷言結果隔離、名額正確歸還、不超額派送。
- [x] 執行 `npm run build && node --test tests/wuf-subtitle-scheduler.test.mjs tests/wuf-subtitle-worker.test.mjs tests/wuf-subtitle-regression.test.mjs`，確認以上測試在實作前失敗。
- [x] 補 regression：Google session 只由新 worker 派送，舊區段入口不發請求；microsoft-translate 與 openai-compat-online 仍保留既有路徑。
- [x] 修正既有「Cross-window heuristicMergeAsr…」測試的 `engine: 'google'`：將跨 30 秒邊界、無缺口、無重複請求的斷言改用 `openai-compat-online`（保留舊區段路徑覆蓋），另以 `google-translate` 在 worker 整合測試中保留相同斷言；路由以精確 engine id 判斷，未知字串走既有路徑，並加一條測試。
- [x] 使用共享選句函式及有界 in-flight 集合實作；逐筆回應立即更新顯示。刪除 Google 已被取代的整批等待路徑。
- [x] 重跑 scheduler、worker 與 subtitle regression 三個測試檔至通過；保留 Google provider 既有排序及網頁翻譯測試。

### Tasks 3–5 的 Google 補充驗收

- [x] Task 3：新增一個 Google 請求失敗、其他兩個成功的測試，成功結果立即可用。
- [x] Task 3：測試 429 觸發引擎冷卻、結束後先單路探測，且重試仍遵守句子次數與 3 路上限。
- [x] Task 4：Google 也測試等待提示、過期結果隔離、診斷資料上限及隱私限制。
- [x] Task 5：完整測試之外，實測 Google 初次啟用、跳轉、2 倍速及密集對白；與修改前同影片比較首句與跳轉等待時間。
- [x] Task 5：確認 Google 峰值 <=3、本機峰值 <=1，並確認網頁翻譯的既有行為未被字幕改動影響。

## 交接注意事項

- 目前工作區已有上一輪本機優先排序補丁與一個回歸測試，尚未提交。執行者先檢查 git diff，將其作為起點，不覆蓋或誤當成此次完整計畫已完成。
- 本文件完整順序為 Tasks 1 → 2 → 2G → 3 → 4 → 5；共六個施工任務。
- 先以可控制的模擬回應驗證排程正確，再用真實服務驗證速度。無法取得瀏覽器／模型實測環境時，必須明列未驗證項目，不能宣稱已解決所有英文閃回。
- 本文件不授權自動提交、推送或發布；交付可檢查的程式修改、測試結果及建置產物即可。

## 本版驗收範圍澄清

本版效能驗收僅包含首句等待、跳轉等待、單句請求耗時與重試次數。準時率與未覆蓋秒數延至第二版，不作為本版交付門檻，也不得宣稱已由數據證明準時率提升。新增 worker 測試檔須納入所有相關驗證命令；完整 npm test 仍是最終門檻。
