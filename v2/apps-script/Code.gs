const SHEETS = Object.freeze({
  MEMBERS: "Members",
  TERMS: "Terms",
  ROLES: "MemberRoles",
  EVENTS: "Events",
  ATTENDANCE: "Attendance",
  ATTENDANCE_RECORDS: "AttendanceRecords",
  REGISTRATIONS: "EventRegistrations",
  GUESTS: "Guests",
  BINDINGS: "BindingRequests",
  AUDIT: "AuditLogs"
});

const LEGACY_ROSTER = Object.freeze({
  spreadsheetId: "1PdVN_4KyubZEHdnLfchX70GcAU7o_DVr7Nc71imQDKk",
  sheetName: "名單"
});

const API_VERSION = "2026-06-27-event-registration-1";

function doGet(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "");
    if (action === "health") return json_({ ok: true, ...getHealth_() });
    if (action === "faceImage") {
      requireDashboardToken_(e.parameter.token);
      return json_({ ok: true, apiVersion: API_VERSION, ...getFaceImage_(e.parameter.fileId) });
    }
    if (action !== "dashboard") throw new Error("不支援的 GET 操作");
    requireDashboardToken_(e.parameter.token);
    return json_({ ok: true, apiVersion: API_VERSION, ...getDashboard_() });
  } catch (error) {
    return json_({ ok: false, error: error.message, apiVersion: API_VERSION });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const result = routePost_(payload);
    return json_({ ok: true, apiVersion: API_VERSION, ...result });
  } catch (error) {
    return json_({ ok: false, error: error.message, apiVersion: API_VERSION });
  }
}

function getHealth_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    apiVersion: API_VERSION,
    lineChannelId: properties.getProperty("LINE_CHANNEL_ID") || "",
    spreadsheetConfigured: Boolean(properties.getProperty("SPREADSHEET_ID"))
  };
}

function routePost_(payload) {
  const action = String(payload.action || "");
  const publicActions = {
    getSession: getSession_,
    requestBinding: requestBinding_,
    registerEvent: registerEvent_,
    cancelRegistration: cancelRegistration_,
    checkIn: checkIn_,
    faceCheckIn: faceCheckIn_
  };
  const adminActions = {
    adminOverview: adminOverview_,
    adminAttendanceReport: adminAttendanceReport_,
    adminRegistrationReport: adminRegistrationReport_,
    adminSyncAttendanceRecords: adminSyncAttendanceRecords_,
    adminManualCheckIn: adminManualCheckIn_,
    adminCreateMember: adminCreateMember_,
    adminSetMemberStatus: adminSetMemberStatus_,
    adminSetMemberLineBinding: adminSetMemberLineBinding_,
    adminApproveBinding: adminApproveBinding_,
    adminCreateEvent: adminCreateEvent_,
    adminUpdateEvent: adminUpdateEvent_,
    adminDeleteEvent: adminDeleteEvent_,
    adminSetEventStatus: adminSetEventStatus_,
    adminCreateTerm: adminCreateTerm_,
    adminSaveRole: adminSaveRole_,
    adminSaveRolesBatch: adminSaveRolesBatch_,
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
    return { member: null, event, bindingPending: pending, alreadyCheckedIn: false, registrationEvents: [] };
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
    alreadyCheckedIn,
    registrationEvents: getRegisterableEvents_(member.member_id)
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

function registerEvent_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const eventId = cleanText_(payload.eventId, 80, "活動 ID");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || member.status !== "active") throw new Error("找不到有效會員綁定");
    const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
    if (!event) throw new Error("找不到指定活動");
    if (!isEventRegisterable_(event)) throw new Error("此活動已截止報名");

    const existing = registrationRows_().find(row =>
      row.event_id === eventId && row.member_id === member.member_id
    );
    const role = getRole_(event.term_id, member.member_id);
    if (existing && existing.status === "registered") throw new Error("您已完成此活動報名");
    if (existing) {
      updateById_(SHEETS.REGISTRATIONS, "registration_id", existing.registration_id, {
        name_snapshot: memberDisplayName_(member),
        role_snapshot: role ? role.position : "會員",
        status: "registered",
        registered_at: now_(),
        canceled_at: "",
        source: "LINE"
      });
    } else {
      append_(SHEETS.REGISTRATIONS, {
        registration_id: id_("RG"),
        event_id: event.event_id,
        member_id: member.member_id,
        name_snapshot: memberDisplayName_(member),
        role_snapshot: role ? role.position : "會員",
        status: "registered",
        registered_at: now_(),
        canceled_at: "",
        source: "LINE"
      });
    }
    audit_("register_event", member.member_id, event.event_id, "LINE");
    return { message: `${event.name} 報名成功。` };
  } finally {
    lock.releaseLock();
  }
}

function cancelRegistration_(payload) {
  const line = verifyLineToken_(payload.idToken);
  const eventId = cleanText_(payload.eventId, 80, "活動 ID");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const member = findOne_(SHEETS.MEMBERS, "line_user_id", line.sub);
    if (!member || member.status !== "active") throw new Error("找不到有效會員綁定");
    const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
    if (!event) throw new Error("找不到指定活動");
    if (!isEventRegisterable_(event)) throw new Error("此活動已截止取消報名");
    const existing = registrationRows_().find(row =>
      row.event_id === eventId && row.member_id === member.member_id && row.status === "registered"
    );
    if (!existing) throw new Error("尚未報名此活動");
    updateById_(SHEETS.REGISTRATIONS, "registration_id", existing.registration_id, {
      status: "canceled",
      canceled_at: now_()
    });
    audit_("cancel_registration", member.member_id, event.event_id, "LINE");
    return { message: `${event.name} 已取消報名。` };
  } finally {
    lock.releaseLock();
  }
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
    const checkinAt = now_();
    append_(SHEETS.ATTENDANCE, {
      attendance_id: attendanceId,
      event_id: event.event_id,
      member_id: member.member_id,
      name_snapshot: memberDisplayName_(member),
      role_snapshot: role ? role.position : "會員",
      checkin_at: checkinAt,
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
    appendReadableAttendanceRecord_(event, member, role, {
      attendanceId,
      source: "LINE",
      checkinAt,
      guestCount,
      guestNames: names.slice(0, guestCount).join("、"),
      note
    });
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
  const guests = findRows_(SHEETS.GUESTS, row => row.event_id === event.event_id);
  const members = rows_(SHEETS.MEMBERS);
  const checkedMemberIds = {};
  const memberCards = records.map(row => {
    checkedMemberIds[row.member_id] = true;
    const member = members.find(item => item.member_id === row.member_id);
    return {
      type: "member",
      name: member ? memberDisplayName_(member) : row.name_snapshot,
      position: row.role_snapshot,
      sort_order: getRole_(event.term_id, row.member_id)?.sort_order || 999,
      guest_count: Number(row.guest_count || 0),
      checkin_at: row.checkin_at
    };
  });
  const guestCards = [];
  guests.forEach(guest => {
    const matchingMembers = members.filter(member =>
      member.status === "active" && memberMatchesName_(member, guest.name)
    );
    if (matchingMembers.length === 1) {
      const member = matchingMembers[0];
      if (checkedMemberIds[member.member_id]) return;
      checkedMemberIds[member.member_id] = true;
      const role = getRole_(event.term_id, member.member_id);
      memberCards.push({
        type: "member",
        name: memberDisplayName_(member),
        position: role ? role.position : "會員",
        sort_order: role ? role.sort_order : 999,
        guest_count: 0,
        checkin_at: guest.created_at,
        registration_note: "由會員攜伴名單辨識"
      });
      return;
    }
    guestCards.push({
      type: "guest",
      name: guest.name || "未填姓名來賓",
      position: guest.type || "來賓",
      host_name: hostDisplayName_(members, guest.host_member_id),
      checkin_at: guest.created_at
    });
  });
  const totalDeclaredGuests = records.reduce((sum, row) => sum + Number(row.guest_count || 0), 0);
  const unnamedGuestCount = Math.max(0, totalDeclaredGuests - guests.length);
  for (let index = 0; index < unnamedGuestCount; index++) {
    guestCards.push({
      type: "guest",
      name: "未填姓名來賓",
      position: "來賓",
      host_name: "",
      checkin_at: ""
    });
  }
  return {
    event,
    memberCount: memberCards.length,
    guestCount: guestCards.length,
    list: memberCards
      .sort((a, b) => Number(a.sort_order || 999) - Number(b.sort_order || 999) || a.name.localeCompare(b.name))
      .concat(guestCards)
  };
}

function getFaceImage_(fileId) {
  const id = cleanText_(fileId || "", 120, "Drive 圖片 ID");
  const file = DriveApp.getFileById(id);
  const blob = file.getBlob();
  const mimeType = blob.getContentType();
  if (!/^image\//i.test(mimeType)) throw new Error("Drive 檔案不是圖片");
  const bytes = blob.getBytes();
  if (bytes.length > 2 * 1024 * 1024) throw new Error("圖片檔案過大，請壓縮到 2MB 以下");
  return {
    mimeType,
    dataUrl: `data:${mimeType};base64,${Utilities.base64Encode(bytes)}`
  };
}

function memberMatchesName_(member, name) {
  const target = normalizeName_(name);
  return target && [member.name, member.chinese_name, member.english_name, memberDisplayName_(member)]
    .filter(Boolean)
    .some(value => normalizeName_(value) === target);
}

function hostDisplayName_(members, memberId) {
  const member = members.find(item => item.member_id === memberId);
  return member ? memberDisplayName_(member) : "";
}

function adminOverview_() {
  ensureMemberColumns_();
  ensureRegistrationSheet_();
  const allBindings = rows_(SHEETS.BINDINGS);
  const registrationCounts = registrationRows_().reduce((counts, row) => {
    if (row.status === "registered") counts[row.event_id] = (counts[row.event_id] || 0) + 1;
    return counts;
  }, {});
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
    events: rows_(SHEETS.EVENTS)
      .map(event => ({
        ...event,
        registration_count: registrationCounts[event.event_id] || 0
      }))
      .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date))),
    bindings: allBindings.filter(row => row.status === "pending"),
    bindingHistory: allBindings.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    terms: rows_(SHEETS.TERMS),
    roles: rows_(SHEETS.ROLES)
  };
}

function adminAttendanceReport_(payload) {
  ensureMemberColumns_();
  ensureRegistrationSheet_();
  const terms = rows_(SHEETS.TERMS);
  const requestedTermId = String(payload.termId || "");
  const currentTerm = terms.find(term => term.status === "current") || terms[0];
  const termId = terms.some(term => term.term_id === requestedTermId)
    ? requestedTermId
    : (currentTerm ? currentTerm.term_id : "");
  const events = rows_(SHEETS.EVENTS)
    .filter(event => event.term_id === termId)
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
  const eventIds = {};
  events.forEach(event => { eventIds[event.event_id] = true; });

  const attendance = rows_(SHEETS.ATTENDANCE).filter(row => eventIds[row.event_id]);
  const guests = rows_(SHEETS.GUESTS).filter(row => eventIds[row.event_id]);
  const registrations = registrationRows_().filter(row => eventIds[row.event_id] && row.status === "registered");
  const roles = rows_(SHEETS.ROLES).filter(role => role.term_id === termId);
  const roleByMember = {};
  roles.forEach(role => { roleByMember[role.member_id] = role; });
  const attendanceMemberIds = {};
  attendance.forEach(row => { attendanceMemberIds[row.member_id] = true; });

  const allMembers = rows_(SHEETS.MEMBERS);
  const members = allMembers
    .filter(member => member.status === "active" || roleByMember[member.member_id] || attendanceMemberIds[member.member_id])
    .map(member => {
      const records = attendance.filter(row => row.member_id === member.member_id);
      const attendedCount = records.length;
      return {
        member_id: member.member_id,
        name: memberDisplayName_(member),
        member_status: member.status,
        position: roleByMember[member.member_id] ? roleByMember[member.member_id].position : "會員",
        sort_order: Number(roleByMember[member.member_id] ? roleByMember[member.member_id].sort_order : 999),
        attended_count: attendedCount,
        absent_count: Math.max(0, events.length - attendedCount),
        attendance_rate: events.length ? Math.round(attendedCount / events.length * 1000) / 10 : 0
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const eventSummaries = events.map(event => ({
    ...event,
    member_count: attendance.filter(row => row.event_id === event.event_id).length,
    registration_count: registrations.filter(row => row.event_id === event.event_id).length,
    guest_count: Math.max(
      guests.filter(row => row.event_id === event.event_id).length,
      attendance
        .filter(row => row.event_id === event.event_id)
        .reduce((sum, row) => sum + Number(row.guest_count || 0), 0)
    )
  }));
  const requestedEventId = String(payload.eventId || "");
  const selectedEvent = eventSummaries.find(event => event.event_id === requestedEventId) || eventSummaries[eventSummaries.length - 1] || null;
  const selectedAttendance = selectedEvent
    ? attendance.filter(row => row.event_id === selectedEvent.event_id)
    : [];
  const selectedByMember = {};
  selectedAttendance.forEach(row => { selectedByMember[row.member_id] = row; });
  const selectedGuestRows = selectedEvent
    ? guests.filter(row => row.event_id === selectedEvent.event_id)
    : [];
  const selectedEventGuests = selectedGuestRows.map(guest => ({
    name: guest.name || "未填姓名來賓",
    type: guest.type || "來賓",
    host_name: hostDisplayName_(allMembers, guest.host_member_id),
    created_at: guest.created_at,
    note: guest.note || ""
  }));
  const selectedEventRegistrations = selectedEvent
    ? registrations
        .filter(row => row.event_id === selectedEvent.event_id)
        .map(row => {
          const member = allMembers.find(item => item.member_id === row.member_id) || {};
          const role = roleByMember[row.member_id];
          return {
            registration_id: row.registration_id,
            member_id: row.member_id,
            name: member.member_id ? memberDisplayName_(member) : row.name_snapshot,
            position: row.role_snapshot || (role ? role.position : "會員"),
            sort_order: Number(role ? role.sort_order : 999),
            registered_at: row.registered_at,
            source: row.source || "LINE"
          };
        })
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    : [];
  selectedAttendance.forEach(record => {
    const namedCount = selectedGuestRows.filter(guest => guest.host_member_id === record.member_id).length;
    const missingCount = Math.max(0, Number(record.guest_count || 0) - namedCount);
    for (let index = 0; index < missingCount; index++) {
      selectedEventGuests.push({
        name: "未填姓名來賓",
        type: "來賓",
        host_name: hostDisplayName_(allMembers, record.member_id),
        created_at: record.checkin_at,
        note: ""
      });
    }
  });

  return {
    terms,
    selectedTermId: termId,
    events: eventSummaries,
    selectedEvent,
    summary: {
      event_count: events.length,
      member_count: members.length,
      attendance_count: attendance.length,
      average_attendance: events.length ? Math.round(attendance.length / events.length * 10) / 10 : 0
    },
    members,
    selectedEventGuests,
    selectedEventRegistrations,
    memberEventRecords: buildMemberEventRecords_(members, events, attendance),
    selectedEventMembers: members.map(member => {
      const record = selectedByMember[member.member_id];
      return {
        ...member,
        attended: Boolean(record),
        checkin_at: record ? record.checkin_at : "",
        role_snapshot: record ? record.role_snapshot : member.position,
        guest_count: record ? Number(record.guest_count || 0) : 0,
        note: record ? record.note : ""
      };
    }).sort((a, b) =>
      Number(b.attended) - Number(a.attended)
      || a.sort_order - b.sort_order
      || a.name.localeCompare(b.name)
    )
  };
}

function buildMemberEventRecords_(members, events, attendance) {
  const recordsByMember = {};
  members.forEach(member => {
    recordsByMember[member.member_id] = events.map(event => {
      const record = attendance.find(row =>
        row.event_id === event.event_id && row.member_id === member.member_id
      );
      return {
        event_id: event.event_id,
        event_name: event.name,
        event_date: event.event_date,
        attended: Boolean(record),
        checkin_at: record ? record.checkin_at : "",
        role_snapshot: record ? record.role_snapshot : member.position,
        source: record ? record.source : "",
        guest_count: record ? Number(record.guest_count || 0) : 0,
        note: record ? record.note : ""
      };
    });
  });
  return recordsByMember;
}

function adminRegistrationReport_(payload) {
  ensureRegistrationSheet_();
  const eventId = cleanText_(payload.eventId, 80, "活動 ID");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到指定活動");
  const members = rows_(SHEETS.MEMBERS);
  const roles = rows_(SHEETS.ROLES).filter(role => role.term_id === event.term_id);
  const roleByMember = {};
  roles.forEach(role => { roleByMember[role.member_id] = role; });
  const registrants = registrationRows_()
    .filter(row => row.event_id === eventId && row.status === "registered")
    .map(row => {
      const member = members.find(item => item.member_id === row.member_id) || {};
      const role = roleByMember[row.member_id];
      return {
        registration_id: row.registration_id,
        member_id: row.member_id,
        name: member.member_id ? memberDisplayName_(member) : row.name_snapshot,
        position: row.role_snapshot || (role ? role.position : "會員"),
        sort_order: Number(role ? role.sort_order : 999),
        registered_at: row.registered_at,
        source: row.source || "LINE"
      };
    })
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  return { event, registrants, total: registrants.length };
}

function adminSyncAttendanceRecords_() {
  const count = rebuildReadableAttendanceRecords_();
  return { message: `已同步 ${count} 筆出席明細到 ${SHEETS.ATTENDANCE_RECORDS} 分頁。` };
}

function adminManualCheckIn_(payload) {
  const memberId = cleanText_(payload.memberId, 30, "會員 ID");
  const guestCount = integer_(payload.guestCount, 0, 20, "攜伴人數");
  const guestNames = cleanText_(payload.guestNames || "", 200);
  const note = cleanText_(payload.note || "", 300);
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member || member.status !== "active") throw new Error("找不到有效會員");
  const event = getOpenEvent_();
  if (!event) throw new Error("目前沒有開放簽到的活動");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
      row.event_id === event.event_id && row.member_id === memberId
    )[0];
    if (duplicate) throw new Error(`${memberDisplayName_(member)} 已完成本次活動簽到`);

    const role = getRole_(event.term_id, memberId);
    const attendanceId = id_("AT");
    const checkinAt = now_();
    append_(SHEETS.ATTENDANCE, {
      attendance_id: attendanceId,
      event_id: event.event_id,
      member_id: memberId,
      name_snapshot: memberDisplayName_(member),
      role_snapshot: role ? role.position : "會員",
      checkin_at: checkinAt,
      source: "ADMIN",
      guest_count: guestCount,
      note
    });

    const names = guestNames.split(/[,，、\n]/).map(name => name.trim()).filter(Boolean);
    names.slice(0, guestCount).forEach(name => append_(SHEETS.GUESTS, {
      guest_id: id_("GU"),
      event_id: event.event_id,
      host_member_id: memberId,
      name: cleanText_(name, 50),
      type: "來賓",
      note: "管理員手動補登",
      created_at: now_()
    }));
    appendReadableAttendanceRecord_(event, member, role, {
      attendanceId,
      source: "ADMIN",
      checkinAt,
      guestCount,
      guestNames: names.slice(0, guestCount).join("、"),
      note
    });
    audit_("manual_check_in", "admin", memberId, event.event_id);
    return { message: `${memberDisplayName_(member)} 已由管理員完成手動簽到。` };
  } finally {
    lock.releaseLock();
  }
}

function faceCheckIn_(payload) {
  requireDashboardToken_(payload.token);
  const memberId = cleanText_(payload.memberId || "", 30);
  const memberName = cleanText_(payload.memberName || "", 80);
  const guestCount = integer_(payload.guestCount, 0, 20, "攜伴人數");
  const guestNames = cleanText_(payload.guestNames || "", 200);
  const note = cleanText_(payload.note || "", 300);
  const confidence = cleanText_(payload.confidence || "", 30);

  let member = memberId ? findOne_(SHEETS.MEMBERS, "member_id", memberId) : null;
  if (!member && memberName) {
    const matches = findRows_(SHEETS.MEMBERS, row => row.status === "active" && memberMatchesName_(row, memberName));
    if (matches.length > 1) throw new Error(`辨識名稱「${memberName}」對應到多位會員，請在 face-data.js 改用 memberId`);
    member = matches[0] || null;
  }
  if (!member || member.status !== "active") throw new Error("找不到有效會員，請確認 face-data.js 的 memberId 或姓名");

  const event = getOpenEvent_();
  if (!event) throw new Error("目前沒有開放簽到的活動");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const duplicate = findRows_(SHEETS.ATTENDANCE, row =>
      row.event_id === event.event_id && row.member_id === member.member_id
    )[0];
    if (duplicate) throw new Error(`${memberDisplayName_(member)} 已完成本次活動簽到`);

    const role = getRole_(event.term_id, member.member_id);
    const attendanceId = id_("AT");
    const checkinAt = now_();
    const finalNote = [note, confidence ? `人臉辨識距離：${confidence}` : ""].filter(Boolean).join("；");
    append_(SHEETS.ATTENDANCE, {
      attendance_id: attendanceId,
      event_id: event.event_id,
      member_id: member.member_id,
      name_snapshot: memberDisplayName_(member),
      role_snapshot: role ? role.position : "會員",
      checkin_at: checkinAt,
      source: "FACE",
      guest_count: guestCount,
      note: finalNote
    });

    const names = guestNames.split(/[,，、\n]/).map(name => name.trim()).filter(Boolean);
    names.slice(0, guestCount).forEach(name => append_(SHEETS.GUESTS, {
      guest_id: id_("GU"),
      event_id: event.event_id,
      host_member_id: member.member_id,
      name: cleanText_(name, 50),
      type: "來賓",
      note: "人臉簽到登記",
      created_at: now_()
    }));
    appendReadableAttendanceRecord_(event, member, role, {
      attendanceId,
      source: "FACE",
      checkinAt,
      guestCount,
      guestNames: names.slice(0, guestCount).join("、"),
      note: finalNote
    });
    audit_("face_check_in", "face", member.member_id, event.event_id);
    return { message: `${memberDisplayName_(member)}，人臉簽到成功！` };
  } finally {
    lock.releaseLock();
  }
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

function adminSetMemberLineBinding_(payload) {
  ensureMemberColumns_();
  const memberId = cleanText_(payload.memberId, 30, "會員 ID");
  const member = findOne_(SHEETS.MEMBERS, "member_id", memberId);
  if (!member) throw new Error("找不到指定會員");
  const lineUserId = cleanText_(payload.lineUserId || "", 80);
  const lineDisplayName = cleanText_(payload.lineDisplayName || "", 80);
  if (lineUserId && !/^U[a-fA-F0-9]{32}$/.test(lineUserId)) {
    throw new Error("LINE User ID 格式不正確，應為 U 開頭加 32 位英數字");
  }
  const used = lineUserId ? findOne_(SHEETS.MEMBERS, "line_user_id", lineUserId) : null;
  if (used && used.member_id !== memberId) {
    throw new Error(`此 LINE User ID 已綁定會員：${memberDisplayName_(used)}`);
  }
  updateById_(SHEETS.MEMBERS, "member_id", memberId, {
    line_user_id: lineUserId,
    line_display_name: lineUserId ? lineDisplayName : "",
    updated_at: now_()
  });
  audit_(lineUserId ? "set_line_binding" : "remove_line_binding", "admin", memberId, lineDisplayName);
  return { message: lineUserId ? "LINE 綁定已更新。" : "LINE 綁定已解除。" };
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
  const termId = termIdForDate_(eventDate) || cleanText_(payload.termId, 30, "年度 ID");
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

function adminUpdateEvent_(payload) {
  const eventId = cleanText_(payload.eventId, 80, "活動 ID");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到指定活動");
  const eventDate = cleanDate_(payload.eventDate, true);
  const termId = termIdForDate_(eventDate) || cleanText_(payload.termId, 30, "年度 ID");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");
  const name = cleanText_(payload.name, 80, "活動名稱");
  updateById_(SHEETS.EVENTS, "event_id", eventId, { name, event_date: eventDate, term_id: termId });
  audit_("update_event", "admin", eventId, JSON.stringify({ name, eventDate, termId }));
  return { message: "活動資料已更新。" };
}

function adminDeleteEvent_(payload) {
  const eventId = cleanText_(payload.eventId, 80, "活動 ID");
  const event = findOne_(SHEETS.EVENTS, "event_id", eventId);
  if (!event) throw new Error("找不到指定活動");
  const attendanceCount = findRows_(SHEETS.ATTENDANCE, row => row.event_id === eventId).length;
  const guestCount = findRows_(SHEETS.GUESTS, row => row.event_id === eventId).length;
  const registrationCount = registrationRows_().filter(row => row.event_id === eventId).length;
  if (attendanceCount || guestCount || registrationCount) {
    throw new Error(`活動已有 ${attendanceCount} 筆出席、${guestCount} 筆來賓、${registrationCount} 筆報名紀錄，不能永久刪除；請改用封存。`);
  }
  deleteById_(SHEETS.EVENTS, "event_id", eventId);
  audit_("delete_event", "admin", eventId, event.name);
  return { message: "沒有簽到紀錄的活動已永久刪除。" };
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

function adminSaveRolesBatch_(payload) {
  const termId = cleanText_(payload.termId, 30, "年度 ID");
  if (!findOne_(SHEETS.TERMS, "term_id", termId)) throw new Error("找不到指定年度");
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  if (!roles.length) throw new Error("沒有可儲存的職位資料");
  if (roles.length > 300) throw new Error("單次最多儲存 300 筆職位");

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    roles.forEach(item => {
      const memberId = cleanText_(item.memberId, 30, "會員 ID");
      const position = cleanText_(item.position, 50, "職位");
      const sortOrder = integer_(item.sortOrder, 1, 999, "顯示順序");
      if (!findOne_(SHEETS.MEMBERS, "member_id", memberId)) throw new Error(`找不到會員：${memberId}`);
      const existing = findRows_(SHEETS.ROLES, row =>
        row.term_id === termId && row.member_id === memberId
      )[0];
      if (existing) {
        updateByComposite_(SHEETS.ROLES, { term_id: termId, member_id: memberId }, {
          position,
          sort_order: sortOrder
        });
      } else {
        append_(SHEETS.ROLES, { term_id: termId, member_id: memberId, position, sort_order: sortOrder });
      }
    });
    audit_("save_roles_batch", "admin", termId, `${roles.length} roles`);
    return { message: `已儲存 ${roles.length} 位會員的年度職位。` };
  } finally {
    lock.releaseLock();
  }
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
  const tokenPayload = decodeJwtPayload_(idToken);
  const response = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "post",
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    let description = "";
    try {
      const errorBody = JSON.parse(response.getContentText());
      description = errorBody.error_description || errorBody.error || "";
    } catch (error) {
      description = "";
    }
    const audience = tokenPayload.aud || "無法判斷";
    throw new Error(
      `LINE 身分驗證失敗${description ? `：${description}` : ""}。` +
      `Token Channel ID：${audience}；Apps Script LINE_CHANNEL_ID：${channelId}`
    );
  }
  const result = JSON.parse(response.getContentText());
  if (!result.sub) throw new Error("LINE Token 缺少使用者識別碼");
  return result;
}

function decodeJwtPayload_(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return {};
    return JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString());
  } catch (error) {
    return {};
  }
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

function ensureRegistrationSheet_() {
  const headers = ["registration_id", "event_id", "member_id", "name_snapshot", "role_snapshot", "status", "registered_at", "canceled_at", "source"];
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(SHEETS.REGISTRATIONS);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEETS.REGISTRATIONS);
  const existing = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0].slice(0, headers.length).map(String)
    : [];
  if (existing.join("\t") !== headers.join("\t")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#fbd050");
  }
  return { sheet, headers };
}

function registrationRows_() {
  ensureRegistrationSheet_();
  return rows_(SHEETS.REGISTRATIONS);
}

function getRegisterableEvents_(memberId) {
  const today = dateOnly_(new Date());
  const registered = {};
  registrationRows_().forEach(row => {
    if (row.member_id === memberId && row.status === "registered") registered[row.event_id] = true;
  });
  return rows_(SHEETS.EVENTS)
    .filter(event => isEventRegisterable_(event, today))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)))
    .map(event => ({
      event_id: event.event_id,
      term_id: event.term_id,
      event_date: event.event_date,
      name: event.name,
      status: event.status,
      registered: Boolean(registered[event.event_id])
    }));
}

function isEventRegisterable_(event, todayValue) {
  const today = todayValue || dateOnly_(new Date());
  return event && event.status !== "archived" && String(event.event_date || "") >= today;
}

function ensureReadableAttendanceSheet_() {
  const headers = ["recorded_at", "event_date", "event_name", "term_id", "member_id", "member_name", "role", "source", "checkin_at", "guest_count", "guest_names", "note", "attendance_id", "event_id"];
  const spreadsheet = spreadsheet_();
  let sheet = spreadsheet.getSheetByName(SHEETS.ATTENDANCE_RECORDS);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEETS.ATTENDANCE_RECORDS);
  const existing = sheet.getLastColumn()
    ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0].slice(0, headers.length).map(String)
    : [];
  if (existing.join("\t") !== headers.join("\t")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#fbd050");
  }
  return { sheet, headers };
}

function appendReadableAttendanceRecord_(event, member, role, data) {
  const { sheet, headers } = ensureReadableAttendanceSheet_();
  const row = readableAttendanceRecord_(event, member, role, data);
  sheet.appendRow(headers.map(header => sheetSafe_(row[header] == null ? "" : row[header])));
}

function rebuildReadableAttendanceRecords_() {
  const { sheet, headers } = ensureReadableAttendanceSheet_();
  const attendance = rows_(SHEETS.ATTENDANCE);
  const events = rows_(SHEETS.EVENTS);
  const members = rows_(SHEETS.MEMBERS);
  const guests = rows_(SHEETS.GUESTS);
  const output = attendance.map(record => {
    const event = events.find(item => item.event_id === record.event_id) || {};
    const member = members.find(item => item.member_id === record.member_id) || {};
    const eventGuests = guests.filter(guest =>
      guest.event_id === record.event_id && guest.host_member_id === record.member_id
    );
    return readableAttendanceRecord_(event, member, null, {
      attendanceId: record.attendance_id,
      source: record.source,
      checkinAt: record.checkin_at,
      roleSnapshot: record.role_snapshot,
      guestCount: Number(record.guest_count || 0),
      guestNames: eventGuests.map(guest => guest.name || "未填姓名來賓").join("、"),
      note: record.note
    });
  }).sort((a, b) =>
    String(a.event_date).localeCompare(String(b.event_date))
    || String(a.checkin_at).localeCompare(String(b.checkin_at))
  );
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  if (output.length) {
    sheet.getRange(2, 1, output.length, headers.length)
      .setValues(output.map(row => headers.map(header => sheetSafe_(row[header] == null ? "" : row[header]))));
  }
  sheet.autoResizeColumns(1, headers.length);
  return output.length;
}

function readableAttendanceRecord_(event, member, role, data) {
  return {
    recorded_at: now_(),
    event_date: storedDateOnly_(event.event_date || ""),
    event_name: event.name || "",
    term_id: event.term_id || "",
    member_id: member.member_id || "",
    member_name: member.member_id ? memberDisplayName_(member) : "",
    role: data.roleSnapshot || (role ? role.position : "會員"),
    source: data.source || "",
    checkin_at: data.checkinAt || now_(),
    guest_count: data.guestCount || 0,
    guest_names: data.guestNames || "",
    note: data.note || "",
    attendance_id: data.attendanceId || "",
    event_id: event.event_id || ""
  };
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

function deleteById_(sheetName, idKey, idValue) {
  const sheet = spreadsheet_().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idIndex = headers.indexOf(idKey);
  const rowIndex = values.findIndex((row, index) => index > 0 && String(row[idIndex]) === String(idValue));
  if (rowIndex < 1) throw new Error(`找不到資料：${idValue}`);
  sheet.deleteRow(rowIndex + 1);
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

function termIdForDate_(dateValue) {
  const date = cleanDate_(dateValue, true);
  const term = rows_(SHEETS.TERMS).find(item => {
    const start = storedDateOnly_(item.start_date);
    const end = storedDateOnly_(item.end_date);
    return start && end && date >= start && date <= end;
  });
  return term ? term.term_id : "";
}

function storedDateOnly_(value) {
  if (!value) return "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text.slice(0, 10) : dateOnly_(date);
}

function serialize_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
