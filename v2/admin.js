(function () {
  "use strict";

  const { post, setMessage } = window.ILionsV2;
  const message = document.getElementById("message");
  const tokenInput = document.getElementById("adminToken");
  let state = { members: [], events: [], bindings: [], terms: [], roles: [] };

  tokenInput.value = sessionStorage.getItem("ilionsV2AdminToken") || "";

  function adminToken() {
    const value = tokenInput.value.trim();
    if (!value) throw new Error("請輸入管理密鑰");
    sessionStorage.setItem("ilionsV2AdminToken", value);
    return value;
  }

  function cell(row, value) {
    const td = document.createElement("td");
    td.textContent = value == null ? "" : String(value);
    row.appendChild(td);
    return td;
  }

  function actionButton(label, handler, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (danger) button.className = "danger";
    button.addEventListener("click", handler);
    return button;
  }

  function render() {
    const roleTerm = document.getElementById("roleTerm");
    const roleMember = document.getElementById("roleMember");
    const selectedTerm = roleTerm.value;
    roleTerm.replaceChildren();
    roleMember.replaceChildren();
    state.terms.forEach((term) => {
      const option = document.createElement("option");
      option.value = term.term_id;
      option.textContent = `${term.name}（${term.status}）`;
      roleTerm.appendChild(option);
    });
    if (selectedTerm && state.terms.some((term) => term.term_id === selectedTerm)) {
      roleTerm.value = selectedTerm;
    }
    state.members.filter((member) => member.status === "active").forEach((member) => {
      const option = document.createElement("option");
      option.value = member.member_id;
      option.textContent = `${member.name}（${member.member_id}）`;
      roleMember.appendChild(option);
    });
    renderRoles();

    const membersBody = document.getElementById("membersBody");
    membersBody.replaceChildren();
    state.members.forEach((member) => {
      const row = document.createElement("tr");
      cell(row, member.member_id);
      cell(row, member.name);
      cell(row, member.status);
      cell(row, member.line_user_id ? "已綁定" : "未綁定");
      const controls = cell(row, "");
      controls.replaceChildren(actionButton(
        member.status === "active" ? "停用" : "啟用",
        () => runAction("adminSetMemberStatus", {
          memberId: member.member_id,
          status: member.status === "active" ? "inactive" : "active"
        }),
        member.status === "active"
      ));
      membersBody.appendChild(row);
    });

    const eventsBody = document.getElementById("eventsBody");
    eventsBody.replaceChildren();
    state.events.forEach((item) => {
      const row = document.createElement("tr");
      cell(row, item.event_date);
      cell(row, item.name);
      cell(row, item.status);
      const controls = cell(row, "");
      const next = item.status === "open" ? "closed" : "open";
      controls.replaceChildren(actionButton(
        next === "open" ? "開放" : "關閉",
        () => runAction("adminSetEventStatus", { eventId: item.event_id, status: next }),
        next === "closed"
      ));
      eventsBody.appendChild(row);
    });

    const bindingsBody = document.getElementById("bindingsBody");
    bindingsBody.replaceChildren();
    state.bindings.forEach((binding) => {
      const row = document.createElement("tr");
      cell(row, binding.line_display_name);
      cell(row, binding.claimed_name);
      const memberCell = cell(row, "");
      const select = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "請選擇會員";
      select.appendChild(blank);
      state.members.filter((member) => member.status === "active").forEach((member) => {
        const option = document.createElement("option");
        option.value = member.member_id;
        option.textContent = `${member.name}（${member.member_id}）`;
        select.appendChild(option);
      });
      memberCell.replaceChildren(select);
      const controls = cell(row, "");
      controls.replaceChildren(actionButton("核准綁定", () => {
        if (!select.value) return setMessage(message, "請先選擇會員", true);
        runAction("adminApproveBinding", { requestId: binding.request_id, memberId: select.value });
      }));
      bindingsBody.appendChild(row);
    });
  }

  function renderRoles() {
    const termId = document.getElementById("roleTerm").value;
    const rolesBody = document.getElementById("rolesBody");
    rolesBody.replaceChildren();
    state.members.filter((member) => member.status === "active").forEach((member) => {
      const existing = state.roles.find((role) =>
        role.term_id === termId && role.member_id === member.member_id
      );
      const row = document.createElement("tr");
      cell(row, `${member.name}（${member.member_id}）`);
      const positionCell = cell(row, "");
      const position = document.createElement("input");
      position.maxLength = 50;
      position.value = existing ? existing.position : "會員";
      positionCell.replaceChildren(position);
      const orderCell = cell(row, "");
      const order = document.createElement("input");
      order.type = "number";
      order.min = "1";
      order.max = "999";
      order.value = existing ? existing.sort_order : "100";
      orderCell.replaceChildren(order);
      const controls = cell(row, "");
      controls.replaceChildren(actionButton("儲存", () => runAction("adminSaveRole", {
        termId,
        memberId: member.member_id,
        position: position.value.trim(),
        sortOrder: Number(order.value || 100)
      })));
      rolesBody.appendChild(row);
    });
  }

  async function load() {
    state = await post({ action: "adminOverview", adminToken: adminToken() });
    render();
    setMessage(message, "管理資料已更新", false);
  }

  async function runAction(action, data) {
    try {
      await post({ action, adminToken: adminToken(), ...data });
      await load();
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }

  document.getElementById("loadButton").addEventListener("click", () => load().catch((error) => setMessage(message, error.message, true)));
  document.getElementById("clearTokenButton").addEventListener("click", () => {
    sessionStorage.removeItem("ilionsV2AdminToken");
    tokenInput.value = "";
  });
  document.getElementById("createMemberButton").addEventListener("click", () => runAction("adminCreateMember", {
    name: document.getElementById("memberName").value.trim(),
    joinDate: document.getElementById("joinDate").value
  }));
  document.getElementById("createEventButton").addEventListener("click", () => runAction("adminCreateEvent", {
    name: document.getElementById("eventTitle").value.trim(),
    eventDate: document.getElementById("eventDate").value,
    termId: document.getElementById("eventTermId").value.trim()
  }));
  document.getElementById("createTermButton").addEventListener("click", () => runAction("adminCreateTerm", {
    termId: document.getElementById("newTermId").value.trim(),
    name: document.getElementById("newTermName").value.trim(),
    startDate: document.getElementById("termStart").value,
    endDate: document.getElementById("termEnd").value,
    sourceTermId: document.getElementById("sourceTermId").value.trim()
  }));
  document.getElementById("saveRoleButton").addEventListener("click", () => runAction("adminSaveRole", {
    termId: document.getElementById("roleTerm").value,
    memberId: document.getElementById("roleMember").value,
    position: document.getElementById("rolePosition").value.trim(),
    sortOrder: Number(document.getElementById("roleOrder").value || 100)
  }));
  document.getElementById("roleTerm").addEventListener("change", renderRoles);
})();
