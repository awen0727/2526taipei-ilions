(function () {
  "use strict";

  const { post, setMessage, formatDateTime } = window.ILionsV2;
  const tokenInput = document.getElementById("adminToken");
  const message = document.getElementById("message");
  let report = null;

  tokenInput.value = sessionStorage.getItem("ilionsV2AdminToken") || "";

  function adminToken() {
    const token = tokenInput.value.trim();
    if (!token) throw new Error("請輸入管理密鑰");
    sessionStorage.setItem("ilionsV2AdminToken", token);
    return token;
  }

  function displayDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(value));
  }

  function addCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text == null ? "" : String(text);
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function fillFilters() {
    const termFilter = document.getElementById("termFilter");
    const eventFilter = document.getElementById("eventFilter");
    termFilter.replaceChildren();
    report.terms.forEach(term => termFilter.appendChild(new Option(term.name, term.term_id, false, term.term_id === report.selectedTermId)));
    eventFilter.replaceChildren();
    if (!report.events.length) eventFilter.appendChild(new Option("本年度尚無活動", ""));
    report.events.forEach(event => eventFilter.appendChild(new Option(
      `${displayDate(event.event_date)}｜${event.name}`,
      event.event_id,
      false,
      report.selectedEvent && event.event_id === report.selectedEvent.event_id
    )));
  }

  function renderSummary() {
    document.getElementById("eventCount").textContent = report.summary.event_count;
    document.getElementById("memberCount").textContent = report.summary.member_count;
    document.getElementById("attendanceCount").textContent = report.summary.attendance_count;
    document.getElementById("averageAttendance").textContent = report.summary.average_attendance;

    const rows = document.getElementById("summaryRows");
    rows.replaceChildren();
    report.members.forEach(member => {
      const row = document.createElement("tr");
      addCell(row, member.name);
      addCell(row, member.position);
      addCell(row, member.attended_count);
      addCell(row, member.absent_count);
      addCell(row, `${member.attendance_rate}%`, member.attendance_rate < 50 ? "rate-low" : "rate-good");
      rows.appendChild(row);
    });
  }

  function renderEvent() {
    const event = report.selectedEvent;
    document.getElementById("selectedEventName").textContent = event ? event.name : "本年度尚無活動";
    document.getElementById("selectedEventMeta").textContent = event ? displayDate(event.event_date) : "";
    document.getElementById("selectedEventBadge").textContent = event ? `出席 ${event.member_count}｜來賓 ${event.guest_count}` : "";
    const query = document.getElementById("memberSearch").value.trim().toLowerCase();
    const status = document.getElementById("statusFilter").value;
    const rows = document.getElementById("eventRows");
    rows.replaceChildren();
    report.selectedEventMembers.filter(member => {
      if (query && !member.name.toLowerCase().includes(query)) return false;
      if (status === "attended" && !member.attended) return false;
      if (status === "absent" && member.attended) return false;
      return true;
    }).forEach(member => {
      const row = document.createElement("tr");
      addCell(row, member.attended ? "已出席" : "未出席", member.attended ? "attendance-yes" : "attendance-no");
      addCell(row, member.name);
      addCell(row, member.role_snapshot || member.position);
      addCell(row, member.checkin_at ? formatDateTime(member.checkin_at) : "");
      addCell(row, member.guest_count || 0);
      addCell(row, member.note || "");
      rows.appendChild(row);
    });
  }

  function renderGuests() {
    const guests = report.selectedEventGuests || [];
    const rows = document.getElementById("guestRows");
    rows.replaceChildren();
    document.getElementById("guestBadge").textContent = `${guests.length} 位`;
    document.getElementById("noGuests").classList.toggle("hidden", guests.length > 0);
    guests.forEach(guest => {
      const row = document.createElement("tr");
      addCell(row, guest.name);
      addCell(row, guest.type);
      addCell(row, guest.host_name || "");
      addCell(row, guest.created_at ? formatDateTime(guest.created_at) : "");
      addCell(row, guest.note || "");
      rows.appendChild(row);
    });
  }

  async function load(options) {
    try {
      const result = await post({
        action: "adminAttendanceReport",
        adminToken: adminToken(),
        termId: options && options.termId,
        eventId: options && options.eventId
      });
      report = result;
      fillFilters();
      renderSummary();
      renderEvent();
      renderGuests();
      document.getElementById("loginPanel").classList.add("hidden");
      document.getElementById("reportApp").classList.remove("hidden");
      setMessage(message, "", false);
    } catch (error) {
      setMessage(document.getElementById("loginMessage"), error.message, true);
      setMessage(message, error.message, true);
    }
  }

  document.getElementById("loginButton").addEventListener("click", () => load());
  document.getElementById("termFilter").addEventListener("change", event => load({ termId: event.target.value }));
  document.getElementById("eventFilter").addEventListener("change", event => load({
    termId: document.getElementById("termFilter").value,
    eventId: event.target.value
  }));
  document.getElementById("statusFilter").addEventListener("change", renderEvent);
  document.getElementById("memberSearch").addEventListener("input", renderEvent);

  if (tokenInput.value) load();
})();
