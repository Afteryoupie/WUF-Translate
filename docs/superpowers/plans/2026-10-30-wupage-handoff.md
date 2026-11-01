# WuPage 移植交接

## 目標與工作目錄

- `/Users/linjiade/LLM/WUF-Translate`，沿用 `main` 上原有未提交修改；不要重設、提交或推送。
- 原版：`/Users/linjiade/LLM/wupage-1.5.5`。完整需求見本對話最初的移植規格；實作計畫見 `2026-10-30-wupage-port.md`。
- 使用者確認一般網頁不套用 OpenCC，字幕維持原狀。

## 已完成

- 一般網頁走獨立 `wuf:wupage-translate` 路徑與 `vendor/wupage/core` 的原版背景管線；支援 Microsoft、Google、OpenAI 相容及 Watchdog，獨立網頁快取。
- 還原原版視窗附近排程、16 項 LLM 批次上限；保留取消與 iframe 整合，YouTube 留言及字幕走原有路徑。
- WUF 彈出介面能在翻譯中還原／取消，呈現後續服務錯誤；新增 Microsoft 選項。更新來源雜湊、來源說明、README 與 CHANGELOG。
- 最近一次 `npm test` 為 80/80 通過；`npm run typecheck` 通過。原版 `npm run build` 與 `test:frames:edge` 成功。真實 Google/Microsoft 單句呼叫成功。
- 真實 Apple 模型隔離 Edge 比較成功：兩邊各 5 組譯文、4 筆 Watchdog 請求一致，並驗證還原、內部標記與程式碼。截圖及無憑據請求保存在 `outputs/wupage-live/`，初始 RED 差異在 `pre-migration-request-diff.txt`。
- 已依獨立審查先重現並修正普通網頁 `pagehide` 清除跨頁自動翻譯狀態的問題，Edge 回歸通過。

## 最終驗證

- 獨立正確性與過度工程審查已完成；跨頁狀態修正後無其他確定問題。已新增隱藏 iframe 顯示及摺疊內容展開後加入翻譯的 Edge 回歸。
- 最終 `npm test`（含建置）80/80 通過，`npm run typecheck` 與 `git diff --check` 通過。程式未提交或推送。

## 驗證命令

```sh
cd /Users/linjiade/LLM/WUF-Translate
npm run typecheck
npm test
node scripts/compare-wupage-live.mjs
```

真實比較使用 `http://127.0.0.1:8080/v1`、`apple-intelligence-translation` 及隔離 Edge profile，會喚醒本機 Watchdog 模型。測試資料不含憑據。
