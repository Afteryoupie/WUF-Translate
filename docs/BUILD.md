# WUF Translate 開發者建置指南

本文件供開發者或協助製作安裝套件的人使用。一般使用者取得已建置套件後，不需要 Node.js、npm 或終端機。安裝與翻譯操作請先看 [README](../README.md)。

本專案使用 TypeScript、Manifest V3。建置環境需要 Node.js 22.18 以上及 npm。以下指令適用於 macOS 終端機與 Windows PowerShell，執行位置均為內含 `package.json` 的專案根目錄。

## 1. 下載與建立檔案

1. 安裝 Node.js **22.18 以上版本**，安裝時保留 npm。Node.js 是用來把本專案轉成瀏覽器擴充功能的工具，不是翻譯模型。
2. 在本 GitHub 頁面按 **Code → Download ZIP**，下載後解壓縮到固定位置，例如「文件」中的 `WUF-Translate` 資料夾。
3. 開啟終端機：macOS 使用「終端機」；Windows 使用 PowerShell 或 Windows Terminal。
4. 輸入 `cd `（後面有一個空格），再把解壓縮後、**內含 `package.json` 的資料夾**拖進終端機，按 Enter，切換到該資料夾。若沒有自動帶上引號，請在路徑兩側加上雙引號，例如 `cd "/你的路徑/WUF-Translate-main"`。

在終端機依序執行，每一行完成後再執行下一行：

```sh
node --version
npm --version
npm ci
npm run build
```

前兩行會顯示版本；`npm ci` 會從網路安裝專案所需套件。最後看到 `Built clean-room extension to dist/wuf/`，代表建立成功。專案中會出現 `dist` 資料夾，裡面的 `wuf` 就是要載入的擴充功能。

若出現「找不到 node／npm」，請完成 Node.js 安裝後關閉並重新開啟終端機。Windows 若顯示無法執行 `npm.ps1`，可在上述指令中將 `npm` 改為 `npm.cmd` 再執行。

建置成功後，依 [README 的瀏覽器安裝步驟](../README.md#2-載入瀏覽器擴充功能)操作，選取專案內的 **`dist/wuf`**。Node.js 不需要在使用擴充功能時保持執行。

## 2. 驗證修改

```sh
npm run typecheck
npm test
```

`npm test` 會先建置，再執行 `tests/*.test.mjs`。

## 3. 更新原始碼

若使用 Git 下載專案，在專案資料夾依序執行：

```sh
git pull --ff-only
npm ci
npm run build
```

若使用 Code → Download ZIP，下載並解壓新版本後重新執行建置。完成後，到擴充功能管理頁重新載入 WUF，再重新整理使用中的分頁。

## 4. 製作可分享的安裝套件

建置完成後，將 `dist/wuf` **裡面的內容**打包為 ZIP，確認解壓縮後可找到 `manifest.json`，並清楚標示為已建置的安裝套件。使用者解壓縮後即可手動載入，不需要再安裝 Node.js。

商店發布時也使用建置結果，ZIP 最外層應直接包含 `manifest.json`；不需要附上 `node_modules`、原始碼、本機服務或模型檔。商店發布還需另外準備商店介紹、截圖、隱私權政策、權限說明與開發者帳號；GitHub 上傳原始碼不等於完成商店上架。

| 目錄 | 內容 |
| --- | --- |
| `wuf-src/` | 擴充功能原始碼、設定頁、彈出面板與翻譯流程 |
| `scripts/` | 建置與診斷腳本 |
| `tests/` | 自動化測試 |
| `docs/` | Laya 真實字幕測試方法與結果 |
| `dist/wuf/` | 建置後供瀏覽器載入的檔案，不提交到 Git |

Watchdog 透過 HTTP API 與原生瀏覽器主機連接，原始碼不包含於本專案。`node_modules`、建置結果、診斷輸出、模型與本機憑證均不隨本儲存庫提供。請保留既有擴充功能公開識別金鑰，不要為已安裝版本重新產生 `identity.json`；測試 fixture 中的公開金鑰不是簽署私鑰。

