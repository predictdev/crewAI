// Login page: SMS code login for approved members, and sign-up requests.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const msg = $("#msg");
  const RESEND_SECONDS = 60;

  function say(text, ok = false) {
    msg.textContent = text;
    msg.classList.toggle("ok", ok);
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = Array.isArray(data.detail) ? "입력값을 확인해 주세요." : data.detail;
      throw new Error(detail || `요청 실패 (${res.status})`);
    }
    return data;
  }

  function showView(view) {
    document.querySelectorAll("[data-view]").forEach((el) => {
      if (el.tagName === "FORM") el.hidden = el.dataset.view !== view;
      else el.classList.toggle("active", el.dataset.view === view);
    });
    say("");
  }
  document.querySelectorAll(".login-tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  const codeBtn = $("#code-btn");
  let timer = null;
  function countdown() {
    let left = RESEND_SECONDS;
    clearInterval(timer);
    codeBtn.disabled = true;
    const tick = () => {
      codeBtn.textContent = left > 0 ? `다시 받기 (${left}초)` : "인증번호 다시 받기";
      codeBtn.disabled = left > 0;
      if (left-- <= 0) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  codeBtn.addEventListener("click", async () => {
    const phone = $("#login-phone").value;
    if (!phone.trim()) return say("휴대폰 번호를 입력해 주세요.");
    codeBtn.disabled = true;
    try {
      await post("/api/auth/code", { phone });
      $("#code-box").hidden = false;
      $("#login-code").focus();
      say("인증번호를 보냈습니다. 문자로 받은 6자리를 입력해 주세요.", true);
      countdown();
    } catch (e) {
      codeBtn.disabled = false;
      say(e.message);
    }
  });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#code-box").hidden) return codeBtn.click(); // Enter on the phone field
    try {
      await post("/api/auth/verify", { phone: $("#login-phone").value, code: $("#login-code").value });
      location.replace("/");
    } catch (err) {
      say(err.message);
    }
  });

  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await post("/api/auth/signup", {
        name: $("#signup-name").value,
        phone: $("#signup-phone").value,
        note: $("#signup-note").value,
      });
      e.target.reset();
      say("가입 신청을 받았습니다. 관리자가 승인하면 문자로 알려 드립니다.", true);
    } catch (err) {
      say(err.message);
    }
  });
})();
