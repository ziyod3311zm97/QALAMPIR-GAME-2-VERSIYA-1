require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const TelegramBot = require("node-telegram-bot-api");

const {
  initDatabase,
  getUser,
  createOrUpdateUser,
  updateGameResult,
  getLeaderboard,
  getUserWithFreshEnergy,
  spendEnergy,
  claimDailyBonus,
  getSkinCatalog,
  buySkin,
  addCoins,
  getAdminStats,
  getRevenueStats,
  recordStarsPayment,
  findUserByIdOrUsername,
  setBanned,
  getAllUserIds,
  setUserTheme
} = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));


/* =====================================================
   TELEGRAM STARS - TO'LOVLAR
===================================================== */

const bot =
  process.env.BOT_TOKEN
    ? new TelegramBot(process.env.BOT_TOKEN, { polling: true })
    : null;

if (!bot) {
  console.error(
    "BOT_TOKEN topilmadi - Stars to'lovlari ishlamaydi."
  );
}

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
);

function isAdmin(userId) {
  return ADMIN_IDS.has(Number(userId));
}

const COIN_PACKAGES = {
  small: {
    id: "small",
    coins: 500,
    stars: 50,
    label: "500 🌶️"
  },
  medium: {
    id: "medium",
    coins: 1200,
    stars: 100,
    label: "1200 🌶️ (+20% bonus)"
  },
  large: {
    id: "large",
    coins: 3000,
    stars: 200,
    label: "3000 🌶️ (+50% bonus)"
  }
};

async function createInvoiceLink({ title, description, payload, prices }) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        payload,
        currency: "XTR",
        prices
      })
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || "Invoice yaratib bo'lmadi"
    );
  }

  return data.result;
}

if (bot) {

  bot.on("pre_checkout_query", async (query) => {
    try {
      await bot.answerPreCheckoutQuery(query.id, true);
    } catch (error) {
      console.error("Pre-checkout xatosi:", error);
    }
  });

  bot.on("message", async (msg) => {

    if (!msg.successful_payment) {
      return;
    }

    try {
      const payload =
        JSON.parse(msg.successful_payment.invoice_payload);

      const pkg = COIN_PACKAGES[payload.packageId];

      if (pkg) {
        await addCoins(
          payload.userId,
          pkg.coins,
          "stars_purchase"
        );

        await recordStarsPayment(
          payload.userId,
          payload.packageId,
          msg.successful_payment.total_amount,
          pkg.coins,
          msg.successful_payment.telegram_payment_charge_id
        );
      }

      await bot.sendMessage(
        msg.chat.id,
        `✅ To'lov qabul qilindi!\n\n+${pkg ? pkg.coins : 0} 🌶️ hisobingizga qo'shildi.`
      );

    } catch (error) {
      console.error("Successful payment xatosi:", error);
    }
  });

  bot.on("polling_error", (error) => {
    console.error("Bot polling xatosi:", error.message);
  });


  /* ===================================================
     ADMIN BUYRUQLARI
  =================================================== */

  bot.onText(/^\/admin$/, async (msg) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      "🛠 *ADMIN PANEL*\n\n" +
      "📊 /stats — umumiy statistika\n" +
      "💰 /revenue — Stars daromadi\n" +
      "🔍 /finduser <id yoki @username> — o'yinchini qidirish\n" +
      "💵 /addcoins <id> <miqdor> — coin qo'shish (manfiy son ayiradi)\n" +
      "🚫 /ban <id> — bloklash\n" +
      "✅ /unban <id> — blokdan chiqarish\n" +
      "📢 /broadcast <matn> — hammaga xabar yuborish",
      { parse_mode: "Markdown" }
    );
  });


  bot.onText(/^\/stats$/, async (msg) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const stats = await getAdminStats();

      await bot.sendMessage(
        msg.chat.id,
        "📊 *STATISTIKA*\n\n" +
        `👥 Jami o'yinchilar: ${stats.total_users}\n` +
        `🌶️ Aylanmadagi coin: ${stats.total_coins}\n` +
        `🏆 Jami o'yinlar: ${stats.total_games}\n` +
        `🚫 Bloklangan: ${stats.total_banned}`,
        { parse_mode: "Markdown" }
      );

    } catch (error) {
      console.error("Admin stats xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/revenue$/, async (msg) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const revenue = await getRevenueStats(10);

      const recentText =
        revenue.recent.length === 0
          ? "Hali xaridlar yo'q."
          : revenue.recent
              .map((r) => {
                const name =
                  r.first_name ||
                  r.username ||
                  r.user_id;

                return `• ${name}: ${r.stars_amount}⭐ → ${r.coins_amount}🌶️`;
              })
              .join("\n");

      await bot.sendMessage(
        msg.chat.id,
        "💰 *STARS DAROMADI*\n\n" +
        `⭐ Jami: ${revenue.totalStars} Stars\n` +
        `🛒 Xaridlar soni: ${revenue.totalPurchases}\n\n` +
        "So'nggi xaridlar:\n" +
        recentText,
        { parse_mode: "Markdown" }
      );

    } catch (error) {
      console.error("Revenue xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/finduser (\S+)$/, async (msg, match) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const user =
        await findUserByIdOrUsername(match[1]);

      if (!user) {
        bot.sendMessage(msg.chat.id, "Topilmadi.");
        return;
      }

      await bot.sendMessage(
        msg.chat.id,
        `👤 ${user.first_name || "-"} (@${user.username || "-"})\n` +
        `ID: \`${user.id}\`\n` +
        `🌶️ Balans: ${user.balance}\n` +
        `🏆 G'alaba: ${user.wins} | ❌ Mag'lubiyat: ${user.losses}\n` +
        `🔋 Jon: ${user.energy}/5\n` +
        `${user.is_banned ? "🚫 BLOKLANGAN" : "✅ Faol"}`,
        { parse_mode: "Markdown" }
      );

    } catch (error) {
      console.error("Finduser xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/addcoins (\S+) (-?\d+)$/, async (msg, match) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const userId = Number(match[1]);
      const amount = Number(match[2]);

      const updated =
        await addCoins(userId, amount, "admin_adjustment");

      await bot.sendMessage(
        msg.chat.id,
        `✅ Yangilandi.\n\nYangi balans: ${updated.balance} 🌶️`
      );

    } catch (error) {
      console.error("Addcoins xatosi:", error);
      bot.sendMessage(msg.chat.id, "Foydalanuvchi topilmadi yoki xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/ban (\d+)$/, async (msg, match) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const updated =
        await setBanned(Number(match[1]), true);

      bot.sendMessage(
        msg.chat.id,
        updated ? "🚫 Bloklandi." : "Foydalanuvchi topilmadi."
      );

    } catch (error) {
      console.error("Ban xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/unban (\d+)$/, async (msg, match) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    try {
      const updated =
        await setBanned(Number(match[1]), false);

      bot.sendMessage(
        msg.chat.id,
        updated ? "✅ Blokdan chiqarildi." : "Foydalanuvchi topilmadi."
      );

    } catch (error) {
      console.error("Unban xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });


  bot.onText(/^\/broadcast ([\s\S]+)$/, async (msg, match) => {

    if (!isAdmin(msg.from.id)) {
      return;
    }

    const text = match[1];

    try {
      const ids = await getAllUserIds();

      await bot.sendMessage(
        msg.chat.id,
        `📢 Yuborilmoqda: ${ids.length} ta foydalanuvchiga...`
      );

      let success = 0;
      let failed = 0;

      for (const id of ids) {
        try {
          await bot.sendMessage(id, text);
          success += 1;
        } catch (sendError) {
          failed += 1;
        }

        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      await bot.sendMessage(
        msg.chat.id,
        `✅ Tugadi.\n\nYuborildi: ${success}\nXato: ${failed}`
      );

    } catch (error) {
      console.error("Broadcast xatosi:", error);
      bot.sendMessage(msg.chat.id, "Xatolik yuz berdi.");
    }
  });
}


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
   USER (yangi frontend uchun - oddiy user obyekti bilan)
===================================================== */

app.post(
  "/api/user",
  async (req, res) => {

    try {
      const incomingUser = req.body;

      if (!incomingUser || !incomingUser.id) {
        return res.status(400).json({
          success: false,
          message: "User ma'lumoti yuborilmadi"
        });
      }

      await createOrUpdateUser(
        incomingUser,
        incomingUser.referralCode
      );

      const dbUser =
        await getUserWithFreshEnergy(incomingUser.id);

      res.json({
        success: true,
        user: {
          id: dbUser.id,
          username: dbUser.username,
          first_name: dbUser.first_name,
          last_name: dbUser.last_name,
          coins: Number(dbUser.balance),
          wins: dbUser.wins,
          losses: dbUser.losses,
          streak: dbUser.streak,
          level: dbUser.level,
          xp: dbUser.xp,
          energy: dbUser.energy,
          maxEnergy: 5,
          equippedSkin: dbUser.equipped_skin,
          theme: dbUser.theme,
          dailyBonusAvailable:
            !dbUser.last_bonus_date ||
            new Date(dbUser.last_bonus_date).toDateString() !==
              new Date().toDateString()
        }
      });

    } catch (error) {
      console.error("api/user xatosi:", error);

      res.status(500).json({
        success: false,
        message: "User ma'lumotlarini olishda xatolik"
      });
    }
  }
);


/* =====================================================
   COIN SOTIB OLISH (Telegram Stars)
===================================================== */

app.post(
  "/api/create-invoice",
  async (req, res) => {

    try {
      const { id, packageId } = req.body || {};
      const pkg = COIN_PACKAGES[packageId];

      if (!id || !pkg) {
        return res.status(400).json({
          success: false,
          message: "Noto'g'ri so'rov"
        });
      }

      if (!bot) {
        return res.status(500).json({
          success: false,
          message: "To'lov tizimi hozircha sozlanmagan"
        });
      }

      const payload = JSON.stringify({
        userId: id,
        packageId
      });

      const invoiceLink = await createInvoiceLink({
        title: `${pkg.coins} 🌶️ Qalampir Coin`,
        description: `Qalampir o'yini uchun ${pkg.coins} ta coin`,
        payload,
        prices: [
          { label: pkg.label, amount: pkg.stars }
        ]
      });

      res.json({
        success: true,
        invoiceLink
      });

    } catch (error) {
      console.error("Invoice yaratish xatosi:", error);

      res.status(500).json({
        success: false,
        message: "Invoice yaratib bo'lmadi"
      });
    }
  }
);


/* =====================================================
   KUNLIK BONUS
===================================================== */

app.post(
  "/api/daily-bonus",
  async (req, res) => {

    try {
      const userId = req.body?.id;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: "User id yuborilmadi"
        });
      }

      const { user, amount } =
        await claimDailyBonus(userId);

      res.json({
        success: true,
        amount,
        user: {
          coins: Number(user.balance)
        }
      });

    } catch (error) {

      if (error.code === "ALREADY_CLAIMED") {
        return res.status(400).json({
          success: false,
          code: "ALREADY_CLAIMED",
          message: "Bugungi bonusni allaqachon oldingiz"
        });
      }

      console.error("Daily bonus xatosi:", error);

      res.status(500).json({
        success: false,
        message: "Bonusni olishda xatolik"
      });
    }
  }
);


/* =====================================================
   SKINLAR
===================================================== */

app.post(
  "/api/skins",
  async (req, res) => {

    try {
      const userId = req.body?.id;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: "User id yuborilmadi"
        });
      }

      const skins =
        await getSkinCatalog(userId);

      res.json({
        success: true,
        skins
      });

    } catch (error) {
      console.error("Skins xatosi:", error);

      res.status(500).json({
        success: false,
        message: "Skinlarni olishda xatolik"
      });
    }
  }
);


app.post(
  "/api/skins/buy",
  async (req, res) => {

    try {
      const { id, skin } = req.body || {};

      if (!id || !skin) {
        return res.status(400).json({
          success: false,
          message: "Ma'lumot yetarli emas"
        });
      }

      const updatedUser =
        await buySkin(id, skin);

      res.json({
        success: true,
        coins: Number(updatedUser.balance),
        equippedSkin: updatedUser.equipped_skin
      });

    } catch (error) {

      if (error.code === "NOT_ENOUGH_COINS") {
        return res.status(400).json({
          success: false,
          code: "NOT_ENOUGH_COINS",
          message: "Coin yetarli emas"
        });
      }

      if (error.code === "SKIN_NOT_FOUND") {
        return res.status(404).json({
          success: false,
          code: "SKIN_NOT_FOUND",
          message: "Skin topilmadi"
        });
      }

      console.error("Skin sotib olish xatosi:", error);

      res.status(500).json({
        success: false,
        message: "Xatolik yuz berdi"
      });
    }
  }
);


/* =====================================================
   MAVZU (THEME)
===================================================== */

app.post(
  "/api/theme",
  async (req, res) => {

    try {
      const { id, theme } = req.body || {};

      if (!id || !theme) {
        return res.status(400).json({
          success: false,
          message: "Ma'lumot yetarli emas"
        });
      }

      await setUserTheme(id, theme);

      res.json({ success: true });

    } catch (error) {

      if (error.code === "INVALID_THEME") {
        return res.status(400).json({
          success: false,
          message: "Noto'g'ri mavzu"
        });
      }

      console.error("Theme xatosi:", error);

      res.status(500).json({
        success: false,
        message: "Xatolik yuz berdi"
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

      const leaderboard =
        users.map((u) => ({
          id: u.id,
          username: u.username,
          first_name: u.first_name,
          coins: Number(u.balance),
          wins: u.wins,
          losses: u.losses,
          streak: u.streak,
          level: u.level,
          xp: u.xp
        }));

      res.json({
        success: true,
        leaderboard
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

  socket.on("joinRandomGame", async (user) => {

    try {
      await spendEnergy(user.id);
    } catch (error) {
      if (error.code === "BANNED") {
        socket.emit(
          "errorMsg",
          "🚫 Siz bloklangansiz. O'yin o'ynay olmaysiz."
        );
      } else if (error.code === "NO_ENERGY") {
        socket.emit(
          "errorMsg",
          "🔋 Jon tugadi! Biroz kuting (har 10 daqiqada +1 jon) yoki do'kondan sotib oling."
        );
      } else {
        socket.emit("errorMsg", "Xatolik yuz berdi, qayta urinib ko'ring.");
      }
      return;
    }

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

  socket.on("createPrivateRoom", async (user) => {

    try {
      await spendEnergy(user.id);
    } catch (error) {
      if (error.code === "BANNED") {
        socket.emit(
          "errorMsg",
          "🚫 Siz bloklangansiz. O'yin o'ynay olmaysiz."
        );
      } else if (error.code === "NO_ENERGY") {
        socket.emit(
          "errorMsg",
          "🔋 Jon tugadi! Biroz kuting (har 10 daqiqada +1 jon) yoki do'kondan sotib oling."
        );
      } else {
        socket.emit("errorMsg", "Xatolik yuz berdi, qayta urinib ko'ring.");
      }
      return;
    }

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


  socket.on("joinPrivateRoom", async ({ roomCode, userData } = {}) => {

    const roomId = roomCodes.get(roomCode);
    const room = roomId && rooms.get(roomId);

    if (!room || room.players.length >= 2) {
      socket.emit("errorMsg", "Xona topilmadi yoki allaqachon to'lgan.");
      return;
    }

    try {
      await spendEnergy(userData.id);
    } catch (error) {
      if (error.code === "BANNED") {
        socket.emit(
          "errorMsg",
          "🚫 Siz bloklangansiz. O'yin o'ynay olmaysiz."
        );
      } else if (error.code === "NO_ENERGY") {
        socket.emit(
          "errorMsg",
          "🔋 Jon tugadi! Biroz kuting (har 10 daqiqada +1 jon) yoki do'kondan sotib oling."
        );
      } else {
        socket.emit("errorMsg", "Xatolik yuz berdi, qayta urinib ko'ring.");
      }
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
