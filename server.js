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
    console.error("[AUTH DEBUG] initData bo'sh yoki yuborilmagan.");
    return null;
  }

  console.error("[AUTH DEBUG] initData uzunligi:", initData.length);

  const params = new URLSearchParams(initData);

  const hash = params.get("hash");

  if (!hash) {
    console.error("[AUTH DEBUG] hash topilmadi initData ichida.");
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const botToken = process.env.BOT_TOKEN;

  if (!botToken) {
    console.error("[AUTH DEBUG] BOT_TOKEN topilmadi (env variable yo'q).");
    return null;
  }

  console.error("[AUTH DEBUG] BOT_TOKEN uzunligi:", botToken.length, "boshi:", botToken.slice(0, 6));

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    console.error("[AUTH DEBUG] HASH MOS KELMADI.");
    console.error("[AUTH DEBUG] kutilgan (telegram):", hash);
    console.error("[AUTH DEBUG] hisoblangan (server):", calculatedHash);
    return null;
  }

  console.error("[AUTH DEBUG] Hash mos keldi, davom etyapti...");

  const authDate = Number(params.get("auth_date"));

  if (!authDate) {
    console.error("[AUTH DEBUG] auth_date topilmadi.");
    return null;
  }

  const maxAge =
    Number(process.env.TELEGRAM_AUTH_MAX_AGE) || 86400;

  const currentTime = Math.floor(Date.now() / 1000);

  if (currentTime - authDate > maxAge) {
    console.error("[AUTH DEBUG] auth_date eskirgan. Farq (sekund):", currentTime - authDate);
    return null;
  }

  const userString = params.get("user");

  if (!userString) {
    console.error("[AUTH DEBUG] user maydoni topilmadi.");
    return null;
  }

  try {
    return JSON.parse(userString);
  } catch (error) {
    console.error("[AUTH DEBUG] user JSON parse xatosi:", error.message);
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
   SOCKET.IO
===================================================== */

io.on("connection", (socket) => {

  console.log(
    "Socket connected:",
    socket.id
  );

  socket.on("join-game", (data) => {

    const roomId =
      data?.roomId;

    if (!roomId) {
      return;
    }

    socket.join(roomId);

    socket.to(roomId).emit(
      "player-joined",
      {
        socketId: socket.id
      }
    );
  });


  socket.on("game-action", (data) => {

    const roomId =
      data?.roomId;

    if (!roomId) {
      return;
    }

    socket.to(roomId).emit(
      "game-action",
      {
        ...data,
        socketId: socket.id
      }
    );
  });


  socket.on("leave-game", (data) => {

    const roomId =
      data?.roomId;

    if (!roomId) {
      return;
    }

    socket.leave(roomId);

    socket.to(roomId).emit(
      "player-left",
      {
        socketId: socket.id
      }
    );
  });


  socket.on("disconnect", () => {

    console.log(
      "Socket disconnected:",
      socket.id
    );

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
