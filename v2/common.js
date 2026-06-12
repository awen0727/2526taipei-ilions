(function () {
  "use strict";

  const config = window.ILIONS_V2_CONFIG || {};

  function assertConfigured() {
    if (!config.apiUrl || config.apiUrl.includes("PASTE_")) {
      throw new Error("尚未設定新版 Apps Script API URL");
    }
  }

  async function post(payload) {
    assertConfigured();
    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "API 操作失敗");
    return result;
  }

  async function get(params) {
    assertConfigured();
    const url = new URL(config.apiUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || "API 操作失敗");
    return result;
  }

  function setMessage(element, message, isError) {
    element.textContent = message || "";
    element.className = `message ${isError ? "error" : "success"}`;
  }

  function formatDateTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "short",
      timeStyle: "short"
    }).format(new Date(value));
  }

  window.ILionsV2 = { config, post, get, setMessage, formatDateTime };
})();
