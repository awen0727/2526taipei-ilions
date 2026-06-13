const SHEETS = Object.freeze({
  MEMBERS: "Members",
  TERMS: "Terms",
  ROLES: "MemberRoles",
  EVENTS: "Events",
  ATTENDANCE: "Attendance",
  GUESTS: "Guests",
  BINDINGS: "BindingRequests",
  AUDIT: "AuditLogs"
});

const LEGACY_ROSTER = Object.freeze({
  spreadsheetId: "1PdVN_4KyubZEHdnLfchX70GcAU7o_DVr7Nc71imQDKk",
  sheetName: "名單"
});

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action !== "dashboard") throw new Error("不支援的 GET 操作");
    requireDashboardToken_(e.parameter.token);
    return json_({ ok: true, ...getDashboard_() });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const result = routePost_(payload);
    return json_({ ok: true, ...result });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function routePost_(payload) {
  const action = String(payload.action || "");
  const publicActions = {
    getSession: getSession_,
    requestBinding: requestBinding_,
    checkIn: checkIn_
  };
  const adminActions = {
    adminOverview: adminOverview_,
    adminCreateMember: adminCreateMember_,
    adminSetMemberStatus: adminSetMemberStatus_,
    adminApproveBinding: adminApproveBinding_,
    adminCreateEvent: adminCreateEvent_,
    adminSetEventStatus: adminSetEventStatus_,
    adminCreateTerm: adminCreateTerm_,
    adminSaveRole: adminSaveRole_,
    adminBulkImportMembers: adminBulkImportMembers_,
    adminImportLegacyRoster: adminImportLegacyRoster_,
    adminInspectLegacyRoster: adminInspectLegacyRoster_,
    adminAutoApproveBindings: adminAutoApproveBindings_
  };

  if (publicActions[action]) return publicActions[action](payload);
  if (adminActions[action]) {
    requireAdmin_(payload.adminToken);
    return adminActions[action](payload);
  }
  throw new Error("不支援的操作");
}

function getSession_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
  const event = getOpenEvent_();
  const pending = findRows_(SHEETS.BINDINGS, row =>
    row.line_user_id === line.sub && row.status === "pending"
  ).length > 0;

  if (!member || member.status !== "active") {
    return { member: null, event, bindingPending: pending, alreadyCheckedIn: false };
  }

  const role = event ? getRole_(event.term_id, member.member_id) : null;
  const alreadyCheckedIn = event
    ? findRows_(SHEETS.ATTENDANCE, row =>
        row.event_id === event.event_id && row.member_id === member.member_id
      ).length > 0
    : false;

  return {
    member: {
      member_id: member.member_id,
      name: memberDisplayName_(member),
      chinese_name: member.chinese_name || "",
      english_name: member.english_name || "",
      position: role ? role.position : "會員"
    },
    event,
    bindingPending: pending,
    alreadyCheckedIn
  };
}

function requestBinding_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const claimedName = cleanText_(payload.claimedName, 40, "會員姓名");
  const existingMember = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
  if (existingMember) throw new Error("此 LINE 帳號已綁定會員");

  const pending = findRows_(SHEETS.BINDINGS, row =>
    row.line_user_id === line.sub && row.status === "pending"
  )[0];
  if (pending) throw new Error("綁定申請已送出，請等待管理員核准");

  const requestId = id_("BR");
  const lineDisplayName = cleanText_(line.name || "", 80);
  append_(SHEETS.BINDINGS, {
    request_id: requestId,
    line_user_id: line.sub,
    line_display_name: lineDisplayName,
    claimed_name: claimedName,
    status: "pending",
    created_at: now_(),
    resolved_at: "",
    resolved_by: ""
  });
  audit_("request_binding", line.sub, claimedName, "");
  const matched = autoApproveBindingByLineName_(requestId);
  return matched
    ? { message: `已依 LINE 名稱自動綁定：${memberDisplayName_(matched)}`, autoApproved: true }
    : { message: "綁定申請已送出，請等待管理員核准", autoApproved: false };
}

function checkIn_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const guestCount = integer_(payload.guestCount, 0, 20, "攜伴人數");
  const guestNames = cleanText_(payload.guestNames || "", 200);
  const note = cleanText_(payload.note || "", 300);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || member.status !== "active") throw new Error("找不到有效會員綁定");
    const event = getOpenEvent_();
    if (!event) throw new Error("目前沒有開放簽到的活動");
    const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
      row.event_id === event.event_id && row.member_id === member.member_id
    )[0];
    if (duplicate) throw new Error("您已完成本次活動簽到");

    const role = getRole_(event.term_id, member.member_id);
    const attendanceId = id_("AT");
    append_(SHEETS.ATTENDANCE, {
      attendance_id: attendanceId,
      event_id: event.event_id,
      member_id: member.member_id,
      name_snapshot: memberDisplayName_(member),
      role_snapshot: role ? role.position : "會員",
      checkin_at: now_(),
      source: "LINE",
      guest_count: guestCount,
      note
    });

    const names = guestNames.split(/[,，、\n]/).map(name => name.trim()).filter(Boolean);
    names.slice(0, guestCount).forEach(name => append_(SHEETS.GUESTS, {
      guest_id: id_("GU"),
      event_id: event.event_id,
      host_member_id: member.member_id,
      name: cleanText_(name, 50),
      type: "來賓",
      note: "",
      created_at: now_()
    }));
    audit_("check_in", member.member_id, event.event_id, attendanceId);
    return { message: `${memberDisplayName_(member)}，簽到成功！` };
  } finally {
    lock.releaseLock();
  }
}

function getDashboard_() {
  const event = getOpenEvent_();
  if (!event) return { event: null, memberCount: 0, guestCount: 0, list: [] };
  const records = findRows_(SHEETS.ATTENDANCE, row => row.event_id === event.event_id);
  return {
    event,
    memberCount: records.length,
    guestCount: records.reduce((sum, row) => sum + Number(row.guest_count || 0), 0),
    list: records.map(row => ({
      name: row.name_snapshot,
      position: row.role_snapshot,
      guest_count: Number(row.guest_count || 0),
      checkin_at: row.checkin_at
    }))
  };
}

function adminOverview_() {
  ensureMemberColumns_();
  const allBindings = rows_(SHEETS.BINDINGS);
  const members = rows_(SHEETS.MEMBERS).map(member => {
    const binding = allBindings.find(row =>
      row.status === "approved" && row.line_user_id === member.line_user_id
    );
    return {
      ...member,
      display_name: memberDisplayName_(member),
      line_display_name: member.line_display_name || (binding ? binding.line_display_name : "")
    };
  });
  return {
    members,
    events: rows_(SHEETS.EVENTS).sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))),
    bindings: allBindings.filter(row => row.status === "pending"),
    bindingHistory: allBindings.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    terms: rows_(SHEETS.TERMS),
    roles: rows_(SHEETS.ROLES)
  };
}

function adminCreateMember_(payload) {
  ensureMemberColumns_();
  const chineseName = cleanText_(payload.chineseName || payload.name, 40, "中文姓名");
  const englishName = cleanText_(payload.englishName || "", 40);
  const name = combineNames_(chineseName, englishName);
  const memberId = nextMemberId_();
  append_(SHEETS.MEMBERS, {
    member_id: memberId,
    name,
    chinese_name: chineseName,
    english_name: englishName,
    status: "active",
    join_date: cleanDate_(payload.joinDate),
    leave_date: "",
    line_user_id: "",
    line_display_name: "",
    created_at: now_(),
    updated_at: now_()
  });
  audit_("create_member", "admin", memberId, name);
  return { memberId };
}

function adminSetMemberStatus_(payload) {
  const status = ["active", "inactive"].includes(payload.status) ? payload.status : "";
  if (!status) throw new Error("會員狀態不正確");
  updateById_(SHEETS.MEMBERS, "member_id", payload.memberId, {
    status,
    leave_date: status === "inactive" ? dateOnly_(new Date()) : "",
    updated_at: now_()
  });
  audit_("set_member_status", "admin", payload.memberId, status);
  return {};
}

function adminApproveBinding_(payload) {
  ensureMemberColumns_();
  const request = findOne_(SHEETS.BINDINGS, "request_id", payload.requestId);
  if (!request || request.status !== "pending") throw new Error("找不到待核准申請");
  const member = findOne_(SHEETS.MEMBERS, "member_id", payload.memberId);
  if (!member || member.status !== "active") throw new Error("找不到有效會員");
  const used = findOne_(SHEETS.MEMBERS, "line_user_id", request.line_user_id);
  if (used && used.member_id !== member.member_id) throw new Error("此 LINE 帳號已綁定其他會員");

  updateById_(SHEETS.MEMBERS, "member_id", member.member_id, {
    line_user_id: request.line_user_id,
    line_display_name: request.line_display_name,
    updated_at: now_()
  });
  updateById_(SHEETS.BINDINGS, "request_id", request.request_id, {
    status: "approved",
    resolved_at: now_(),
    resolved_by: "admin"
  });
  audit_("approve_binding", "admin", member.member_id, request.request_id);
  return {};
}

function adminAutoApproveBindings_() {
  ensureMemberColumns_();
  const pending = findRows_(SHEETS.BINDINGS, row => row.status === "pending");
  let approved = 0;
  pending.forEach(request => {
    if (autoApproveBindingByLineName_(request.request_id)) approved++;
  });
  return { message: `自動核准完成：成功綁定 ${approved} 筆，其他申請仍需人工確認。` };
}

function autoApproveBindingByLineName_(requestId) {
  const request = findOne_(SHEETS.BINDINGS, "request_id", requestId);
  if (!request || request.status !== "pending") return null;
  const target = normalizeName_(request.line_display_name);
  if (!target) return null;
  const matches = findRows_(SHEETS.MEMBERS, row =>
    row.status === "active" &&
    !row.line_user_id &&
    normalizeName_(row.line_display_name) === target
  );
  if (matches.length !== 1) return null;
  const member = matches[0];
  updateById_(SHEETS.MEMBERS, "member_id", member.member_id, {
    line_user_id: request.line_user_id,
    line_display_name: request.line_display_name,
    updated_at: now_()
  });
  updateById_(SHEETS.BINDINGS, "request_id", request.request_id, {
    status: "approved",
    resolved_at: now_(),
    resolved_by: "line_name_auto_match"
  });
  audit_("auto_approve_binding", "system", member.member_id, request.request_id);
  return member;
}

function adminCreateEvent_(payload) {
  const name = cleanText_(payload.name, 80, "活動名稱");
  const eventDate = cleanDate_(payload.eventDate, true);
  const termId = cleanText_(payload.termId, 30, "年度 ID");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");

  const recentDuplicate = findRows_(SHEETS.EVENTS, row =>
    row.name === name && Date.now() - new Date(row.created_at).getTime() < 60000
  )[0];
  if (recentDuplicate) throw new Error("這場活動剛剛已建立，請勿重複送出");

  findRows_(SHEETS.EVENTS, row => row.status === "open").forEach(event =>
    updateById_(SHEETS.EVENTS, "event_id", event.event_id, { status: "closed" })
  );
  const eventId = id_("EV");
  append_(SHEETS.EVENTS, {
    event_id: eventId,
    term_id: termId,
    event_date: eventDate,
    name,
    status: "open",
    created_at: now_()
  });
  audit_("create_event", "admin", eventId, name);
  return { eventId };
}

function adminSetEventStatus_(payload) {
  const status = ["open", "closed", "archived"].includes(payload.status) ? payload.status : "";
  if (!status) throw new Error("活動狀態不正確");
  if (status === "open") {
    findRows_(SHEETS.EVENTS, row => row.status === "open" && row.event_id !== payload.eventId)
      .forEach(event => updateById_(SHEETS.EVENTS, "event_id", event.event_id, { status: "closed" }));
  }
  updateById_(SHEETS.EVENTS, "event_id", payload.eventId, { status });
  audit_("set_event_status", "admin", payload.eventId, status);
  return {};
}

function adminCreateTerm_(payload) {
  const termId = cleanText_(payload.termId, 30, "新年度 ID");
  if (findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("年度 ID 已存在");
  append_(SHEETS.TERMS, {
    term_id: termId,
    name: cleanText_(payload.name, 50, "新年度名稱"),
    start_date: cleanDate_(payload.startDate, true),
    end_date: cleanDate_(payload.endDate, true),
    status: "draft"
  });

  const source = cleanText_(payload.sourceTermId || "", 30);
  if (source) {
    findRows_(SHEETS.ROLES, row => row.term_id === source).forEach(role => append_(SHEETS.ROLES, {
      term_id: termId,
      member_id: role.member_id,
      position: role.position,
      sort_order: role.sort_order
    }));
  }
  audit_("create_term", "admin", termId, source);
  return {};
}

function adminSaveRole_(payload) {
  const termId = cleanText_(payload.termId, 30, "年度 ID");
  const memberId = cleanText_(payload.memberId, 30, "會員 ID");
  const position = cleanText_(payload.position, 50, "職位");
  const sortOrder = integer_(payload.sortOrder, 1, 999, "顯示順序");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");
  if (!findOne_(SHEETS.MEMBERS, "member_id", memberId)) throw new Error("找不到指定會員");
  const existing = findRows_(SHEETS.ROLES, row =>
    row.term_id === termId && row.member_id === memberId
  )[0];
  if (existing) {
    updateByComposite_(SHEETS.ROLES, { term_id: termId, member_id: memberId }, { position, sort_order: sortOrder });
  } else {
    append_(SHEETS.ROLES, { term_id: termId, member_id: memberId, position, sort_order: sortOrder });
  }
  audit_("save_role", "admin", `${termId}/${memberId}`, position);
  return {};
}

function adminBulkImportMembers_(payload) {
  const termId = cleanText_(payload.termId, 30, "匯入年度");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");
  const text = String(payload.text || "").trim();
  if (!text) throw new Error("請先貼上舊會員名單");

  const parsed = text.split(/\r?\n/).map((line, index) => {
    const columns = line.includes("\t") ? line.split("\t") : line.split(/[,，]/);
    return {
      name: cleanText_(columns[0] || "", 40),
      position: cleanText_(columns[1] || "會員", 50),
      sortOrder: index + 1
    };
  }).filter(row => row.name && !/^(姓名|會員姓名|name)$/i.test(row.name));
  if (!parsed.length) throw new Error("沒有找到可匯入的會員資料");
  if (parsed.length > 300) throw new Error("單次最多匯入 300 位會員");

  return importMemberRecords_(termId, parsed);
}

function adminImportLegacyRoster_(payload) {
  ensureMemberColumns_();
  const termId = cleanText_(payload.termId, 30, "匯入年度");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");
  const legacySheet = SpreadsheetApp.openById(LEGACY_ROSTER.spreadsheetId)
    .getSheetByName(LEGACY_ROSTER.sheetName);
  if (!legacySheet) throw new Error(`舊試算表找不到「${LEGACY_ROSTER.sheetName}」分頁`);
  const values = legacySheet.getDataRange().getDisplayValues();
  if (values.length < 2) throw new Error("舊版名單沒有可匯入資料");

  const headerInfo = detectLegacyHeaders_(values);
  const parsed = values.slice(headerInfo.headerRow + 1).map((row, index) => {
    const chineseName = cleanText_(row[headerInfo.nameColumn] || "", 40);
    const englishName = cleanText_(headerInfo.englishNameColumn >= 0 ? row[headerInfo.englishNameColumn] || "" : "", 40);
    return {
    name: combineNames_(chineseName, englishName),
    chineseName,
    englishName,
    matchName: chineseName,
    lineDisplayName: cleanText_(headerInfo.lineNameColumn >= 0 ? row[headerInfo.lineNameColumn] || "" : "", 80),
    position: cleanText_(headerInfo.positionColumn >= 0 ? row[headerInfo.positionColumn] || "會員" : "會員", 50),
    sortOrder: index + 1
  };}).filter(row => row.chineseName);
  if (!parsed.length) throw new Error("舊版名單沒有找到會員姓名");
  return importMemberRecords_(termId, parsed);
}

function adminInspectLegacyRoster_() {
  const legacySheet = SpreadsheetApp.openById(LEGACY_ROSTER.spreadsheetId)
    .getSheetByName(LEGACY_ROSTER.sheetName);
  if (!legacySheet) throw new Error(`舊試算表找不到「${LEGACY_ROSTER.sheetName}」分頁`);
  const values = legacySheet.getDataRange().getDisplayValues();
  const headerInfo = detectLegacyHeaders_(values);
  const headers = values[headerInfo.headerRow].map(String);
  const dataRows = values.slice(headerInfo.headerRow + 1);
  return {
    sheetName: LEGACY_ROSTER.sheetName,
    rowCount: dataRows.length,
    nonEmptyNameCount: dataRows.filter(row => String(row[headerInfo.nameColumn] || "").trim()).length,
    nonEmptyEnglishNameCount: headerInfo.englishNameColumn >= 0
      ? dataRows.filter(row => String(row[headerInfo.englishNameColumn] || "").trim()).length
      : 0,
    nonEmptyLineNameCount: headerInfo.lineNameColumn >= 0
      ? dataRows.filter(row => String(row[headerInfo.lineNameColumn] || "").trim()).length
      : 0,
    headerRow: headerInfo.headerRow + 1,
    headers,
    detected: {
      name: headers[headerInfo.nameColumn] || "",
      englishName: headerInfo.englishNameColumn >= 0 ? headers[headerInfo.englishNameColumn] : "",
      lineName: headerInfo.lineNameColumn >= 0 ? headers[headerInfo.lineNameColumn] : "",
      position: headerInfo.positionColumn >= 0 ? headers[headerInfo.positionColumn] : ""
    }
  };
}

function detectLegacyHeaders_(values) {
  const nameAliases = ["姓名", "會員姓名", "獅友姓名", "中文姓名", "名字", "name"];
  const englishNameAliases = [
    "英文名字", "英文姓名", "英文名", "英文名稱", "英文", "英文稱呼",
    "englishname", "english name", "english", "nickname", "nick name"
  ];
  const lineNameAliases = [
    "line名稱", "line名字", "line姓名", "line暱稱", "line name", "linename", "line"
  ];
  const positionAliases = ["職位", "職稱", "職務", "position", "job"];
  const limit = Math.min(values.length, 10);
  for (let rowIndex = 0; rowIndex < limit; rowIndex++) {
    const headers = values[rowIndex].map(value => normalizeName_(value));
    const nameColumn = headers.findIndex(value => nameAliases.map(normalizeName_).includes(value));
    if (nameColumn >= 0) {
      return {
        headerRow: rowIndex,
        nameColumn,
        englishNameColumn: headers.findIndex(value => englishNameAliases.map(normalizeName_).includes(value)),
        lineNameColumn: headers.findIndex(value => lineNameAliases.map(normalizeName_).includes(value)),
        positionColumn: headers.findIndex(value => positionAliases.map(normalizeName_).includes(value))
      };
    }
  }
  throw new Error("無法辨識舊名單的姓名欄，請確認前十列含有「姓名」標題");
}

function importMemberRecords_(termId, parsed) {
  if (parsed.length > 300) throw new Error("單次最多匯入 300 位會員");
  const uniqueRecords = [];
  const inputNames = {};
  parsed.forEach(item => {
    const normalized = normalizeName_(item.name);
    if (!normalized || inputNames[normalized]) return;
    inputNames[normalized] = true;
    uniqueRecords.push(item);
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existingMembers = rows_(SHEETS.MEMBERS);
    const seen = {};
    existingMembers.forEach(member => {
      [member.name, member.chinese_name, member.english_name].filter(Boolean)
        .forEach(value => seen[normalizeName_(value)] = member);
    });
    let created = 0;
    let existing = 0;
    let rolesSaved = 0;
    uniqueRecords.forEach(item => {
      const normalized = normalizeName_(item.name);
      if (!normalized) return;
      const matchNormalized = normalizeName_(item.matchName || item.name);
      const englishNormalized = normalizeName_(item.englishName || "");
      let member = seen[normalized] || seen[matchNormalized] || seen[englishNormalized];
      if (!member) {
        member = {
          member_id: nextMemberId_(),
          name: item.name,
          chinese_name: item.chineseName || item.name,
          english_name: item.englishName || "",
          status: "active",
          join_date: "",
          leave_date: "",
          line_user_id: "",
          line_display_name: item.lineDisplayName || "",
          created_at: now_(),
          updated_at: now_()
        };
        append_(SHEETS.MEMBERS, member);
        seen[normalized] = member;
        created++;
      } else {
        if (member.name !== item.name || member.chinese_name !== item.chineseName || member.english_name !== item.englishName) {
          updateById_(SHEETS.MEMBERS, "member_id", member.member_id, {
            name: item.name,
            chinese_name: item.chineseName || member.chinese_name || "",
            english_name: item.englishName || "",
            line_display_name: item.lineDisplayName || member.line_display_name || "",
            updated_at: now_()
          });
          delete seen[normalizeName_(member.name)];
          member.name = item.name;
          seen[normalized] = member;
        }
        existing++;
      }

      const role = findRows_(SHEETS.ROLES, row =>
        row.term_id === termId && row.member_id === member.member_id
      )[0];
      if (role) {
        updateByComposite_(SHEETS.ROLES, { term_id: termId, member_id: member.member_id }, {
          position: item.position,
          sort_order: item.sortOrder || role.sort_order || 100
        });
      } else {
        append_(SHEETS.ROLES, {
          term_id: termId,
          member_id: member.member_id,
          position: item.position,
          sort_order: item.sortOrder || 100
        });
      }
      rolesSaved++;
    });

    audit_("bulk_import_members", "admin", termId, JSON.stringify({ created, existing, rolesSaved }));
    return { message: `匯入完成：新增 ${created} 位、更新 ${existing} 位既有會員、儲存 ${rolesSaved} 筆職位。` };
  } finally {
    lock.releaseLock();
  }
}

function verifyLineToken_(idToken) {
  if (!idToken) throw new Error("缺少 LINE ID Token");
  const channelId = property_("LINE_CHANNEL_ID");
  const response = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error("LINE 身分驗證失敗");
  const result = JSON.parse(response.getContentText());
  if (!result.sub) throw new Error("LINE Token 缺少使用者識別碼");
  return result;
}

function requireAdmin_(token) {
  if (!token || !secureEqual_(String(token), property_("ADMIN_TOKEN"))) {
    throw new Error("管理密鑰不正確");
  }
}

function requireDashboardToken_(token) {
  if (!token || !secureEqual_(String(token), property_("DASHBOARD_TOKEN"))) {
    throw new Error("Dashboard Token 不正確");
  }
}

function getOpenEvent_() {
  return findRows_(SHEETS.EVENTS, row => row.status === "open")[0] || null;
}

function getRole_(termId, memberId) {
  return findRows_(SHEETS.ROLES, row => row.term_id === termId && row.member_id === memberId)
    .sort((a, b) => Number(a.sort_order || 999) - Number(b.sort_order || 999))[0] || null;
}

function spreadsheet_() {
  return SpreadsheetApp.openById(property_("SPREADSHEET_ID"));
}

function ensureMemberColumns_() {
  const sheet = spreadsheet_().getSheetByName(SHEETS.MEMBERS);
  if (!sheet) throw new Error("找不到 Members 資料表");
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  ["chinese_name", "english_name", "line_display_name"].forEach(header => {
    if (!headers.includes(header)) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(header);
      headers.push(header);
    }
  });
}

function rows_(sheetName) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error(`缺少資料表：${sheetName}`);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(row => row.some(value => value !== "")).map(row => {
    const item = {};
    headers.forEach((header, index) => item[header] = serialize_(row[index]));
    return item;
  });
}

function findRows_(sheetName, predicate) {
  return rows_(sheetName).filter(predicate);
}

function findOne_(sheetName, key, value) {
  return findRows_(sheetName, row => String(row[key]) === String(value))[0] || null;
}

function append_(sheetName, record) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(headers.map(header => sheetSafe_(record[header] == null ? "" : record[header])));
}

function updateById_(sheetName, idKey, idValue, changes) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idIndex = headers.indexOf(idKey);
  const rowIndex = values.findIndex((row, index) => index > 0 && String(row[idIndex]) === String(idValue));
  if (rowIndex < 1) throw new Error(`找不到資料：${idValue}`);
  Object.keys(changes).forEach(key => {
    const columnIndex = headers.indexOf(key);
    if (columnIndex >= 0) sheet.getRange(rowIndex + 1, columnIndex + 1).setValue(sheetSafe_(changes[key]));
  });
}

function updateByComposite_(sheetName, keys, changes) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const rowIndex = values.findIndex((row, index) =>
    index > 0 && Object.keys(keys).every(key => String(row[headers.indexOf(key)]) === String(keys[key]))
  );
  if (rowIndex < 1) throw new Error("找不到指定資料");
  Object.keys(changes).forEach(key => {
    const columnIndex = headers.indexOf(key);
    if (columnIndex >= 0) sheet.getRange(rowIndex + 1, columnIndex + 1).setValue(sheetSafe_(changes[key]));
  });
}

function nextMemberId_() {
  const max = rows_(SHEETS.MEMBERS).reduce((value, row) => {
    const number = Number(String(row.member_id).replace(/\D/g, "")) || 0;
    return Math.max(value, number);
  }, 0);
  return `M${String(max + 1).padStart(4, "0")}`;
}

function audit_(action, actor, target, details) {
  append_(SHEETS.AUDIT, {
    log_id: id_("LG"),
    action,
    actor,
    target,
    details: cleanText_(details || "", 500),
    created_at: now_()
  });
}

function cleanText_(value, maxLength, label) {
  const text = String(value == null ? "" : value).trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (label && !text) throw new Error(`${label}不可空白`);
  if (text.length > maxLength) throw new Error(`${label || "文字"}不可超過 ${maxLength} 字`);
  return text;
}

function normalizeName_(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function combineNames_(chineseName, englishName) {
  return [String(chineseName || "").trim(), String(englishName || "").trim()].filter(Boolean).join(" ");
}

function memberDisplayName_(member) {
  return combineNames_(member.chinese_name, member.english_name) || member.name || "";
}

function cleanDate_(value, required) {
  const text = String(value || "").trim();
  if (!text && !required) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("日期格式不正確");
  return text;
}

function integer_(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}必須介於 ${min} 至 ${max}`);
  }
  return number;
}

function sheetSafe_(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function secureEqual_(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

function property_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) throw new Error(`尚未設定 Script Property：${name}`);
  return value;
}

function id_(prefix) {
  return `${prefix}-${Utilities.getUuid()}`;
}

function now_() {
  return new Date().toISOString();
}

function dateOnly_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function serialize_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
