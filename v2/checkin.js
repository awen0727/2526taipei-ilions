(async function () {
  "use strict";

  const { config, post, setMessage } = window.ILionsV2;
  const message = document.getElementById("message");
  let idToken = "";

  function show(id) {
    document.getElementById(id).classList.remove("hidden");
  }

  async function initialize() {
    try {
      if (!config.liffId || config.liffId.includes("PASTE_")) throw new Error("尚未設定 LIFF ID");
      await liff.init({ liffId: config.liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      idToken = liff.getIDToken();
      if (!idToken) throw new Error("無法取得 LINE ID Token，請確認 LIFF 已啟用 openid scope");

      const profile = await liff.getProfile();
      document.getElementById("lineName").textContent = profile.displayName || "LINE 使用者";
      if (profile.pictureUrl) document.getElementById("profileImage").src = profile.pictureUrl;
      show("profile");

      const session = await post({ action: "getSession", idToken });
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

  initialize();
})();
