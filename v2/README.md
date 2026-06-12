# 群愛獅子會簽到系統 V2 測試版

此目錄是與現行系統完全分離的測試版。根目錄的舊版 `index.html`、`dashboard.html` 和既有 Apps Script API 均不會被修改。

## V2 解決的問題

- 使用 LINE 驗證後的固定 `line_user_id` 對應會員，不依賴可變更的 LINE 名稱。
- 新增會員與離會會員使用 `active`／`inactive` 狀態，不刪除歷史資料。
- 每場活動有獨立 `event_id`，簽到紀錄不再混在一起。
- 使用 `event_id + member_id` 防止同一活動重複簽到。
- 每個年度保存獨立職位；建立新年度時可複製上一年度，再修改異動人員。
- Dashboard 使用 `textContent` 建立內容，避免舊版的儲存型 XSS 問題。
- 所有管理與簽到異動寫入 `AuditLogs`。

## 目錄

- `index.html`：新版 LINE 簽到頁
- `dashboard.html`：新版現場看板
- `admin.html`：新版管理台
- `apps-script/`：新版 Google Apps Script 後端原始碼

## 建立獨立測試環境

### 1. 建立測試 Google Sheet

請建立一份全新的 Google Sheet，例如「群愛獅子會簽到 V2 測試」，不要使用舊版正式試算表。

在該試算表開啟「擴充功能 → Apps Script」，加入：

- `apps-script/Code.gs`
- `apps-script/Setup.gs`
- `apps-script/appsscript.json`

執行 `setupV2()`，系統會建立：

- `Members`
- `Terms`
- `MemberRoles`
- `Events`
- `Attendance`
- `Guests`
- `BindingRequests`
- `AuditLogs`

首次測試可再執行 `createSampleTerm()` 建立 `T2526` 測試年度。

### 2. 設定 Apps Script Properties

在 Apps Script「專案設定 → 指令碼屬性」加入：

| 名稱 | 內容 |
|---|---|
| `LINE_CHANNEL_ID` | 測試 LIFF 所屬的 LINE Login Channel ID |
| `ADMIN_TOKEN` | 自行產生的長隨機管理密鑰，建議至少 32 字元 |
| `DASHBOARD_TOKEN` | 自行產生的長隨機看板密鑰 |

`SPREADSHEET_ID` 會由 `setupV2()` 自動設定。

### 3. 部署新版 Apps Script

選擇「部署 → 新增部署作業 → 網頁應用程式」：

- 執行身分：自己
- 誰可以存取：所有人

這是新的部署，請勿修改舊版部署。複製新的 `/exec` URL。

### 4. 建立測試 LIFF

在 LINE Developers Console 建立一個獨立測試 LIFF App：

- Scope 必須包含 `openid` 與 `profile`
- Endpoint URL 指向 V2 測試頁，例如 GitHub Pages 的 `/v2/index.html`

不要先修改現行 LIFF Endpoint。

### 5. 設定前端

編輯 `config.js`：

```js
window.ILIONS_V2_CONFIG = {
  apiUrl: "新版 Apps Script /exec URL",
  liffId: "測試 LIFF ID",
  dashboardToken: "與 Script Property 相同的 DASHBOARD_TOKEN"
};
```

注意：放在 GitHub Pages 的 `dashboardToken` 可以被查看，它只能降低意外存取，不能作為真正的私密權限。若現場名單必須完全私密，需要把 Dashboard 移到有登入驗證的服務。

## 建議測試流程

1. 在 `admin.html` 輸入 `ADMIN_TOKEN`。
2. 建立數位測試會員。
3. 建立或複製年度，為測試會員設定職位。
4. 建立並開放一場測試活動。
5. 測試會員從測試 LIFF 送出綁定申請。
6. 管理員在 `admin.html` 核准綁定。
7. 測試會員重新進入 LIFF 並簽到。
8. 驗證重複簽到會被阻止。
9. 驗證 `dashboard.html` 正確顯示簽到會員與攜伴數。
10. 關閉活動，確認會員無法再簽到。

## 舊資料移轉策略

先只匯入會員，不立即移轉所有歷史簽到：

1. 在舊試算表選取「姓名、職位」兩欄並複製。
2. 開啟 V2 管理台的「會員管理 → 匯入舊名單」，選擇年度後貼上並匯入。
3. 系統會自動建立缺少的會員、略過重複姓名，並寫入該年度職位。
4. 讓少量會員測試 LINE 綁定與簽到。
5. 測試穩定後，再決定是否將舊簽到紀錄轉成 `Events` 與 `Attendance`。
6. 正式切換後，舊系統保留唯讀備份。

## 正式切換前必做

- 將測試會員與測試活動資料清除或封存。
- 重新部署正式 V2 Apps Script。
- 產生新的正式 `ADMIN_TOKEN`。
- 完成會員名單與年度職位核對。
- 先由管理人員進行一次完整現場演練。
- 最後才修改正式 LIFF Endpoint；舊版 GitHub 頁面與 Apps Script 保留作為回復方案。
