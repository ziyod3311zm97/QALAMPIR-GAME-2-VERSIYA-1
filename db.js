const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

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

  console.log("PostgreSQL database tayyor.");
}

async function getUser(userId) {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function createOrUpdateUser(user) {
  const result = await pool.query(
    `
    INSERT INTO users (
      id,
      username,
      first_name,
      last_name
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [
      user.id,
      user.username || null,
      user.first_name || null,
      user.last_name || null
    ]
  );

  return result.rows[0];
}

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
      balanceChange = 100;
      newWins += 1;
      newStreak += 1;
      xpChange = 50;
      transactionType = "game_win";
    } else if (result === "loss") {
      balanceChange = -10;
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
  getLeaderboard
};
