(() => {
  const { LOOKS, MANAGER_LOOK, MANAGER, MANAGER_ZONE } = Pixel;

  // Fallbacks for recordings made before the team editor existed.
  const PEOPLE = {
    researcher: { name: "리아", title: "리서처", team: "Research" },
    writer: { name: "윤", title: "라이터", team: "Writing" },
    reviewer: { name: "서진", title: "리뷰어", team: "Review" },
  };
  const DEFAULT_KEYS = ["researcher", "writer", "reviewer"];
  const TASK_LABELS = { research_task: "리서치", writing_task: "초안 작성", review_task: "검토·최종본" };
  const WORKING = new Set(["assigned", "working", "thinking", "tool"]);
  // Who sits in a seat. A manager swap moves these; role, goal, model and work stay with the seat.
  const PERSON_FIELDS = ["name", "look"];
  const FIELD_LABELS = {
    name: "이름", title: "직함", team: "팀 이름", role: "역할", goal: "목표", backstory: "배경",
    model: "모델", task_name: "담당 분야", task: "하는 일", expected_output: "결과물 형식", tools: "도구", look: "외형",
  };
  const TOOL_LABELS = {
    web_search: "웹 검색", web_crawl: "사이트 읽기·크롤링", naver_search: "네이버 검색·트렌드", save_file: "파일 저장",
    naver_ads: "네이버 검색광고", meta_ads: "메타 광고", google_ads: "구글 Ads",
  };
  const ACTION_LABELS = { pending: "승인 대기", running: "실행 중", done: "반영됨", failed: "실패", rejected: "거절" };
  const ACTION_PILLS = { pending: "in_progress", running: "in_progress", done: "done", failed: "failed", rejected: "stopped" };
  const MODEL_LABELS = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" };
  const NEW_LOOKS = [
    { hair: "#3a2a1a", skin: "#f2c9a0", shirt: "#d6873d", pants: "#2a2a3a", long_hair: false },
    { hair: "#1d1a26", skin: "#c98f68", shirt: "#3dbad6", pants: "#26302a", long_hair: true },
    { hair: "#b5651d", skin: "#e8b48a", shirt: "#d64545", pants: "#2f2a3a", long_hair: false },
  ];

  const $ = (sel) => document.querySelector(sel);
  const canvas = $("#office");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const overlay = $("#overlay");

  let state;
  let bubbles = new Map();
  let savedTeam = null;
  let meta = { models: Object.keys(MODEL_LABELS), tools: ["web_search"], tools_ready: {}, max_members: 20 };
  let actions = []; // ad changes of the selected business, newest first
  let isAdmin = false;
  let edit = null; // { draft, saved, selected, drag, scene } while the team editor is open
  let idle = null; // scene of the selected business at rest
  let overlayOf = null; // scene the overlay was built for
  let projects = [];
  let selectedProject = null;
  let orders = []; // the selected business's instructions, newest first
  let reportView = null; // a past result opened from the orders list
  let status = { busy: false, current: null, recordings: [], has_api_key: true };

  // ---------- people ----------

  function toLook(look, manager = false) {
    const base = { hair: look.hair, skin: look.skin, shirt: look.shirt, pants: look.pants, longHair: look.long_hair };
    return manager ? { ...base, tie: "#d64545", crown: true } : base;
  }

  function makeAgent(data, index) {
    const fallback = PEOPLE[data.key] || { name: `에이전트 ${index + 1}`, title: data.key || "팀원", team: data.key || `Team ${index + 1}` };
    return {
      id: data.id || null, key: data.key, role: data.role || "", index,
      name: data.name || fallback.name, title: data.title || fallback.title, team: data.team || fallback.team,
      look: data.look ? toLook(data.look) : LOOKS[index % LOOKS.length],
      status: "idle", bubble: null, toolCount: 0,
    };
  }

  function makeManager(data) {
    return {
      id: data?.id || null, role: data?.role || "",
      name: data?.name || "매니저", title: data?.title || "팀장",
      look: toLook(data?.look || { ...MANAGER_LOOK, long_hair: false }, true),
      status: "idle", bubble: null, pending: null,
    };
  }

  // One room per team, in order of first appearance; one desk per member inside.
  function setLayout(scene, addSlot) {
    const teams = [];
    scene.agents.forEach((a) => {
      let g = teams.findIndex((t) => t.name === a.team);
      if (g < 0) g = teams.push({ name: a.team, size: 0 }) - 1;
      a.room = g;
      a.slot = teams[g].size++;
    });
    const sizes = teams.map((t) => t.size).concat(addSlot ? [1] : []);
    scene.layout = { ...Pixel.layout(sizes), addSlot, teams: teams.map((t) => t.name) };
  }

  const anchorOf = (sc, agent) => Pixel.deskAnchor(sc.layout.rooms[agent.room], agent.slot);
  const teamLabel = (name) => (name.endsWith("팀") ? name : `${name} 팀`);

  // ---------- run state ----------

  // The run shown in the office: live, replayed, or the last one. scope = { project_id, order_id }.
  function resetState(mode = "idle", scope = {}) {
    const agents = savedTeam
      ? savedTeam.members.map((m, i) => makeAgent(m, i))
      : DEFAULT_KEYS.map((key, i) => makeAgent({ key }, i));
    state = {
      mode, topic: "", agents, byId: {},
      projectId: scope.project_id || null, orderId: scope.order_id || null, projectName: "",
      tasks: [], taskById: {}, report: "", tokens: null,
      startedAt: null, endedAt: null, failed: null,
      manager: makeManager(savedTeam?.manager),
      papers: [],
    };
    setLayout(state, false);
    $("#feed").innerHTML = "";
  }

  // The selected business's team at rest, shown when the office has no run of its own.
  function buildIdle() {
    const team = savedTeam;
    idle = {
      agents: team ? team.members.map((m, i) => makeAgent(m, i)) : DEFAULT_KEYS.map((key, i) => makeAgent({ key }, i)),
      manager: makeManager(team?.manager), tasks: [], papers: [],
    };
    say(idle.manager, "📨 위 입력칸에 업무를 지시하세요");
    setLayout(idle, false);
  }

  // A sample replay (no business) shows in any business; a real run only in its own.
  const runVisible = () => Boolean(state.startedAt) && (!state.projectId || state.projectId === selectedProject);
  const scene = () => (edit ? edit.scene : runVisible() ? state : idle);
  const directed = () => Boolean(state.manager.id); // a real manager agent runs this crew
  const currentTask = () => state.tasks.find((t) => t.status === "in_progress");
  const agentOf = (ev) => state.byId[ev.agent] || (directed() ? null : currentTask()?.agent) || null;
  const taskLabel = (task) => task?.label || TASK_LABELS[task?.name] || task?.name || "작업";
  const say = (who, text, kind = "") => { who.bubble = { text, kind }; };
  const norm = (s) => (s || "").toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ").trim();

  function findCoworker(name) {
    const n = norm(name);
    if (!n) return null;
    return state.agents.find((a) => norm(a.role) === n)
      || state.agents.find((a) => norm(a.name) === n)
      || state.agents.find((a) => norm(a.role).includes(n) || n.includes(norm(a.role)))
      || null;
  }

  function parseQuery(args) {
    const m = /['"]query['"]\s*:\s*(['"])(.*?)\1\s*[,}]/.exec(args || "");
    return m ? m[2] : args;
  }

  function applyManager(ev, live) {
    const mgr = state.manager;
    switch (ev.kind) {
      case "agent_started":
      case "thinking":
        if (!mgr.pending) { mgr.status = "thinking"; say(mgr, "💭 계획 중…"); }
        break;
      case "tool_started": {
        if (!ev.coworker) {
          say(mgr, `🔧 ${ev.tool}`, "tool");
          feed(ev, "tool", mgr.name, `🔧 ${ev.tool}: ${parseQuery(ev.args)}`);
          break;
        }
        const target = findCoworker(ev.coworker);
        const ask = /question/i.test(ev.tool || "");
        const who = target?.name || ev.coworker || "팀원";
        mgr.status = "tool";
        mgr.pending = target;
        if (!ask) {
          const item = { id: `d${state.tasks.length}`, label: ev.request || "업무", agent: target, status: "in_progress", output: null, delegated: true };
          state.tasks.push(item);
          mgr.pendingItem = item;
        }
        say(mgr, ask ? `❓ ${who}에게 질문: ${ev.request || ""}` : `📋 ${who}에게 지시: ${ev.request || ""}`, "tool");
        feed(ev, "manager", mgr.name, ask ? `❓ ${who}에게 질문` : `📋 ${who}에게 업무 지시`, ev.request);
        if (target) {
          target.status = "assigned";
          say(target, ask ? "❓ 팀장 질문 받음" : "📥 팀장 지시 받음");
          if (live) paper(MANAGER, anchorOf(state, target));
        }
        break;
      }
      case "tool_finished": {
        if (!/coworker/i.test(ev.tool || "")) break;
        // Newer recordings name who reported, which matters when several work in parallel.
        const target = ev.coworker ? findCoworker(ev.coworker) || mgr.pending : mgr.pending;
        const item = state.tasks.find((t) => t.delegated && t.agent === target && t.status === "in_progress") || mgr.pendingItem;
        mgr.pending = null;
        if (item) Object.assign(item, { status: "done", output: ev.output });
        mgr.pendingItem = null;
        mgr.status = "thinking";
        say(mgr, `🧐 ${target?.name || "팀원"}의 보고 검토 중`);
        feed(ev, "manager", mgr.name, `📑 ${target?.name || "팀원"}의 보고 수신`, ev.output);
        if (target && live) paper(anchorOf(state, target), MANAGER);
        break;
      }
      case "tool_error":
        mgr.pending = null;
        if (mgr.pendingItem) mgr.pendingItem.status = "failed";
        mgr.pendingItem = null;
        say(mgr, `⚠️ ${ev.tool} 오류`, "error");
        feed(ev, "error", mgr.name, `⚠️ ${ev.tool} 오류`, ev.error);
        break;
      case "agent_error":
        mgr.status = "error";
        say(mgr, "⚠️ 오류 발생", "error");
        feed(ev, "error", mgr.name, "⚠️ 팀장 오류", ev.error);
        break;
    }
  }

  function apply(ev, live) {
    // Task events name the manager too (it runs every task), but they belong to the task flow.
    if (ev.agent && ev.agent === state.manager.id && !ev.kind.startsWith("task_")) return applyManager(ev, live);
    const agent = ev.agent !== undefined ? agentOf(ev) : null;
    const mgr = state.manager;
    switch (ev.kind) {
      case "reset":
        resetState(ev.mode, ev);
        break;
      case "roster": {
        state.topic = ev.topic;
        state.startedAt = ev.t;
        state.projectId = ev.project?.id || state.projectId;
        state.projectName = ev.project?.name || "";
        state.manager = makeManager(ev.manager);
        state.agents = ev.agents.map((a, i) => makeAgent(a, i));
        state.agents.forEach((a) => (state.byId[a.id] = a));
        state.tasks = ev.tasks.map((t) => ({ ...t, agent: state.byId[t.agent], status: "todo", output: null }));
        state.tasks.forEach((t) => (state.taskById[t.id] = t));
        setLayout(state, false);
        if (scene() === state) buildOverlay(state);
        if (ev.project) {
          say(state.manager, "📨 업무 지시를 받았습니다");
          feed(ev, "manager", state.manager.name, `📨 ${ev.project.name} 업무 지시 접수 — 팀원 ${state.agents.length}명`, ev.topic);
        } else {
          say(state.manager, `“${ev.topic}” 프로젝트 시작!`);
          feed(ev, "manager", state.manager.name, `프로젝트 시작: “${ev.topic}” — 팀원 ${state.agents.length}명, 작업 ${state.tasks.length}개`);
        }
        break;
      }
      case "task_started": {
        const task = state.taskById[ev.task];
        if (!task) break;
        task.status = "in_progress";
        const who = task.agent || agent;
        if (task.name === "order") {
          mgr.status = "thinking";
          say(mgr, "🗂 지시 검토 중 — 일을 나누는 중");
          break;
        }
        if (directed()) {
          mgr.status = "thinking";
          say(mgr, `🗂 '${taskLabel(task)}' 착수 — ${who?.name || "?"} 담당`);
          feed(ev, "manager", mgr.name, `🗂 '${taskLabel(task)}' 착수 — ${who?.name || "?"}(${who?.title || ""}) 담당`);
          break;
        }
        if (who) {
          who.status = "assigned";
          say(who, `📥 '${taskLabel(task)}' 받았어요`);
        }
        say(mgr, `${who?.team || ""}팀 ${who?.name || ""}에게 '${taskLabel(task)}' 배정`);
        feed(ev, "manager", mgr.name, `${who?.name || "?"}(${who?.title || ""})에게 '${taskLabel(task)}' 배정`);
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
      case "agent_completed":
        if (agent && directed() && agent.status !== "done") {
          agent.status = "idle";
          say(agent, "📤 팀장에게 보고");
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
        if (task.name === "order") {
          mgr.status = "idle";
          say(mgr, "✅ 최종 결과물 정리 완료", "done");
          feed(ev, "done", mgr.name, "✅ 팀원 결과를 종합해 최종 결과물 완성", ev.output);
          break;
        }
        const who = task.agent;
        if (!who) break;
        who.status = "done";
        if (directed()) {
          mgr.status = "idle";
          say(who, "✅ 내 업무 완료", "done");
          say(mgr, `✅ '${taskLabel(task)}' 승인`, "done");
          feed(ev, "done", mgr.name, `✅ '${taskLabel(task)}' 승인 — ${who.name}`, ev.output);
          break;
        }
        const next = state.agents[who.index + 1];
        say(who, next ? `✅ 완료! ${next.name}에게 전달` : "✅ 최종본 완료!", "done");
        feed(ev, "done", who.name, `✅ '${taskLabel(task)}' 완료`, ev.output);
        if (live && next) paper(anchorOf(state, who), anchorOf(state, next));
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
        mgr.status = "idle";
        say(mgr, "🎉 완료! Report 탭에서 결과를 확인하세요", "done");
        feed(ev, "manager", mgr.name, `🎉 전체 완료${ev.total_tokens ? ` — ${ev.total_tokens.toLocaleString()} 토큰` : ""}`);
        if (live) {
          reportView = null;
          $("#report-badge").hidden = false;
        }
        renderReport();
        break;
      case "run_failed":
        state.failed = ev.error;
        state.endedAt = ev.t;
        mgr.status = "error";
        say(mgr, "⚠️ 실행 실패", "error");
        feed(ev, "error", mgr.name, "❌ 실행 실패", ev.error);
        break;
      case "action_proposed":
        feed(ev, "tool", ev.action.agent, `🧾 승인 요청 (${TOOL_LABELS[`${ev.action.platform}_ads`]}): ${ev.action.summary}`);
        break;
      case "run_stopped":
        state.endedAt = ev.t;
        state.tasks.forEach((t) => { if (t.status === "in_progress") t.status = "stopped"; });
        state.agents.forEach((a) => { if (a.status !== "done") { a.status = "idle"; a.bubble = null; } });
        mgr.status = "idle";
        mgr.pending = null;
        say(mgr, "⏹ 중지했습니다", "error");
        feed(ev, "error", mgr.name, "⏹ 사용자가 실행을 중지함");
        break;
    }
  }

  // ---------- overlay (labels, nameplates, bubbles) ----------

  function place(el, x, y, { W, H }) {
    el.style.left = `${(x / W) * 100}%`;
    el.style.top = `${(y / H) * 100}%`;
  }

  function buildOverlay(sc) {
    overlayOf = sc;
    const { rooms } = sc.layout;
    const size = sc.layout;
    overlay.innerHTML = "";
    bubbles = new Map();
    overlay.append(nameplate(sc.manager.name, `👑 ${sc.manager.title}`, MANAGER, size, "manager"));
    // Opens to the right of the monitor so the face stays visible (no room above in the lobby).
    bubbles.set(sc.manager, addBubble(MANAGER.cx + 32, MANAGER.deskY - 8, size, "from-left"));

    sc.layout.teams.forEach((name, g) => {
      const room = rooms[g];
      const label = document.createElement("div");
      label.className = "label";
      label.style.background = room.trim;
      label.textContent = teamLabel(name);
      place(label, room.x + room.w / 2, room.y + 1, size);
      overlay.append(label);
    });
    sc.agents.forEach((agent) => {
      const anchor = anchorOf(sc, agent);
      overlay.append(nameplate(agent.name, agent.title, anchor, size));
      bubbles.set(agent, addBubble(anchor.headX + 12, anchor.headY - 6, size));
    });

    if (sc.layout.addSlot) {
      const room = rooms[sc.layout.teams.length];
      const add = document.createElement("div");
      add.className = "label add";
      add.textContent = "+ 팀원 추가";
      place(add, room.x + room.w / 2, room.y + room.h / 2 + 14, size);
      overlay.append(add);
    }
  }

  function nameplate(name, title, anchor, size, extra = "") {
    const plate = document.createElement("div");
    plate.className = `nameplate ${extra}`;
    plate.innerHTML = `<b></b><span></span>`;
    plate.querySelector("b").textContent = name;
    plate.querySelector("span").textContent = title;
    place(plate, anchor.cx, anchor.deskY + 5, size);
    return plate;
  }

  function addBubble(x, y, size, extra = "") {
    const el = document.createElement("div");
    el.dataset.extra = extra;
    el.className = `bubble ${extra} hidden`;
    place(el, x, y, size);
    overlay.append(el);
    return el;
  }

  function renderBubbles() {
    bubbles.forEach((el, who) => {
      const b = who.bubble;
      el.className = `bubble ${el.dataset.extra} ${b?.kind || ""} ${b ? "" : "hidden"}`;
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

  const ORDER_LABELS = { queued: "대기", running: "진행 중", done: "완료", failed: "실패", stopped: "중지", cancelled: "취소" };
  const ORDER_PILLS = { queued: "", running: "in_progress", done: "done", failed: "failed", stopped: "stopped", cancelled: "stopped" };
  const clock = (t) => new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const minutes = (a, b) => `${Math.max(1, Math.round((b - a) / 60))}분`;

  // The selected business's instructions, with the running one's delegations as sub-items.
  function renderOrders() {
    const list = $("#task-list");
    const open = orders.filter((o) => o.status === "queued" || o.status === "running").length;
    $("#tasks-badge").textContent = open ? `${open}` : `${orders.length}`;
    $("#tasks-badge").classList.toggle("new", open > 0);
    list.innerHTML = "";
    if (!orders.length) {
      list.innerHTML = `<p class="empty">아직 업무 지시가 없습니다. 위 입력칸에 지시를 쓰고 📨 지시를 누르세요. 여러 개를 넣으면 차례대로 처리합니다.</p>`;
      return;
    }
    orders.forEach((order) => {
      const card = document.createElement("div");
      card.className = `task order ${order.status}`;
      card.innerHTML = `<header><h3></h3><span class="who"></span><span class="pill"></span></header><p class="instruction"></p>`;
      const [firstLine, ...rest] = order.instruction.split("\n");
      const cut = firstLine.length > 60;
      card.querySelector("h3").textContent = cut ? `${firstLine.slice(0, 60)}…` : firstLine;
      const meta = [clock(order.created)];
      if (order.started && order.ended) meta.push(minutes(order.started, order.ended));
      if (order.tokens) meta.push(`${order.tokens.toLocaleString()} 토큰`);
      card.querySelector(".who").textContent = meta.join(" · ");
      const pill = card.querySelector(".pill");
      if (ORDER_PILLS[order.status]) pill.classList.add(ORDER_PILLS[order.status]);
      pill.textContent = ORDER_LABELS[order.status];
      // The title already shows the first line; below it only what the title left out.
      const more = card.querySelector(".instruction");
      more.textContent = cut ? order.instruction : rest.join("\n").trim();
      more.hidden = !more.textContent;
      if (order.resume_of) card.querySelector(".who").textContent += " · ↪ 중단된 지시를 이어서 실행";
      if (order.error) card.append(note(`⚠️ ${order.error}`));

      if (order.status === "running" && state.orderId === order.id) {
        const items = state.tasks.filter((t) => t.delegated);
        const ul = document.createElement("ul");
        ul.className = "delegations";
        if (!items.length) ul.innerHTML = `<li class="muted">팀장이 지시를 검토하고 일을 나누는 중…</li>`;
        items.forEach((item) => {
          const li = document.createElement("li");
          li.innerHTML = `<b></b><span></span><em class="pill"></em>`;
          li.querySelector("b").textContent = `📋 ${item.agent?.name || "팀원"}`;
          li.querySelector("span").textContent = item.label;
          const p = li.querySelector(".pill");
          p.classList.add(item.status);
          p.textContent = { in_progress: "진행 중", done: "보고 완료", failed: "실패", stopped: "중지" }[item.status] || item.status;
          ul.append(li);
        });
        card.append(ul);
      }

      const actions = document.createElement("div");
      actions.className = "group-actions";
      const again = () => {
        $("#instruction").value = order.instruction;
        $("#instruction").focus();
      };
      if (order.status === "queued") actions.append(button("취소", "대기열에서 뺍니다", () => api(`/api/orders/${order.id}`, "DELETE")));
      if (order.status === "running") {
        actions.append(button("🏢 사무실에서 보기", "", () => showTab("office")));
      }
      if (order.status === "done") actions.append(button("📄 결과 보기", "", () => openReport(order), { cls: "primary" }));
      if (order.run && order.status !== "running") {
        actions.append(button("⟲ 재생", "이 업무가 진행된 모습을 다시 봅니다 (비용 없음)", () => {
          api(`/api/orders/${order.id}/replay`, "POST", { speed: Number($("#speed").value) }).then((ok) => ok && showTab("office"));
        }));
      }
      if (["failed", "stopped"].includes(order.status)) {
        actions.append(button("▶ 이어서 실행", "팀원들이 이미 끝낸 일은 그대로 쓰고, 남은 일만 이어서 합니다", async () => {
          if (await api(`/api/orders/${order.id}/resume`, "POST")) flash("▶ 이어서 실행을 대기열에 넣었습니다. 끝난 팀원 결과는 팀장에게 함께 전달됩니다.");
        }, { cls: "primary" }));
      }
      if (["failed", "stopped", "cancelled", "done"].includes(order.status)) actions.append(button("↻ 다시 지시", "같은 내용을 입력칸에 넣습니다", again));
      if (actions.children.length) card.append(actions);
      list.append(card);
    });
  }

  async function loadReport(order) {
    const res = await fetch(`/api/orders/${order.id}/report`);
    if (!res.ok) return false;
    const body = await res.json();
    reportView = { title: order.instruction, text: body.report, tokens: order.tokens, orderId: order.id };
    return true;
  }

  async function openReport(order) {
    if (!(await loadReport(order))) return alert("결과물을 불러오지 못했습니다.");
    renderReport();
    showTab("report");
  }

  function renderReport() {
    const el = $("#report");
    const view = reportView || (state.report ? { title: state.topic, text: state.report, tokens: state.tokens } : null);
    if (!view) {
      el.innerHTML = `<p class="empty">결과물이 완성되면 여기에 표시됩니다. 지난 결과는 📋 업무 탭의 📄 결과 보기로 엽니다.</p>`;
      $("#report-meta").textContent = "";
      $("#download-btn").disabled = true;
      return;
    }
    el.innerHTML = DOMPurify.sanitize(marked.parse(view.text));
    el.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    const title = view.title.length > 80 ? `${view.title.slice(0, 80)}…` : view.title;
    $("#report-meta").textContent = `지시: ${title}${view.tokens ? ` · ${view.tokens.toLocaleString()} 토큰` : ""}`;
    $("#download-btn").disabled = false;
    renderFiles(view.orderId || (state.mode === "live" && state.orderId) || orders.find((o) => o.status === "done")?.id);
  }

  // Files the team saved with save_file, next to the report they belong to.
  async function renderFiles(orderId) {
    const box = $("#report-files");
    box.hidden = true;
    if (!orderId) return;
    const files = await (await fetch(`/api/orders/${orderId}/files`)).json().catch(() => []);
    if (!Array.isArray(files) || !files.length) return;
    box.innerHTML = "<b>📎 저장된 파일</b>";
    files.forEach((f) => {
      const a = document.createElement("a");
      a.href = `/api/orders/${orderId}/files/${encodeURIComponent(f.name)}`;
      a.download = f.name;
      a.textContent = `${f.name} (${f.size < 1024 ? `${f.size} B` : `${Math.ceil(f.size / 1024)} KB`})`;
      box.append(a);
    });
    box.hidden = false;
  }

  // ---------- ad changes awaiting approval ----------

  async function loadActions() {
    if (!selectedProject) return;
    actions = await (await fetch(`/api/actions?project_id=${encodeURIComponent(selectedProject)}`)).json();
    renderActions();
  }

  function renderActions() {
    const pending = actions.filter((a) => a.status === "pending").length;
    $("#approvals-badge").textContent = pending;
    $("#approvals-badge").hidden = !pending;
    const list = $("#action-list");
    list.innerHTML = "";
    if (!actions.length) {
      list.innerHTML = `<p class="empty">승인 요청이 없습니다. 팀 편집에서 팀원에게 광고 도구(네이버 검색광고·메타 광고·구글 Ads)를 주면, 그 팀원이 광고 변경을 여기로 요청합니다.</p>`;
      return;
    }
    actions.forEach((a) => {
      const card = document.createElement("div");
      card.className = `task action ${a.status}`;
      card.innerHTML = `<header><h3></h3><span class="pill ${ACTION_PILLS[a.status]}"></span></header>
        <p class="who"></p><p class="cost"></p><details><summary>요청 내용</summary><pre class="request"></pre></details>`;
      card.querySelector("h3").textContent = a.summary;
      card.querySelector(".pill").textContent = ACTION_LABELS[a.status];
      card.querySelector(".who").textContent = `${a.platform_label} · ${a.agent || "팀원"} 요청 · ${clock(a.created)}`
        + (a.decided_by ? ` · ${a.decided_by} ${a.status === "rejected" ? "거절" : "승인"}` : "");
      card.querySelector(".cost").textContent = a.daily_cost_krw ? `하루 최대 비용 증가: ${a.daily_cost_krw.toLocaleString()}원` : "추가 비용 없음 (요청자 기준)";
      card.querySelector(".request").textContent = `${a.method} ${a.path}${Object.keys(a.params || {}).length ? `\nparams: ${JSON.stringify(a.params, null, 1)}` : ""}${a.body != null ? `\nbody: ${JSON.stringify(a.body, null, 1)}` : ""}`;
      if (a.result) {
        const d = document.createElement("details");
        d.innerHTML = `<summary>${a.status === "failed" ? "오류" : "플랫폼 응답"}</summary><pre></pre>`;
        d.querySelector("pre").textContent = a.result;
        if (a.status === "failed") d.open = true;
        card.append(d);
      }
      if (a.status === "pending") {
        const row = document.createElement("div");
        row.className = "actions";
        if (isAdmin) {
          const decide = (verb, question) => async () => {
            if (!confirm(question)) return;
            const ok = await api(`/api/actions/${a.id}/${verb}`, "POST");
            if (ok) loadActions();
          };
          row.append(
            button("✅ 승인하고 실행", "이 요청을 광고 플랫폼에 그대로 보냅니다", decide("approve", `${a.platform_label}에 이 변경을 반영할까요?\n\n${a.summary}`), { cls: "primary" }),
            button("거절", "실행하지 않고 닫습니다", decide("reject", "이 요청을 거절할까요?")),
          );
        } else {
          row.innerHTML = `<span class="muted">관리자 승인 대기 중</span>`;
        }
        card.append(row);
      }
      list.append(card);
    });
  }

  function renderStats() {
    const sc = scene();
    if (!sc) return; // before the first business loads
    const tasks = sc.tasks || [];
    const working = sc.agents.filter((a) => WORKING.has(a.status)).length + (WORKING.has(sc.manager.status) ? 1 : 0);
    const done = tasks.filter((t) => t.status === "done").length;
    $("#stat-staff").textContent = sc.agents.length + 1;
    $("#stat-working").textContent = working;
    $("#stat-progress").textContent = tasks.filter((t) => t.status === "in_progress").length;
    $("#stat-done").textContent = `${done}/${tasks.length}`;
    const start = sc.startedAt;
    const end = sc.endedAt || Date.now() / 1000;
    const secs = start ? Math.max(0, Math.round(end - start)) : 0;
    $("#stat-time").textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    renderNow();
  }

  // The one place that says what the office is doing now, with the stop button.
  function renderNow() {
    const now = $("#now");
    now.hidden = !status.busy;
    if (!status.busy) return;
    const mode = $("#mode");
    const go = $("#now-go");
    const current = status.current;
    const other = current && current.project_id !== selectedProject;
    go.hidden = !other;
    if (!current) {
      mode.textContent = "REPLAY";
      mode.className = "mode replay";
      $("#now-text").textContent = "지난 업무를 다시 보는 중입니다.";
    } else if (other) {
      const name = projects.find((p) => p.id === current.project_id)?.name || "다른 사업";
      mode.textContent = "BUSY";
      mode.className = "mode";
      go.dataset.project = current.project_id;
      $("#now-text").textContent = `'${name}' 사업이 일하는 중입니다. 이 사업의 지시는 그다음 차례로 처리됩니다.`;
    } else {
      const order = orders.find((o) => o.id === current.order_id);
      const line = order ? order.instruction.split("\n")[0] : "";
      mode.textContent = "LIVE";
      mode.className = "mode live";
      $("#now-text").textContent = `팀장이 지시를 진행하는 중${line ? ` · ${line}` : ""}`;
    }
  }

  function renderAll() {
    renderBubbles();
    renderOrders();
    renderStats();
  }

  function showTab(name) {
    document.querySelectorAll(".tabs button[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
    if (name === "report") $("#report-badge").hidden = true;
  }

  // ---------- canvas ----------

  function paper(a, b) {
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
    const sc = scene();
    if (overlayOf !== sc) {
      buildOverlay(sc);
      renderBubbles();
    }
    const { W, H, rooms } = sc.layout;
    // Back the canvas with enough device pixels that each logical pixel is a crisp square.
    const S = Math.max(1, Math.ceil(((canvas.clientWidth || W) * devicePixelRatio) / W));
    if (canvas.width !== W * S || canvas.height !== H * S) {
      canvas.width = W * S;
      canvas.height = H * S;
    }
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const kanban = { todo: [], doing: [], done: [] };
    (sc.tasks || []).forEach((t) => {
      const col = t.status === "done" ? "done" : t.status === "in_progress" ? "doing" : "todo";
      kanban[col].push(t.agent?.look.shirt || "#9a93b3");
    });
    ctx.clearRect(0, 0, W, H);
    Pixel.drawLobby(ctx, W, now, kanban);
    Pixel.drawCorridor(ctx, W, H);

    const running = sc === state && Boolean(state.startedAt && !state.endedAt);
    const frame = Math.floor(now / 140);
    const drag = edit?.drag?.moved ? edit.drag : null;
    const mgr = sc.manager;
    const mgrScreen = mgr.status !== "idle" ? screenFor(mgr.status) : running ? "on" : "off";
    Pixel.drawWorkstation(ctx, MANAGER, drag?.who === "manager" ? null : mgr.look, {
      typing: mgr.status === "tool", frame,
      bob: mgr.status === "thinking" ? Math.sin(now / 260) * 0.8 : running ? Math.sin(now / 500) * 0.6 : 0,
      blink: now % 3700 < 130,
    }, mgrScreen, now);

    sc.layout.teams.forEach((_, g) => {
      const tools = sc.agents.filter((a) => a.room === g).reduce((n, a) => n + a.toolCount, 0);
      Pixel.drawRoom(ctx, rooms[g], now, Array.from({ length: Math.min(tools, 12) }, () => "#ffd36b"));
    });
    sc.agents.forEach((agent) => {
      const typing = agent.status === "tool" || agent.status === "working" || agent.status === "assigned";
      Pixel.drawWorkstation(ctx, anchorOf(sc, agent), drag && drag.who === agent.key ? null : agent.look, {
        typing, frame,
        bob: agent.status === "thinking" ? Math.sin(now / 260) * 0.8 : 0,
        blink: (now + agent.index * 900) % 4100 < 130,
      }, screenFor(agent.status), now);
    });
    if (sc.layout.addSlot) Pixel.drawEmptyRoom(ctx, rooms[sc.layout.teams.length], now);

    if (edit) {
      if (!drag) (edit.selected === "manager" ? ["manager"] : edit.selected).forEach((seat) => Pixel.highlight(ctx, seatBounds(seat), "#ffd36b"));
      if (drag) {
        if (drag.target !== null) Pixel.highlight(ctx, dropRect(drag.target), "#5b8cff");
        const look = drag.who === "manager" ? mgr.look : memberAgent(drag.who).look;
        Pixel.drawGhost(ctx, drag.pos.x, drag.pos.y, look);
      }
    }

    sc.papers = (sc.papers || []).filter((p) => {
      const k = (now - p.start) / p.dur;
      if (k >= 1) return false;
      const x = p.x0 + (p.x1 - p.x0) * k;
      const y = p.y0 + (p.y1 - p.y0) * k - Math.sin(Math.PI * k) * 34;
      Pixel.drawPaper(ctx, x, y);
      return true;
    });
    requestAnimationFrame(draw);
  }

  // ---------- team editor: seats on the canvas ----------
  // Selection is "manager" or a list of member keys (several = a group to act on).

  const inside = (pt, r) => pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h;
  const members = () => edit.draft.members;
  const indexOf = (key) => members().findIndex((m) => m.key === key);
  const memberAgent = (key) => edit.scene.agents.find((a) => a.key === key);
  const selectedKeys = () => (Array.isArray(edit.selected) ? edit.selected : []);
  const seatBounds = (seat) => Pixel.workstationBounds(seat === "manager" ? MANAGER : anchorOf(edit.scene, memberAgent(seat)));
  const dropRect = (t) => (t === "manager" ? MANAGER_ZONE : t.key ? seatBounds(t.key) : edit.scene.layout.rooms[t.room]);
  const multiKey = (e) => e.shiftKey || e.metaKey || e.ctrlKey;

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    const { W, H } = edit.scene.layout;
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  function seatAt(pt) {
    if (inside(pt, seatBounds("manager"))) return "manager";
    return edit.scene.agents.find((a) => inside(pt, seatBounds(a.key)))?.key ?? null;
  }

  function roomAt(pt) {
    const g = edit.scene.layout.teams.findIndex((_, i) => inside(pt, edit.scene.layout.rooms[i]));
    return g >= 0 ? g : null;
  }

  // Manager seat, a member's desk (insert there), or a room's floor (join that team).
  function dropAt(pt) {
    if (inside(pt, MANAGER_ZONE)) return "manager";
    const key = seatAt(pt);
    if (key && key !== "manager") return { key };
    const room = roomAt(pt);
    return room === null ? null : { room };
  }

  const onAddSlot = (pt) => edit.scene.layout.addSlot && inside(pt, edit.scene.layout.rooms[edit.scene.layout.teams.length]);

  canvas.addEventListener("pointerdown", (e) => {
    if (!edit) return;
    e.preventDefault(); // no text selection while dragging
    const pt = toLogical(e);
    const who = seatAt(pt);
    if (who === null) {
      if (onAddSlot(pt)) return addMember();
      const room = roomAt(pt);
      if (room !== null) selectTeam(edit.scene.layout.teams[room], multiKey(e));
      return;
    }
    edit.drag = { who, start: pt, pos: pt, moved: false, target: null, multi: multiKey(e) };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!edit) return;
    const pt = toLogical(e);
    const drag = edit.drag;
    if (!drag) {
      canvas.style.cursor = seatAt(pt) !== null ? "grab" : onAddSlot(pt) || roomAt(pt) !== null ? "pointer" : "default";
      return;
    }
    drag.pos = pt;
    drag.moved = drag.moved || Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) > 3;
    drag.target = drag.moved ? dropAt(pt) : null;
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointerup", () => {
    const drag = edit?.drag;
    if (!drag) return;
    edit.drag = null;
    if (drag.moved) {
      if (drag.target !== null) moveSeat(drag.who, drag.target);
    } else if (drag.multi && drag.who !== "manager") toggle(drag.who);
    else select(drag.who === "manager" ? "manager" : [drag.who]);
  });
  canvas.addEventListener("pointercancel", () => { if (edit) edit.drag = null; });

  document.addEventListener("keydown", (e) => {
    if (!edit || !selectedKeys().length || !["Delete", "Backspace"].includes(e.key)) return;
    if (e.target.closest("input, textarea, select")) return;
    e.preventDefault();
    removeMembers(selectedKeys());
  });

  function select(seat) {
    edit.selected = seat;
    showMessage("");
    renderEditor();
  }

  function toggle(key) {
    const keys = selectedKeys();
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    select(next.length ? next : "manager");
  }

  function selectTeam(name, add) {
    const keys = members().filter((m) => m.team === name).map((m) => m.key);
    select(add ? [...new Set([...selectedKeys(), ...keys])] : keys);
  }

  function changed(selected) {
    if (selected !== undefined) edit.selected = selected;
    draftChanged(true);
    renderEditor();
  }

  function moveSeat(from, to) {
    const list = members();
    if (from === "manager" || to === "manager") {
      if (from === to || (from === "manager" && !to.key)) return;
      // The manager swaps places with a member: the people move, each seat keeps its job.
      const member = list[indexOf(from === "manager" ? to.key : from)];
      const manager = edit.draft.manager;
      PERSON_FIELDS.forEach((f) => { [member[f], manager[f]] = [manager[f], member[f]]; });
      return changed(from === "manager" ? [to.key] : "manager");
    }
    const fromIdx = indexOf(from);
    const team = to.key ? list[indexOf(to.key)].team : edit.scene.layout.teams[to.room];
    if (to.key === from || (!to.key && team === list[fromIdx].team)) return;
    const [m] = list.splice(fromIdx, 1);
    m.team = team;
    if (to.key) {
      const t = indexOf(to.key);
      list.splice(fromIdx <= t ? t + 1 : t, 0, m); // dragged right: after the target
    } else {
      list.splice(list.map((x) => x.team).lastIndexOf(team) + 1, 0, m);
    }
    changed([from]);
  }

  function uniqueTeam(base, except = null) {
    const taken = (t) => members().some((m) => m !== except && m.team === t);
    let name = base;
    for (let k = 2; taken(name); k++) name = `${base} ${k}`;
    return name;
  }

  function addMember() {
    const n = members().length;
    if (n >= meta.max_members) return;
    const key = `m${Date.now().toString(36)}`;
    // Roles must differ: the manager names the coworker by role when delegating.
    const roles = new Set([edit.draft.manager, ...members()].map((p) => p.role));
    let role = "전문가";
    for (let k = 2; roles.has(role); k++) role = `전문가 ${k}`;
    members().push({
      key, name: "새 팀원", title: "팀원", team: uniqueTeam(`Team ${n + 1}`),
      role,
      goal: "맡은 분야의 일을 정확하게 해낸다",
      backstory: "맡은 분야의 경험이 많은 전문가다. 근거 없는 내용을 지어내지 않는다.",
      task_name: "일반 업무",
      task: "팀장이 맡긴 일을 수행한다.",
      expected_output: "결과를 정리한 마크다운 문서.",
      tools: [], model: "claude-sonnet-5-5",
      look: { ...NEW_LOOKS[n % NEW_LOOKS.length] },
    });
    changed([key]);
  }

  function removeMembers(keys) {
    const doomed = members().filter((m) => keys.includes(m.key));
    if (!doomed.length) return;
    if (doomed.length >= members().length) return showMessage("팀원은 최소 1명이 있어야 합니다.", "error");
    const names = doomed.map((m) => m.name).join(", ");
    if (!confirm(`${names} 팀원을 삭제할까요?`)) return;
    edit.draft.members = members().filter((m) => !keys.includes(m.key));
    changed("manager");
    showMessage(`${doomed.length}명을 삭제했습니다. 💾 저장해야 반영됩니다.`, "ok");
  }

  function groupMembers(keys, rawName) {
    const name = rawName.trim();
    if (!name) return showMessage("그룹 이름을 입력하세요.", "error");
    const list = members();
    const picked = list.filter((m) => keys.includes(m.key));
    const rest = list.filter((m) => !keys.includes(m.key));
    // The group takes the place of its first member.
    const before = list.slice(0, list.indexOf(picked[0])).filter((m) => !keys.includes(m.key)).length;
    picked.forEach((m) => { m.team = name; });
    edit.draft.members = [...rest.slice(0, before), ...picked, ...rest.slice(before)];
    changed(keys);
    showMessage(`${picked.length}명을 '${teamLabel(name)}'으로 묶었습니다.`, "ok");
  }

  function ungroupMembers(keys) {
    members().filter((m) => keys.includes(m.key)).forEach((m) => { m.team = uniqueTeam(m.name, m); });
    changed(keys);
    showMessage("각자 자기 방으로 나눴습니다.", "ok");
  }

  function moveTeam(name, dir) {
    const teams = [...new Set(members().map((m) => m.team))];
    const i = teams.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= teams.length) return;
    [teams[i], teams[j]] = [teams[j], teams[i]];
    edit.draft.members = teams.flatMap((t) => members().filter((m) => m.team === t));
    changed();
  }

  // ---------- team editor: lifecycle and form ----------

  function draftChanged(visual) {
    // Teams stay contiguous: rooms follow first appearance and tasks run in this order.
    const order = [...new Set(members().map((m) => m.team))];
    edit.draft.members = order.flatMap((t) => members().filter((m) => m.team === t));
    if (Array.isArray(edit.selected)) {
      const keys = edit.selected.filter((k) => indexOf(k) >= 0);
      edit.selected = keys.length ? keys : "manager";
    }
    if (visual) {
      const d = edit.draft;
      const sc = { agents: d.members.map((m, i) => makeAgent(m, i)), manager: makeManager(d.manager), tasks: [], papers: [] };
      say(sc.manager, "끌어서 배치 · 클릭해서 설정 · ⇧/⌘클릭으로 여러 명 선택");
      setLayout(sc, d.members.length < meta.max_members);
      edit.scene = sc;
      buildOverlay(sc);
      renderBubbles();
    }
    const dirty = isDirty();
    $("#editor-save").disabled = !dirty;
    $("#editor-revert").disabled = !dirty;
    $("#editor-state").textContent = dirty ? "저장 안 됨" : "저장됨";
    $("#editor-state").classList.toggle("dirty", dirty);
  }

  const isDirty = () => Boolean(edit) && JSON.stringify(edit.draft) !== edit.saved;

  async function openEditor() {
    const data = await (await fetch(`/api/projects/${selectedProject}/team`)).json();
    edit = { draft: structuredClone(data.team), saved: JSON.stringify(data.team), selected: "manager", drag: null, scene: null };
    showTab("office");  // the editor lives in the Office panel
    $("#feed-box").hidden = true;
    $("#editor").hidden = false;
    $("#edit-btn").textContent = "✕ 편집 닫기";
    canvas.classList.add("editing");
    showMessage("");
    draftChanged(true);
    renderEditor();
    renderStats();
    $("#stage").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeEditor(force = false) {
    if (!edit) return true;
    if (!force && isDirty() && !confirm("저장하지 않은 변경을 버릴까요?")) return false;
    edit = null;
    $("#feed-box").hidden = false;
    $("#editor").hidden = true;
    $("#edit-btn").textContent = "🛠 팀 편집";
    canvas.classList.remove("editing");
    canvas.style.cursor = "";
    buildOverlay(scene());
    renderAll();
    return true;
  }

  function showMessage(text, kind = "") {
    const el = $("#editor-msg");
    el.textContent = text;
    el.className = `editor-msg ${kind}`;
  }

  function control(person, path, type = "text") {
    const keys = path.split(".");
    const get = () => keys.reduce((o, k) => o[k], person);
    const set = (v) => { keys.slice(0, -1).reduce((o, k) => o[k], person)[keys.at(-1)] = v; };
    let el;
    if (type === "textarea") el = document.createElement("textarea");
    else if (type === "model") {
      el = document.createElement("select");
      meta.models.forEach((m) => el.add(new Option(MODEL_LABELS[m] || m, m)));
    } else {
      el = document.createElement("input");
      el.type = type;
    }
    if (type === "checkbox") el.checked = get();
    else el.value = get();
    const visual = ["name", "title", "team"].includes(keys[0]) || keys[0] === "look";
    // The team name regroups rooms; apply it when the field is done, not per keystroke.
    const event = type === "checkbox" || type === "model" || keys[0] === "team" ? "change" : "input";
    el.addEventListener(event, () => {
      set(type === "checkbox" ? el.checked : el.value);
      draftChanged(visual);
      if (keys[0] === "team") renderEditor();
    });
    return el;
  }

  function field(label, el, wide = false) {
    const wrap = document.createElement("label");
    wrap.className = `field${wide ? " wide" : ""}`;
    const span = document.createElement("span");
    span.textContent = label;
    wrap.append(span, el);
    return wrap;
  }

  function button(text, title, onClick, { disabled = false, cls = "" } = {}) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title, disabled, className: cls });
    b.addEventListener("click", onClick);
    return b;
  }

  function editorHead(text, ...tools) {
    const head = document.createElement("div");
    head.className = "editor-head";
    const title = document.createElement("h3");
    title.textContent = text;
    const box = document.createElement("div");
    box.className = "seat-tools";
    box.append(...tools);
    head.append(title, box);
    return head;
  }

  function note(text) {
    const p = document.createElement("p");
    p.className = "editor-note";
    p.textContent = text;
    return p;
  }

  function renderGroupPanel(keys) {
    const box = $("#editor-fields");
    const picked = members().filter((m) => keys.includes(m.key));
    const common = picked.every((m) => m.team === picked[0].team) ? picked[0].team : "";
    const wholeTeam = common && members().filter((m) => m.team === common).length === picked.length;
    box.append(
      editorHead(`👥 ${picked.length}명 선택됨`,
        button(`🗑 ${picked.length}명 삭제`, "선택한 팀원 삭제", () => removeMembers(keys), { cls: "danger-outline" })),
      note(picked.map((m) => `${m.name} (${teamLabel(m.team)})`).join(" · ")),
    );
    const name = Object.assign(document.createElement("input"), { type: "text", value: common, placeholder: "예: 마케팅" });
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") groupMembers(keys, name.value); });
    box.append(field("그룹(팀) 이름", name, true));
    const actions = document.createElement("div");
    actions.className = "group-actions";
    actions.append(
      button("👥 그룹으로 묶기", "선택한 팀원을 한 방에 모읍니다", () => groupMembers(keys, name.value), { cls: "primary" }),
      button("그룹 해제", "각자 자기 방으로 나눕니다", () => ungroupMembers(keys)),
    );
    if (wholeTeam) {
      const teams = edit.scene.layout.teams;
      const i = teams.indexOf(common);
      actions.append(
        button("◀ 팀 앞으로", "이 팀의 방을 앞으로", () => moveTeam(common, -1), { disabled: i <= 0 }),
        button("팀 뒤로 ▶", "이 팀의 방을 뒤로", () => moveTeam(common, 1), { disabled: i >= teams.length - 1 }),
      );
    }
    box.append(actions, note("⇧Shift 또는 ⌘/Ctrl을 누른 채 클릭하면 선택에 더하거나 뺍니다. 방 바닥을 클릭하면 그 팀 전체가 선택됩니다."));
  }

  function renderEditor() {
    if (!edit) return;
    const box = $("#editor-fields");
    box.innerHTML = "";
    const keys = selectedKeys();
    if (keys.length > 1) return renderGroupPanel(keys);

    const isManager = edit.selected === "manager";
    const list = members();
    const idx = isManager ? -1 : indexOf(keys[0]);
    const person = isManager ? edit.draft.manager : list[idx];
    if (isManager) box.append(editorHead("👑 팀장"));
    else {
      const sameTeam = (j) => list[j] && list[j].team === person.team;
      const swap = (j) => { [list[idx], list[j]] = [list[j], list[idx]]; changed(); };
      box.append(editorHead(`${person.name} · ${teamLabel(person.team)}`,
        button("◀", "팀 안에서 앞 순서로", () => swap(idx - 1), { disabled: !sameTeam(idx - 1) }),
        button("▶", "팀 안에서 뒤 순서로", () => swap(idx + 1), { disabled: !sameTeam(idx + 1) }),
        button("🗑 팀원 삭제", "이 팀원 삭제 (Delete 키)", () => removeMembers([person.key]), { disabled: list.length <= 1, cls: "danger-outline" })));
    }

    const grid = document.createElement("div");
    grid.className = "field-grid";
    grid.append(field("이름", control(person, "name")), field("직함", control(person, "title")));
    if (!isManager) grid.append(field("팀 이름", control(person, "team")));
    grid.append(field("모델", control(person, "model", "model")));
    if (!isManager) {
    }
    box.append(grid);
    if (!isManager) {
      // Ad tools only ask; an admin approves each change in the 승인 tab.
      const picks = document.createElement("div");
      picks.className = "tool-picks";
      meta.tools.forEach((name) => {
        const on = { get on() { return person.tools.includes(name); }, set on(v) { person.tools = v ? [...person.tools, name] : person.tools.filter((t) => t !== name); } };
        const label = TOOL_LABELS[name] || name;
        const wrap = field(meta.tools_ready[name] === false ? `${label} (키 없음)` : label, control(on, "on", "checkbox"));
        wrap.classList.add("check");
        picks.append(wrap);
      });
      box.append(field("도구 (광고 도구의 변경은 승인 탭에서 관리자가 승인해야 반영)", picks, true));
    }

    const looks = document.createElement("div");
    looks.className = "look-row";
    [["hair", "머리"], ["skin", "피부"], ["shirt", "상의"], ["pants", "하의"]].forEach(([k, label]) => looks.append(field(label, control(person, `look.${k}`, "color"))));
    const longHair = field("긴 머리", control(person, "look.long_hair", "checkbox"));
    longHair.classList.add("check");
    looks.append(longHair);
    box.append(field("외형", looks, true));

    box.append(
      field("역할 (role)", control(person, "role"), true),
      field("목표 (goal)", control(person, "goal", "textarea"), true),
      field("배경 (backstory)", control(person, "backstory", "textarea"), true),
    );
    if (!isManager) {
      box.append(
        field("담당 분야", control(person, "task_name"), true),
        field("하는 일 (팀장이 보고 일을 맡깁니다)", control(person, "task", "textarea"), true),
        field("결과물 형식", control(person, "expected_output", "textarea"), true),
        note("⇧/⌘ 클릭으로 여러 명을 고르면 그룹으로 묶거나 한꺼번에 삭제할 수 있습니다."),
      );
    } else {
      box.append(note("팀장은 업무 지시를 받으면 일을 나누고, 팀원의 담당 분야와 하는 일을 보고 알맞은 사람에게 맡긴 뒤 결과를 검토합니다. 직접 작업하지는 않습니다."));
    }
  }

  function errorText(detail) {
    if (!Array.isArray(detail)) return detail || "저장하지 못했습니다.";
    return detail.map((d) => {
      const loc = d.loc.slice(1); // drop "body"
      let who = "";
      if (loc[0] === "manager") who = "팀장";
      else if (loc[0] === "members" && typeof loc[1] === "number") who = edit.draft.members[loc[1]]?.name || `${loc[1] + 1}번 팀원`;
      const name = loc.find((k) => FIELD_LABELS[k]);
      return `${who}${name ? ` · ${FIELD_LABELS[name]}` : ""}: ${d.msg.replace(/^Value error, /, "")}`;
    }).join("\n");
  }

  async function saveTeam() {
    const res = await fetch(`/api/projects/${selectedProject}/team`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edit.draft) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return showMessage(errorText(body.detail), "error");
    teamSaved(body.team);
    showMessage("저장했습니다. 다음 업무 지시부터 이 팀이 일합니다.", "ok");
  }

  function teamSaved(team) {
    savedTeam = team;
    buildIdle();
    edit.saved = JSON.stringify(team);
    edit.draft = structuredClone(team);
    draftChanged(true);
    renderEditor();
    loadProjects();
  }

  $("#edit-btn").addEventListener("click", () => (edit ? closeEditor() : openEditor()));
  $("#editor-save").addEventListener("click", saveTeam);
  $("#editor-revert").addEventListener("click", () => {
    edit.draft = JSON.parse(edit.saved);
    showMessage("");
    draftChanged(true);
    renderEditor();
  });
  $("#editor-default").addEventListener("click", async () => {
    if (!confirm("이 사업의 팀을 기본 구성(리서처·라이터·리뷰어)으로 되돌릴까요?")) return;
    const body = await (await fetch(`/api/projects/${selectedProject}/team/reset`, { method: "POST" })).json();
    teamSaved(body.team);
    showMessage("기본 구성으로 되돌렸습니다.", "ok");
  });

  // ---------- server ----------

  // JSON request; shows the server's message and returns false on failure.
  async function api(url, method = "GET", body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(Array.isArray(err.detail) ? err.detail.map((d) => d.msg).join("\n") : err.detail || `요청 실패 (${res.status})`);
      return false;
    }
    refreshStatus();
    return res.json().catch(() => true);
  }

  function connect(delay = 500) {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    const conn = $("#conn");
    ws.onopen = () => { conn.classList.add("on"); conn.lastChild.textContent = "연결됨"; delay = 500; };
    ws.onmessage = (msg) => {
      const ev = JSON.parse(msg.data);
      if (ev.kind === "actions") {
        loadActions();
        return;
      }
      if (ev.kind === "orders") {
        loadOrders();
        loadProjects();
        refreshStatus();
        return;
      }
      if (ev.kind === "history") {
        resetState();
        ev.events.forEach((e) => apply(e, false));
      } else {
        apply(ev, true);
        // A run started (maybe from another tab) or the server became free again.
        if (ev.kind === "reset" || ev.kind === "idle") refreshStatus();
      }
      if (scene() === state && overlayOf === state && ev.kind === "roster") buildOverlay(state);
      renderAll();
    };
    ws.onclose = () => {
      conn.classList.remove("on");
      conn.lastChild.textContent = "재연결 중";
      fetch("/api/me"); // back to the login page if the session ended
      setTimeout(() => connect(Math.min(delay * 2, 8000)), delay);
    };
  }

  async function refreshStatus() {
    try {
      status = await (await fetch("/api/status")).json();
      meta = { models: status.models, tools: status.tools, tools_ready: status.tools_ready || {}, max_members: status.max_members };
      renderRecordings();
      $("#order-btn").disabled = !status.has_api_key;
      $("#stop-btn").disabled = false;
      const hint = $("#hint");
      hint.hidden = status.has_api_key;
      hint.textContent = "ANTHROPIC_API_KEY가 없어 업무 지시는 꺼져 있습니다. 녹화 재생은 사용할 수 있습니다.";
      renderBusinesses();
      renderStats();
    } catch {
      /* server restarting; the websocket reconnect will retry */
    }
  }

  // ---------- businesses and instructions ----------

  // The left list: every business with its goal and latest instruction. Picking one
  // switches the whole screen (team, office, orders, report, recordings) to it.
  function renderBusinesses() {
    const list = $("#biz-list");
    list.innerHTML = "";
    projects.forEach((p) => {
      const working = status.current?.project_id === p.id;
      const li = document.createElement("li");
      li.className = `biz-item${p.id === selectedProject ? " active" : ""}${working ? " working" : ""}`;
      li.tabIndex = 0;
      li.innerHTML = `<div class="biz-name"><b></b><span class="muted"></span></div><p class="biz-goal"></p><div class="biz-last muted"></div><div class="biz-meta"></div>`;
      li.querySelector("b").textContent = `${working ? "● " : ""}${p.name}`;
      li.querySelector(".biz-name .muted").textContent = `${p.members + 1}명`;
      const goal = li.querySelector(".biz-goal");
      goal.textContent = p.goal || "사업 목표 없음";
      goal.classList.toggle("none", !p.goal);
      const last = li.querySelector(".biz-last");
      if (p.last) {
        const line = p.last.instruction.split("\n")[0];
        last.textContent = `최근 지시 · ${clock(p.last.at)} · ${ORDER_LABELS[p.last.status]}\n${line.length > 44 ? `${line.slice(0, 44)}…` : line}`;
      } else {
        last.textContent = "아직 지시 없음";
      }
      const meta = li.querySelector(".biz-meta");
      const o = p.orders;
      meta.innerHTML = [
        // ● already marks the working business; count only what waits behind it.
        o.waiting - working > 0 ? `<span class="pill in_progress">대기 ${o.waiting - working}</span>` : "",
        o.done ? `<span class="pill done">완료 ${o.done}</span>` : "",
        o.failed ? `<span class="pill failed">실패·중지 ${o.failed}</span>` : "",
      ].join("");
      if (p.id === selectedProject) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "biz-edit";
        btn.textContent = "✎ 이름·목표";
        btn.addEventListener("click", (e) => { e.stopPropagation(); openBizDialog(p); });
        meta.append(btn);
      }
      li.addEventListener("click", () => p.id !== selectedProject && switchProject(p.id));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") li.click(); });
      list.append(li);
    });
  }

  function renderRecordings() {
    const select = $("#recording");
    const current = select.value;
    // Each instruction replays from its card; this list keeps samples and runs from before businesses.
    const shared = status.recordings.filter((r) => !r.project_id);
    select.innerHTML = "";
    shared.forEach((r) => select.add(new Option(r.label, r.name)));
    if (shared.some((r) => r.name === current)) select.value = current;
    $("#more-recordings").hidden = !shared.length;
    $("#replay-btn").disabled = status.busy;
  }

  async function loadProjects() {
    projects = await (await fetch("/api/projects")).json();
    if (!projects.some((p) => p.id === selectedProject)) {
      let saved = null;
      try { saved = localStorage.getItem("office.project"); } catch { /* storage blocked */ }
      selectedProject = projects.some((p) => p.id === saved) ? saved : projects[0].id;
    }
    renderBusinesses();
  }

  async function loadTeam() {
    savedTeam = (await (await fetch(`/api/projects/${selectedProject}/team`)).json()).team;
    buildIdle();
  }

  async function loadOrders() {
    if (!selectedProject) return;
    orders = await (await fetch(`/api/orders?project_id=${encodeURIComponent(selectedProject)}`)).json();
    renderOrders();
  }

  // Report, recordings and the instruction box follow the selected business.
  async function showProjectState() {
    const p = projects.find((x) => x.id === selectedProject);
    if (!p) return;
    $("#instruction").placeholder = `'${p.name}' 팀장에게 업무 지시 (Enter 보내기 · Shift+Enter 줄바꿈)`;
    renderRecordings();
    reportView = null;
    const latest = orders.find((o) => o.status === "done"); // newest first
    if (!(runVisible() && state.report) && latest) await loadReport(latest);
    renderReport();
  }

  async function switchProject(id) {
    if (!closeEditor()) return;
    selectedProject = id;
    try { localStorage.setItem("office.project", id); } catch { /* storage blocked */ }
    await Promise.all([loadTeam(), loadOrders(), loadActions()]);
    renderBusinesses();
    await showProjectState();
    renderAll();
  }

  // One dialog for a new business and for a business's name and goal.
  const bizDialog = $("#biz-dialog");
  let bizEditing = null; // the business being edited, or null for a new one
  function openBizDialog(project = null) {
    bizEditing = project;
    $("#biz-dialog-title").textContent = project ? "BUSINESS" : "NEW BUSINESS";
    $("#biz-name").value = project?.name || "";
    $("#biz-goal").value = project?.goal || "";
    $("#biz-copy").checked = false;
    $("#biz-copy-row").hidden = Boolean(project);
    $("#biz-delete").hidden = !project;
    $("#biz-delete").disabled = projects.length <= 1;
    bizDialog.showModal();
    $("#biz-name").focus();
  }
  $("#project-new").addEventListener("click", () => openBizDialog());
  $("#biz-cancel").addEventListener("click", () => bizDialog.close());
  $("#biz-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: $("#biz-name").value.trim(), goal: $("#biz-goal").value.trim() };
    if (!body.name) return $("#biz-name").focus();
    const saved = bizEditing
      ? await api(`/api/projects/${bizEditing.id}`, "PATCH", body)
      : await api("/api/projects", "POST", { ...body, copy_from: $("#biz-copy").checked ? selectedProject : null });
    if (!saved) return;
    bizDialog.close();
    await loadProjects();
    if (!bizEditing) await switchProject(saved.id);
    else showProjectState();
  });
  $("#biz-delete").addEventListener("click", async () => {
    if (!confirm(`'${bizEditing.name}' 사업을 삭제할까요? 팀 설정이 지워지고, 대기 중인 지시는 취소됩니다.`)) return;
    if (!(await api(`/api/projects/${bizEditing.id}`, "DELETE"))) return;
    bizDialog.close();
    await loadProjects();
    switchProject(projects[0].id);
  });

  async function submitOrder() {
    const input = $("#instruction");
    const instruction = input.value.trim();
    if (!instruction) return input.focus();
    if (isDirty()) return alert("팀 편집 내용을 먼저 저장하거나 되돌리세요.");
    const order = await api("/api/orders", "POST", { project_id: selectedProject, instruction });
    if (!order) return;
    input.value = "";
    autosize();
    const ahead = status.busy ? " 앞선 작업이 끝나면 시작합니다." : "";
    flash(`📨 지시를 보냈습니다.${ahead} 📋 업무 탭에서 진행 상황을 볼 수 있습니다.`);
    loadOrders();
  }

  function flash(text) {
    const el = $("#flash");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  function autosize() {
    const input = $("#instruction");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitOrder();
  });
  $("#instruction").addEventListener("input", autosize);
  $("#instruction").addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter adds a line (not while composing Korean).
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitOrder();
    }
  });
  $("#replay-btn").addEventListener("click", () => {
    if (!closeEditor()) return;
    api("/api/replay", "POST", { name: $("#recording").value, speed: Number($("#speed").value) }).then((ok) => ok && showTab("office"));
  });
  $("#now-go").addEventListener("click", (e) => switchProject(e.target.dataset.project));
  $("#stop-btn").addEventListener("click", () => {
    $("#stop-btn").disabled = true;
    api("/api/stop", "POST");
  });
  $("#download-btn").addEventListener("click", () => {
    const text = reportView?.text || state.report;
    const blob = new Blob([text], { type: "text/markdown" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "report.md" });
    a.click();
    URL.revokeObjectURL(a.href);
  });
  document.querySelectorAll(".tabs button[data-tab]").forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

  async function start() {
    resetState();
    fetch("/api/me").then((r) => r.json()).then((user) => { isAdmin = Boolean(user.is_admin); renderActions(); }).catch(() => {});
    await refreshStatus();
    try {
      await loadProjects();
      await Promise.all([loadTeam(), loadOrders(), loadActions()]);
      await showProjectState();
    } catch {
      buildIdle(); /* fall back to the built-in roster */
    }
    renderAll();
    setInterval(renderStats, 500);
    requestAnimationFrame(draw);
    connect();
  }

  start();
})();
