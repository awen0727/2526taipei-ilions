(function () {
  "use strict";

  const { config, post, get, setMessage } = window.ILionsV2;
  const message = document.getElementById("message");
  const tokenInput = document.getElementById("adminToken");
  let state = { members: [], events: [], bindings: [], terms: [], roles: [] };

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

  function selectMembers(selectedId) {
    const select = el("select");
    select.appendChild(new Option("請選擇會員", ""));
    state.members.filter(member => member.status === "active").forEach(member => {
      select.appendChild(new Option(member.name, member.member_id, false, member.member_id === selectedId));
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
    render(dashboard);
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
    renderBindings();
    renderMembers();
    renderEvents();
    renderRoles();
  }

  function renderToday(dashboard) {
    const openEvent = state.events.find(event => event.status === "open");
    document.getElementById("currentEventName").textContent = openEvent ? openEvent.name : "目前沒有開放活動";
    document.getElementById("currentEventDate").textContent = openEvent ? openEvent.event_date : "可在下方快速建立";
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
    state.members.filter(member => !query || member.name.toLowerCase().includes(query)).forEach(member => {
      const card = el("article", "manage-card");
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", member.name));
      info.append(el("span", "muted", `${statusText(member.status)} · ${member.line_user_id ? "LINE 已綁定" : "LINE 未綁定"}`));
      const next = member.status === "active" ? "inactive" : "active";
      const action = button(next === "active" ? "重新啟用" : "停用會員", () =>
        confirmAction(`確定要${next === "active" ? "重新啟用" : "停用"}「${member.name}」嗎？`, () =>
          runAction("adminSetMemberStatus", { memberId: member.member_id, status: next })
        ), next === "active" ? "" : "danger");
      card.append(info, action);
      container.appendChild(card);
    });
  }

  function renderEvents() {
    const container = document.getElementById("eventCards");
    container.replaceChildren();
    state.events.forEach(event => {
      const card = el("article", `manage-card ${event.status === "open" ? "open-card" : ""}`);
      const info = el("div", "manage-card-info");
      info.append(el("strong", "", event.name), el("span", "muted", `${event.event_date} · ${statusText(event.status)}`));
      const next = event.status === "open" ? "closed" : "open";
      const action = button(next === "open" ? "開放簽到" : "關閉簽到", () =>
        confirmAction(`確定要${next === "open" ? "開放" : "關閉"}「${event.name}」嗎？`, () =>
          runAction("adminSetEventStatus", { eventId: event.event_id, status: next })
        ), next === "closed" ? "danger" : "");
      card.append(info, action);
      container.appendChild(card);
    });
  }

  function renderRoles() {
    const termId = document.getElementById("roleTerm").value || currentTermId();
    document.getElementById("roleTerm").value = termId;
    const container = document.getElementById("roleCards");
    container.replaceChildren();
    state.members.filter(member => member.status === "active").forEach(member => {
      const existing = state.roles.find(role => role.term_id === termId && role.member_id === member.member_id);
      const card = el("article", "manage-card role-card");
      card.appendChild(el("strong", "", member.name));
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
      card.append(position, order, button("儲存", () => runAction("adminSaveRole", {
        termId, memberId: member.member_id, position: position.value.trim(), sortOrder: Number(order.value || 100)
      })));
      container.appendChild(card);
    });
  }

  async function runAction(action, data) {
    try {
      const result = await post({ action, adminToken: adminToken(), ...data });
      await load();
      setMessage(message, result.message || "操作完成", false);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }

  function toggleForm(id) {
    document.getElementById(id).classList.toggle("hidden");
  }

  document.getElementById("loginButton").addEventListener("click", () => load().catch(error => setMessage(document.getElementById("loginMessage"), error.message, true)));
  document.getElementById("refreshButton").addEventListener("click", () => load().catch(error => setMessage(message, error.message, true)));
  document.querySelectorAll(".tab-button").forEach(tab => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach(item => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".tab-page").forEach(page => page.classList.toggle("active", page.dataset.page === tab.dataset.tab));
  }));
  document.getElementById("memberSearch").addEventListener("input", renderMembers);
  document.getElementById("roleTerm").addEventListener("change", renderRoles);
  document.getElementById("showCreateMemberButton").addEventListener("click", () => toggleForm("createMemberForm"));
  document.getElementById("showImportMembersButton").addEventListener("click", () => toggleForm("importMembersForm"));
  document.getElementById("showCreateEventButton").addEventListener("click", () => toggleForm("createEventForm"));
  document.getElementById("showCreateTermButton").addEventListener("click", () => toggleForm("createTermForm"));
  document.getElementById("createMemberButton").addEventListener("click", () => runAction("adminCreateMember", {
    name: document.getElementById("memberName").value.trim(), joinDate: document.getElementById("joinDate").value
  }));
  document.getElementById("importMembersButton").addEventListener("click", () => confirmAction(
    "確定要將貼上的名單匯入 V2 測試資料嗎？舊資料不會被修改。",
    () => runAction("adminBulkImportMembers", {
      termId: document.getElementById("importTerm").value,
      text: document.getElementById("importMembersText").value
    })
  ));
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

  if (tokenInput.value) load().catch(() => {});
})();
