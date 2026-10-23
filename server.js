const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const MAX_PLAYERS = 10;

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({length: 5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    maxPlayers: MAX_PLAYERS,
    started: room.started
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function sendError(socket, message) { socket.emit("app:error", message); }

io.on("connection", socket => {
  socket.on("room:create", ({name}) => {
    name = String(name || "").trim().slice(0, 18);
    if (!name) return sendError(socket, "请先输入昵称。");
    const code = makeCode();
    const room = { code, hostId: socket.id, players: [], started: false };
    rooms.set(code, room);
    room.players.push({ id: socket.id, name, ready: false, role: null });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:joined", { code, playerId: socket.id, isHost: true });
    broadcastRoom(room);
  });

  socket.on("room:join", ({code, name}) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 18);
    const room = rooms.get(code);
    if (!name) return sendError(socket, "请先输入昵称。");
    if (!room) return sendError(socket, "没有找到这个房间，请检查房间码或邀请链接。");
    if (room.started) return sendError(socket, "本局已经开始，不能再加入。");
    if (room.players.length >= MAX_PLAYERS) return sendError(socket, "房间已满，最多 10 人。");
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return sendError(socket, "这个昵称已被使用，请换一个。");
    }
    room.players.push({ id: socket.id, name, ready: false, role: null });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:joined", { code, playerId: socket.id, isHost: false });
    broadcastRoom(room);
  });

  socket.on("player:ready", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started) return;
    const player = room.players.find(p => p.id === socket.id);
    if (player) { player.ready = !player.ready; broadcastRoom(room); }
  });

  socket.on("game:start", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return sendError(socket, "房间不存在。");
    if (room.hostId !== socket.id) return sendError(socket, "只有房主可以开始游戏。");
    if (room.players.length !== MAX_PLAYERS) return sendError(socket, "需要刚好 10 人才能开始。");
    if (room.players.some(p => !p.ready)) return sendError(socket, "请等待所有玩家点击“准备”。");

    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => {
      const real = room.players.find(x => x.id === p.id);
      real.role = i < 2 ? "间谍" : "平民";
    });
    room.started = true;
    room.players.forEach(p => io.to(p.id).emit("game:role", {
      role: p.role,
      briefing: p.role === "间谍"
        ? "你的身份是间谍。隐藏身份，设法帮助间谍阵营达成目标。"
        : "你的身份是平民。找出两名间谍，并通过讨论和投票完成任务。"
    }));
    io.to(room.code).emit("game:started", { message: "身份已分配！请查看自己的私密身份。" });
    broadcastRoom(room);
  });

  socket.on("game:restart", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.started = false;
    room.players.forEach(p => { p.role = null; p.ready = false; });
    io.to(room.code).emit("game:reset");
    broadcastRoom(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    if (!room.players.length) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    // If someone disconnects after start, reset so a fresh full group can play.
    if (room.started) {
      room.started = false;
      room.players.forEach(p => { p.role = null; p.ready = false; });
      io.to(room.code).emit("game:reset", { message: "有玩家离开，本局已重置。" });
    }
    broadcastRoom(room);
  });
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
