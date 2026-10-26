// Signed-in member: name and logout in the top bar, member approval for admins,
// and back to the login page whenever the server says the session is gone.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);

  const fetch0 = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await fetch0(...args);
    if (res.status === 401 && String(args[0]).startsWith("/api/")) location.replace("/login.html");
    return res;
  };

  const STATUS = { pending: "승인 대기", approved: "승인됨", rejected: "거절됨" };
  const dialog = $("#members");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "—");
  const phone = (p) => p.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
  let me = null;

  async function request(url, method = "GET", body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `요청 실패 (${res.status})`);
    return data;
  }

  async function renderMembers() {
    const list = $("#members-list");
    let users;
    try {
      users = await request("/api/admin/users");
    } catch (e) {
      list.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
      return;
    }
    const pending = users.filter((u) => u.status === "pending").length;
    $("#members-badge").textContent = pending;
    $("#members-badge").hidden = !pending;
    list.innerHTML = users.length ? users.map((u) => {
      const self = u.id === me.id;
      const actions = self ? '<span class="muted">나</span>' : [
        u.status !== "approved" ? `<button type="button" class="primary" data-act="approved">승인</button>` : "",
        u.status === "pending" ? `<button type="button" class="danger-outline" data-act="rejected">거절</button>` : "",
        u.status === "approved" ? `<button type="button" class="danger-outline" data-act="rejected">이용 중지</button>` : "",
        u.status === "approved" ? `<button type="button" data-act="admin">${u.is_admin ? "관리자 해제" : "관리자 지정"}</button>` : "",
      ].join("");
      return `<li class="member ${u.status}" data-id="${u.id}" data-admin="${u.is_admin}">
        <div class="member-main">
          <b>${esc(u.name)}</b>${u.is_admin ? ' <span class="pill admin">관리자</span>' : ""}
          <span class="pill ${u.status}">${STATUS[u.status]}</span>
          <div class="muted">${phone(u.phone)} · 신청 ${when(u.created_at)} · 최근 로그인 ${when(u.last_login_at)}</div>
          ${u.note ? `<div class="member-note">${esc(u.note)}</div>` : ""}
        </div>
        <div class="member-actions">${actions}</div>
      </li>`;
    }).join("") : '<p class="empty">회원이 없습니다.</p>';
  }

  $("#members-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const li = btn.closest("li");
    const act = btn.dataset.act;
    const body = act === "admin" ? { is_admin: li.dataset.admin !== "true" } : { status: act };
    if (act === "rejected" && !confirm("이 회원의 로그인을 막을까요? 로그인 중이면 바로 로그아웃됩니다.")) return;
    btn.disabled = true;
    try {
      await request(`/api/admin/users/${li.dataset.id}`, "PATCH", body);
    } catch (err) {
      alert(err.message);
    }
    renderMembers();
  });

  $("#members-btn").addEventListener("click", () => {
    renderMembers();
    dialog.showModal();
  });
  $("#members-close").addEventListener("click", () => dialog.close());

  $("#logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.replace("/login.html");
  });

  request("/api/me").then((user) => {
    me = user;
    $("#user-name").textContent = user.name;
    $("#members-btn").hidden = !user.is_admin;
    if (user.is_admin) renderMembers(); // pending count on the badge
  });
})();
