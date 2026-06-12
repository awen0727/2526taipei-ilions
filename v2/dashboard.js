(function () {
  "use strict";

  const { config, get, setMessage, formatDateTime } = window.ILionsV2;
  const message = document.getElementById("message");

  function addText(parent, className, value) {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = value || "";
    parent.appendChild(element);
  }

  async function refresh() {
    try {
      if (!config.dashboardToken || config.dashboardToken.includes("PASTE_")) {
        throw new Error("尚未設定 Dashboard Token");
      }
      const result = await get({ action: "dashboard", token: config.dashboardToken });
      document.getElementById("eventName").textContent = result.event
        ? result.event.name
        : "目前沒有開放中的活動";
      document.getElementById("memberCount").textContent = String(result.memberCount || 0);
      document.getElementById("guestCount").textContent = String(result.guestCount || 0);
      document.getElementById("updatedAt").textContent = `更新：${formatDateTime(new Date().toISOString())}`;

      const people = document.getElementById("people");
      people.replaceChildren();
      result.list.forEach((person) => {
        const card = document.createElement("article");
        card.className = "person-card";
        addText(card, "role", person.position || "會員");
        addText(card, "name", person.name);
        if (person.guest_count) addText(card, "muted", `攜伴 ${person.guest_count} 位`);
        people.appendChild(card);
      });
      setMessage(message, "", false);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
