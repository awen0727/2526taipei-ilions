const SCHEMA = Object.freeze({
  Members: ["member_id", "name", "chinese_name", "english_name", "status", "join_date", "leave_date", "line_user_id", "line_display_name", "created_at", "updated_at"],
  Terms: ["term_id", "name", "start_date", "end_date", "status"],
  MemberRoles: ["term_id", "member_id", "position", "sort_order"],
  Events: ["event_id", "term_id", "event_date", "name", "status", "created_at"],
  EventRegistrations: ["registration_id", "event_id", "member_id", "name_snapshot", "role_snapshot", "status", "registered_at", "canceled_at", "source"],
  Attendance: ["attendance_id", "event_id", "member_id", "name_snapshot", "role_snapshot", "checkin_at", "source", "guest_count", "note"],
  AttendanceRecords: ["recorded_at", "event_date", "event_name", "term_id", "member_id", "member_name", "role", "source", "checkin_at", "guest_count", "guest_names", "note", "attendance_id", "event_id"],
  Guests: ["guest_id", "event_id", "host_member_id", "name", "type", "note", "created_at"],
  BindingRequests: ["request_id", "line_user_id", "line_display_name", "claimed_name", "status", "created_at", "resolved_at", "resolved_by"],
  AuditLogs: ["log_id", "action", "actor", "target", "details", "created_at"]
});

function setupV2() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("請從群愛獅子會簽到試算表內執行 setupV2");

  Object.keys(SCHEMA).forEach(name => {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    const headers = SCHEMA[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#fbd050");
    sheet.autoResizeColumns(1, headers.length);
  });

  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", spreadsheet.getId());
  SpreadsheetApp.getUi().alert(
    "V2 資料表已建立。\n接著請在「專案設定 → 指令碼屬性」設定 LINE_CHANNEL_ID、ADMIN_TOKEN、DASHBOARD_TOKEN。"
  );
}

function migrateMemberColumns() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName("Members");
  if (!sheet) throw new Error("找不到 Members 分頁");
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  ["chinese_name", "english_name", "line_display_name"].forEach(header => {
    if (!headers.includes(header)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      headers.push(header);
    }
  });
  sheet.autoResizeColumns(1, sheet.getLastColumn());
}

function createSampleTerm() {
  const termSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Terms");
  if (termSheet.getLastRow() > 1) throw new Error("Terms 已有資料");
  termSheet.appendRow(["T2526", "2025-2026年度", "2025-07-01", "2026-06-30", "current"]);
}
