// Procedural pixel art for the office. Everything is drawn in a 384x208 logical canvas.
(() => {
  const W = 384, H = 232;
  const SCALE = 2; // characters and desks are drawn at 2x

  // 12x16 seated character. h hair, s skin, e eye, m mouth, b shirt, t tie, p pants.
  const BODY = [
    "...hhhhhh...",
    "..hhhhhhhh..",
    ".hhhhhhhhhh.",
    ".hhsssssshh.",
    ".hssssssssh.",
    ".hssessessh.",
    "..ssssssss..",
    "..sssmmsss..",
    "....ssss....",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "..pppppppp..",
    "..pp....pp..",
  ];
  const TIE_ROWS = { 9: [5, 6], 10: [5, 6], 11: [5, 6] };

  const ROOMS = [
    { floor: ["#24324f", "#2a3a5c"], wall: "#18223a", trim: "#3d6bd6" },
    { floor: ["#3a2a4f", "#43305c"], wall: "#2a1e3a", trim: "#9a5bd6" },
    { floor: ["#20402f", "#264a37"], wall: "#17301f", trim: "#3fae6a" },
  ];
  ROOMS.forEach((room, i) => Object.assign(room, { x: 6 + i * 126, y: 88, w: 120, h: 136 }));

  const LOOKS = [
    { hair: "#2b1d14", skin: "#f2c9a0", shirt: "#3d6bd6", pants: "#2a2a3a", longHair: true },
    { hair: "#d9a441", skin: "#e8b48a", shirt: "#9a5bd6", pants: "#2f2a3a" },
    { hair: "#6b3b2a", skin: "#c98f68", shirt: "#3fae6a", pants: "#26302a", longHair: true },
  ];
  const MANAGER_LOOK = { hair: "#1d1a26", skin: "#f0c49a", shirt: "#2f2f3f", pants: "#1d1d29", tie: "#d64545", crown: true };

  function px(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function drawCharacter(ctx, x, y, look, pose) {
    const bob = pose.bob ? Math.round(pose.bob) : 0;
    const colors = { h: look.hair, s: look.skin, e: "#1d1a26", m: "#b8705c", b: look.shirt, p: look.pants };
    BODY.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        let key = row[c];
        if (key === ".") {
          if (look.longHair && r >= 4 && r <= 9 && (c === 1 || c === 10)) key = "h";
          else continue;
        }
        let color = colors[key];
        if (look.tie && TIE_ROWS[r] && TIE_ROWS[r].includes(c)) color = look.tie;
        px(ctx, x + c, y + r + bob, 1, 1, color);
      }
    });
    if (pose.blink) {
      px(ctx, x + 4, y + 5 + bob, 1, 1, look.skin);
      px(ctx, x + 7, y + 5 + bob, 1, 1, look.skin);
    }
    // Hands: alternate while typing.
    const left = pose.typing && pose.frame % 2 === 0 ? 11 : 12;
    const right = pose.typing && pose.frame % 2 === 1 ? 11 : 12;
    px(ctx, x, y + left + bob, 1, 1, look.skin);
    px(ctx, x + 11, y + right + bob, 1, 1, look.skin);
    if (look.crown) {
      px(ctx, x + 3, y - 3 + bob, 6, 2, "#ffd36b");
      px(ctx, x + 3, y - 4 + bob, 1, 1, "#ffd36b");
      px(ctx, x + 5, y - 5 + bob, 2, 2, "#ffd36b");
      px(ctx, x + 8, y - 4 + bob, 1, 1, "#ffd36b");
      px(ctx, x + 5, y - 3 + bob, 2, 1, "#d64545");
    }
  }

  function drawChair(ctx, cx, y) {
    px(ctx, cx - 8, y - 18, 16, 14, "#4a3b35");
    px(ctx, cx - 7, y - 17, 14, 12, "#5d4a42");
  }

  function drawDesk(ctx, cx, y, screen, t) {
    px(ctx, cx - 22, y, 44, 4, "#c8945a");
    px(ctx, cx - 22, y + 4, 44, 9, "#9c6b3c");
    px(ctx, cx - 20, y + 6, 18, 5, "#8a5c33");
    px(ctx, cx - 21, y + 13, 3, 4, "#5e4027");
    px(ctx, cx + 18, y + 13, 3, 4, "#5e4027");
    // Monitor on the right side of the desk.
    px(ctx, cx + 6, y - 11, 15, 11, "#1b1b24");
    let glow = "#2a3140";
    if (screen === "on") glow = (Math.floor(t / 180) % 2) ? "#59d0ff" : "#4ab8e8";
    if (screen === "think") glow = "#7a6cff";
    if (screen === "done") glow = "#4fd18b";
    if (screen === "error") glow = "#ff6b6b";
    px(ctx, cx + 7, y - 10, 13, 8, glow);
    if (screen === "on") {
      for (let i = 0; i < 3; i++) px(ctx, cx + 9, y - 9 + i * 2, 4 + ((Math.floor(t / 120) + i * 3) % 7), 1, "#e8f7ff");
    }
    px(ctx, cx + 12, y - 1, 3, 1, "#1b1b24");
    // Keyboard and mug.
    px(ctx, cx - 9, y + 1, 12, 2, "#e8e4f0");
    px(ctx, cx - 18, y - 3, 4, 4, "#f2f2f2");
    px(ctx, cx - 17, y - 3, 2, 1, "#6b4a2e");
  }

  function drawPlant(ctx, x, y) {
    px(ctx, x + 1, y + 7, 6, 5, "#b0603c");
    px(ctx, x, y + 6, 8, 2, "#c97448");
    px(ctx, x + 2, y, 4, 7, "#3fae6a");
    px(ctx, x, y + 2, 3, 3, "#2f8f55");
    px(ctx, x + 5, y + 1, 3, 3, "#2f8f55");
  }

  function drawWindow(ctx, x, y, t) {
    px(ctx, x, y, 22, 14, "#0e1424");
    px(ctx, x + 1, y + 1, 20, 12, "#3b5b8f");
    px(ctx, x + 1, y + 9, 20, 4, "#2b4470");
    px(ctx, x + 10, y + 1, 2, 12, "#0e1424");
    const cloud = (Math.floor(t / 400) % 24) - 4;
    px(ctx, x + 1 + Math.max(0, cloud), y + 3, Math.min(5, 20 - Math.max(0, cloud)), 2, "#c9d8f0");
  }

  function drawBoard(ctx, x, y, notes) {
    px(ctx, x, y, 30, 16, "#d9d4c7");
    px(ctx, x + 1, y + 1, 28, 14, "#f6f3ea");
    (notes || []).forEach((color, i) => px(ctx, x + 3 + (i % 4) * 6, y + 3 + Math.floor(i / 4) * 6, 4, 4, color));
  }

  function drawShelf(ctx, x, y) {
    px(ctx, x, y, 16, 20, "#5e4027");
    const books = ["#d64545", "#3d6bd6", "#ffd36b", "#3fae6a", "#9a5bd6"];
    for (let row = 0; row < 2; row++) {
      px(ctx, x + 1, y + 9 + row * 9, 14, 1, "#3f2a19");
      for (let i = 0; i < 4; i++) px(ctx, x + 2 + i * 3, y + 2 + row * 9, 2, 7, books[(i + row * 2) % books.length]);
    }
  }

  function checker(ctx, x, y, w, h, colors, size = 8) {
    for (let yy = 0; yy < h; yy += size) {
      for (let xx = 0; xx < w; xx += size) {
        px(ctx, x + xx, y + yy, Math.min(size, w - xx), Math.min(size, h - yy), colors[((xx + yy) / size) % 2]);
      }
    }
  }

  function drawRoom(ctx, room, t, notes) {
    checker(ctx, room.x, room.y, room.w, room.h, room.floor);
    px(ctx, room.x, room.y, room.w, 30, room.wall);
    px(ctx, room.x, room.y + 30, room.w, 2, room.trim);
    drawShelf(ctx, room.x + 6, room.y + 8);
    drawWindow(ctx, room.x + room.w / 2 - 11, room.y + 8, t);
    drawBoard(ctx, room.x + room.w - 36, room.y + 8, notes);
    drawPlant(ctx, room.x + 4, room.y + room.h - 16);
    drawPlant(ctx, room.x + room.w - 12, room.y + room.h - 16);
    // Walls between rooms.
    px(ctx, room.x - 1, room.y, 1, room.h, "#0c0b11");
    px(ctx, room.x + room.w, room.y, 1, room.h, "#0c0b11");
  }

  function deskAnchor(index) {
    const room = ROOMS[index];
    const cx = room.x + room.w / 2;
    return workstation(cx, room.y + 92);
  }

  function workstation(cx, deskY) {
    return { cx, deskY, headX: cx - 4 * SCALE, headY: deskY - 13 * SCALE };
  }

  const MANAGER = workstation(56, 44);

  // Chair, seated character and desk at SCALE, anchored on the desk's top-center.
  function drawWorkstation(ctx, anchor, look, pose, screen, t) {
    ctx.save();
    ctx.translate(anchor.cx, anchor.deskY);
    ctx.scale(SCALE, SCALE);
    drawChair(ctx, -4, 0);
    drawCharacter(ctx, -10, -13, look, pose);
    drawDesk(ctx, 0, 0, screen, t);
    ctx.restore();
  }

  function drawLobby(ctx, t, kanban) {
    checker(ctx, 0, 0, W, 80, ["#3b2f2a", "#433530"]);
    px(ctx, 0, 0, W, 16, "#221c1a");
    px(ctx, 0, 16, W, 2, "#ffd36b");
    // Collaboration table.
    for (let i = 0; i < 3; i++) {
      px(ctx, 168 + i * 26, 32, 12, 6, "#6b5340");
      px(ctx, 168 + i * 26, 58, 12, 6, "#6b5340");
    }
    px(ctx, 160, 38, 88, 20, "#c8945a");
    px(ctx, 162, 40, 84, 16, "#d8a46a");
    // Kanban board: todo / doing / done columns.
    px(ctx, 296, 2, 80, 13, "#d9d4c7");
    px(ctx, 297, 3, 78, 11, "#f6f3ea");
    ["todo", "doing", "done"].forEach((col, ci) => {
      px(ctx, 297 + ci * 26 + 25, 3, 1, 11, "#d9d4c7");
      (kanban[col] || []).forEach((color, i) => px(ctx, 300 + ci * 26 + (i % 3) * 7, 5 + Math.floor(i / 3) * 5, 5, 4, color));
    });
    drawPlant(ctx, 272, 62);
    drawPlant(ctx, 368, 62);
  }

  function drawCorridor(ctx) {
    px(ctx, 0, 80, W, 8, "#2b2633");
    for (let x = 4; x < W; x += 16) px(ctx, x, 83, 8, 1, "#3a3445");
    px(ctx, 0, 224, W, 8, "#0c0b11");
  }

  function drawPaper(ctx, x, y) {
    px(ctx, x, y, 7, 9, "#fffdf5");
    px(ctx, x, y, 7, 1, "#d9d4c7");
    for (let i = 0; i < 3; i++) px(ctx, x + 1, y + 2 + i * 2, 5, 1, "#9a93b3");
  }

  window.Pixel = {
    W, H, ROOMS, LOOKS, MANAGER_LOOK, MANAGER,
    px, drawWorkstation, drawRoom, drawLobby, drawCorridor, drawPaper, deskAnchor,
  };
})();
