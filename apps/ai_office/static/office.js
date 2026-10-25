(() => {
  const { W, H, ROOMS, LOOKS, MANAGER_LOOK, MANAGER } = Pixel;

  const PEOPLE = {
    researcher: { name: "리아", title: "리서처", team: "Research" },
    writer: { name: "윤", title: "라이터", team: "Writing" },
    reviewer: { name: "서진", title: "리뷰어", team: "Review" },
  };
  const DEFAULT_KEYS = ["researcher", "writer", "reviewer"];
  const TASK_LABELS = { research_task: "리서치", writing_task: "초안 작성", review_task: "검토·최종본" };
  const WORKING = new Set(["assigned", "working", "thinking", "tool"]);

  const $ = (sel) => document.querySelector(sel);
  const canvas = $("#office");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const overlay = $("#overlay");

  let state;
  let bubbles = new Map();
  let busy = false;

  // ---------- state ----------

  function makeAgent(key, index, id = null, role = "") {
    const person = PEOPLE[key] || { name: `에이전트 ${index + 1}`, title: key, team: role || key };
    return {
      id, key, role, index, ...person,
      look: LOOKS[index % LOOKS.length],
      status: "idle", bubble: null, toolCount: 0,
    };
  }

  function resetState(mode = "idle") {
    state = {
      mode, topic: "", agents: DEFAULT_KEYS.map((k, i) => makeAgent(k, i)), byId: {},
      tasks: [], taskById: {}, report: "", tokens: null,
      startedAt: null, endedAt: null, failed: null,
      manager: { bubble: { text: "주제를 입력하고 ▶ 실행을 누르세요", kind: "" } },
      papers: [],
    };
    $("#feed").innerHTML = "";
    buildOverlay();
    renderReport();
  }

  const agentOf = (ev) => state.byId[ev.agent] || currentTask()?.agent || null;
  const currentTask = () => state.tasks.find((t) => t.status === "in_progress");
  const taskLabel = (task) => TASK_LABELS[task?.name] || task?.name || "작업";
  const say = (who, text, kind = "") => { who.bubble = { text, kind }; };

  function parseQuery(args) {
    const m = /['"]query['"]\s*:\s*(['"])(.*?)\1\s*[,}]/.exec(args || "");
    return m ? m[2] : args;
  }

  function apply(ev, live) {
    const agent = ev.agent !== undefined ? agentOf(ev) : null;
    switch (ev.kind) {
      case "reset":
        resetState(ev.mode);
        break;
      case "roster": {
        state.topic = ev.topic;
        state.startedAt = ev.t;
        state.agents = ev.agents.map((a, i) => makeAgent(a.key, i, a.id, a.role));
        state.agents.forEach((a) => (state.byId[a.id] = a));
        state.tasks = ev.tasks.map((t) => ({ ...t, agent: state.byId[t.agent], status: "todo", output: null }));
        state.tasks.forEach((t) => (state.taskById[t.id] = t));
        buildOverlay();
        say(state.manager, `“${ev.topic}” 프로젝트 시작!`);
        feed(ev, "manager", "매니저", `프로젝트 시작: “${ev.topic}” — 팀원 ${state.agents.length}명, 작업 ${state.tasks.length}개`);
        break;
      }
      case "task_started": {
        const task = state.taskById[ev.task];
        if (!task) break;
        task.status = "in_progress";
        const who = task.agent || agent;
        if (who) {
          who.status = "assigned";
          say(who, `📥 '${taskLabel(task)}' 받았어요`);
        }
        say(state.manager, `${who?.team || ""}팀 ${who?.name || ""}에게 '${taskLabel(task)}' 배정`);
        feed(ev, "manager", "매니저", `${who?.name || "?"}(${who?.title || ""})에게 '${taskLabel(task)}' 배정`);
        break;
      }
      case "agent_started":
        if (agent) { agent.status = "working"; say(agent, "📝 작업 시작"); }
        break;
      case "thinking":
        if (agent && agent.status !== "done") { agent.status = "thinking"; say(agent, "💭 생각 중…"); }
        break;
      case "tool_started":
        if (agent) {
          agent.status = "tool";
          agent.toolCount += 1;
          const q = parseQuery(ev.args);
          say(agent, `🔍 ${q}`, "tool");
          feed(ev, "tool", agent.name, `🔍 ${ev.tool}: ${q}`);
        }
        break;
      case "tool_finished":
        if (agent) {
          agent.status = "thinking";
          say(agent, "📑 검색 결과 검토 중", "tool");
          feed(ev, "tool", agent.name, `📑 ${ev.tool} 결과 수신`, ev.output);
        }
        break;
      case "tool_error":
        if (agent) {
          say(agent, `⚠️ ${ev.tool} 오류`, "error");
          feed(ev, "error", agent.name, `⚠️ ${ev.tool} 오류`, ev.error);
        }
        break;
      case "agent_error":
        if (agent) { agent.status = "error"; say(agent, "⚠️ 오류 발생", "error"); }
        feed(ev, "error", agent?.name || "?", "⚠️ 에이전트 오류", ev.error);
        break;
      case "task_completed": {
        const task = state.taskById[ev.task];
        if (!task) break;
        task.status = "done";
        task.output = ev.output;
        const who = task.agent;
        if (!who) break;
        who.status = "done";
        const next = state.agents[who.index + 1];
        say(who, next ? `✅ 완료! ${next.name}에게 전달` : "✅ 최종본 완료!", "done");
        feed(ev, "done", who.name, `✅ '${taskLabel(task)}' 완료`, ev.output);
        if (live && next) handoff(who.index, next.index);
        break;
      }
      case "task_failed": {
        const task = state.taskById[ev.task];
        if (task) task.status = "failed";
        feed(ev, "error", task?.agent?.name || "?", `❌ '${taskLabel(task)}' 실패`, ev.error);
        break;
      }
      case "run_completed":
        state.report = ev.report || "";
        state.tokens = ev.total_tokens;
        state.endedAt = ev.t;
        say(state.manager, "🎉 리포트 완성! Report 탭을 확인하세요", "done");
        feed(ev, "manager", "매니저", `🎉 전체 완료${ev.total_tokens ? ` — ${ev.total_tokens.toLocaleString()} 토큰` : ""}`);
        renderReport();
        if (live) $("#report-badge").hidden = false;
        refreshStatus();
        break;
      case "run_failed":
        state.failed = ev.error;
        state.endedAt = ev.t;
        say(state.manager, "⚠️ 실행 실패", "error");
        feed(ev, "error", "매니저", "❌ 실행 실패", ev.error);
        refreshStatus();
        break;
    }
  }

  // ---------- overlay (labels, nameplates, bubbles) ----------

  function place(el, x, y) {
    el.style.left = `${(x / W) * 100}%`;
    el.style.top = `${(y / H) * 100}%`;
  }

  function buildOverlay() {
    overlay.innerHTML = "";
    bubbles = new Map();
    const managerLabel = document.createElement("div");
    managerLabel.className = "label";
    managerLabel.style.background = "#8a6a1f";
    managerLabel.textContent = "👑 매니저";
    place(managerLabel, MANAGER.cx - 4, 4);
    overlay.append(managerLabel);
    bubbles.set(state.manager, addBubble(MANAGER.cx + 66, MANAGER.deskY - 12));

    state.agents.forEach((agent) => {
      const room = ROOMS[agent.index];
      if (!room) return;
      const anchor = Pixel.deskAnchor(agent.index);
      const label = document.createElement("div");
      label.className = "label";
      label.style.background = room.trim;
      label.textContent = `${agent.team} 팀`;
      place(label, room.x + room.w / 2, room.y + 1);
      const plate = document.createElement("div");
      plate.className = "nameplate";
      plate.innerHTML = `<b></b><span></span>`;
      plate.querySelector("b").textContent = agent.name;
      plate.querySelector("span").textContent = agent.title;
      place(plate, anchor.cx - 22, anchor.deskY + 9);
      overlay.append(label, plate);
      bubbles.set(agent, addBubble(anchor.headX + 12, anchor.headY - 6));
    });
  }

  function addBubble(x, y) {
    const el = document.createElement("div");
    el.className = "bubble hidden";
    place(el, x, y);
    overlay.append(el);
    return el;
  }

  function renderBubbles() {
    bubbles.forEach((el, who) => {
      const b = who.bubble;
      el.className = `bubble ${b?.kind || ""} ${b ? "" : "hidden"}`;
      if (b && el.textContent !== b.text) el.textContent = b.text;
    });
  }

  // ---------- feed, tasks, report, stats ----------

  function feed(ev, cls, who, text, details) {
    const li = document.createElement("li");
    li.className = cls;
    const time = new Date(ev.t * 1000).toLocaleTimeString("ko-KR", { hour12: false });
    li.innerHTML = `<div class="meta"><b></b><span></span></div><div class="text"></div>`;
    li.querySelector(".meta b").textContent = who;
    li.querySelector(".meta span").textContent = time;
    li.querySelector(".text").textContent = text;
    if (details) {
      const d = document.createElement("details");
      d.innerHTML = "<summary>내용 보기</summary><pre></pre>";
      d.querySelector("pre").textContent = details;
      li.append(d);
    }
    const list = $("#feed");
    list.append(li);
    while (list.children.length > 300) list.firstChild.remove();
  }

  function renderTasks() {
    const list = $("#task-list");
    const done = state.tasks.filter((t) => t.status === "done").length;
    $("#tasks-badge").textContent = `${done}/${state.tasks.length}`;
    if (!state.tasks.length) {
      list.innerHTML = `<p class="empty">아직 작업이 없습니다. 주제를 실행하거나 녹화를 재생하세요.</p>`;
      return;
    }
    const labels = { todo: "대기", in_progress: "진행 중", done: "완료", failed: "실패" };
    list.innerHTML = "";
    state.tasks.forEach((task, i) => {
      const card = document.createElement("div");
      card.className = "task";
      card.innerHTML = `<header><h3></h3><span class="who"></span><span class="pill"></span></header>`;
      card.querySelector("h3").textContent = `${i + 1}. ${taskLabel(task)}`;
      card.querySelector(".who").textContent = task.agent ? `${task.agent.name} · ${task.agent.title}` : "";
      const pill = card.querySelector(".pill");
      pill.classList.add(task.status);
      pill.textContent = labels[task.status] || task.status;
      if (task.output) {
        const d = document.createElement("details");
        d.innerHTML = "<summary>결과 미리보기</summary><pre></pre>";
        d.querySelector("pre").textContent = task.output;
        card.append(d);
      }
      list.append(card);
    });
  }

  function renderReport() {
    const el = $("#report");
    if (!state.report) {
      el.innerHTML = `<p class="empty">리포트가 완성되면 여기에 표시됩니다.</p>`;
      $("#report-meta").textContent = "";
      $("#download-btn").disabled = true;
      return;
    }
    el.innerHTML = DOMPurify.sanitize(marked.parse(state.report));
    el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    $("#report-meta").textContent = `주제: ${state.topic}${state.tokens ? ` · ${state.tokens.toLocaleString()} 토큰` : ""}`;
    $("#download-btn").disabled = false;
  }

  function renderStats() {
    const working = state.agents.filter((a) => WORKING.has(a.status)).length;
    const done = state.tasks.filter((t) => t.status === "done").length;
    $("#stat-staff").textContent = state.agents.length + 1;
    $("#stat-working").textContent = working;
    $("#stat-progress").textContent = state.tasks.filter((t) => t.status === "in_progress").length;
    $("#stat-done").textContent = `${done}/${state.tasks.length}`;
    const start = state.startedAt;
    const end = state.endedAt || Date.now() / 1000;
    const secs = start ? Math.max(0, Math.round(end - start)) : 0;
    $("#stat-time").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    const mode = $("#mode");
    const running = state.startedAt && !state.endedAt;
    mode.textContent = running ? (state.mode === "replay" ? "REPLAY" : "LIVE") : state.endedAt ? "DONE" : "IDLE";
    mode.className = `mode ${running ? state.mode : ""}`;
  }

  function renderAll() {
    renderBubbles();
    renderTasks();
    renderStats();
  }

  // ---------- canvas ----------

  function handoff(from, to) {
    const a = Pixel.deskAnchor(from), b = Pixel.deskAnchor(to);
    state.papers.push({ x0: a.cx - 3, y0: a.deskY - 10, x1: b.cx - 3, y1: b.deskY - 10, start: performance.now(), dur: 1400 });
  }

  function screenFor(status) {
    if (status === "tool" || status === "working" || status === "assigned") return "on";
    if (status === "thinking") return "think";
    if (status === "done") return "done";
    if (status === "error") return "error";
    return "off";
  }

  function draw(now) {
    const kanban = { todo: [], doing: [], done: [] };
    state.tasks.forEach((t) => {
      const col = t.status === "done" ? "done" : t.status === "in_progress" ? "doing" : "todo";
      kanban[col].push(t.agent?.look.shirt || "#9a93b3");
    });
    ctx.clearRect(0, 0, W, H);
    Pixel.drawLobby(ctx, now, kanban);
    Pixel.drawCorridor(ctx);

    const running = Boolean(state.startedAt && !state.endedAt);
    const frame = Math.floor(now / 140);
    Pixel.drawWorkstation(ctx, MANAGER, MANAGER_LOOK, {
      bob: running ? Math.sin(now / 500) * 0.6 : 0, blink: now % 3700 < 130,
    }, running ? "on" : "off", now);

    state.agents.forEach((agent) => {
      const room = ROOMS[agent.index];
      if (!room) return;
      const notes = Array.from({ length: Math.min(agent.toolCount, 12) }, () => "#ffd36b");
      Pixel.drawRoom(ctx, room, now, notes);
      const typing = agent.status === "tool" || agent.status === "working" || agent.status === "assigned";
      Pixel.drawWorkstation(ctx, Pixel.deskAnchor(agent.index), agent.look, {
        typing, frame,
        bob: agent.status === "thinking" ? Math.sin(now / 260) * 0.8 : 0,
        blink: (now + agent.index * 900) % 4100 < 130,
      }, screenFor(agent.status), now);
    });

    state.papers = state.papers.filter((p) => {
      const k = (now - p.start) / p.dur;
      if (k >= 1) return false;
      const x = p.x0 + (p.x1 - p.x0) * k;
      const y = p.y0 + (p.y1 - p.y0) * k - Math.sin(Math.PI * k) * 34;
      Pixel.drawPaper(ctx, x, y);
      return true;
    });
    requestAnimationFrame(draw);
  }

  // ---------- server ----------

  function connect(delay = 500) {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    const conn = $("#conn");
    ws.onopen = () => { conn.classList.add("on"); conn.lastChild.textContent = "연결됨"; delay = 500; };
    ws.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.kind === "history") {
        resetState();
        ev.events.forEach((e) => apply(e, false));
      } else {
        apply(ev, true);
      }
      renderAll();
    };
    ws.onclose = () => {
      conn.classList.remove("on");
      conn.lastChild.textContent = "재연결 중";
      setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
    };
  }

  async function refreshStatus() {
    try {
      const res = await fetch("/api/status");
      const s = await res.json();
      busy = s.busy;
      const select = $("#recording");
      const current = select.value;
      select.innerHTML = "";
      s.recordings.forEach((name) => select.add(new Option(name.replace("sample/", "샘플: ").replace("run/", "실행: "), name)));
      if (s.recordings.includes(current)) select.value = current;
      $("#run-btn").disabled = busy || !s.has_api_key;
      $("#replay-btn").disabled = busy || !s.recordings.length;
      const hint = $("#hint");
      hint.hidden = s.has_api_key;
      hint.textContent = "ANTHROPIC_API_KEY가 없어 실행은 꺼져 있습니다. 녹화 재생은 사용할 수 있습니다.";
    } catch {
      /* server restarting; the websocket reconnect will retry */
    }
  }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.detail || `요청 실패 (${res.status})`);
    }
    $("#report-badge").hidden = true;
    refreshStatus();
  }

  $("#run-form").addEventListener("submit", (e) => {
    e.preventDefault();
    post("/api/run", { topic: $("#topic").value });
  });
  $("#replay-btn").addEventListener("click", () => {
    post("/api/replay", { name: $("#recording").value, speed: Number($("#speed").value) });
  });
  $("#download-btn").addEventListener("click", () => {
    const blob = new Blob([state.report], { type: "text/markdown" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "report.md" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === btn.dataset.tab));
      if (btn.dataset.tab === "report") $("#report-badge").hidden = true;
    });
  });

  resetState();
  renderAll();
  setInterval(renderStats, 500);
  requestAnimationFrame(draw);
  refreshStatus();
  connect();
})();
