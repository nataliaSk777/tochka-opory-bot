'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id BIGINT PRIMARY KEY,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      program_type TEXT NOT NULL DEFAULT 'none',
      current_day INT NOT NULL DEFAULT 1,
      support_step INT NOT NULL DEFAULT 1,
      last_morning_sent_key TEXT,
      last_evening_sent_key TEXT,

      -- debug /dbtest
      db_test_counter INT NOT NULL DEFAULT 0,
      db_test_last_at TIMESTAMPTZ,

      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // На случай, если таблица уже была создана раньше без этих колонок:
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS db_test_counter INT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS db_test_last_at TIMESTAMPTZ;`);
}

function rowToUser(r) {
  return {
    chatId: Number(r.chat_id),
    isActive: !!r.is_active,
    programType: r.program_type,
    currentDay: Number(r.current_day),
    supportStep: Number(r.support_step),
    lastMorningSentKey: r.last_morning_sent_key,
    lastEveningSentKey: r.last_evening_sent_key,

    // debug /dbtest
    dbTestCounter: Number(r.db_test_counter || 0),
    dbTestLastAt: r.db_test_last_at ? String(r.db_test_last_at) : null
  };
}

async function getUser(chatId) {
  const res = await pool.query(
    `SELECT * FROM users WHERE chat_id = $1`,
    [String(chatId)]
  );
  if (!res.rows.length) return null;
  return rowToUser(res.rows[0]);
}

async function upsertUser(u) {
  await pool.query(
    `INSERT INTO users (
       chat_id,
       is_active,
       program_type,
       current_day,
       support_step,
       last_morning_sent_key,
       last_evening_sent_key,
       db_test_counter,
       db_test_last_at,
       updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       program_type = EXCLUDED.program_type,
       current_day = EXCLUDED.current_day,
       support_step = EXCLUDED.support_step,
       last_morning_sent_key = EXCLUDED.last_morning_sent_key,
       last_evening_sent_key = EXCLUDED.last_evening_sent_key,
       db_test_counter = EXCLUDED.db_test_counter,
       db_test_last_at = EXCLUDED.db_test_last_at,
       updated_at = NOW()`,
    [
      String(u.chatId),
      !!u.isActive,
      String(u.programType || 'none'),
      Number(u.currentDay || 1),
      Number(u.supportStep || 1),
      u.lastMorningSentKey || null,
      u.lastEveningSentKey || null,

      // debug /dbtest
      Number(u.dbTestCounter || 0),
      u.dbTestLastAt ? new Date(u.dbTestLastAt) : null
    ]
  );
  return u;
}

async function listUsers() {
  const res = await pool.query(`SELECT * FROM users ORDER BY updated_at DESC`);
  return res.rows.map(rowToUser);
}

async function ensureUser(chatId) {
  const existing = await getUser(chatId);
  if (existing) return existing;

  const u = {
    chatId: Number(chatId),
    isActive: true,
    programType: 'none',
    currentDay: 1,
    supportStep: 1,
    lastMorningSentKey: null,
    lastEveningSentKey: null,

    dbTestCounter: 0,
    dbTestLastAt: null
  };

  await upsertUser(u);
  return u;
}

module.exports = { init, getUser, upsertUser, listUsers, ensureUser };
