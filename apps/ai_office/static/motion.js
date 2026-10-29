// Little scenes the office plays between events: the lead and a member meeting at the
// lobby table when work is handed out, a member walking a report over to the lead,
// confetti when something is finished. Each person runs a queue of steps; while one
// runs they are a "walker" drawn standing (sprites.js drawStanding) and their chair is
// empty. Only live events start scenes, so loading history never replays them.
(() => {
  const SPEED = 0.075; // logical units per ms
  const CONFETTI = ["#5b7cfa", "#f5c443", "#2fae76", "#e0574f", "#9468ee", "#2aa9c4"];

  const busy = (who) => Boolean(who.script?.length || who.walker);

  // ---------- the step runner ----------
  // Steps: { to: {x, y}, fade?: "in" | "out", door?: room index } walk there;
  // { at: {x, y} } appear there; { wait: ms }; { until: () => bool, max?: ms };
  // { talk: ms }; { face: -1 | 1 }; { run: (who) => void }; { sit: true } back in the chair.

  function play(who, steps) {
    who.script = steps;
  }

  function update(scene, now) {
    const dt = Math.min(now - (scene.motionAt || now), 60);
    scene.motionAt = now;
    [scene.manager, ...scene.agents].forEach((who) => {
      const w = who.walker;
      if (w) {
        w.talking = w.talkUntil > now;
        if (w.moving) w.phase += dt * 0.018;
      }
      let guard = 8; // finish instant steps within one frame
      while (who.script?.length && guard--) {
        const step = who.script[0];
        if (!step.started) step.started = now;
        if (!advance(scene, who, step, now, dt)) break;
        who.script.shift();
      }
    });
  }

  // true when the step is finished.
  function advance(scene, who, step, now, dt) {
    const w = who.walker;
    if (step.at) {
      Object.assign(who.walker, { x: step.at.x, y: step.at.y });
      return true;
    }
    if (step.to) {
      if (step.from === undefined) step.from = { x: w.x, y: w.y };
      if (step.door !== undefined) (scene.doors ||= {})[step.door] = now + 500;
      const dx = step.to.x - w.x, dy = step.to.y - w.y, d = Math.hypot(dx, dy);
      const move = SPEED * dt;
      w.moving = true;
      if (Math.abs(dx) > 0.3) w.look = dx > 0 ? 1 : -1;
      const total = Math.hypot(step.to.x - step.from.x, step.to.y - step.from.y) || 1;
      if (d <= move) {
        w.x = step.to.x;
        w.y = step.to.y;
      } else {
        w.x += (dx / d) * move;
        w.y += (dy / d) * move;
      }
      const k = 1 - Math.hypot(step.to.x - w.x, step.to.y - w.y) / total;
      if (step.fade === "out") w.alpha = 1 - k;
      if (step.fade === "in") w.alpha = k;
      if (d > move) return false;
      w.moving = false;
      return true;
    }
    if (step.wait) return now - step.started >= step.wait;
    if (step.until) return step.until() || now - step.started >= (step.max || 15000);
    if (step.talk) {
      w.talkUntil = step.started + step.talk;
      return now - step.started >= step.talk;
    }
    if (step.face) {
      w.look = step.face;
      return true;
    }
    if (step.run) {
      step.run(who);
      return true;
    }
    if (step.sit) {
      who.walker = null;
      return true;
    }
    return true;
  }

  // ---------- routes ----------

  // From a seat to a lobby spot and back. seat: the desk anchor; room: the member's room
  // (index and rect), or null for the lead, whose desk is in the lobby.
  function stand(seat, carry) {
    return { run: (who) => { who.walker = { x: seat.cx, y: seat.deskY - 1, alpha: 1, phase: 0, look: 1, carry }; } };
  }

  function routeOut(seat, room, dest, carry = false) {
    if (!room) return [stand(seat, carry), { to: { x: seat.cx + 40, y: seat.deskY + 6 } }, { to: dest }];
    const door = Pixel.doorOf(room.rect);
    return [
      stand(seat, carry),
      { to: { x: seat.cx + 40, y: seat.deskY + 4 } },
      { to: { x: seat.cx + 40, y: room.rect.y + 46 } },
      { to: { x: door.x, y: room.rect.y + 46 } },
      { to: { x: door.x, y: door.y }, fade: "out", door: room.index },
      { at: { x: door.x, y: Pixel.CORRIDOR_Y + 4 } },
      { to: { x: door.x, y: Pixel.CORRIDOR_Y - 4 }, fade: "in" },
      { to: dest },
    ];
  }

  function routeBack(seat, room) {
    if (!room) return [{ to: { x: seat.cx + 40, y: seat.deskY + 6 } }, { to: { x: seat.cx, y: seat.deskY - 1 } }, { sit: true }];
    const door = Pixel.doorOf(room.rect);
    return [
      { to: { x: door.x, y: Pixel.CORRIDOR_Y - 4 } },
      { to: { x: door.x, y: Pixel.CORRIDOR_Y + 4 }, fade: "out" },
      { at: { x: door.x, y: door.y } },
      { to: { x: door.x, y: room.rect.y + 46 }, fade: "in", door: room.index },
      { to: { x: seat.cx + 40, y: room.rect.y + 46 } },
      { to: { x: seat.cx + 40, y: seat.deskY + 4 } },
      { to: { x: seat.cx, y: seat.deskY - 1 } },
      { sit: true },
    ];
  }

  // ---------- scenes ----------

  // The lead calls a member to the lobby table, they talk it over, the member leaves
  // with the assignment. place(who) -> { seat, room }. false when either is busy.
  function meeting(scene, lead, member, place, onHandOff) {
    if (busy(lead) || busy(member)) return false;
    const [spotL, spotM] = Pixel.meetingSpots(scene.layout.W);
    const here = { lead: false, member: false };
    const together = { until: () => here.lead && here.member };
    const L = place(lead), M = place(member);
    play(lead, [
      ...routeOut(L.seat, L.room, spotL),
      { face: 1 },
      { run: () => { here.lead = true; } },
      together,
      { talk: 2400 },
      { run: () => onHandOff?.(spotL, spotM) },
      { wait: 900 },
      ...routeBack(L.seat, L.room),
    ]);
    play(member, [
      ...routeOut(M.seat, M.room, spotM),
      { face: -1 },
      { run: () => { here.member = true; } },
      together,
      { wait: 500 },
      { talk: 1900 },
      { wait: 900 },
      { run: (who) => { who.walker.carry = true; } },
      ...routeBack(M.seat, M.room),
    ]);
    return true;
  }

  // A member walks a finished piece over to the lead's desk and hands it in.
  function report(scene, member, lead, place, onHandIn) {
    if (busy(member)) return false;
    const M = place(member);
    play(member, [
      { run: (who) => { who.jumpAt = performance.now(); } },
      { wait: 450 },
      ...routeOut(M.seat, M.room, Pixel.REPORT_SPOT, true),
      { face: -1 },
      { until: () => !busy(lead), max: 9000 },
      { talk: 1100 },
      { run: (who) => { who.walker.carry = false; onHandIn?.(Pixel.REPORT_SPOT); } },
      { wait: 700 },
      ...routeBack(M.seat, M.room),
    ]);
    return true;
  }

  function burst(scene, x, y, now, count = 18) {
    scene.confetti = (scene.confetti || []).filter((b) => now - b.born < b.life);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI - Math.PI; // upward fan
      const v = 22 + Math.random() * 30;
      scene.confetti.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (Math.random() - 0.5) * 14,
        color: CONFETTI[i % CONFETTI.length], born: now + Math.random() * 120, life: 1300 + Math.random() * 500,
      });
    }
  }

  // Everyone hops in their seat, with confetti over the lobby.
  function celebrate(scene, now) {
    [scene.manager, ...scene.agents].forEach((who, i) => { who.jumpAt = now + i * 70; });
    const W = scene.layout.W;
    burst(scene, W / 2, 30, now, 30);
    burst(scene, Pixel.MANAGER.cx, 22, now + 150, 16);
  }

  // Extra pose for someone seated: hops, shakes and idle fidgets.
  function seatedPose(who, now, idleIndex) {
    const pose = {};
    const hop = (now - (who.jumpAt || -1e9)) / 520;
    if (hop >= 0 && hop < 2) pose.bob = -Math.abs(Math.sin(hop * Math.PI)) * 4;
    if (who.shakeUntil > now) pose.dx = Math.sin(now / 24) * 1.3;
    if (idleIndex !== null && who.status === "idle") {
      const p = (now + idleIndex * 2731) % 15000;
      if (p < 1600) pose.stretch = Math.sin((p / 1600) * Math.PI);
      else if (p > 7000 && p < 8600) pose.look = Math.sin(((p - 7000) / 1600) * Math.PI * 2);
    }
    return pose;
  }

  function standingPose(who, now) {
    const w = who.walker;
    const hop = (now - (who.jumpAt || -1e9)) / 520;
    return {
      moving: w.moving, phase: w.phase, carry: w.carry, look: w.look,
      talk: w.talking ? 0.5 + 0.5 * Math.sin(now / 85) : 0,
      gesture: w.talking ? now / 210 : undefined,
      jump: hop >= 0 && hop < 1 ? Math.sin(hop * Math.PI) * 5 : 0,
      blink: now % 3900 < 120,
    };
  }

  window.Motion = { busy, update, meeting, report, burst, celebrate, seatedPose, standingPose };
})();
