const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});


/* =====================================================
   O'YIN SOZLAMALARI
===================================================== */

const MAX_ENERGY = 5;
const ENERGY_REGEN_MINUTES = 10;   // har 10 daqiqada +1 jon
const DAILY_BONUS_AMOUNT = 50;
const REFERRAL_BONUS_REFERRER = 100;
const REFERRAL_BONUS_NEW_USER = 30;

const SKINS = {
  chili_v1: {
    id: "chili_v1",
    name: "Chili V1",
    image: "/assets/skins/chili_v1.png",
    rarity: "Oddiy",
    price: 0
  },
  chili_v2: {
    id: "chili_v2",
    name: "Chili V2",
    image: "/assets/skins/chili_v2.png",
    rarity: "Nodir",
    price: 250
  },
  gold_v2: {
    id: "gold_v2",
    name: "Gold V2",
    image: "/assets/skins/gold_v2.png",
    rarity: "Nodir",
    price: 600
  },
  chili_fold: {
    id: "chili_fold",
    name: "Chili Fold",
    image: "/assets/skins/chili_fold.png",
    rarity: "Kamyob",
    price: 1000
  },
  amethyst: {
    id: "amethyst",
    name: "Amethyst Chili",
    image: "/assets/skins/amethyst.png",
    rarity: "Kamyob",
    price: 1500
  },
  chili_frost: {
    id: "chili_frost",
    name: "Chili Frost",
    image: "/assets/skins/chili_frost.png",
    rarity: "Afsonaviy",
    price: 2200
  },
  chili_void: {
    id: "chili_void",
    name: "Chili Void",
    image: "/assets/skins/chili_void.png",
    rarity: "Afsonaviy",
    price: 3500
  }
};


/* =====================================================
   SXEMA
===================================================== */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      balance BIGINT NOT NULL DEFAULT 100,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      energy INTEGER NOT NULL DEFAULT 5,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount BIGINT NOT NULL,
      type TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Eski (allaqachon yaratilgan) jadvallarga yangi ustunlarni
  // xavfsiz qo'shamiz - mavjud ma'lumotlarga tegmaydi.
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS energy_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS last_bonus_date DATE,
      ADD COLUMN IF NOT EXISTS referred_by BIGINT,
      ADD COLUMN IF NOT EXISTS equipped_skin TEXT NOT NULL DEFAULT 'chili_v1',
      ADD COLUMN IF NOT EXISTS owned_skins TEXT[] NOT NULL DEFAULT ARRAY['chili_v1']::TEXT[],
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'classic_dark';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stars_payments (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      package_id TEXT NOT NULL,
      stars_amount INTEGER NOT NULL,
      coins_amount INTEGER NOT NULL,
      telegram_charge_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Eski skin katalogidagi "fire" nomini yangi "chili_v1" ga o'tkazamiz.
  await pool.query(`
    UPDATE users
    SET owned_skins = array_replace(owned_skins, 'fire', 'chili_v1')
    WHERE 'fire' = ANY(owned_skins);
  `);

  await pool.query(`
    UPDATE users
    SET equipped_skin = 'chili_v1'
    WHERE equipped_skin = 'fire';
  `);

  console.log("PostgreSQL database tayyor.");
}


/* =====================================================
   ENERGY (JON) HISOB-KITOBI
===================================================== */

function recalcEnergy(user) {
  const now = Date.now();

  const lastUpdate =
    user.energy_updated_at
      ? new Date(user.energy_updated_at).getTime()
      : now;

  const minutesPassed =
    (now - lastUpdate) / 60000;

  const regenSteps =
    Math.floor(minutesPassed / ENERGY_REGEN_MINUTES);

  let energy = Number(user.energy);

  if (energy >= MAX_ENERGY || regenSteps <= 0) {
    return {
      energy,
      energyUpdatedAt: user.energy_updated_at,
      changed: false
    };
  }

  const newEnergy =
    Math.min(MAX_ENERGY, energy + regenSteps);

  const consumedMs =
    regenSteps * ENERGY_REGEN_MINUTES * 60000;

  const newUpdatedAt =
    new Date(lastUpdate + consumedMs);

  return {
    energy: newEnergy,
    energyUpdatedAt: newUpdatedAt,
    changed: true
  };
}

async function getUserWithFreshEnergy(userId) {
  const user = await getUser(userId);

  if (!user) {
    return null;
  }

  const recalculated = recalcEnergy(user);

  if (!recalculated.changed) {
    return user;
  }

  const updated = await pool.query(
    `
    UPDATE users
    SET
      energy = $1,
      energy_updated_at = $2
    WHERE id = $3
    RETURNING *
    `,
    [
      recalculated.energy,
      recalculated.energyUpdatedAt,
      userId
    ]
  );

  return updated.rows[0];
}

async function spendEnergy(userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error("Foydalanuvchi topilmadi");
    }

    const user = result.rows[0];

    if (user.is_banned) {
      const error = new Error("Foydalanuvchi bloklangan");
      error.code = "BANNED";
      throw error;
    }

    const recalculated = recalcEnergy(user);

    if (recalculated.energy < 1) {
      const error = new Error("Jon yetarli emas");
      error.code = "NO_ENERGY";
      throw error;
    }

    const updated = await client.query(
      `
      UPDATE users
      SET
        energy = $1,
        energy_updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        recalculated.energy - 1,
        userId
      ]
    );

    await client.query("COMMIT");

    return updated.rows[0];

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/* =====================================================
   USER
===================================================== */

async function getUser(userId) {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function createOrUpdateUser(user, referralCode) {
  const inserted = await pool.query(
    `
    INSERT INTO users (
      id,
      username,
      first_name,
      last_name
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO NOTHING
    RETURNING *
    `,
    [
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ]
  );

  const isNewUser = inserted.rows.length > 0;

  if (!isNewUser) {
    const updated = await pool.query(
      `
      UPDATE users
      SET
        username = $1,
        first_name = $2,
        last_name = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [
        user.username || null,
        user.first_name || null,
        user.last_name || null,
        user.id
      ]
    );

    return updated.rows[0];
  }

  // Yangi foydalanuvchi - referral kodi bo'lsa taklif qilgan
  // do'stiga bonus beramiz.
  let finalUser = inserted.rows[0];

  if (referralCode) {
    finalUser =
      await applyReferralBonus(user.id, referralCode) ||
      finalUser;
  }

  return finalUser;
}

async function applyReferralBonus(newUserId, referralCode) {
  const referrerId = Number(referralCode);

  if (!referrerId || referrerId === Number(newUserId)) {
    return null;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const newUserResult = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [newUserId]
    );

    const newUser = newUserResult.rows[0];

    if (!newUser || newUser.referred_by) {
      await client.query("ROLLBACK");
      return null;
    }

    const referrerResult = await client.query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [referrerId]
    );

    if (referrerResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `
      UPDATE users
      SET
        balance = balance + $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [REFERRAL_BONUS_REFERRER, referrerId]
    );

    const updatedNewUser = await client.query(
      `
      UPDATE users
      SET
        balance = balance + $1,
        referred_by = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
      `,
      [REFERRAL_BONUS_NEW_USER, referrerId, newUserId]
    );

    await client.query(
      `
      INSERT INTO transactions (user_id, amount, type)
      VALUES
        ($1, $2, 'referral_bonus_referrer'),
        ($3, $4, 'referral_bonus_new_user')
      `,
      [
        referrerId,
        REFERRAL_BONUS_REFERRER,
        newUserId,
        REFERRAL_BONUS_NEW_USER
      ]
    );

    await client.query("COMMIT");

    return updatedNewUser.rows[0];

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Referral bonus xatosi:", error);
    return null;
  } finally {
    client.release();
  }
}


/* =====================================================
   KUNLIK BONUS
===================================================== */

async function claimDailyBonus(userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error("Foydalanuvchi topilmadi");
    }

    const alreadyToday = await client.query(
      `SELECT (last_bonus_date = CURRENT_DATE) AS claimed FROM users WHERE id = $1`,
      [userId]
    );

    if (alreadyToday.rows[0].claimed) {
      const error = new Error("Bugungi bonus allaqachon olingan");
      error.code = "ALREADY_CLAIMED";
      throw error;
    }

    const updated = await client.query(
      `
      UPDATE users
      SET
        balance = balance + $1,
        last_bonus_date = CURRENT_DATE,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [DAILY_BONUS_AMOUNT, userId]
    );

    await client.query(
      `
      INSERT INTO transactions (user_id, amount, type)
      VALUES ($1, $2, 'daily_bonus')
      `,
      [userId, DAILY_BONUS_AMOUNT]
    );

    await client.query("COMMIT");

    return {
      user: updated.rows[0],
      amount: DAILY_BONUS_AMOUNT
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/* =====================================================
   SKINLAR
===================================================== */

function buildSkinCatalog(user) {
  const owned = user.owned_skins || ["chili_v1"];

  return Object.values(SKINS).map((skin) => ({
    ...skin,
    owned: owned.includes(skin.id),
    equipped: user.equipped_skin === skin.id
  }));
}

async function getSkinCatalog(userId) {
  const user = await getUser(userId);

  if (!user) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  return buildSkinCatalog(user);
}

async function buySkin(userId, skinId) {
  const skin = SKINS[skinId];

  if (!skin) {
    const error = new Error("Skin topilmadi");
    error.code = "SKIN_NOT_FOUND";
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error("Foydalanuvchi topilmadi");
    }

    const user = result.rows[0];
    const owned = user.owned_skins || ["chili_v1"];

    if (owned.includes(skinId)) {
      const updated = await client.query(
        `
        UPDATE users
        SET equipped_skin = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
        `,
        [skinId, userId]
      );

      await client.query("COMMIT");
      return updated.rows[0];
    }

    if (Number(user.balance) < skin.price) {
      const error = new Error("Coin yetarli emas");
      error.code = "NOT_ENOUGH_COINS";
      throw error;
    }

    const newOwned = [...owned, skinId];

    const updated = await client.query(
      `
      UPDATE users
      SET
        balance = balance - $1,
        owned_skins = $2,
        equipped_skin = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [skin.price, newOwned, skinId, userId]
    );

    await client.query(
      `
      INSERT INTO transactions (user_id, amount, type)
      VALUES ($1, $2, 'skin_purchase')
      `,
      [userId, -skin.price]
    );

    await client.query("COMMIT");

    return updated.rows[0];

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/* =====================================================
   COIN QO'SHISH (Stars xaridlari va boshqa manbalar uchun)
===================================================== */

async function addCoins(userId, amount, type) {
  const result = await pool.query(
    `
    UPDATE users
    SET balance = GREATEST(0, balance + $1), updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
    `,
    [amount, userId]
  );

  if (result.rows.length === 0) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  await pool.query(
    `
    INSERT INTO transactions (user_id, amount, type)
    VALUES ($1, $2, $3)
    `,
    [userId, amount, type]
  );

  return result.rows[0];
}


const THEME_IDS = [
  "classic_dark",
  "neon_cyber",
  "fantasy_fire",
  "futuristic_glass",
  "retro_pixel",
  "dark_neon_green",
  "light_theme",
  "space_theme",
  "matrix",
  "gold_premium"
];

async function setUserTheme(userId, theme) {
  if (!THEME_IDS.includes(theme)) {
    const error = new Error("Noto'g'ri mavzu");
    error.code = "INVALID_THEME";
    throw error;
  }

  const result = await pool.query(
    `
    UPDATE users
    SET theme = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
    `,
    [theme, userId]
  );

  if (result.rows.length === 0) {
    throw new Error("Foydalanuvchi topilmadi");
  }

  return result.rows[0];
}


/* =====================================================
   ADMIN
===================================================== */

async function getAdminStats() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_users,
      COALESCE(SUM(balance), 0)::bigint AS total_coins,
      COALESCE(SUM(wins + losses), 0)::bigint AS total_games,
      COUNT(*) FILTER (WHERE is_banned)::int AS total_banned
    FROM users
  `);

  return result.rows[0];
}

async function getRevenueStats(limit = 10) {
  const totals = await pool.query(`
    SELECT
      COALESCE(SUM(stars_amount), 0)::bigint AS total_stars,
      COUNT(*)::int AS total_purchases
    FROM stars_payments
  `);

  const recent = await pool.query(
    `
    SELECT
      sp.stars_amount,
      sp.coins_amount,
      sp.created_at,
      u.first_name,
      u.username,
      u.id AS user_id
    FROM stars_payments sp
    JOIN users u ON u.id = sp.user_id
    ORDER BY sp.created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return {
    totalStars: totals.rows[0].total_stars,
    totalPurchases: totals.rows[0].total_purchases,
    recent: recent.rows
  };
}

async function recordStarsPayment(userId, packageId, starsAmount, coinsAmount, chargeId) {
  await pool.query(
    `
    INSERT INTO stars_payments (
      user_id, package_id, stars_amount, coins_amount, telegram_charge_id
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [userId, packageId, starsAmount, coinsAmount, chargeId || null]
  );
}

async function findUserByIdOrUsername(query) {
  const numericId = Number(query);

  if (!Number.isNaN(numericId) && numericId > 0) {
    const byId = await getUser(numericId);
    if (byId) {
      return byId;
    }
  }

  const cleanUsername = query.replace(/^@/, "");

  const result = await pool.query(
    `SELECT * FROM users WHERE username ILIKE $1 LIMIT 1`,
    [cleanUsername]
  );

  return result.rows[0] || null;
}

async function setBanned(userId, banned) {
  const result = await pool.query(
    `
    UPDATE users
    SET is_banned = $1, updated_at = CURRENT_TIMESTAMP
    WHERE id = $2
    RETURNING *
    `,
    [banned, userId]
  );

  return result.rows[0] || null;
}

async function getAllUserIds() {
  const result = await pool.query(
    `SELECT id FROM users WHERE is_banned = false`
  );

  return result.rows.map((row) => row.id);
}


/* =====================================================
   O'YIN NATIJASI
===================================================== */

async function updateGameResult(userId, result) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error("Foydalanuvchi topilmadi");
    }

    const user = userResult.rows[0];

    let balanceChange = 0;
    let newWins = user.wins;
    let newLosses = user.losses;
    let newStreak = user.streak;
    let xpChange = 0;
    let transactionType = "";

    if (result === "win") {
      balanceChange = 20;
      newWins += 1;
      newStreak += 1;
      xpChange = 50;
      transactionType = "game_win";
    } else if (result === "loss") {
      balanceChange = 0;
      newLosses += 1;
      newStreak = 0;
      xpChange = 10;
      transactionType = "game_loss";
    } else {
      throw new Error("Noto‘g‘ri o‘yin natijasi");
    }

    const newBalance = Math.max(
      0,
      Number(user.balance) + balanceChange
    );

    const newXp = Number(user.xp) + xpChange;

    const newLevel = Math.max(
      1,
      Math.floor(newXp / 100) + 1
    );

    const updated = await client.query(
      `
      UPDATE users
      SET
        balance = $1,
        wins = $2,
        losses = $3,
        streak = $4,
        xp = $5,
        level = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
      `,
      [
        newBalance,
        newWins,
        newLosses,
        newStreak,
        newXp,
        newLevel,
        userId
      ]
    );

    await client.query(
      `
      INSERT INTO transactions (
        user_id,
        amount,
        type
      )
      VALUES ($1, $2, $3)
      `,
      [
        userId,
        balanceChange,
        transactionType
      ]
    );

    await client.query("COMMIT");

    return updated.rows[0];

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getLeaderboard(limit = 20) {
  const result = await pool.query(
    `
    SELECT
      id,
      username,
      first_name,
      balance,
      wins,
      losses,
      streak,
      level,
      xp
    FROM users
    ORDER BY balance DESC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}

module.exports = {
  pool,
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
  setUserTheme,
  THEME_IDS,
  MAX_ENERGY,
  ENERGY_REGEN_MINUTES,
  SKINS
};
