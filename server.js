require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const {
  initDatabase,
  getUser,
  createOrUpdateUser,
  updateGameResult,
  getLeaderboard
} = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));


/* =====================================================
   TELEGRAM INIT DATA TEKSHIRISH
===================================================== */

function validateTelegramInitData(initData) {
  if (!initData) {
    return null;
  }

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    console.error("BOT_TOKEN topilmadi.");
    return null;
  }

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    return null;
  }

  const maxAge =
    Number(process.env.TELEGRAM_AUTH_MAX_AGE) || 86400;

  const currentTime = Math.floor(Date.now() / 1000);

  if (currentTime - authDate > maxAge) {
    return null;
  }

  const userString = params.get("user");

  if (!userString) {
    return null;
  }

  try {
    return JSON.parse(userString);
  } catch (error) {
    return null;
  }
}


/* =====================================================
   AUTH MIDDLEWARE
===================================================== */

async function authenticateTelegram(req, res, next) {
  try {
    const initData =
      req.headers["x-telegram-init-data"] ||
      req.body?.initData;

    const telegramUser =
      validateTelegramInitData(initData);

    if (!telegramUser) {
      return res.status(401).json({
        success: false,
        error: "Telegram authentication failed"
      });
    }

    await createOrUpdateUser(telegramUser);

    req.telegramUser = telegramUser;

    next();

  } catch (error) {
    console.error("Authentication error:", error);

    res.status(500).json({
      success: false,
      error: "Authentication server error"
    });
  }
}


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/api/health", async (req, res) => {
  res.json({
    success: true,
    message: "Qalampir Game server ishlayapti",
    time: new Date().toISOString()
  });
});


/* =====================================================
   USER
===================================================== */

app.get(
  "/api/me",
  authenticateTelegram,
  async (req, res) => {

    try {
      const user =
        await getUser(req.telegramUser.id);

      res.json({
        success: true,
        user
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error: "User ma'lumotlarini olishda xatolik"
      });
    }
  }
);


/* =====================================================
   GAME RESULT
===================================================== */

app.post(
  "/api/game/result",
  authenticateTelegram,
  async (req, res) => {

    try {
      const { result } = req.body;

      if (!["win", "loss"].includes(result)) {
        return res.status(400).json({
          success: false,
          error: "Noto'g'ri game result"
        });
      }

      const userId =
        req.telegramUser.id;

      const updatedUser =
        await updateGameResult(
          userId,
          result
        );

      res.json({
        success: true,
        user: updatedUser
      });

    } catch (error) {
      console.error("Game result error:", error);

      res.status(500).json({
        success: false,
        error: "Game result saqlanmadi"
      });
    }
  }
);


/* =====================================================
   LEADERBOARD
===================================================== */

app.get(
  "/api/leaderboard",
  async (req, res) => {

    try {

      const limit =
        Math.min(
          Number(req.query.limit) || 20,
          100
        );

      const users =
        await getLeaderboard(limit);

      res.json({
        success: true,
        users
      });

    } catch (error) {

      console.error(
        "Leaderboard error:",
        error
      );

      res.status(500).json({
        success: false,
        error: "Leaderboardni olishda xatolik"
      });
    }
  }
);


/* =====================================================
   QALAMPIR DUEL - O'YIN HOLATI (in-memory)
===================================================== */

const waitingQueue = [];      // [{ socketId, user }] - tasodifiy o'yin navbati
const rooms = new Map();      // roomId -> room
const roomCodes = new Map();  // roomCode -> roomId (do'st bilan o'ynash xonalari)

function generateRoomId() {
  return "room_" + Math.random().toString(36).slice(2, 10);
}

function generateRoomCode() {
  let code;

  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (roomCodes.has(code));

  return code;
}

function findPlayer(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function otherPlayer(room, socketId) {
  return room.players.find((p) => p.socketId !== socketId);
}

async function recordGameResult(userId, result) {
  try {
    if (!userId || userId === "demo") {
      return;
    }

    await createOrUpdateUser({ id: userId });
    await updateGameResult(userId, result);

  } catch (error) {
    console.error("O'yin natijasini saqlashda xatolik:", error);
  }
}

function cleanupRoom(room) {
  if (room.code) {
    roomCodes.delete(room.code);
  }

  rooms.delete(room.id);
}

function scheduleBotAttack(room) {
  setTimeout(() => {

    if (!rooms.has(room.id) || room.phase !== "BATTLE") {
      return;
    }

    const bot = room.players.find((p) => p.isBot);
    const human = otherPlayer(room, bot.socketId);

    if (!human || room.turn !== bot.socketId) {
      return;
    }

    room.botAttacked = room.botAttacked || new Set();

    let spot;

    do {
      spot = Math.floor(Math.random() * 6);
    } while (room.botAttacked.has(spot));

    room.botAttacked.add(spot);

    resolveAttack(room, bot, spot);

  }, 1000 + Math.random() * 1200);
}

function startBattlePhase(room) {
  room.phase = "BATTLE";

  const starter =
    room.players[Math.floor(Math.random() * 2)];

  room.turn = starter.socketId;

  room.players.forEach((p) => {
    if (!p.isBot) {
      io.to(p.socketId).emit("battleStart", { turn: room.turn });
    }
  });

  if (starter.isBot) {
    scheduleBotAttack(room);
  }
}

function checkBothReady(room) {
  const bothSet = room.players.every((p) => p.spot !== null);

  if (bothSet) {
    startBattlePhase(room);
  }
}

function resolveAttack(room, attacker, spot) {
  const defender = otherPlayer(room, attacker.socketId);

  if (!defender) {
    return;
  }

  const isHit = defender.spot === spot;

  if (isHit) {
    room.phase = "END";

    room.players.forEach((p) => {
      if (!p.isBot) {
        io.to(p.socketId).emit("gameOver", {
          winner: attacker.socketId,
          hitSpot: spot
        });
      }
    });

    if (!attacker.isBot) {
      recordGameResult(attacker.user?.id, "win");
    }

    if (!defender.isBot) {
      recordGameResult(defender.user?.id, "loss");
    }

    cleanupRoom(room);

  } else {

    room.turn = defender.socketId;

    room.players.forEach((p) => {
      if (!p.isBot) {
        io.to(p.socketId).emit("turnChanged", {
          attacker: attacker.socketId,
          spot,
          nextTurn: room.turn
        });
      }
    });

    if (defender.isBot) {
      scheduleBotAttack(room);
    }
  }
}


/* =====================================================
   SOCKET.IO
===================================================== */

io.on("connection", (socket) => {

  console.log(
    "Socket connected:",
    socket.id
  );


  /* ---------- TEZKOR O'YIN (tasodifiy raqib) ---------- */

  socket.on("joinRandomGame", (user) => {

    const staleIdx = waitingQueue.findIndex(
      (w) => w.socketId === socket.id
    );

    if (staleIdx !== -1) {
      waitingQueue.splice(staleIdx, 1);
    }

    if (waitingQueue.length > 0) {

      const opponent = waitingQueue.shift();

      const roomId = generateRoomId();

      const room = {
        id: roomId,
        code: null,
        phase: "PLACE",
        turn: null,
        players: [
          { socketId: opponent.socketId, user: opponent.user, spot: null, isBot: false },
          { socketId: socket.id, user, spot: null, isBot: false }
        ]
      };

      rooms.set(roomId, room);

      io.to(opponent.socketId).emit("gameMatched", {
        roomId,
        opponent: user
      });

      io.to(socket.id).emit("gameMatched", {
        roomId,
        opponent: opponent.user
      });

    } else {

      waitingQueue.push({ socketId: socket.id, user });

      socket.emit("waitingForOpponent");

      setTimeout(() => {

        const stillWaitingIdx = waitingQueue.findIndex(
          (w) => w.socketId === socket.id
        );

        if (stillWaitingIdx === -1) {
          return;
        }

        waitingQueue.splice(stillWaitingIdx, 1);

        const roomId = generateRoomId();

        const room = {
          id: roomId,
          code: null,
          phase: "PLACE",
          turn: null,
          players: [
            { socketId: socket.id, user, spot: null, isBot: false },
            {
              socketId: "bot_" + roomId,
              user: { first_name: "Bot 🤖" },
              spot: Math.floor(Math.random() * 6),
              isBot: true
            }
          ]
        };

        rooms.set(roomId, room);

        io.to(socket.id).emit("gameMatched", {
          roomId,
          opponent: room.players[1].user
        });

      }, 6000);
    }
  });


  /* ---------- DO'ST BILAN O'YNASH (xona) ---------- */

  socket.on("createPrivateRoom", (user) => {

    const roomId = generateRoomId();
    const code = generateRoomCode();

    const room = {
      id: roomId,
      code,
      phase: "WAITING",
      turn: null,
      players: [
        { socketId: socket.id, user, spot: null, isBot: false }
      ]
    };

    rooms.set(roomId, room);
    roomCodes.set(code, roomId);

    socket.emit("roomCreated", { roomId, roomCode: code });
  });


  socket.on("joinPrivateRoom", ({ roomCode, userData } = {}) => {

    const roomId = roomCodes.get(roomCode);
    const room = roomId && rooms.get(roomId);

    if (!room || room.players.length >= 2) {
      socket.emit("errorMsg", "Xona topilmadi yoki allaqachon to'lgan.");
      return;
    }

    room.players.push({
      socketId: socket.id,
      user: userData,
      spot: null,
      isBot: false
    });

    room.phase = "PLACE";

    roomCodes.delete(roomCode);

    room.players.forEach((p) => {
      io.to(p.socketId).emit("gameMatched", {
        roomId: room.id,
        opponent: otherPlayer(room, p.socketId).user
      });
    });
  });


  /* ---------- QALAMPIRNI YASHIRISH ---------- */

  socket.on("setSpot", ({ roomId, spot } = {}) => {

    const room = rooms.get(roomId);

    if (!room || room.phase !== "PLACE") {
      return;
    }

    const player = findPlayer(room, socket.id);

    if (!player || typeof spot !== "number" || spot < 0 || spot > 5) {
      return;
    }

    player.spot = spot;

    checkBothReady(room);
  });


  /* ---------- HUJUM ---------- */

  socket.on("attackSpot", ({ roomId, spot } = {}) => {

    const room = rooms.get(roomId);

    if (!room || room.phase !== "BATTLE" || room.turn !== socket.id) {
      return;
    }

    const attacker = findPlayer(room, socket.id);

    if (!attacker || typeof spot !== "number" || spot < 0 || spot > 5) {
      return;
    }

    resolveAttack(room, attacker, spot);
  });


  /* ---------- ULANISH UZILISHI ---------- */

  socket.on("disconnect", () => {

    console.log(
      "Socket disconnected:",
      socket.id
    );

    const qIdx = waitingQueue.findIndex(
      (w) => w.socketId === socket.id
    );

    if (qIdx !== -1) {
      waitingQueue.splice(qIdx, 1);
    }

    for (const room of rooms.values()) {

      const player = findPlayer(room, socket.id);

      if (!player) {
        continue;
      }

      const opponent = otherPlayer(room, socket.id);

      if (opponent && !opponent.isBot) {
        io.to(opponent.socketId).emit(
          "errorMsg",
          "Raqib o'yindan chiqib ketdi."
        );
      }

      cleanupRoom(room);
    }
  });

});


/* =====================================================
   ERROR HANDLER
===================================================== */

app.use((err, req, res, next) => {

  console.error(err);

  res.status(500).json({
    success: false,
    error: "Server error"
  });

});


/* =====================================================
   START SERVER
===================================================== */

async function startServer() {

  try {

    await initDatabase();

    server.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `Qalampir Game server ${PORT}-portda ishlayapti`
        );

      }
    );

  } catch (error) {

    console.error(
      "Server ishga tushmadi:",
      error
    );

    process.exit(1);
  }
}

startServer();
