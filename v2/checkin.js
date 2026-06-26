(async function () {
  "use strict";

  const { config, post, setMessage } = window.ILionsV2;
  const message = document.getElementById("message");
  const RELOGIN_KEY = "ilions-v2-line-relogin-at";
  let idToken = "";
  let initialized = false;

  function show(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  function tokenIsExpired() {
    const decoded = liff.getDecodedIDToken();
    return !decoded || !decoded.exp || decoded.exp <= Math.floor(Date.now() / 1000) + 60;
  }

  function relogin() {
    const lastRelogin = Number(sessionStorage.getItem(RELOGIN_KEY) || 0);
    if (Date.now() - lastRelogin < 120000) {
      throw new Error("LINE 登入憑證仍然過期，請關閉此頁後重新從 LINE 開啟簽到連結。");
    }
    sessionStorage.setItem(RELOGIN_KEY, String(Date.now()));
    liff.logout();
    liff.login({ redirectUri: window.location.href });
  }

  async function loadSession() {
    try {
      return await post({ action: "getSession", idToken });
    } catch (error) {
      if (/IdToken expired/i.test(error.message)) {
        relogin();
        return null;
      }
      throw error;
    }
  }

  function formatEventDate(value) {
    if (!value) return "";
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00+08:00`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    }).format(date);
  }

  function renderRegistrationEvents(events) {
    const panel = document.getElementById("registrationPanel");
    const list = document.getElementById("registrationList");
    const empty = document.getElementById("noRegistrationEvents");
    if (!panel || !list || !empty) return;
    list.replaceChildren();
    panel.classList.remove("hidden");
    empty.classList.toggle("hidden", events.length > 0);
    events.forEach(item => {
      const card = document.createElement("article");
      card.className = "registration-card";

      const info = document.createElement("div");
      info.className = "manage-card-info";
      const title = document.createElement("strong");
      title.textContent = item.name || "未命名活動";
      const meta = document.createElement("span");
      meta.className = "muted";
      meta.textContent = `${formatEventDate(item.event_date)} · ${item.registered ? "已報名" : "尚未報名"}`;
      const badge = document.createElement("span");
      badge.className = item.registered ? "badge success-badge" : "badge";
      badge.textContent = item.registered ? "已報名" : "可報名";
      info.append(title, meta, badge);

      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.className = item.registered ? "secondary" : "";
      actionButton.textContent = item.registered ? "取消報名" : "我要報名";
      actionButton.addEventListener("click", async () => {
        try {
          actionButton.disabled = true;
          const action = item.registered ? "cancelRegistration" : "registerEvent";
          const result = await post({ action, idToken, eventId: item.event_id });
          setMessage(message, result.message, false);
          const session = await loadSession();
          if (session) renderRegistrationEvents(session.registrationEvents || []);
        } catch (error) {
          setMessage(message, error.message, true);
        } finally {
          actionButton.disabled = false;
        }
      });

      card.append(info, actionButton);
      list.appendChild(card);
    });
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    try {
      if (!config.liffId || config.liffId.includes("PASTE_")) throw new Error("尚未設定 LIFF ID");
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      idToken = liff.getIDToken();
      if (!idToken) throw new Error("無法取得 LINE ID Token，請確認 LIFF 已啟用 openid scope");
      if (tokenIsExpired()) {
        relogin();
        return;
      }

      const profile = await liff.getProfile();
      document.getElementById("lineName").textContent = profile.displayName || "LINE 使用者";
      if (profile.pictureUrl) document.getElementById("profileImage").src = profile.pictureUrl;
      show("profile");

      const session = await loadSession();
      if (!session) return;
      sessionStorage.removeItem(RELOGIN_KEY);
      document.getElementById("eventInfo").textContent = session.event
        ? `目前活動：${session.event.name}（${session.event.event_date}）`
        : "目前沒有開放簽到的活動";

      if (!session.member) {
        show("bindingPanel");
        setMessage(message, session.bindingPending ? "您的綁定申請正在等待管理員核准。" : "尚未綁定會員資料。", false);
        return;
      }

      document.getElementById("memberInfo").textContent =
        `${session.member.name}｜${session.member.position || "會員"}`;
      renderRegistrationEvents(session.registrationEvents || []);
      if (session.event && !session.alreadyCheckedIn) show("checkinPanel");
      setMessage(message, session.alreadyCheckedIn ? "您已完成本次活動簽到。" : "", false);
    } catch (error) {
      setMessage(message, error.message, true);
    }
  }

  document.getElementById("bindingButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      const claimedName = document.getElementById("claimedName").value.trim();
      if (!claimedName) throw new Error("請輸入會員姓名");
      const result = await post({ action: "requestBinding", idToken, claimedName });
      document.getElementById("bindingPanel").classList.add("hidden");
      setMessage(message, result.autoApproved ? `${result.message}\n請重新整理後簽到。` : result.message, false);
    } catch (error) {
      setMessage(message, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("checkinButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      const result = await post({
        action: "checkIn",
        idToken,
        guestCount: Number(document.getElementById("guestCount").value || 0),
        guestNames: document.getElementById("guestNames").value.trim(),
        note: document.getElementById("note").value.trim()
      });
      document.getElementById("checkinPanel").classList.add("hidden");
      setMessage(message, result.message, false);
    } catch (error) {
      setMessage(message, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  function setMode(mode) {
    const isFace = mode === "face";
    document.getElementById("lineModePanel").classList.toggle("hidden", isFace);
    document.getElementById("faceModePanel").classList.toggle("hidden", !isFace);
    document.getElementById("lineModeButton").classList.toggle("active", !isFace);
    document.getElementById("faceModeButton").classList.toggle("active", isFace);
    if (isFace) {
      if (location.hash !== "#face") history.replaceState(null, "", "#face");
    } else {
      if (location.hash) history.replaceState(null, "", location.pathname + location.search);
      initialize();
    }
  }

  document.getElementById("lineModeButton").addEventListener("click", () => setMode("line"));
  document.getElementById("faceModeButton").addEventListener("click", () => setMode("face"));

  setMode(location.hash === "#face" ? "face" : "line");
})();
