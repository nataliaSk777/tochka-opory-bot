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
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id BIGINT PRIMARY KEY,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      program_type TEXT NOT NULL DEFAULT 'none',
      current_day INT NOT NULL DEFAULT 1,
      support_step INT NOT NULL DEFAULT 1,
      last_morning_sent_key TEXT,
      last_evening_sent_key TEXT,
      paid_until TIMESTAMPTZ,
      last_payment_id TEXT,
      awaiting_review BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // миграции на случай старой таблицы
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_payment_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS awaiting_review BOOLEAN NOT NULL DEFAULT FALSE;`);

  // deliveries (защита от дублей + “одноразовые” события типа просьбы об отзыве)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deliveries (
      chat_id BIGINT NOT NULL,
      kind TEXT NOT NULL,          -- 'morning' | 'evening' | 'review_ask' | ...
      send_key TEXT NOT NULL,      -- например '2026-02-19'
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      error TEXT,
      PRIMARY KEY (chat_id, kind, send_key)
    );
  `);

  // reviews
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text TEXT NOT NULL,
      program_type TEXT,
      current_day INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
    paidUntil: r.paid_until ? new Date(r.paid_until).toISOString() : null,
    lastPaymentId: r.last_payment_id || null,
    awaitingReview: !!r.awaiting_review
  };
}

async function getUser(chatId) {
  const res = await pool.query(`SELECT * FROM users WHERE chat_id = $1`, [String(chatId)]);
  if (!res.rows.length) return null;
  return rowToUser(res.rows[0]);
}

async function upsertUser(u) {
  await pool.query(
    `INSERT INTO users (
        chat_id, is_active, program_type, current_day, support_step,
        last_morning_sent_key, last_evening_sent_key, paid_until, last_payment_id,
        awaiting_review, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       program_type = EXCLUDED.program_type,
       current_day = EXCLUDED.current_day,
       support_step = EXCLUDED.support_step,
       last_morning_sent_key = EXCLUDED.last_morning_sent_key,
       last_evening_sent_key = EXCLUDED.last_evening_sent_key,
       paid_until = EXCLUDED.paid_until,
       last_payment_id = EXCLUDED.last_payment_id,
       awaiting_review = EXCLUDED.awaiting_review,
       updated_at = NOW()`,
    [
      String(u.chatId),
      !!u.isActive,
      String(u.programType || 'none'),
      Number(u.currentDay || 1),
      Number(u.supportStep || 1),
      u.lastMorningSentKey || null,
      u.lastEveningSentKey || null,
      u.paidUntil ? new Date(u.paidUntil) : null,
      u.lastPaymentId || null,
      !!u.awaitingReview
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
    paidUntil: null,
    lastPaymentId: null,
    awaitingReview: false
  };

  await upsertUser(u);
  return u;
}

/**
 * Защита от дублей/повторов событий: вернёт true, если “забронировали” событие.
 */
async function claimDelivery(chatId, kind, sendKey) {
  const res = await pool.query(
    `INSERT INTO deliveries (chat_id, kind, send_key)
     VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [String(chatId), String(kind), String(sendKey)]
  );
  return res.rowCount === 1;
}

async function markDeliverySent(chatId, kind, sendKey) {
  await pool.query(
    `UPDATE deliveries
     SET sent_at = NOW(), error = NULL
     WHERE chat_id = $1 AND kind = $2 AND send_key = $3`,
    [String(chatId), String(kind), String(sendKey)]
  );
}

async function markDeliveryError(chatId, kind, sendKey, errorText) {
  await pool.query(
    `UPDATE deliveries
     SET error = $4
     WHERE chat_id = $1 AND kind = $2 AND send_key = $3`,
    [String(chatId), String(kind), String(sendKey), String(errorText || 'error')]
  );
}

async function addReview({ chatId, text, programType, currentDay }) {
  const res = await pool.query(
    `INSERT INTO reviews (chat_id, text, program_type, current_day)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [
      String(chatId),
      String(text || '').trim(),
      programType ? String(programType) : null,
      currentDay != null ? Number(currentDay) : null
    ]
  );
  return res.rows && res.rows[0] ? Number(res.rows[0].id) : null;
}

async function countReviews() {
  const res = await pool.query(`SELECT COUNT(*)::int AS c FROM reviews`);
  return res.rows && res.rows[0] ? Number(res.rows[0].c) : 0;
}

module.exports = {
  init,
  getUser,
  upsertUser,
  listUsers,
  ensureUser,
  claimDelivery,
  markDeliverySent,
  markDeliveryError,
  addReview,
  countReviews
};
