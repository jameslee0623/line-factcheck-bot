# LINE 群組事實查核機器人

用免費 Gemini API 查核群組裡轉發的文章 / 說法。語氣溫和：先肯定正確的部分，再用補充資料的方式糾正。跑在 Google Apps Script 上，不用自己架伺服器，成本 $0。

## 它會做什麼

- 群組裡有人貼文章連結 → 自動查證，用 Google 搜尋找資料，附來源連結回覆
- 輸入 `查 …`、`!fact …` 或 @ 機器人 → 查你問的內容
- 1:1 私聊：任何文字都回，圖片也可以查（群組裡的圖片不自動觸發，可能是家人照片）
- 只用 reply 回覆，不主動 push，所以 LINE 免費額度不會被吃掉

## 設定步驟（照順序做）

### 1. Gemini API key（免費）

1. 到 [Google AI Studio](https://aistudio.google.com/) → **Get API key** → 建立一把 key
2. 不用綁信用卡。順便到 AI Studio 的 rate-limit 頁面確認你的額度，以及目前免費的 Flash 型號名稱（型號會退役，`gemini-2.5-flash` 在 2026/12/1 退役，程式預設用 `gemini-3.5-flash-lite`）

### 2. LINE 官方帳號 + Messaging API

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號（地區選台灣）
2. 設定 → Messaging API → 啟用（2024/9 之後不能直接在 Developers Console 建 channel，要從 OA Manager 進去）
3. 到 [LINE Developers Console](https://developers.line.biz/) → 你的 channel → Messaging API 分頁，複製：
   - **Channel access token**（長效型）
   - **Channel secret**（備用，程式目前用不到，因為 Apps Script 看不到 HTTP header）
4. 同一頁打開 **Allow bot to join group chats**（預設是關的）

### 3. 部署 Apps Script

1. 到 [script.google.com](https://script.google.com/) → 新增專案
2. 把 `Code.gs` 的內容整份貼上（蓋掉原本的 `myFunction`）
3. 左邊齒輪 **專案設定 → 指令碼屬性**，加入 4 個屬性：
   | 屬性名稱 | 值 |
   |---|---|
   | `LINE_CHANNEL_ACCESS_TOKEN` | 步驟 2 的 channel access token |
   | `GEMINI_API_KEY` | 步驟 1 的 key |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite`（或 AI Studio 顯示的當前免費 Flash 型號） |
   | `WEBHOOK_TOKEN` | 自己編一串亂碼，例如 `aB3x9qZ7`，等下 webhook URL 要用 |
4. 右上角 **部署 → 新增部署作業 → 網頁應用程式**
   - 執行身分：**我**
   - 具有存取權的使用者：**所有人**
   - 部署 → 複製網址（結尾是 `/exec`）

### 4. 接上 LINE webhook

1. LINE Developers Console → Messaging API 分頁 → Webhook URL 填：
   ```
   https://script.google.com/macros/s/XXXX/exec?token=你的WEBHOOK_TOKEN
   ```
   （把 `XXXX` 換成你的部署網址，`token=` 後面填步驟 3 的 `WEBHOOK_TOKEN`）
2. 按 **驗證** → 成功後打開 **使用 webhook**

### 5. 測試

1. 先在 1:1 私聊加官方帳號為好友，傳一個新聞連結或 `查 台積電要被美國罰款是真的嗎`
2. 沒問題後，把官方帳號邀請進家族群組
3. 群組測試：貼連結、@ 機器人、或輸入 `查 …`

## 成本

| 項目 | 費用 |
|---|---|
| Gemini API（Flash 免費額度） | $0，約每天 100–1000 次請求（看 AI Studio 顯示的實際額度），搜尋 grounding 每天 500 次 |
| LINE 回覆（reply） | $0，不計入額度 |
| LINE push | 本機器人不用，所以 $0 |
| Apps Script | $0 |

## 常見問題

| 症狀 | 原因 / 解法 |
|---|---|
| Webhook 驗證失敗 | 檢查 URL 後面的 `?token=` 是否跟 `WEBHOOK_TOKEN` 屬性一樣；部署的存取權要是「所有人」 |
| 機器人完全不回 | 看 Apps Script **執行紀錄**（左邊時鐘圖示）：沒紀錄 = webhook 沒打進來；有紀錄看錯誤訊息 |
| 回「今天問太多了」 | Gemini 免費額度用完，明天再試 |
| 回「模型名稱可能已退役」 | 到 AI Studio 查現在的 Flash 型號，改 `GEMINI_MODEL` 屬性 |
| 群組裡不回，私聊會回 | 「Allow bot to join group chats」沒開，或官方帳號還沒被邀進群組 |
| 回得慢 / 沒回 | Gemini 超過 50 秒就跳過（replyToken 只有 1 分鐘有效）。 grounding 搜尋偶爾會慢，重問一次通常就好 |

## 安全說明

- Apps Script 的 `doPost` 看不到 HTTP header，所以無法驗 LINE 的簽名。改用 webhook URL 後面的 `?token=` 驗證：不知道 token 的人打進來會被拒絕。不要把這個 URL 公開。
- 免費版 Gemini 可能會拿你的資料去改善 Google 產品，不要傳私密內容。
- 金鑰都放在指令碼屬性裡，不要寫進程式碼、不要 commit 到 GitHub。
