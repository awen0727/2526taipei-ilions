(function () {
  "use strict";

  const { config, post, get, setMessage, formatDateTime } = window.ILionsV2;
  const message = document.getElementById("message");
  const tokenInput = document.getElementById("adminToken");
  let state = { members: [], events: [], bindings: [], bindingHistory: [], terms: [], roles: [] };
  let attendanceReport = null;
  let todayAttendanceReport = null;
  let currentDashboard = null;

  tokenInput.value = sessionStorage.getItem("ilionsV2AdminToken") || "";
  document.getElementById("quickEventDate").valueAsDate = new Date();
  document.getElementById("eventDate").valueAsDate = new Date();
  document.getElementById("joinDate").valueAsDate = new Date();

  function adminToken() {
    const value = tokenInput.value.trim();
    if (!value) throw new Error("請輸入管理密鑰");
    sessionStorage.setItem("ilionsV2AdminToken", value);
    return value;
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }

  function button(label, handler, style) {
    const control = el("button", style || "", label);
    control.type = "button";
    control.addEventListener("click", handler);
    return control;
  }

  function labeledControl(labelText, control) {
    const label = el("label", "", labelText);
    label.appendChild(control);
    return label;
  }

  function selectMembers(selectedId) {
    const select = el("select");
    select.appendChild(new Option("請選擇會員", ""));
    state.members.filter(member => member.status === "active").forEach(member => {
      select.appendChild(new Option(member.display_name || member.name, member.member_id, false, member.member_id === selectedId));
    });
    return select;
  }

  function fillTerms(select, includeBlank) {
    const previous = select.value;
    select.replaceChildren();
    if (includeBlank) select.appendChild(new Option("不複製職位", ""));
    state.terms.forEach(term => select.appendChild(new Option(term.name, term.term_id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function statusText(status) {
    return ({ open: "簽到開放中", closed: "已關閉", archived: "已封存", active: "在籍", inactive: "已停用" })[status] || status;
  }

  function displayDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  }

  function currentTermId() {
    const current = state.terms.find(term => term.status === "current") || state.terms[0];
    return current ? current.term_id : "";
  }

  function confirmAction(text, action) {
    if (window.confirm(text)) action();
  }

  async function load() {
    const [overview, dashboard] = await Promise.all([
      post({ action: "adminOverview", adminToken: adminToken() }),
      get({ action: "dashboard", token: config.dashboardToken })
    ]);
    state = overview;
    currentDashboard = dashboard;
    render(dashboard);
    loadTodayAttendanceReport().catch(error => setMessage(message, error.message, true));
    document.getElementById("loginPanel").classList.add("hidden");
    document.getElementById("adminApp").classList.remove("hidden");
    document.getElementById("refreshButton").classList.remove("hidden");
    setMessage(document.getElementById("loginMessage"), "", false);
    setMessage(message, "", false);
  }

  function render(dashboard) {
    renderToday(dashboard);
    fillTerms(document.getElementById("quickEventTerm"));
    fillTerms(document.getElementById("eventTerm"));
    fillTerms(document.getElementById("sourceTerm"), true);
    fillTerms(document.getElementById("roleTerm"));
    fillTerms(document.getElementById("importTerm"));
    document.getElementById("quickEventTerm").value = currentTermId();
    document.getElementById("eventTerm").value = currentTermId();
    document.getElementById("importTerm").value = currentTermId();
    selectTermForDate("quickEventDate", "quickEventTerm");
    selectTermForDate("eventDate", "eventTerm");
    fillManualCheckinMembers();
    renderBindings();
    renderMembers();
    renderBindingHistory();
    renderEvents();
    renderRoles();
  }

  function renderToday(dashboard) {
    const openEvent = state.events.find(event => event.status === "open");
    document.getElementById("currentEventName").textContent = openEvent ? openEvent.name : "目前沒有開放活動";
    document.getElementById("currentEventDate").textContent = openEvent ? displayDate(openEvent.event_date) : "可在下方快速建立";
    document.getElementById("todayMemberCount").textContent = dashboard.memberCount || 0;
    document.getElementById("todayGuestCount").textContent = dashboard.guestCount || 0;
    document.getElementById("pendingCount").textContent = state.bindings.length;
    const toggle = document.getElementById("toggleCurrentEventButton");
    toggle.classList.toggle("hidden", !openEvent);
    if (openEvent) {
      toggle.textContent = "關閉本場簽到";
      toggle.onclick = () => confirmAction(`確定要關閉「${openEvent.name}」的簽到嗎？`, () =>
        runAction("adminSetEventStatus", { eventId: openEvent.event_id, status: "closed" })
      );
    }
    const members = (dashboard.list || []).filter(person => person.type === "member");
    const guests = (dashboard.list || []).filter(person => person.type === "guest");
    renderTodayPeople("todayMemberCards", "noTodayMembers", members, person =>
      `${person.position || "會員"} · ${person.checkin_at ? formatDateTime(person.checkin_at) : "已登記"}`
    );
    renderTodayPeople("todayGuestCards", "noTodayGuests", guests, person =>
      person.host_name ? `介紹會員：${person.host_name}` : "未記錄介紹會員"
    );
    const absent = todayAttendanceReport
      ? todayAttendanceReport.selectedEventMembers.filter(member => !member.attended && member.member_status === "active")
      : [];
    renderTodayPeople("todayAbsentCards", "noTodayAbsent", absent, person => person.position || "會員");
  }

  function fillManualCheckinMembers() {
    const select = document.getElementById("manualCheckinMember");
    const previous = select.value;
    select.replaceChildren(new Option("請選擇會員", ""));
    const attendedIds = new Set(
      todayAttendanceReport
        ? todayAttendanceReport.selectedEventMembers.filter(member => member.attended).map(member => member.member_id)
        : []
    );
    state.members
      .filter(member => member.status === "active" && !attendedIds.has(member.member_id))
      .sort((a, b) => String(a.display_name || a.name).localeCompare(String(b.display_name || b.name)))
      .forEach(member => select.appendChild(new Option(member.display_name || member.name, member.member_id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function renderTodayPeople(containerId, emptyId, people, detail) {
    const container = document.getElementById(containerId);
    container.replaceChildren();
    document.getElementById(emptyId).classList.toggle("hidden", people.length > 0);
    people.forEach(person => {
      const card = el("article", "manage-card");
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", person.name), el("span", "muted", detail(person)));
      card.appendChild(info);
      container.appendChild(card);
    });
  }

  async function refreshToday() {
    if (document.getElementById("adminApp").classList.contains("hidden")) return;
    try {
      await Promise.all([
        get({ action: "dashboard", token: config.dashboardToken }).then(result => { currentDashboard = result; }),
        loadTodayAttendanceReport()
      ]);
      renderToday(currentDashboard);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }

  async function loadTodayAttendanceReport() {
    const openEvent = state.events.find(event => event.status === "open");
    if (!openEvent) {
      todayAttendanceReport = null;
      return;
    }
    todayAttendanceReport = await post({
      action: "adminAttendanceReport",
      adminToken: adminToken(),
      termId: openEvent.term_id,
      eventId: openEvent.event_id
    });
    fillManualCheckinMembers();
    renderToday(currentDashboard || { list: [] });
  }

  function renderBindings() {
    const container = document.getElementById("bindingCards");
    container.replaceChildren();
    document.getElementById("bindingBadge").textContent = `${state.bindings.length} 筆`;
    document.getElementById("noBindings").classList.toggle("hidden", state.bindings.length > 0);
    state.bindings.forEach(binding => {
      const card = el("article", "manage-card");
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", binding.claimed_name), el("span", "muted", `LINE 名稱：${binding.line_display_name}`));
      const controls = el("div", "manage-card-actions");
      const memberSelect = selectMembers();
      controls.append(memberSelect, button("核准綁定", () => {
        if (!memberSelect.value) return setMessage(message, "請先選擇對應會員", true);
        confirmAction(`確定將此 LINE 帳號綁定給「${memberSelect.options[memberSelect.selectedIndex].text}」嗎？`, () =>
          runAction("adminApproveBinding", { requestId: binding.request_id, memberId: memberSelect.value })
        );
      }));
      card.append(info, controls);
      container.appendChild(card);
    });
  }

  function renderMembers() {
    const query = document.getElementById("memberSearch").value.trim().toLowerCase();
    const container = document.getElementById("memberCards");
    container.replaceChildren();
    state.members.filter(member => {
      const searchable = [member.display_name, member.chinese_name, member.english_name, member.line_display_name].join(" ").toLowerCase();
      return !query || searchable.includes(query);
    }).forEach(member => {
      const card = el("article", "manage-card");
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", member.display_name || member.name));
      const lineText = member.line_user_id
        ? `LINE 已綁定：${member.line_display_name || "名稱未記錄"}`
        : "LINE 未綁定";
      info.append(el("span", "muted", `${statusText(member.status)} · ${lineText}`));
      if (member.line_user_id) info.append(el("span", "technical-id", `LINE ID：${member.line_user_id}`));
      const next = member.status === "active" ? "inactive" : "active";
      const controls = el("div", "manage-card-actions");
      controls.appendChild(button(member.line_user_id ? "修改 LINE 綁定" : "設定 LINE 綁定", () =>
        toggleMemberLineForm(member, card), "secondary"));
      if (member.line_user_id) controls.appendChild(button("解除 LINE", () =>
        confirmAction(`確定解除「${member.display_name || member.name}」的 LINE 綁定嗎？`, () =>
          runAction("adminSetMemberLineBinding", { memberId: member.member_id, lineUserId: "", lineDisplayName: "" })
        ), "danger"));
      controls.appendChild(button(next === "active" ? "重新啟用" : "停用會員", () =>
        confirmAction(`確定要${next === "active" ? "重新啟用" : "停用"}「${member.display_name || member.name}」嗎？`, () =>
          runAction("adminSetMemberStatus", { memberId: member.member_id, status: next })
        ), next === "active" ? "" : "danger"));
      card.append(info, controls);
      container.appendChild(card);
    });
  }

  function toggleMemberLineForm(member, card) {
    const existing = card.querySelector(".member-line-form");
    if (existing) {
      existing.remove();
      return;
    }
    const form = el("div", "inline-form card-inline-form member-line-form");
    const lineUserId = el("input");
    lineUserId.value = member.line_user_id || "";
    lineUserId.placeholder = "U 開頭加 32 位英數字";
    const lineName = el("input");
    lineName.value = member.line_display_name || "";
    lineName.placeholder = "LINE 顯示名稱（可留空）";
    form.append(
      labeledControl("LINE User ID", lineUserId),
      labeledControl("LINE 顯示名稱", lineName),
      button("儲存 LINE 綁定", () => confirmAction(
        `確定更新「${member.display_name || member.name}」的 LINE 綁定嗎？`,
        () => runAction("adminSetMemberLineBinding", {
          memberId: member.member_id,
          lineUserId: lineUserId.value.trim(),
          lineDisplayName: lineName.value.trim()
        })
      )),
      button("取消", () => form.remove(), "secondary")
    );
    card.appendChild(form);
  }

  function renderBindingHistory() {
    const container = document.getElementById("bindingHistoryCards");
    const history = state.bindingHistory || [];
    container.replaceChildren();
    document.getElementById("bindingHistoryBadge").textContent = `${history.length} 筆`;
    document.getElementById("noBindingHistory").classList.toggle("hidden", history.length > 0);
    history.forEach(binding => {
      const member = state.members.find(item => item.line_user_id === binding.line_user_id);
      const card = el("article", "manage-card");
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", member ? member.display_name || member.name : binding.claimed_name));
      info.append(el("span", "muted", `LINE 名稱：${binding.line_display_name || "未記錄"} · ${binding.status === "approved" ? "已核准" : "待核准"}`));
      info.append(el("span", "technical-id", `LINE ID：${binding.line_user_id}`));
      card.appendChild(info);
      container.appendChild(card);
    });
  }

  function renderEvents() {
    const container = document.getElementById("eventCards");
    container.replaceChildren();
    state.events.forEach(event => {
      const card = el("article", `manage-card event-manage-card ${event.status === "open" ? "open-card" : ""}`);
      const info = el("div", "manage-card-info");
      const term = state.terms.find(item => item.term_id === event.term_id);
      info.append(
        el("strong", "", event.name),
        el("span", "muted", `${displayDate(event.event_date)} · ${term ? term.name : event.term_id} · ${statusText(event.status)}`)
      );
      const next = event.status === "open" ? "closed" : "open";
      const controls = el("div", "manage-card-actions");
      controls.appendChild(button("查看出席", () => openEventReport(event), "secondary"));
      controls.appendChild(button("複製查詢連結", () => copyEventReportLink(event), "secondary"));
      controls.appendChild(button("編輯", () => toggleEventEditForm(event, card), "secondary"));
      controls.appendChild(button(next === "open" ? "開放簽到" : "關閉簽到", () =>
        confirmAction(`確定要${next === "open" ? "開放" : "關閉"}「${event.name}」嗎？`, () =>
          runAction("adminSetEventStatus", { eventId: event.event_id, status: next })
        ), next === "closed" ? "danger" : ""));
      if (event.status !== "archived") controls.appendChild(button("封存", () =>
        confirmAction(`確定封存「${event.name}」嗎？`, () =>
          runAction("adminSetEventStatus", { eventId: event.event_id, status: "archived" })
        ), "danger"));
      controls.appendChild(button("永久刪除", () =>
        confirmAction(`只有完全沒有出席及來賓紀錄時才能刪除。\n確定永久刪除「${event.name}」嗎？`, () =>
          runAction("adminDeleteEvent", { eventId: event.event_id })
        ), "danger"));
      card.append(info, controls);
      container.appendChild(card);
    });
  }

  function eventReportUrl(event) {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("tab", "reports");
    url.searchParams.set("termId", event.term_id);
    url.searchParams.set("eventId", event.event_id);
    return url.toString();
  }

  function openEventReport(event) {
    history.replaceState(null, "", eventReportUrl(event));
    activateTab("reports");
    loadAttendanceReport({ termId: event.term_id, eventId: event.event_id })
      .catch(error => setMessage(message, error.message, true));
  }

  async function copyEventReportLink(event) {
    try {
      await navigator.clipboard.writeText(eventReportUrl(event));
      setMessage(message, "活動查詢連結已複製。", false);
    } catch (error) {
      window.prompt("請複製活動查詢連結", eventReportUrl(event));
    }
  }

  function toggleEventEditForm(event, card) {
    const existing = card.querySelector(".event-edit-form");
    if (existing) {
      existing.remove();
      return;
    }
    const form = el("div", "inline-form card-inline-form event-edit-form");
    const name = el("input");
    name.value = event.name;
    name.maxLength = 80;
    const eventDate = el("input");
    eventDate.type = "date";
    eventDate.value = dateInputValue(event.event_date);
    const term = el("select");
    state.terms.forEach(item => term.appendChild(new Option(item.name, item.term_id, false, item.term_id === event.term_id)));
    eventDate.addEventListener("change", () => {
      const suggested = termForDate(eventDate.value);
      if (suggested) term.value = suggested.term_id;
    });
    form.append(
      labeledControl("活動名稱", name),
      labeledControl("活動日期", eventDate),
      labeledControl("年度", term),
      button("儲存活動", () => confirmAction(`確定更新「${event.name}」嗎？`, () =>
        runAction("adminUpdateEvent", {
          eventId: event.event_id,
          name: name.value.trim(),
          eventDate: eventDate.value,
          termId: term.value
        })
      )),
      button("取消", () => form.remove(), "secondary")
    );
    card.appendChild(form);
  }

  function renderRoles() {
    const termId = document.getElementById("roleTerm").value || currentTermId();
    document.getElementById("roleTerm").value = termId;
    const container = document.getElementById("roleCards");
    container.replaceChildren();
    state.members.filter(member => member.status === "active").sort((a, b) => {
      const roleA = state.roles.find(role => role.term_id === termId && role.member_id === a.member_id);
      const roleB = state.roles.find(role => role.term_id === termId && role.member_id === b.member_id);
      return Number(roleA ? roleA.sort_order : 999) - Number(roleB ? roleB.sort_order : 999)
        || String(a.display_name || a.name).localeCompare(String(b.display_name || b.name));
    }).forEach(member => {
      const existing = state.roles.find(role => role.term_id === termId && role.member_id === member.member_id);
      const card = el("article", "manage-card role-card");
      card.appendChild(el("strong", "", member.display_name || member.name));
      const position = el("input");
      position.maxLength = 50;
      position.value = existing ? existing.position : "會員";
      position.placeholder = "職位";
      const order = el("input");
      order.type = "number";
      order.min = "1";
      order.max = "999";
      order.value = existing ? existing.sort_order : "100";
      order.title = "顯示順序";
      card.dataset.memberId = member.member_id;
      position.className = "role-position";
      order.className = "role-order";
      card.append(position, order);
      container.appendChild(card);
    });
  }

  function addReportCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text == null ? "" : String(text);
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function addReportMemberLink(row, member) {
    const cell = document.createElement("td");
    const link = button(member.name, () => showMemberAttendanceDetail(member), "link-button");
    cell.appendChild(link);
    row.appendChild(cell);
  }

  function fillReportFilters() {
    const termFilter = document.getElementById("reportTermFilter");
    const eventFilter = document.getElementById("reportEventFilter");
    termFilter.replaceChildren();
    attendanceReport.terms.forEach(term => termFilter.appendChild(
      new Option(term.name, term.term_id, false, term.term_id === attendanceReport.selectedTermId)
    ));
    eventFilter.replaceChildren();
    if (!attendanceReport.events.length) eventFilter.appendChild(new Option("本年度尚無活動", ""));
    attendanceReport.events.forEach(event => eventFilter.appendChild(new Option(
      `${displayDate(event.event_date)}｜${event.name}`,
      event.event_id,
      false,
      attendanceReport.selectedEvent && event.event_id === attendanceReport.selectedEvent.event_id
    )));
  }

  function renderAttendanceReport() {
    const report = attendanceReport;
    document.getElementById("reportEventCount").textContent = report.summary.event_count;
    document.getElementById("reportMemberCount").textContent = report.summary.member_count;
    document.getElementById("reportAttendanceCount").textContent = report.summary.attendance_count;
    document.getElementById("reportAverageAttendance").textContent = report.summary.average_attendance;

    const event = report.selectedEvent;
    document.getElementById("reportSelectedEventName").textContent = event ? event.name : "本年度尚無活動";
    document.getElementById("reportSelectedEventMeta").textContent = event ? displayDate(event.event_date) : "";
    document.getElementById("reportSelectedEventBadge").textContent = event ? `出席 ${event.member_count}｜來賓 ${event.guest_count}` : "";
    renderReportMembers();

    const guestRows = document.getElementById("reportGuestRows");
    const guests = report.selectedEventGuests || [];
    guestRows.replaceChildren();
    document.getElementById("reportGuestBadge").textContent = `${guests.length} 位`;
    document.getElementById("reportNoGuests").classList.toggle("hidden", guests.length > 0);
    guests.forEach(guest => {
      const row = document.createElement("tr");
      addReportCell(row, guest.name);
      addReportCell(row, guest.type);
      addReportCell(row, guest.host_name || "");
      addReportCell(row, guest.created_at ? formatDateTime(guest.created_at) : "");
      addReportCell(row, guest.note || "");
      guestRows.appendChild(row);
    });

    const summaryRows = document.getElementById("reportSummaryRows");
    summaryRows.replaceChildren();
    report.members.forEach(member => {
      const row = document.createElement("tr");
      addReportMemberLink(row, member);
      addReportCell(row, member.position);
      addReportCell(row, member.attended_count);
      addReportCell(row, member.absent_count);
      addReportCell(row, `${member.attendance_rate}%`, member.attendance_rate < 50 ? "rate-low" : "rate-good");
      summaryRows.appendChild(row);
    });
  }

  function showMemberAttendanceDetail(member) {
    const panel = document.getElementById("memberAttendanceDetailPanel");
    const rows = document.getElementById("memberAttendanceDetailRows");
    document.getElementById("memberAttendanceDetailName").textContent = `${member.name} 出席明細`;
    rows.replaceChildren();
    const records = (attendanceReport.memberEventRecords && attendanceReport.memberEventRecords[member.member_id]) || [];
    records.forEach(record => {
      const row = document.createElement("tr");
      addReportCell(row, displayDate(record.event_date));
      addReportCell(row, record.event_name);
      addReportCell(row, record.attended ? "已出席" : "未出席", record.attended ? "attendance-yes" : "attendance-no");
      addReportCell(row, record.checkin_at ? formatDateTime(record.checkin_at) : "");
      addReportCell(row, record.source || "");
      addReportCell(row, record.guest_count || 0);
      addReportCell(row, record.note || "");
      rows.appendChild(row);
    });
    panel.classList.remove("hidden");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderReportMembers() {
    if (!attendanceReport) return;
    const query = document.getElementById("reportMemberSearch").value.trim().toLowerCase();
    const status = document.getElementById("reportStatusFilter").value;
    const rows = document.getElementById("reportEventRows");
    rows.replaceChildren();
    attendanceReport.selectedEventMembers.filter(member => {
      if (query && !member.name.toLowerCase().includes(query)) return false;
      if (status === "attended" && !member.attended) return false;
      if (status === "absent" && member.attended) return false;
      return true;
    }).forEach(member => {
      const row = document.createElement("tr");
      addReportCell(row, member.attended ? "已出席" : "未出席", member.attended ? "attendance-yes" : "attendance-no");
      addReportCell(row, member.name);
      addReportCell(row, member.role_snapshot || member.position);
      addReportCell(row, member.checkin_at ? formatDateTime(member.checkin_at) : "");
      addReportCell(row, member.guest_count || 0);
      addReportCell(row, member.note || "");
      rows.appendChild(row);
    });
  }

  async function loadAttendanceReport(options) {
    attendanceReport = await post({
      action: "adminAttendanceReport",
      adminToken: adminToken(),
      termId: options && options.termId,
      eventId: options && options.eventId
    });
    fillReportFilters();
    renderAttendanceReport();
  }

  async function runAction(action, data) {
    const controls = [...document.querySelectorAll("button")].filter(control => !control.disabled);
    try {
      controls.forEach(control => control.disabled = true);
      const result = await post({ action, adminToken: adminToken(), ...data });
      attendanceReport = null;
      todayAttendanceReport = null;
      await load();
      setMessage(message, result.message || "操作完成", false);
    } catch (error) {
      const hint = error.message === "不支援的操作"
        ? "Apps Script 尚未部署最新 Code.gs，請建立新版本後再試。"
        : error.message;
      setMessage(message, hint, true);
    } finally {
      controls.forEach(control => control.disabled = false);
    }
  }

  function toggleForm(id) {
    document.getElementById(id).classList.toggle("hidden");
  }

  function activateTab(tabName) {
    document.querySelectorAll(".tab-button").forEach(item => item.classList.toggle("active", item.dataset.tab === tabName));
    document.querySelectorAll(".tab-page").forEach(page => page.classList.toggle("active", page.dataset.page === tabName));
  }

  function dateInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(date);
  }

  function termForDate(dateValue) {
    return state.terms.find(term => {
      const start = dateInputValue(term.start_date);
      const end = dateInputValue(term.end_date);
      return dateValue && start && end && dateValue >= start && dateValue <= end;
    }) || null;
  }

  function selectTermForDate(dateInputId, termSelectId) {
    const term = termForDate(document.getElementById(dateInputId).value);
    if (term) document.getElementById(termSelectId).value = term.term_id;
  }

  document.getElementById("loginButton").addEventListener("click", () =>
    load().then(initializeFromUrl).catch(error => setMessage(document.getElementById("loginMessage"), error.message, true))
  );
  document.getElementById("refreshButton").addEventListener("click", () => load().catch(error => setMessage(message, error.message, true)));
  document.querySelectorAll(".tab-button").forEach(tab => tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab);
    if (tab.dataset.tab === "reports" && !attendanceReport) {
      loadAttendanceReport().catch(error => setMessage(message, error.message, true));
    }
  }));
  document.getElementById("memberSearch").addEventListener("input", renderMembers);
  document.getElementById("roleTerm").addEventListener("change", renderRoles);
  document.getElementById("reportTermFilter").addEventListener("change", event =>
    loadAttendanceReport({ termId: event.target.value }).catch(error => setMessage(message, error.message, true))
  );
  document.getElementById("reportEventFilter").addEventListener("change", event =>
    loadAttendanceReport({
      termId: document.getElementById("reportTermFilter").value,
      eventId: event.target.value
    }).catch(error => setMessage(message, error.message, true))
  );
  document.getElementById("reportStatusFilter").addEventListener("change", renderReportMembers);
  document.getElementById("reportMemberSearch").addEventListener("input", renderReportMembers);
  document.getElementById("closeMemberAttendanceDetailButton").addEventListener("click", () =>
    document.getElementById("memberAttendanceDetailPanel").classList.add("hidden")
  );
  document.getElementById("syncAttendanceRecordsButton").addEventListener("click", () =>
    confirmAction("確定要重建 Google Sheet 的 AttendanceRecords 出席明細嗎？", () =>
      runAction("adminSyncAttendanceRecords", {})
    )
  );
  document.getElementById("quickEventDate").addEventListener("change", () => selectTermForDate("quickEventDate", "quickEventTerm"));
  document.getElementById("eventDate").addEventListener("change", () => selectTermForDate("eventDate", "eventTerm"));
  document.getElementById("todayReportButton").addEventListener("click", () => {
    const openEvent = state.events.find(event => event.status === "open");
    if (openEvent) openEventReport(openEvent);
    else activateTab("reports");
  });
  document.getElementById("manualCheckinButton").addEventListener("click", () => {
    const memberId = document.getElementById("manualCheckinMember").value;
    if (!memberId) return setMessage(message, "請先選擇要手動簽到的會員", true);
    const memberName = document.getElementById("manualCheckinMember").selectedOptions[0].textContent;
    confirmAction(`確定由管理員替「${memberName}」完成目前活動簽到嗎？`, () =>
      runAction("adminManualCheckIn", {
        memberId,
        guestCount: Number(document.getElementById("manualGuestCount").value || 0),
        guestNames: document.getElementById("manualGuestNames").value.trim(),
        note: document.getElementById("manualCheckinNote").value.trim()
      })
    );
  });
  document.getElementById("saveAllRolesButton").addEventListener("click", () => confirmAction(
    "確定儲存目前年度的全部職位設定嗎？",
    () => {
      const roles = [...document.querySelectorAll("#roleCards .role-card")].map(card => ({
        memberId: card.dataset.memberId,
        position: card.querySelector(".role-position").value.trim(),
        sortOrder: Number(card.querySelector(".role-order").value || 100)
      }));
      runAction("adminSaveRolesBatch", {
        termId: document.getElementById("roleTerm").value,
        roles
      });
    }
  ));
  document.getElementById("autoApproveBindingsButton").addEventListener("click", () => confirmAction(
    "只會自動核准 LINE 名稱完全相同且唯一的會員；同名或不明資料會保留人工確認。確定執行嗎？",
    () => runAction("adminAutoApproveBindings", {})
  ));
  document.getElementById("showCreateMemberButton").addEventListener("click", () => toggleForm("createMemberForm"));
  document.getElementById("showImportMembersButton").addEventListener("click", () => toggleForm("importMembersForm"));
  document.getElementById("showCreateEventButton").addEventListener("click", () => toggleForm("createEventForm"));
  document.getElementById("showCreateTermButton").addEventListener("click", () => toggleForm("createTermForm"));
  document.getElementById("createMemberButton").addEventListener("click", () => runAction("adminCreateMember", {
    chineseName: document.getElementById("memberChineseName").value.trim(),
    englishName: document.getElementById("memberEnglishName").value.trim(),
    name: [
      document.getElementById("memberChineseName").value.trim(),
      document.getElementById("memberEnglishName").value.trim()
    ].filter(Boolean).join(" "),
    joinDate: document.getElementById("joinDate").value
  }));
  document.getElementById("importMembersButton").addEventListener("click", () => confirmAction(
    "確定要將貼上的名單匯入會員資料嗎？",
    () => runAction("adminBulkImportMembers", {
      termId: document.getElementById("importTerm").value,
      text: document.getElementById("importMembersText").value
    })
  ));
  document.getElementById("importLegacySheetButton").addEventListener("click", () => confirmAction(
    "確定要重新同步舊版「名單」嗎？會員 ID、LINE 綁定與簽到紀錄會保留。",
    () => runAction("adminImportLegacyRoster", {
      termId: document.getElementById("importTerm").value
    })
  ));
  document.getElementById("inspectLegacySheetButton").addEventListener("click", async () => {
    const output = document.getElementById("legacyInspection");
    try {
      const result = await post({ action: "adminInspectLegacyRoster", adminToken: adminToken() });
      output.replaceChildren();
      [
        `標題列：第 ${result.headerRow} 列`,
        `所有欄位：${result.headers.join("、")}`,
        `中文姓名欄：${result.detected.name || "未辨識"}`,
        `英文姓名欄：${result.detected.englishName || "未辨識"}`,
        `LINE 名稱欄：${result.detected.lineName || "未辨識"}`,
        `職位欄：${result.detected.position || "未辨識"}`,
        `中文姓名非空白：${result.nonEmptyNameCount} 筆`,
        `英文姓名非空白：${result.nonEmptyEnglishNameCount} 筆`,
        `LINE 名稱非空白：${result.nonEmptyLineNameCount} 筆`
      ].forEach(text => output.appendChild(el("div", "", text)));
      output.classList.remove("hidden");
    } catch (error) {
      setMessage(message, error.message, true);
    }
  });
  function createEvent(prefix) {
    const stem = prefix ? `${prefix}Event` : "event";
    return runAction("adminCreateEvent", {
      name: document.getElementById(`${stem}Title`).value.trim(),
      eventDate: document.getElementById(`${stem}Date`).value,
      termId: document.getElementById(`${stem}Term`).value
    });
  }
  document.getElementById("quickCreateEventButton").addEventListener("click", () => createEvent("quick"));
  document.getElementById("createEventButton").addEventListener("click", () => createEvent(""));
  document.getElementById("createTermButton").addEventListener("click", () => runAction("adminCreateTerm", {
    termId: document.getElementById("newTermId").value.trim(),
    name: document.getElementById("newTermName").value.trim(),
    startDate: document.getElementById("termStart").value,
    endDate: document.getElementById("termEnd").value,
    sourceTermId: document.getElementById("sourceTerm").value
  }));

  async function initializeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "reports") {
      activateTab("reports");
      await loadAttendanceReport({ termId: params.get("termId"), eventId: params.get("eventId") });
    }
  }

  if (tokenInput.value) load().then(initializeFromUrl).catch(() => {});
  setInterval(refreshToday, 10000);
})();
