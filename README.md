# Google Form Observer

婚禮賓客表單整理：Google 表單 → n8n 同步 → 手動標記 → 自動分組 → 瀏覽器預覽。

## 功能

1. **收表單**：Google 表單回覆寫入試算表
2. **同步**：n8n 把試算表覆蓋到 `data/guests.raw.json`
3. **標記**：在 `data/guests.tags.json` 填 `relationship_ids`、`head_table_names`
4. **分組**：產出 8–10 人一組的社交單位（`output/groups.json`）
5. **預覽**：瀏覽器開 `output/groups-view.html` 確認

## 環境

| 工具 | 用途 |
|------|------|
| [Docker](https://www.docker.com/) | 跑 n8n |
| [Node.js](https://nodejs.org/)（建議 18+） | 跑同步與分組腳本 |
| Google 帳號 | 表單、試算表、OAuth |

```bash
docker --version
node --version
npm --version
```

---

## 取得 Google Sheet ID

讀的是**試算表**（表單連結的那張），不是表單網址。

1. 開啟試算表
2. 看網址：`https://docs.google.com/spreadsheets/d/這段就是SheetID/edit`
3. 複製 `/d/` 和 `/edit` 中間那串
4. n8n 節點裡的分頁名稱通常是 **`表單回應 1`**（Google 表單預設）

可記在專案根目錄 `.env`（勿提交）：

```env
GOOGLE_SHEET_ID=你的SheetID
```

---

## 取得 Google Client ID / Secret（n8n 自架必做）

自架 n8n **不能**用 n8n 內建的 Google 一鍵登入，要自己建 OAuth。

### 最短步驟

1. 開 [Google Cloud Console](https://console.cloud.google.com/) → 新建專案
2. **API 和服務 → 程式庫** → 啟用 **Google Sheets API**、**Google Drive API**
3. **OAuth 同意畫面** → 類型選「外部」→ 測試使用者加你的 Gmail
4. **憑證 → 建立憑證 → OAuth 用戶端 ID** → 類型「網頁應用程式」
5. **重新導向 URI** 填（本機 n8n）：

   ```
   http://localhost:5678/rest/oauth2-credential/callback
   ```

   > 先在 n8n 新增 Google Sheets 憑證時，畫面上也會顯示這個 Redirect URL，**以 n8n 顯示的為準**，貼到 Google 要完全一致。

6. 建立後複製 **Client ID**、**Client Secret** → 貼到 n8n 憑證 → **Sign in with Google**

```env
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
```

### 卡關時怎麼找答案

| 問題 | 搜什麼 |
|------|--------|
| 整體流程 | `n8n google sheets oauth self hosted` |
| redirect_uri_mismatch | 比對 n8n 與 Google Console 的 callback URL 是否一字不差 |
| access blocked / 測試使用者 | OAuth 同意畫面 → 測試使用者加你的 Gmail |
| 讀不到試算表 | 確認 Drive API 有開、試算表已分享給該 Google 帳號 |

**官方文件**（最準）：

- [n8n — Google Sheets OAuth2](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/)

**影片**：YouTube 搜 `n8n google sheets oauth2`，挑「self-hosted」+「Google Cloud Console」關鍵字的即可，步驟都大同小異。

---

## n8n 設定流程

### 1. 啟動

```bash
docker compose up -d
```

瀏覽器開 http://localhost:5678 ，第一次會要你設本機帳密。

### 2. 建立 Google 憑證

**Credentials → Add credential → Google Sheets OAuth2 API**

- 貼上 Client ID / Secret
- Sign in with Google 完成授權

### 3. 匯入 workflow

**Workflows → ⋯ → Import from File** → 選 `n8n/workflows/getGoogleSheet.json`

匯入後：

1. 開 **Get row(s) in sheet** 節點 → Document 改成你的 Sheet ID
2. Credential 選你剛建的 **Google Sheets account**（名稱要對上）

節點順序（已內建在 JSON 裡）：

```text
Manual Trigger
  → Google Sheets（Get row(s) in sheet）
  → Code in JavaScript（Run Once for Each Item，轉換欄位）
  → Code in JavaScript1（Run Once for All Items，組 JSON）
  → Read/Write Files from Disk（/data/guests.raw.json）
```

| 節點 | 重點 |
|------|------|
| Google Sheets | Document = Sheet ID；Sheet = `表單回應 1` |
| Code in JavaScript | Mode：**Run Once for Each Item** |
| Code in JavaScript1 | 用 `$('Code in JavaScript').all()` 收集全部 |
| Read/Write Files | 路徑 `/data/guests.raw.json`（對應本機 `data/`） |

> n8n 2.x 開了 `N8N_RUNNERS_ENABLED` 時，Code 節點不能直接用 `fs`，要用 `prepareBinaryData` + Read/Write Files。`docker-compose.yml` 已掛好 `./data:/data`。

**本機 workflow 有改動、想更新 repo 備份：**

```bash
node scripts/export-n8n-workflows.js
```

會從 `n8n-data/database.sqlite` 重新匯出到 `n8n/workflows/`（Sheet ID 會替換成 placeholder，可安全 commit）。

### 4. 測試

1. Execute workflow
2. 確認本機出現 `data/guests.raw.json`，筆數與試算表一致
3. 表單多填一筆 → 再 Execute → raw 有更新

之後有新回覆就**手動再跑一次** workflow。

---

## 日常流程（兩步）

```bash
# 1. n8n 已更新 raw 後
npm run sync

# 2. 手改 data/guests.tags.json 後
npm run build
```

| 指令 | 說明 |
|------|------|
| `npm run sync` | raw → tags |
| `npm run sync:pending` | 只印待標記名單 |
| `npm run build` | 驗證 + 分組 + 開瀏覽器 |
| `npm run build:all` | sync + build 一鍵重跑 |

## 資料檔

| 檔案 | 說明 |
|------|------|
| `data/guests.raw.json` | 表單原始資料（n8n 寫入，勿手改） |
| `data/guests.tags.json` | 標記檔（手改） |
| `data/tags.json` | 關係詞彙表 |
| `output/groups.json` | 分組結果 |

## Docker 常用

```bash
docker compose up -d
docker compose down
docker compose logs -f n8n
```
