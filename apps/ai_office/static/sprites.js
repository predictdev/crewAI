// Flat vector illustration of the office, drawn on a canvas. The logical canvas
// grows with the team: one room per team (one desk per member) under the lobby,
// wrapping into rows. office.js scales the context to the device's pixel density,
// so shapes stay sharp at any size; positions are in logical units.
// (The global stays `Pixel` because office.js and older recordings use it.)
(() => {
  const MIN_W = 384, H = 232; // H: height with one row of rooms
  const ROOM_GAP = 6, ROOM_Y = 88, ROOM_H = 136, ROOM_PAD = 8, DESK_GAP = 104;
  const ROW_MAX = 624; // five single-desk rooms
  const INK = "#262833"; // darkest line and detail color

  // One accent per team; walls, floors and rugs are light tints of it.
  const ACCENTS = ["#5b7cfa", "#9468ee", "#2fae76", "#e5874a", "#2aa9c4"];
  const PALETTES = ACCENTS.map((trim) => ({
    trim,
    wall: mix(trim, "#f6f3ee", 0.9),
    floor: [mix(trim, "#ebe5dc", 0.86), mix(trim, "#e4ddd2", 0.78)],
  }));

  // Fallback looks for recordings made before the team editor existed.
  const LOOKS = [
    { hair: "#2b1d14", skin: "#f2c9a0", shirt: "#3d6bd6", pants: "#2a2a3a", longHair: true },
    { hair: "#d9a441", skin: "#e8b48a", shirt: "#9a5bd6", pants: "#2f2a3a" },
    { hair: "#6b3b2a", skin: "#c98f68", shirt: "#3fae6a", pants: "#26302a", longHair: true },
  ];
  const MANAGER_LOOK = { hair: "#1d1a26", skin: "#f0c49a", shirt: "#2f2f3f", pants: "#1d1d29" };
  const MANAGER_ZONE = { x: 0, y: 0, w: 120, h: 80 };

  // sizes[i] = desks in room i. Rooms flow left to right in centered rows.
  function layout(sizes) {
    const rows = [];
    let row = [], rowW = 0;
    sizes.forEach((desks, i) => {
      const w = desks * DESK_GAP + 2 * ROOM_PAD;
      if (row.length && rowW + ROOM_GAP + w > ROW_MAX) {
        rows.push({ row, rowW });
        row = [];
        rowW = 0;
      }
      rowW += (row.length ? ROOM_GAP : 0) + w;
      row.push({ i, desks, w });
    });
    if (row.length) rows.push({ row, rowW });
    const W = Math.max(MIN_W, ...rows.map((r) => r.rowW + 2 * ROOM_GAP));
    const rooms = [];
    rows.forEach(({ row, rowW }, r) => {
      let x = Math.round((W - rowW) / 2);
      row.forEach(({ i, desks, w }) => {
        rooms[i] = { ...PALETTES[i % PALETTES.length], x, y: ROOM_Y + r * (ROOM_H + ROOM_GAP), w, h: ROOM_H, desks };
        x += w + ROOM_GAP;
      });
    });
    return { W, H: H + (Math.max(rows.length, 1) - 1) * (ROOM_H + ROOM_GAP), rooms };
  }

  // ---------- places people walk between ----------

  const CORRIDOR_Y = 84;
  const doorOf = (room) => ({ x: room.x + 36.5, y: room.y + 36 });
  const tableX = (W) => Math.round((W - 88) / 2) + 4;
  // Standing spots in front of the lobby table (lead, member) and beside the lead's desk.
  const meetingSpots = (W) => [{ x: tableX(W) + 20, y: 77 }, { x: tableX(W) + 70, y: 77 }];
  const REPORT_SPOT = { x: 102, y: 76 };

  // ---------- primitives ----------

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }

  // a weighted toward b by k (0..1).
  function mix(a, b, k) {
    const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
    const f = (x, y) => Math.round(x + (y - x) * k).toString(16).padStart(2, "0");
    return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
  }

  // amt > 0 lightens toward white, amt < 0 darkens toward black.
  const shade = (hex, amt) => mix(hex, amt > 0 ? "#ffffff" : "#000000", Math.abs(amt));

  function rect(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  function ellipse(ctx, cx, cy, rx, ry, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Soft contact shadow on the floor.
  const floorShadow = (ctx, cx, cy, rx, ry, alpha = 0.16) => ellipse(ctx, cx, cy, rx, ry, `rgba(30,24,20,${alpha})`);

  function vertical(ctx, x, y, w, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  // A limb hanging from (x, y), swung by `angle` radians (0 = straight down).
  function limb(ctx, x, y, w, len, angle, fill) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    rect(ctx, -w / 2, 0, w, len, w / 2, fill);
    ctx.restore();
  }
  // Where the end of that limb is.
  const limbEnd = (x, y, len, angle) => [x - Math.sin(angle) * len, y + Math.cos(angle) * len];

  // ---------- characters ----------

  // Head centered on (cx, cy): ears, face, hair, optional crown.
  // pose.look shifts the eyes (-1 left, 1 right); pose.talk (0..1) opens the mouth.
  function drawHead(ctx, cx, cy, look, pose = {}) {
    const hair = look.hair, skin = look.skin, skinLo = shade(skin, -0.12);
    ellipse(ctx, cx - 8.4, cy + 1.5, 1.6, 2.1, skinLo);
    ellipse(ctx, cx + 8.4, cy + 1.5, 1.6, 2.1, skinLo);
    ellipse(ctx, cx, cy, 8.3, 8.6, skin);

    // Hair: a cap with a swept fringe, plus side locks when long.
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.moveTo(cx - 8.9, cy + 1.5);
    ctx.arc(cx, cy - 0.3, 8.9, Math.PI * 1.03, Math.PI * 1.97);
    ctx.lineTo(cx + 8.9, cy + 1.5);
    ctx.quadraticCurveTo(cx + 7.6, cy - 3.6, cx + 2.5, cy - 3.4);
    ctx.quadraticCurveTo(cx - 2.5, cy - 3.2, cx - 6, cy - 5.2);
    ctx.quadraticCurveTo(cx - 7.6, cy - 2.4, cx - 8.9, cy + 1.5);
    ctx.fill();
    if (look.longHair) {
      rect(ctx, cx - 9.6, cy - 1, 3.2, 12, 1.6, hair);
      rect(ctx, cx + 6.4, cy - 1, 3.2, 12, 1.6, hair);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 1;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx - 1, cy - 1.5, 6, Math.PI * 1.2, Math.PI * 1.45);
    ctx.stroke();

    // Face.
    const ex = (pose.look || 0) * 1.1;
    if (pose.blink) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - 4.3 + ex, cy + 2.6);
      ctx.lineTo(cx - 2.1 + ex, cy + 2.6);
      ctx.moveTo(cx + 2.1 + ex, cy + 2.6);
      ctx.lineTo(cx + 4.3 + ex, cy + 2.6);
      ctx.stroke();
    } else {
      ellipse(ctx, cx - 3.2 + ex, cy + 2.4, 1, 1.3, INK);
      ellipse(ctx, cx + 3.2 + ex, cy + 2.4, 1, 1.3, INK);
      ellipse(ctx, cx - 2.9 + ex, cy + 1.9, 0.35, 0.35, "#ffffff");
      ellipse(ctx, cx + 3.5 + ex, cy + 1.9, 0.35, 0.35, "#ffffff");
    }
    ellipse(ctx, cx - 5.4, cy + 4.6, 1.5, 0.9, "rgba(240,120,120,0.28)");
    ellipse(ctx, cx + 5.4, cy + 4.6, 1.5, 0.9, "rgba(240,120,120,0.28)");
    if (pose.talk) {
      ellipse(ctx, cx + ex * 0.5, cy + 5, 1.3, 0.5 + pose.talk * 0.9, shade(skin, -0.5));
    } else {
      ctx.strokeStyle = shade(skin, -0.45);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.arc(cx + ex * 0.5, cy + 4.6, 1.3, Math.PI * 0.2, Math.PI * 0.8);
      ctx.stroke();
    }

    if (look.crown) {
      const top = cy - 9.5;
      ctx.fillStyle = "#f5c443";
      ctx.beginPath();
      ctx.moveTo(cx - 5, top - 1.5);
      ctx.lineTo(cx - 5.5, top - 6.5);
      ctx.lineTo(cx - 2.6, top - 4);
      ctx.lineTo(cx, top - 7.5);
      ctx.lineTo(cx + 2.6, top - 4);
      ctx.lineTo(cx + 5.5, top - 6.5);
      ctx.lineTo(cx + 5, top - 1.5);
      ctx.closePath();
      ctx.fill();
      ellipse(ctx, cx, top - 3.2, 0.9, 0.9, "#e0574f");
    }
  }

  function drawCollar(ctx, cx, top, look) {
    ctx.fillStyle = "#f7f5f0";
    ctx.beginPath();
    ctx.moveTo(cx - 4, top);
    ctx.lineTo(cx, top + 3.9);
    ctx.lineTo(cx + 4, top);
    ctx.closePath();
    ctx.fill();
    if (look.tie) {
      ctx.fillStyle = look.tie;
      ctx.beginPath();
      ctx.moveTo(cx - 1.2, top + 2.4);
      ctx.lineTo(cx + 1.2, top + 2.4);
      ctx.lineTo(cx + 1.8, top + 8.4);
      ctx.lineTo(cx, top + 9.9);
      ctx.lineTo(cx - 1.8, top + 8.4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Seated figure seen from the front in a 22x30 box; the desk covers the lower body.
  // pose: bob, dx (shake), typing/frame, blink, look, talk, stretch (0..1 arms up).
  function drawCharacter(ctx, x, y, look, pose = {}) {
    y += pose.bob || 0;
    x += pose.dx || 0;
    const cx = x + 11, cy = y + 9.5; // head center
    const shirt = look.shirt, sleeve = shade(shirt, -0.08);

    if (look.longHair) rect(ctx, x + 1.5, y + 3, 19, 21, 8, shade(look.hair, -0.18));

    // Raised arms go behind the head.
    if (pose.stretch) {
      const a = Math.PI * (1 - 0.2 * pose.stretch);
      for (const [sx, dir] of [[x + 4.5, 1], [x + 17.5, -1]]) {
        limb(ctx, sx, y + 20, 4.6, 13, a * dir, sleeve);
        const [hx, hy] = limbEnd(sx, y + 20, 13, a * dir);
        ellipse(ctx, hx, hy, 2.3, 2.3, look.skin);
      }
    }

    // Torso with a soft side shade, collar and optional tie.
    rect(ctx, x + 3, y + 17.5, 16, 14, [7, 7, 3, 3], shirt);
    rect(ctx, x + 13.5, y + 19, 5.5, 12, [0, 6, 3, 0], shade(shirt, -0.12));
    drawCollar(ctx, cx, y + 17.6, look);
    if (!pose.stretch) {
      rect(ctx, x + 0.5, y + 19.5, 5, 9.5, 2.5, sleeve);
      rect(ctx, x + 16.5, y + 19.5, 5, 9.5, 2.5, sleeve);
    }

    rect(ctx, cx - 2, y + 15, 4, 3.5, 1, shade(look.skin, -0.12));
    drawHead(ctx, cx, cy, look, pose);
  }

  // Standing or walking figure with its feet at (x, y).
  // pose: phase (walk cycle, radians), moving, carry (holding a paper), talk (0..1),
  // gesture (radians, an arm waving while talking), jump (units off the floor), look.
  function drawStanding(ctx, x, y, look, pose = {}) {
    const swing = pose.moving ? Math.sin(pose.phase || 0) : 0;
    const lift = pose.moving ? Math.abs(Math.sin(pose.phase || 0)) * 0.9 : 0;
    floorShadow(ctx, x, y + 0.5, Math.max(4, 7 - (pose.jump || 0) * 0.3), 1.8, 0.18);
    y -= lift + (pose.jump || 0);
    const shirt = look.shirt, sleeve = shade(shirt, -0.08), pants = look.pants || "#2a2a3a";

    // Legs and shoes.
    for (const [lx, a] of [[x - 2.2, swing * 0.45], [x + 2.2, -swing * 0.45]]) {
      limb(ctx, lx, y - 10, 3.6, 9, a, pants);
      const [fx, fy] = limbEnd(lx, y - 10, 9, a);
      ellipse(ctx, fx, fy, 2.4, 1.3, "#2b2d35");
    }

    if (look.longHair) rect(ctx, x - 9.5, y - 37, 19, 18, 8, shade(look.hair, -0.18));

    // Arms swing opposite the legs; the right one reaches forward to carry, waves to talk.
    const left = -swing * 0.5;
    const right = pose.carry ? 0.95 : pose.gesture !== undefined ? -1.5 - Math.sin(pose.gesture) * 0.45 : swing * 0.5;
    limb(ctx, x - 7.2, y - 20, 3.8, 10, -left, sleeve);
    rect(ctx, x - 7, y - 22, 14, 13, [6, 6, 3, 3], shirt);
    rect(ctx, x + 1.5, y - 20.5, 5.5, 11, [0, 5, 3, 0], shade(shirt, -0.12));
    drawCollar(ctx, x, y - 21.9, look);
    limb(ctx, x + 7.2, y - 20, 3.8, 10, right, sleeve);
    const [lhx, lhy] = limbEnd(x - 7.2, y - 20, 10, -left);
    ellipse(ctx, lhx, lhy, 2, 2, look.skin);
    const [rhx, rhy] = limbEnd(x + 7.2, y - 20, 10, right);
    if (pose.carry) {
      rect(ctx, rhx - 3.5, rhy - 7, 7, 9, 1, "#ffffff");
      for (let i = 0; i < 3; i++) rect(ctx, rhx - 2.3, rhy - 5.4 + i * 2, 4.6 - (i === 2 ? 1.6 : 0), 0.7, 0.35, "#a9acb8");
    }
    ellipse(ctx, rhx, rhy, 2, 2, look.skin);

    rect(ctx, x - 2, y - 25, 4, 3.5, 1, shade(look.skin, -0.12));
    drawHead(ctx, x, y - 32, look, pose);
  }

  // ---------- effects ----------

  // Thought cloud to the upper right of a head at (hx, hy), with dots that tick.
  function drawThought(ctx, hx, hy, t) {
    const x = hx + 13, y = hy - 13;
    ellipse(ctx, hx + 7, hy - 4, 1.1, 1.1, "#ffffff");
    ellipse(ctx, hx + 9.5, hy - 7.5, 1.7, 1.7, "#ffffff");
    [[0, 0, 6, 4.2], [-4, 1, 3.6, 3.2], [4.5, 1, 3.8, 3.2], [1, -2.5, 4, 3.2]].forEach(([dx, dy, rx, ry]) => ellipse(ctx, x + dx, y + dy, rx, ry, "#ffffff"));
    const lit = Math.floor(t / 320) % 4;
    for (let i = 0; i < 3; i++) ellipse(ctx, x - 3 + i * 3, y + 0.5, 0.85, 0.85, i < lit ? "#8b7cf6" : "#d7d9e2");
  }

  // Bits of work floating up off a monitor; a magnifier sweeps while searching.
  function drawWorkFx(ctx, cx, deskY, kind, t) {
    const color = kind === "search" ? "#5b7cfa" : "#2fae76";
    for (let i = 0; i < 3; i++) {
      const p = (t / 1500 + i / 3) % 1;
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.9;
      rect(ctx, cx + 13 + Math.sin(i * 2.1 + p * 5) * 4, deskY - 20 - p * 16, 4 - p * 1.5, 1.6, 0.8, color);
      ctx.restore();
    }
    if (kind === "search") {
      const mx = cx + 29 + Math.sin(t / 260) * 2.5, my = deskY - 21 + Math.cos(t / 260) * 1.5;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(mx + 2.2, my + 2.2);
      ctx.lineTo(mx + 5, my + 5);
      ctx.stroke();
      ellipse(ctx, mx, my, 3.4, 3.4, "rgba(255,255,255,0.9)");
      ctx.strokeStyle = "#5b7cfa";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(mx, my, 3.3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Red "!" badge over a head at (hx, hy).
  function drawAlert(ctx, hx, hy, t) {
    const y = hy - 15 - Math.abs(Math.sin(t / 180)) * 1.5;
    ellipse(ctx, hx, y, 4, 4, "#f0696c");
    rect(ctx, hx - 0.7, y - 2.5, 1.4, 3.2, 0.7, "#ffffff");
    ellipse(ctx, hx, y + 2, 0.75, 0.75, "#ffffff");
  }

  // Confetti pieces: { x, y, vx, vy, color, spin, born, life } (ms).
  function drawConfetti(ctx, bits, now) {
    bits.forEach((b) => {
      const age = (now - b.born) / 1000;
      const k = age / (b.life / 1000);
      if (k < 0 || k >= 1) return;
      ctx.save();
      ctx.globalAlpha = 1 - k * k;
      ctx.translate(b.x + b.vx * age, b.y + b.vy * age + 70 * age * age);
      ctx.rotate(b.spin * age);
      ctx.fillStyle = b.color;
      ctx.fillRect(-1.3, -0.75, 2.6, 1.5);
      ctx.restore();
    });
  }

  // ---------- furniture ----------

  function drawChair(ctx, cx, deskY) {
    rect(ctx, cx - 12.5, deskY - 25, 25, 23, 7, "#3a3e4b");
    rect(ctx, cx - 10, deskY - 23, 20, 3, 1.5, "rgba(255,255,255,0.1)");
  }

  function screenColor(screen, t) {
    if (screen === "on") return Math.floor(t / 180) % 2 ? "#4fb6ef" : "#47a9e2";
    if (screen === "think") return "#8b7cf6";
    if (screen === "done") return "#3fcf8e";
    if (screen === "error") return "#f0696c";
    return "#3a3f4c";
  }

  function drawDesk(ctx, cx, deskY, screen, t) {
    floorShadow(ctx, cx, deskY + 21, 30, 2.6);

    // Monitor on a stand, to the right of the keyboard.
    if (screen !== "off") {
      ctx.save();
      ctx.globalAlpha = 0.18;
      rect(ctx, cx + 4, deskY - 20, 28, 21, 6, screenColor(screen, t));
      ctx.restore();
    }
    rect(ctx, cx + 16.5, deskY - 3, 3, 3, 0.5, "#8f939f");
    rect(ctx, cx + 13.5, deskY - 1.2, 9, 1.4, 0.7, "#8f939f");
    rect(ctx, cx + 7, deskY - 17, 22, 15, 2, "#2b2e38");
    rect(ctx, cx + 8.2, deskY - 15.8, 19.6, 12.6, 1.2, screenColor(screen, t));
    if (screen === "on") {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (let i = 0; i < 4; i++) {
        const len = 3 + ((Math.floor(t / 120) + i * 3) % 11);
        ctx.beginPath();
        ctx.roundRect(cx + 10, deskY - 13.6 + i * 2.6, len, 1.1, 0.5);
        ctx.fill();
      }
    } else if (screen === "done") {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx + 14.5, deskY - 9.5);
      ctx.lineTo(cx + 17, deskY - 7);
      ctx.lineTo(cx + 21.5, deskY - 12);
      ctx.stroke();
    } else if (screen !== "off") {
      rect(ctx, cx + 8.2, deskY - 15.8, 19.6, 4, [1.2, 1.2, 0, 0], "rgba(255,255,255,0.18)");
    }

    // Desk: legs, front panel with drawers, top.
    rect(ctx, cx - 27, deskY + 14, 2.4, 7, 1, "#5b5f6b");
    rect(ctx, cx + 24.6, deskY + 14, 2.4, 7, 1, "#5b5f6b");
    rect(ctx, cx - 29, deskY + 2, 58, 14, [0, 0, 3, 3], "#c99a6a");
    rect(ctx, cx - 29, deskY + 2, 58, 2, 0, "rgba(0,0,0,0.12)");
    rect(ctx, cx + 4, deskY + 6, 21, 7.5, 1.5, "#d6aa7a");
    rect(ctx, cx + 12, deskY + 9.2, 5, 1.1, 0.5, "#a97a4c");
    rect(ctx, cx - 31, deskY - 1.5, 62, 4.5, 2, "#e8c9a0");
    rect(ctx, cx - 31, deskY - 1.5, 62, 1.3, [2, 2, 0, 0], "#f3dcbb");

    // Keyboard and mug.
    rect(ctx, cx - 10, deskY - 0.8, 17, 2.6, 1, "#f2f2f5");
    rect(ctx, cx - 9, deskY + 0.6, 15, 0.6, 0.3, "#c8cad3");
    rect(ctx, cx - 25.5, deskY - 6, 5.5, 6, [1, 1, 1.8, 1.8], "#ffffff");
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.arc(cx - 19.6, deskY - 3, 1.5, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    rect(ctx, cx - 25, deskY - 5.6, 4.5, 1.2, 0.5, "#7a5236");
  }

  function drawPlant(ctx, x, y) {
    floorShadow(ctx, x + 5, y + 14, 5.5, 1.3, 0.14);
    const leaves = [[2.5, 4, -0.5], [7.5, 3.5, 0.5], [5, 1.5, 0], [3.5, 6.5, -0.9], [7, 6, 0.9]];
    leaves.forEach(([lx, ly, a], i) => {
      ctx.fillStyle = i % 2 ? "#3aa86b" : "#4cc07f";
      ctx.beginPath();
      ctx.ellipse(x + lx, y + ly, 2.2, 3.8, a, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#e9e4dc";
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 7.5);
    ctx.lineTo(x + 9.5, y + 7.5);
    ctx.lineTo(x + 8.5, y + 14);
    ctx.lineTo(x + 1.5, y + 14);
    ctx.closePath();
    ctx.fill();
    rect(ctx, x, y + 7, 10, 1.6, 0.8, "#d6cfc4");
  }

  function drawWindow(ctx, x, y, w, h, t) {
    rect(ctx, x - 1, y - 1, w + 2, h + 2, 2.5, "#ffffff");
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#9fcdf5");
    g.addColorStop(1, "#d7ecfb");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 1.5);
    ctx.fill();
    // A cloud drifting across.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const cxCloud = x - 8 + ((t / 90) % (w + 16));
    ellipse(ctx, cxCloud, y + h * 0.4, 4, 1.6, "rgba(255,255,255,0.9)");
    ellipse(ctx, cxCloud + 2.5, y + h * 0.4 - 1.2, 2.4, 1.6, "rgba(255,255,255,0.9)");
    ctx.restore();
    rect(ctx, x + w / 2 - 0.5, y, 1, h, 0, "#ffffff");
  }

  // The room's door to the corridor; open while someone passes through.
  function drawDoor(ctx, x, y, open) {
    rect(ctx, x - 1, y - 1, 15, 25, [2, 2, 0, 0], "#ffffff");
    if (open) {
      rect(ctx, x, y, 13, 24, [1.5, 1.5, 0, 0], "#2b2d35");
      rect(ctx, x, y, 3.5, 24, [1.5, 0, 0, 0], "#b98a5c");
    } else {
      rect(ctx, x, y, 13, 24, [1.5, 1.5, 0, 0], "#c99a6a");
      rect(ctx, x + 2, y + 2.5, 9, 8, 1, "#d6aa7a");
      rect(ctx, x + 2, y + 13, 9, 8.5, 1, "#d6aa7a");
      ellipse(ctx, x + 10.5, y + 12.5, 0.9, 0.9, "#f5c443");
    }
  }

  function drawBoard(ctx, x, y, notes) {
    rect(ctx, x, y, 32, 18, 2, "#ffffff");
    rect(ctx, x, y + 16.5, 32, 1.5, [0, 0, 2, 2], "#dcdde3");
    (notes || []).forEach((color, i) => rect(ctx, x + 3 + (i % 4) * 7, y + 2.5 + Math.floor(i / 4) * 4.6, 5, 3.6, 0.6, color));
    if (!(notes || []).length) {
      [[4, 5, 18], [4, 8.5, 12], [4, 12, 15]].forEach(([dx, dy, len]) => rect(ctx, x + dx, y + dy, len, 1, 0.5, "#d2d4dc"));
    }
  }

  function drawShelf(ctx, x, y) {
    rect(ctx, x, y, 20, 20, 1.5, "#d9c2a3");
    const books = ["#e0574f", "#5b7cfa", "#f5c443", "#2fae76", "#9468ee", "#2aa9c4"];
    for (let row = 0; row < 2; row++) {
      const by = y + 2 + row * 9.5;
      for (let i = 0; i < 5; i++) {
        const tall = 6.5 - (i % 2) * 1.2;
        rect(ctx, x + 2 + i * 3.3, by + (7 - tall), 2.7, tall, 0.5, books[(i + row * 2) % books.length]);
      }
      rect(ctx, x + 1, by + 7, 18, 1.2, 0.4, "#b99a74");
    }
  }

  function drawClock(ctx, x, y, t) {
    const cx = x + 4.5, cy = y + 4.5;
    ellipse(ctx, cx, cy, 5, 5, "#ffffff");
    ctx.strokeStyle = "#dcdde3";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(cx, cy, 4.6, 0, Math.PI * 2);
    ctx.stroke();
    const a = ((t / 1000) % 60) / 60 * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - 2.8);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * 3.6, cy + Math.sin(a) * 3.6);
    ctx.stroke();
  }

  // ---------- rooms and floors ----------

  // room.doorOpen: someone is passing through.
  function drawRoom(ctx, room, t, notes) {
    const { x, y, w, h } = room;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.clip();
    // Wall: tint, accent stripe under the ceiling, shelf, door, window, board.
    ctx.fillStyle = room.wall;
    ctx.fillRect(x, y, w, 36);
    ctx.fillStyle = room.trim;
    ctx.fillRect(x, y, w, 2.5);
    drawShelf(ctx, x + 7, y + 10);
    drawDoor(ctx, x + 30, y + 12, room.doorOpen);
    const wide = w >= 200;
    const winW = wide ? 46 : 30;
    drawWindow(ctx, Math.round(x + w / 2 - winW / 2) + (wide ? 0 : 1), y + 9, winW, 18, t);
    drawBoard(ctx, x + w - (wide ? 56 : 40), y + 10, notes);
    if (wide) drawClock(ctx, x + w - 17, y + 13, t);
    // Floor, a rug, and the line where wall meets floor.
    vertical(ctx, x, y + 36, w, h - 36, room.floor[0], room.floor[1]);
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    ctx.fillRect(x, y + 36, w, 1.5);
    rect(ctx, x + 10, y + 46, w - 20, h - 58, 8, mix(room.trim, room.floor[1], 0.84));
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.roundRect(x + 13, y + 49, w - 26, h - 64, 6);
    ctx.stroke();
    drawPlant(ctx, x + 4, y + h - 18);
    drawPlant(ctx, x + w - 14, y + h - 18);
    ctx.restore();
  }

  function drawEmptyRoom(ctx, room, t) {
    const { x, y, w, h } = room;
    rect(ctx, x, y, w, h, 6, "#17181e");
    ctx.save();
    ctx.strokeStyle = "#3a3d4a";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.lineDashOffset = -Math.floor(t / 120) % 7;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6);
    ctx.stroke();
    ctx.restore(); // the "+ 팀원 추가" label sits in the middle (office.js overlay)
  }

  function drawLobby(ctx, W, t, kanban) {
    // Wall and wood floor.
    vertical(ctx, 0, 0, W, 20, "#f3eee7", "#ebe4da");
    ctx.fillStyle = "#f5c443";
    ctx.fillRect(0, 0, W, 2.5);
    vertical(ctx, 0, 20, W, 60, "#e3cfb3", "#d7bf9f");
    ctx.fillStyle = "rgba(120,90,60,0.08)";
    for (let yy = 26; yy < 80; yy += 9) ctx.fillRect(0, yy, W, 0.8);
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0, 20, W, 1.5);

    // Windows between the manager's desk and the board.
    const wx = Math.round(W / 2 - 40);
    drawWindow(ctx, wx, 4, 34, 12, t);
    drawWindow(ctx, wx + 46, 4, 34, 12, t);

    // Collaboration table with six chairs, centered.
    const tx = tableX(W);
    floorShadow(ctx, tx + 45, 63, 50, 4);
    for (let i = 0; i < 3; i++) rect(ctx, tx + 10 + i * 26, 30, 15, 10, 4, "#3a3e4b");
    rect(ctx, tx, 37, 90, 22, 6, "#c99a6a");
    rect(ctx, tx, 37, 90, 19, 6, "#e3bf92");
    rect(ctx, tx + 4, 39, 82, 1.5, 0.75, "rgba(255,255,255,0.35)");
    for (let i = 0; i < 3; i++) rect(ctx, tx + 10 + i * 26, 57, 15, 9, 4, "#454a58");

    // Kanban board on the wall: todo / doing / done.
    const kx = W - 90;
    rect(ctx, kx, 2, 82, 16, 2, "#ffffff");
    ["todo", "doing", "done"].forEach((col, ci) => {
      if (ci) rect(ctx, kx + ci * 27, 4, 0.8, 12, 0, "#e3e4ea");
      (kanban[col] || []).forEach((color, i) => rect(ctx, kx + 3 + ci * 27 + (i % 3) * 8, 4.5 + Math.floor(i / 3) * 4.6, 6, 3.6, 0.6, color));
    });
    drawPlant(ctx, W - 112, 62);
    drawPlant(ctx, W - 16, 62);
    drawPlant(ctx, 6, 62);
  }

  function drawCorridor(ctx, W, H) {
    ctx.fillStyle = "#1c1d24";
    ctx.fillRect(0, 80, W, 8);
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, ROOM_Y, W, H - ROOM_Y); // gaps between rows of rooms
  }

  function drawPaper(ctx, x, y) {
    rect(ctx, x - 0.5, y + 0.5, 9, 11, 1.2, "rgba(0,0,0,0.18)");
    rect(ctx, x - 1, y - 1, 9, 11, 1.2, "#ffffff");
    for (let i = 0; i < 3; i++) rect(ctx, x + 0.8, y + 1.8 + i * 2.2, 5.4 - (i === 2 ? 2 : 0), 0.8, 0.4, "#a9acb8");
  }

  // ---------- workstations ----------

  function workstation(cx, deskY) {
    return { cx, deskY, headX: cx - 12, headY: deskY - 26 };
  }

  function deskAnchor(room, slot = 0) {
    return workstation(room.x + ROOM_PAD + slot * DESK_GAP + DESK_GAP / 2, room.y + 92);
  }

  // Area covered by a seated character with chair and desk (for hit tests).
  function workstationBounds(anchor) {
    return { x: anchor.cx - 31, y: anchor.deskY - 30, w: 62, h: 52 };
  }

  const MANAGER = workstation(56, 50);

  // Chair, seated character and desk, anchored on the desk's top-center.
  // look null: the seat is empty (dragged away, or out walking).
  // pose.fx: "think" | "work" | "search" | "error" adds the matching effect.
  function drawWorkstation(ctx, anchor, look, pose, screen, t) {
    drawChair(ctx, anchor.cx, anchor.deskY);
    if (look) drawCharacter(ctx, anchor.cx - 11, anchor.deskY - 26, look, pose);
    drawDesk(ctx, anchor.cx, anchor.deskY, screen, t);
    if (!look) return;
    if (!pose.stretch) {
      // Hands rest on the desk top, in front of it; they tap while typing.
      const lift = (side) => (pose.typing && pose.frame % 2 === side ? 1.2 : 0);
      const dx = pose.dx || 0;
      ellipse(ctx, anchor.cx - 8 + dx, anchor.deskY - 0.2 - lift(0), 2.2, 1.6, look.skin);
      ellipse(ctx, anchor.cx + 5 + dx, anchor.deskY - 0.2 - lift(1), 2.2, 1.6, look.skin);
    }
    const hx = anchor.cx + (pose.dx || 0), hy = anchor.deskY - 16.5 + (pose.bob || 0);
    if (pose.fx === "think") drawThought(ctx, hx, hy, t);
    else if (pose.fx === "work" || pose.fx === "search") drawWorkFx(ctx, anchor.cx, anchor.deskY, pose.fx, t);
    else if (pose.fx === "error") drawAlert(ctx, hx, hy, t);
  }

  function drawGhost(ctx, x, y, look) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    drawCharacter(ctx, x - 11, y - 15, look);
    ctx.restore();
  }

  function highlight(ctx, rect_, color) {
    ctx.save();
    ctx.globalAlpha = 0.18;
    rect(ctx, rect_.x, rect_.y, rect_.w, rect_.h, 5, color);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(rect_.x + 0.6, rect_.y + 0.6, rect_.w - 1.2, rect_.h - 1.2, 5);
    ctx.stroke();
    ctx.restore();
  }

  window.Pixel = {
    LOOKS, MANAGER_LOOK, MANAGER, MANAGER_ZONE, CORRIDOR_Y, REPORT_SPOT,
    layout, deskAnchor, workstationBounds, doorOf, meetingSpots,
    drawWorkstation, drawStanding, drawConfetti,
    drawRoom, drawEmptyRoom, drawLobby, drawCorridor, drawPaper, drawGhost, highlight,
  };
})();
