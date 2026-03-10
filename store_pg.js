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
      pending_payment_id TEXT,
      pending_plan TEXT,
      receipt_email TEXT,
      awaiting_receipt_email BOOLEAN NOT NULL DEFAULT FALSE,

      -- ✅ экстренная помощь по стране
      country_code TEXT,
      awaiting_country_name BOOLEAN NOT NULL DEFAULT FALSE,

      awaiting_review BOOLEAN NOT NULL DEFAULT FALSE,
      review_postponed BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // миграции на случай старой таблицы
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_payment_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_payment_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_plan TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS receipt_email TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS awaiting_receipt_email BOOLEAN NOT NULL DEFAULT FALSE;`);

  // ✅ экстренная помощь по стране
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS awaiting_country_name BOOLEAN NOT NULL DEFAULT FALSE;`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS awaiting_review BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS review_postponed BOOLEAN NOT NULL DEFAULT FALSE;`);

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

  // ускорение выборок по дню
  await pool.query(`CREATE INDEX IF NOT EXISTS deliveries_send_key_idx ON deliveries (send_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS deliveries_send_key_kind_idx ON deliveries (send_key, kind);`);

  // reviews
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text TEXT NOT NULL,
      program_type TEXT,
      current_day INT,
      allow_public_use BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // миграция для старой таблицы reviews
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS allow_public_use BOOLEAN;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS reviews_created_at_idx ON reviews (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS reviews_chat_id_idx ON reviews (chat_id);`);
}

function rowToUser(r) {
  const awaitingCountry = !!r.awaiting_country_name;

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

    // ✅ оплата/ожидание оплаты
    pendingPaymentId: r.pending_payment_id || null,
    pendingPlan: r.pending_plan || null,

    // ✅ email для чека
    receiptEmail: r.receipt_email || null,
    awaitingReceiptEmail: !!r.awaiting_receipt_email,

    // ✅ экстренная помощь по стране
    countryCode: r.country_code || null,
    awaitingCountryName: awaitingCountry,
    awaitingCountryCode: awaitingCountry,

    // ✅ отзывы
    awaitingReview: !!r.awaiting_review,
    reviewPostponed: !!r.review_postponed
  };
}

async function getUser(chatId) {
  const res = await pool.query(`SELECT * FROM users WHERE chat_id = $1`, [String(chatId)]);
  if (!res.rows.length) return null;
  return rowToUser(res.rows[0]);
}

async function upsertUser(u) {
  const awaitingCountry = !!(u.awaitingCountryCode || u.awaitingCountryName);

  await pool.query(
    `INSERT INTO users (
        chat_id, is_active, program_type, current_day, support_step,
        last_morning_sent_key, last_evening_sent_key, paid_until, last_payment_id,
        pending_payment_id, pending_plan,
        receipt_email, awaiting_receipt_email,
        country_code, awaiting_country_name,
        awaiting_review, review_postponed, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (chat_id) DO UPDATE SET
       is_active = EXCLUDED.is_active,
       program_type = EXCLUDED.program_type,
       current_day = EXCLUDED.current_day,
       support_step = EXCLUDED.support_step,
       last_morning_sent_key = EXCLUDED.last_morning_sent_key,
       last_evening_sent_key = EXCLUDED.last_evening_sent_key,
       paid_until = EXCLUDED.paid_until,
       last_payment_id = EXCLUDED.last_payment_id,
       pending_payment_id = EXCLUDED.pending_payment_id,
       pending_plan = EXCLUDED.pending_plan,
       receipt_email = EXCLUDED.receipt_email,
       awaiting_receipt_email = EXCLUDED.awaiting_receipt_email,
       country_code = EXCLUDED.country_code,
       awaiting_country_name = EXCLUDED.awaiting_country_name,
       awaiting_review = EXCLUDED.awaiting_review,
       review_postponed = EXCLUDED.review_postponed,
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

      u.pendingPaymentId || null,
      u.pendingPlan || null,

      u.receiptEmail || null,
      !!u.awaitingReceiptEmail,

      u.countryCode ? String(u.countryCode) : null,
      awaitingCountry,

      !!u.awaitingReview,
      !!u.reviewPostponed
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

    pendingPaymentId: null,
    pendingPlan: null,

    receiptEmail: null,
    awaitingReceiptEmail: false,

    countryCode: null,
    awaitingCountryName: false,
    awaitingCountryCode: false,

    awaitingReview: false,
    reviewPostponed: false
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

/**
 * Статистика доставок за конкретный день (send_key), сгруппировано по kind.
 * Возвращает структуру, которую ждёт bot.js в /deliveries.
 */
async function getDeliveryStatsByDay(sendKey) {
  const key = String(sendKey || '').trim();
  if (!key) {
    return {
      sendKey: '',
      totalAll: 0,
      sentAll: 0,
      errorsAll: 0,
      byKind: {}
    };
  }

  const res = await pool.query(
    `
      SELECT
        kind,
        COUNT(*)::int AS total,
        COUNT(sent_at)::int AS sent,
        COUNT(CASE WHEN error IS NOT NULL THEN 1 END)::int AS errors
      FROM deliveries
      WHERE send_key = $1
      GROUP BY kind
    `,
    [key]
  );

  const byKind = {};
  let totalAll = 0;
  let sentAll = 0;
  let errorsAll = 0;

  for (const r of res.rows) {
    const kind = String(r.kind);
    const total = Number(r.total || 0);
    const sent = Number(r.sent || 0);
    const errors = Number(r.errors || 0);

    byKind[kind] = { total, sent, errors };

    totalAll += total;
    sentAll += sent;
    errorsAll += errors;
  }

  return { sendKey: key, totalAll, sentAll, errorsAll, byKind };
}

async function addReview({ chatId, text, programType, currentDay, allowPublicUse = null }) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const res = await pool.query(
    `INSERT INTO reviews (chat_id, text, program_type, current_day, allow_public_use)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [
      String(chatId),
      clean,
      programType ? String(programType) : null,
      currentDay != null ? Number(currentDay) : null,
      allowPublicUse == null ? null : !!allowPublicUse
    ]
  );
  return res.rows && res.rows[0] ? Number(res.rows[0].id) : null;
}

async function setReviewPublicPermission(reviewId, allowPublicUse) {
  if (!reviewId) return;
  await pool.query(
    `UPDATE reviews
     SET allow_public_use = $2
     WHERE id = $1`,
    [Number(reviewId), !!allowPublicUse]
  );
}

async function countReviews() {
  const res = await pool.query(`SELECT COUNT(*)::int AS c FROM reviews`);
  return res.rows && res.rows[0] ? Number(res.rows[0].c) : 0;
}

async function close() {
  try {
    await pool.end();
  } catch (_) {}
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
  getDeliveryStatsByDay,
  addReview,
  setReviewPublicPermission,
  countReviews,
  close
};
