// Procedural pixel art for the office. The logical canvas grows with the team:
// one room per team (one desk per member) under the lobby, wrapping into rows.
// office.js scales the context to the device's pixel density, so one logical
// pixel stays a crisp square on screen.
(() => {
  const MIN_W = 384, H = 232; // H: height with one row of rooms
  const ROOM_GAP = 6, ROOM_Y = 88, ROOM_H = 136, ROOM_PAD = 8, DESK_GAP = 104;
  const ROW_MAX = 624; // five single-desk rooms
  const OUT = "#16131d"; // outline

  const PALETTES = [
    { floor: ["#2a3a5c", "#30436a"], wall: "#1c2742", trim: "#4a7ae0" },
    { floor: ["#3d2d55", "#463463"], wall: "#2a1f3d", trim: "#a066e0" },
    { floor: ["#234a36", "#295540"], wall: "#183322", trim: "#46c27a" },
    { floor: ["#4d3626", "#5a402d"], wall: "#33241a", trim: "#e0904a" },
    { floor: ["#22454f", "#28515c"], wall: "#173138", trim: "#46c3e0" },
  ];

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

  // ---------- primitives ----------

  function px(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // Rectangle with the four corner pixels cut, the basic pixel-art "rounded" box.
  function rr(ctx, x, y, w, h, color) {
    px(ctx, x + 1, y, w - 2, h, color);
    px(ctx, x, y + 1, w, h - 2, color);
  }

  // Outlined box: a 1px OUT border around a filled body.
  function box(ctx, x, y, w, h, fill) {
    rr(ctx, x, y, w, h, OUT);
    rr(ctx, x + 1, y + 1, w - 2, h - 2, fill);
  }

  // amt > 0 lightens toward white, amt < 0 darkens toward black.
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  function checker(ctx, x, y, w, h, colors, size = 8) {
    for (let yy = 0; yy < h; yy += size) {
      for (let xx = 0; xx < w; xx += size) {
        px(ctx, x + xx, y + yy, Math.min(size, w - xx), Math.min(size, h - yy), colors[((xx + yy) / size) % 2]);
      }
    }
  }

  // ---------- characters ----------

  // 22x30 chibi seen from the front; the desk covers the lower body.
  function drawCharacter(ctx, x, y, look, pose = {}) {
    y += pose.bob ? Math.round(pose.bob) : 0;
    const hair = look.hair, hairHi = shade(hair, 0.35), hairLo = shade(hair, -0.3);
    const skin = look.skin, skinLo = shade(skin, -0.14);
    const shirt = look.shirt, shirtLo = shade(shirt, -0.28), shirtHi = shade(shirt, 0.22);

    if (look.longHair) box(ctx, x + 1, y + 4, 20, 21, hairLo);

    // Torso, collar, tie.
    box(ctx, x + 3, y + 18, 16, 13, shirt);
    px(ctx, x + 15, y + 20, 3, 10, shirtLo);
    px(ctx, x + 5, y + 20, 1, 8, shirtHi);
    px(ctx, x + 8, y + 19, 6, 1, "#f4f1ea");
    px(ctx, x + 8, y + 20, 1, 1, "#f4f1ea");
    px(ctx, x + 13, y + 20, 1, 1, "#f4f1ea");
    if (look.tie) {
      px(ctx, x + 10, y + 20, 2, 2, look.tie);
      px(ctx, x + 10, y + 22, 2, 5, shade(look.tie, -0.2));
    }

    // Arms down the sides; hands alternate on the keyboard while typing.
    box(ctx, x, y + 20, 5, 9, shirtLo);
    box(ctx, x + 17, y + 20, 5, 9, shirtLo);
    const left = pose.typing && pose.frame % 2 === 0 ? 25 : 27;
    const right = pose.typing && pose.frame % 2 === 1 ? 25 : 27;
    box(ctx, x + 1, y + left, 4, 4, skin);
    box(ctx, x + 17, y + right, 4, 4, skin);

    // Neck and head.
    px(ctx, x + 9, y + 17, 4, 2, skinLo);
    box(ctx, x + 2, y + 1, 18, 18, skin);
    px(ctx, x + 4, y + 16, 14, 1, skinLo);

    // Hair: cap, highlight, fringe, side locks.
    rr(ctx, x + 2, y, 18, 9, OUT);
    rr(ctx, x + 3, y + 1, 16, 7, hair);
    px(ctx, x + 3, y + 8, 16, 1, hair);
    px(ctx, x + 4, y + 9, 3, 1, hair);
    px(ctx, x + 9, y + 9, 2, 1, hair);
    px(ctx, x + 14, y + 9, 3, 1, hair);
    px(ctx, x + 6, y + 2, 5, 1, hairHi);
    px(ctx, x + 5, y + 3, 2, 1, hairHi);
    const lock = look.longHair ? 11 : 5;
    px(ctx, x + 3, y + 8, 2, lock, hair);
    px(ctx, x + 17, y + 8, 2, lock, hair);

    // Face.
    if (pose.blink) {
      px(ctx, x + 6, y + 13, 3, 1, "#2a2238");
      px(ctx, x + 13, y + 13, 3, 1, "#2a2238");
    } else {
      px(ctx, x + 6, y + 11, 3, 3, "#2a2238");
      px(ctx, x + 13, y + 11, 3, 3, "#2a2238");
      px(ctx, x + 6, y + 11, 1, 1, "#ffffff");
      px(ctx, x + 13, y + 11, 1, 1, "#ffffff");
    }
    px(ctx, x + 4, y + 14, 2, 1, "#f4a3a3");
    px(ctx, x + 16, y + 14, 2, 1, "#f4a3a3");
    px(ctx, x + 10, y + 15, 2, 1, "#a0524a");

    if (look.crown) {
      rr(ctx, x + 5, y - 7, 12, 6, OUT);
      px(ctx, x + 6, y - 4, 10, 2, "#ffd36b");
      px(ctx, x + 6, y - 6, 2, 2, "#ffd36b");
      px(ctx, x + 10, y - 6, 2, 2, "#ffd36b");
      px(ctx, x + 14, y - 6, 2, 2, "#ffd36b");
      px(ctx, x + 10, y - 4, 2, 1, "#d64545");
      px(ctx, x + 6, y - 4, 10, 1, "#ffe8a3");
    }
  }

  // ---------- furniture ----------

  function drawChair(ctx, cx, deskY) {
    box(ctx, cx - 13, deskY - 24, 26, 20, "#5d4a42");
    px(ctx, cx - 11, deskY - 22, 22, 2, "#6e5850");
  }

  function screenColor(screen, t) {
    if (screen === "on") return Math.floor(t / 180) % 2 ? "#59d0ff" : "#4ab8e8";
    if (screen === "think") return "#7a6cff";
    if (screen === "done") return "#4fd18b";
    if (screen === "error") return "#ff6b6b";
    return "#262b38";
  }

  function drawDesk(ctx, cx, deskY, screen, t) {
    // Monitor (facing the viewer) on the right of the desk.
    box(ctx, cx + 7, deskY - 17, 22, 16, "#2b2838");
    px(ctx, cx + 9, deskY - 15, 18, 11, screenColor(screen, t));
    if (screen === "on") {
      for (let i = 0; i < 4; i++) px(ctx, cx + 11, deskY - 13 + i * 2, 3 + ((Math.floor(t / 120) + i * 3) % 11), 1, "#e8f7ff");
    } else if (screen !== "off") {
      px(ctx, cx + 9, deskY - 15, 18, 1, "rgba(255,255,255,0.35)");
    }
    px(ctx, cx + 16, deskY - 2, 4, 2, OUT);

    // Desk body: top surface, front panels with drawers, legs, shadow.
    px(ctx, cx - 28, deskY + 20, 56, 2, "rgba(0,0,0,0.28)");
    px(ctx, cx - 28, deskY + 15, 3, 6, OUT);
    px(ctx, cx + 25, deskY + 15, 3, 6, OUT);
    box(ctx, cx - 30, deskY - 1, 60, 18, "#b07a45");
    px(ctx, cx - 29, deskY, 58, 4, "#e0b077");
    px(ctx, cx - 29, deskY, 58, 1, "#f2cc94");
    px(ctx, cx - 29, deskY + 4, 58, 1, "#8a5c33");
    px(ctx, cx - 25, deskY + 6, 21, 8, "#9a6a3a");
    px(ctx, cx + 4, deskY + 6, 21, 8, "#9a6a3a");
    px(ctx, cx - 17, deskY + 9, 5, 1, "#e0b077");
    px(ctx, cx + 12, deskY + 9, 5, 1, "#e0b077");

    // Keyboard and mug on the desk top.
    px(ctx, cx - 9, deskY + 1, 16, 2, "#ece8f4");
    px(ctx, cx - 9, deskY + 2, 16, 1, "#c4bed4");
    box(ctx, cx - 25, deskY - 5, 6, 6, "#f4f1ea");
    px(ctx, cx - 24, deskY - 4, 4, 1, "#6b4a2e");
  }

  function drawPlant(ctx, x, y) {
    px(ctx, x + 4, y, 2, 3, "#2f8f55");
    box(ctx, x + 1, y + 1, 4, 6, "#46c27a");
    box(ctx, x + 5, y + 2, 5, 5, "#3fae6a");
    px(ctx, x + 2, y + 2, 1, 2, "#7ee0a4");
    box(ctx, x, y + 7, 10, 7, "#c97448");
    px(ctx, x + 1, y + 8, 8, 1, "#e08a5a");
  }

  function drawWindows(ctx, x, y, panes, t) {
    for (let i = 0; i < panes; i++) {
      const wx = x + i * 16;
      box(ctx, wx, y, 15, 13, "#6d8fc6");
      px(ctx, wx + 1, y + 1, 13, 5, "#8fb0e0");
      px(ctx, wx + 7, y + 1, 1, 11, OUT);
      px(ctx, wx + 1, y + 6, 13, 1, OUT);
      const cloud = (Math.floor(t / 500) + i * 5) % 16;
      if (cloud < 11) px(ctx, wx + 1 + cloud, y + 3, 3, 1, "#eef4ff");
    }
  }

  function drawBoard(ctx, x, y, notes) {
    box(ctx, x, y, 30, 17, "#f6f3ea");
    px(ctx, x + 2, y + 14, 26, 1, "#c8c2b4");
    (notes || []).forEach((color, i) => px(ctx, x + 3 + (i % 4) * 6, y + 3 + Math.floor(i / 4) * 5, 4, 4, color));
  }

  function drawShelf(ctx, x, y) {
    box(ctx, x, y, 18, 20, "#6e4a2c");
    const books = ["#d64545", "#3d6bd6", "#ffd36b", "#3fae6a", "#9a5bd6"];
    for (let row = 0; row < 2; row++) {
      px(ctx, x + 1, y + 9 + row * 9, 16, 1, OUT);
      for (let i = 0; i < 5; i++) px(ctx, x + 2 + i * 3, y + 2 + row * 9 + (i % 2), 2, 7 - (i % 2), books[(i + row * 2) % books.length]);
    }
  }

  function drawClock(ctx, x, y, t) {
    box(ctx, x, y, 9, 9, "#f4f1ea");
    px(ctx, x + 4, y + 2, 1, 3, OUT);
    const tick = Math.floor(t / 1000) % 4;
    const hand = [[5, 4, 2, 1], [4, 5, 1, 2], [2, 4, 2, 1], [4, 2, 1, 2]][tick];
    px(ctx, x + hand[0], y + hand[1], hand[2], hand[3], "#d64545");
  }

  // Pennant string along a wall.
  function drawBunting(ctx, x, y, w, color) {
    px(ctx, x, y, w, 1, "rgba(255,255,255,0.18)");
    const colors = [color, shade(color, -0.4)];
    for (let i = 2, n = 0; i + 5 < w; i += 9, n++) {
      const c = colors[n % 2];
      px(ctx, x + i, y + 1, 5, 1, c);
      px(ctx, x + i + 1, y + 2, 3, 1, c);
      px(ctx, x + i + 2, y + 3, 1, 1, c);
    }
  }

  // ---------- rooms and floors ----------

  function drawRoom(ctx, room, t, notes) {
    const { x, y, w, h } = room;
    px(ctx, x - 1, y - 1, w + 2, h + 2, OUT);
    // Wall with pennants, shelf, windows, whiteboard and clock.
    px(ctx, x + 1, y + 1, w - 2, 35, room.wall);
    px(ctx, x + 1, y + 34, w - 2, 2, room.trim);
    px(ctx, x + 1, y + 36, w - 2, 1, OUT);
    drawBunting(ctx, x + 4, y + 3, w - 8, room.trim);
    drawShelf(ctx, x + 6, y + 11);
    const panes = w >= 200 ? 3 : 2;
    drawWindows(ctx, Math.round(x + w / 2 - (panes * 16 - 1) / 2) - (w >= 200 ? 0 : 6), y + 13, panes, t);
    drawBoard(ctx, x + w - (w >= 200 ? 52 : 38), y + 12, notes);
    if (w >= 200) drawClock(ctx, x + w - 16, y + 16, t);
    // Floor with an inset carpet.
    px(ctx, x + 1, y + 37, w - 2, h - 38, room.floor[0]);
    const cw = w - 14, ch = h - 52;
    rr(ctx, x + 7, y + 42, cw, ch, shade(room.floor[1], 0.18));
    checker(ctx, x + 8, y + 43, cw - 2, ch - 2, [room.floor[1], shade(room.floor[1], -0.08)], 6);
    drawPlant(ctx, x + 4, y + h - 17);
    drawPlant(ctx, x + w - 14, y + h - 17);
  }

  function drawEmptyRoom(ctx, room, t) {
    const { x, y, w, h } = room;
    px(ctx, x, y, w, h, "#1f1c29");
    const dash = Math.floor(t / 200) % 2;
    for (let i = dash; i < w; i += 4) {
      px(ctx, x + i, y, 2, 1, "#6b6582");
      px(ctx, x + i, y + h - 1, 2, 1, "#6b6582");
    }
    for (let i = dash; i < h; i += 4) {
      px(ctx, x, y + i, 1, 2, "#6b6582");
      px(ctx, x + w - 1, y + i, 1, 2, "#6b6582");
    }
    const cx = x + w / 2, cy = y + h / 2;
    rr(ctx, cx - 10, cy - 3, 20, 6, "#8a84a6");
    rr(ctx, cx - 3, cy - 10, 6, 20, "#8a84a6");
  }

  function drawLobby(ctx, W, t, kanban) {
    checker(ctx, 0, 20, W, 60, ["#3d302a", "#44362f"]);
    px(ctx, 0, 0, W, 18, "#2a2230");
    px(ctx, 0, 18, W, 2, "#ffd36b");
    drawBunting(ctx, 130, 3, W - 230, "#ffd36b");

    // Collaboration table with six chairs, centered.
    const tx = Math.round((W - 88) / 2) + 4;
    for (let i = 0; i < 3; i++) {
      box(ctx, tx + 10 + i * 26, 31, 14, 8, "#7a5a42");
      box(ctx, tx + 10 + i * 26, 57, 14, 8, "#7a5a42");
    }
    px(ctx, tx + 2, 60, 86, 2, "rgba(0,0,0,0.25)");
    box(ctx, tx, 37, 90, 22, "#d8a46a");
    px(ctx, tx + 2, 39, 86, 2, "#ecc088");
    px(ctx, tx + 2, 55, 86, 2, "#b8844e");

    // Kanban board on the wall: todo / doing / done.
    const kx = W - 90;
    box(ctx, kx, 1, 82, 16, "#f6f3ea");
    ["todo", "doing", "done"].forEach((col, ci) => {
      if (ci) px(ctx, kx + ci * 27, 2, 1, 14, "#d9d4c7");
      (kanban[col] || []).forEach((color, i) => px(ctx, kx + 3 + ci * 27 + (i % 3) * 8, 4 + Math.floor(i / 3) * 5, 6, 4, color));
    });
    drawPlant(ctx, W - 112, 62);
    drawPlant(ctx, W - 16, 62);
    drawPlant(ctx, 6, 62);
  }

  function drawCorridor(ctx, W, H) {
    px(ctx, 0, 80, W, 8, "#3a3242");
    for (let x = 4; x < W; x += 16) px(ctx, x, 83, 8, 2, "#4a4154");
    px(ctx, 0, ROOM_Y, W, H - ROOM_Y, "#0c0b11"); // gaps between rows of rooms
  }

  function drawPaper(ctx, x, y) {
    box(ctx, x - 1, y - 1, 9, 11, "#fffdf5");
    for (let i = 0; i < 3; i++) px(ctx, x + 1, y + 2 + i * 2, 5, 1, "#9a93b3");
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
  function drawWorkstation(ctx, anchor, look, pose, screen, t) {
    drawChair(ctx, anchor.cx, anchor.deskY);
    if (look) drawCharacter(ctx, anchor.cx - 11, anchor.deskY - 26, look, pose); // null: seat empty while dragging
    drawDesk(ctx, anchor.cx, anchor.deskY, screen, t);
  }

  function drawGhost(ctx, x, y, look) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    drawCharacter(ctx, Math.round(x) - 11, Math.round(y) - 15, look);
    ctx.restore();
  }

  function highlight(ctx, rect, color) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    px(ctx, rect.x, rect.y, rect.w, rect.h, color);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    ctx.restore();
  }

  window.Pixel = {
    LOOKS, MANAGER_LOOK, MANAGER, MANAGER_ZONE,
    layout, deskAnchor, workstationBounds,
    drawWorkstation, drawRoom, drawEmptyRoom, drawLobby, drawCorridor, drawPaper, drawGhost, highlight,
  };
})();
