
// ========================= bot.js (PART 1/4) =========================
'use strict';

require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');

// ✅ YooKassa (safe require: бот не падает, даже если пакет не установился)
let YooKassa = null;
try {
  // eslint-disable-next-line global-require
  YooKassa = require('yookassa');
} catch (e) {
  console.error('[payments] yookassa module not found. Payments disabled until dependency is installed.');
}

const store = require('./store_pg');
const { runMorning } = require('./jobs_morning');
const { runEvening } = require('./jobs_evening');

// ✅ content: утро/вечер + “возвраты в течение дня”
const {
  getPauseText,
  getCheckText,
  getSupportText,
  getBackText
} = require('./content');

/* ============================================================================
   Boot safety
============================================================================ */

process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION:', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION:', e));

/* ============================================================================
   Env / constants
============================================================================ */

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

// Твой owner id (для админ-команд)
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';

// ✅ YooKassa env (поддерживаем оба набора имён переменных)
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || process.env.SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || process.env.SECRET_KEY || '';

// Базовый публичный URL сервиса (Railway домен). Поддержим BASE_URL и PUBLIC_URL.
const BASE_URL = process.env.BASE_URL || process.env.PUBLIC_URL || '';

// Цена 30 дней (в RUB). Можно переопределить в env.
const PRICE_30_RUB = String(process.env.PRICE_30_RUB || '299.00');

// Опциональная защита webhook через Basic Auth
const YOOKASSA_WEBHOOK_USER = process.env.YOOKASSA_WEBHOOK_USER || '';
const YOOKASSA_WEBHOOK_PASS = process.env.YOOKASSA_WEBHOOK_PASS || '';

const PORT = Number(process.env.PORT || 8080);

/* ============================================================================
   Telegraf webhook mode (fix 409 getUpdates conflict)
============================================================================ */

const USE_WEBHOOK = (process.env.USE_WEBHOOK != null)
  ? /^(1|true|yes)$/i.test(String(process.env.USE_WEBHOOK))
  : Boolean(BASE_URL);

function makeWebhookPathFromToken(token) {
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  return `/telegraf/${h.slice(0, 32)}`;
}

const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || makeWebhookPathFromToken(BOT_TOKEN);

/* ============================================================================
   Payments (YooKassa)
============================================================================ */

const yooKassa = (YooKassa && YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY)
  ? new YooKassa({ shopId: YOOKASSA_SHOP_ID, secretKey: YOOKASSA_SECRET_KEY })
  : null;

function havePaymentsEnabled() {
  return !!(yooKassa && BASE_URL);
}

function parseBasicAuth(req) {
  const h = req.headers && req.headers.authorization ? String(req.headers.authorization) : '';
  if (!h.startsWith('Basic ')) return null;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
}

function checkWebhookAuth(req) {
  if (!YOOKASSA_WEBHOOK_USER && !YOOKASSA_WEBHOOK_PASS) return true;
  const creds = parseBasicAuth(req);
  if (!creds) return false;
  return creds.user === YOOKASSA_WEBHOOK_USER && creds.pass === YOOKASSA_WEBHOOK_PASS;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;

      data += chunk;
      if (data.length > 1024 * 1024) {
        aborted = true;
        try { req.destroy(); } catch (_) {}
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => {
      if (aborted) return;
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });

    req.on('error', (e) => {
      if (aborted) return;
      reject(e);
    });
  });
}

function makeIdempotencyKey() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidEmail(s) {
  const t = String(s || '').trim();
  if (t.length < 6 || t.length > 200) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(t);
}

async function createPayment30Days(chatId, receiptEmail) {
  if (!havePaymentsEnabled()) {
    throw new Error('Payments not configured: set (SHOP_ID|YOOKASSA_SHOP_ID), (SECRET_KEY|YOOKASSA_SECRET_KEY), (BASE_URL|PUBLIC_URL)');
  }

  if (!isValidEmail(receiptEmail)) {
    throw new Error('Receipt email is required');
  }

  const idempotencyKey = makeIdempotencyKey();
  const base = BASE_URL.replace(/\/$/, '');

  const payment = await yooKassa.createPayment(
    {
      amount: { value: PRICE_30_RUB, currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: `${base}/success`
      },
      description: 'Точка опоры — 30 дней',
      metadata: {
        plan: 'paid_30',
        chatId: String(chatId)
      },
      receipt: {
        customer: { email: String(receiptEmail).trim() },
        items: [
          {
            description: 'Подписка «Точка опоры» — 30 дней',
            quantity: 1,
            amount: { value: PRICE_30_RUB, currency: 'RUB' },
            vat_code: 1
          }
        ]
      }
    },
    idempotencyKey
  );

  const url = payment && payment.confirmation ? payment.confirmation.confirmation_url : null;
  const paymentId = payment && payment.id ? String(payment.id) : null;

  if (!url || !paymentId) {
    throw new Error('Failed to create payment: missing confirmation_url or payment.id');
  }

  return { url, paymentId };
}

/* ============================================================================
   Time helpers (Moscow time, stable on Railway)
============================================================================ */

const MOSCOW_TZ = 'Europe/Moscow';

function moscowParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);

  const get = (t) => {
    const p = parts.find(x => x.type === t);
    return p ? p.value : null;
  };

  const y = get('year');
  const m = get('month');
  const day = get('day');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const second = Number(get('second'));

  const key = `${y}-${m}-${day}`;
  const isoLike = `${key} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

  return { key, hour, minute, second, isoLike };
}

function moscowDayKey(d = new Date()) {
  return moscowParts(d).key;
}

/* ============================================================================
   Bot instance
============================================================================ */

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error('[telegraf] error', {
    updateType: ctx && ctx.updateType,
    chatId: ctx && ctx.chat && ctx.chat.id,
    message: err && err.message,
    stack: err && err.stack
  });
});

/* ============================================================================
   Small helpers
============================================================================ */

console.log('BOOT', new Date().toISOString(), 'tzOffsetMin=', new Date().getTimezoneOffset());
async function sendWithPace(ctx, text, ms = 400) {
  try { await ctx.reply(text); } catch (_) {}
  if (ms > 0) {
    await new Promise(r => setTimeout(r, ms));
  }
}
async function safeAnswerCbQuery(ctx) {
  try { await ctx.answerCbQuery(); } catch (_) {}
}

function isActiveProgram(u) {
  return !!(u && u.isActive && u.programType && u.programType !== 'none');
}

function isOwnerStrict(ctx) {
  const ownerIdRaw = OWNER_CHAT_ID;
  if (!ownerIdRaw) return false;
  const ownerId = Number(ownerIdRaw);
  if (!Number.isFinite(ownerId)) return false;
  return !!(ctx && ctx.chat && ctx.chat.id === ownerId);
}

/* ============================================================================
   FIRST IMPRESSION 10/10 (on /start)
   - без session middleware: держим состояние в памяти процесса (Map)
   - не ломает остальной код, не требует миграций БД
============================================================================ */

const firstImpression = new Map(); // chatId -> { step, mood, palms, startedAt }
const fiTimers = new Map(); // chatId -> timeoutId

function fiClearTimer(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) return;
  const t = fiTimers.get(id);
  if (t) {
    try { clearTimeout(t); } catch (_) {}
    fiTimers.delete(id);
  }
}

function fiSetTimer(chatId, fn, ms) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) return;
  fiClearTimer(id);
  const t = setTimeout(() => {
    try { fn(); } catch (_) {}
  }, ms);
  fiTimers.set(id, t);
}

function fiNudgeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Продолжим', 'FI_CONTINUE')],
    [Markup.button.callback('🏠 Меню', 'FI_MENU')]
  ]);
}

async function fiSendNudgeIfStill(chatId) {
  const st = fiGet(chatId);
  if (!st) return;

  // если сценарий уже завершён/сброшен — не трогаем
  if (!['mood_asked', 'palms_asked', 'end_asked'].includes(st.step)) return;

  let u = null;
  try { u = await store.ensureUser(chatId); } catch (_) {}

  const text = [
    'Я тут.',
    '',
    'Можно продолжить — или вернуться в меню.'
  ].join('\n');

  try {
    await bot.telegram.sendMessage(chatId, text, fiNudgeKeyboard());
  } catch (_) {}

  // на всякий — если человек хочет просто меню без кнопок
  // (не спамим: это одно сообщение-подхват)
  try { void u; } catch (_) {}
}
function fiGet(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) return null;
  return firstImpression.get(id) || null;
}

function fiReset(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) return;
  fiClearTimer(id);
  firstImpression.delete(id);
}

function fiEnsure(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id)) return null;

  let st = firstImpression.get(id);
  if (!st) {
    st = { step: 'idle', mood: null, palms: null, startedAt: Date.now() };
    firstImpression.set(id, st);
  }
  return st;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendWithPace(ctx, text, ms = 900) {
  if (!ctx || !ctx.chat || !ctx.chat.id) return;
  await ctx.reply(text, { disable_web_page_preview: true });
  await sleep(ms);
}

function fiMoodKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('😮‍💨 немного напряжена', 'FI_MOOD_TENSE')],
    [Markup.button.callback('🥱 устала', 'FI_MOOD_TIRED')],
    [Markup.button.callback('🌿 спокойно', 'FI_MOOD_CALM')],
    [Markup.button.callback('🤷‍♀️ не понимаю', 'FI_MOOD_UNSURE')]
  ]);
}

function fiPalmsKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔥 тёплые', 'FI_PALMS_WARM')],
    [Markup.button.callback('❄️ прохладные', 'FI_PALMS_COOL')],
    [Markup.button.callback('🙂 нейтрально', 'FI_PALMS_NEUTRAL')],
    [Markup.button.callback('🤷‍♀️ сложно сказать', 'FI_PALMS_UNSURE')]
  ]);
}

function fiEndKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✨ хочу ещё', 'FI_MORE')],
    [Markup.button.callback('✅ достаточно', 'FI_DONE')]
  ]);
}

function fiMirrorMood(mood) {
  if (mood === 'tired') return 'Тогда давай очень мягко. Без усилия. Только заметить.';
  if (mood === 'tense') return 'Ок. Тогда мы не “расслабляемся”, а просто чуть уменьшаем давление внутри.';
  if (mood === 'calm') return 'Супер. Тогда сохраним это состояние — аккуратно, без разгона.';
  return 'Нормально, что сейчас непонятно. Давай без “правильных” ощущений — просто отметим факт.';
}

function fiHaiku() {
  return `Тихий выдох
плечи опускаются
внутри яснее`;
}

async function runFirstImpression(ctx) {
  const st = fiEnsure(ctx.chat.id);
  if (!st) return;

  // анти-двойной запуск
  if (st.step !== 'idle') return;

  st.step = 'mood_asked';

  await sendWithPace(ctx, '…', 800);
  await sendWithPace(ctx, 'Ты здесь.', 900);
  await sendWithPace(ctx, 'Сейчас можно чуть выдохнуть.', 900);

  await ctx.reply('Как ты сейчас?', fiMoodKeyboard());
  // мягкий автоподхват, если человек завис
fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
}

/* ============================================================================
   Day Return (anti “lost among chats”)
============================================================================ */

function dayReturnSeed(ctx) {
  const p = moscowParts(new Date());
  const chatId = ctx && ctx.chat && ctx.chat.id ? Number(ctx.chat.id) : 0;
  const base = `${p.key}:${Number.isFinite(chatId) ? chatId : 0}`;

  let h = 0;
  for (let i = 0; i < base.length; i += 1) {
    h = ((h << 5) - h) + base.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) + 1;
}

function dayReturnText(kind, seed) {
  if (kind === 'pause') return getPauseText(seed);
  if (kind === 'check') return getCheckText(seed);
  if (kind === 'support') return getSupportText(seed);
  if (kind === 'back') return getBackText(seed);
  return null;
}

async function sendDayReturn(ctx, kind) {
  const u = await store.ensureUser(ctx.chat.id);

  if (u && u.awaitingReview) {
    await ctx.reply(
      [
        'Я вижу, ты в отзыве.',
        '',
        'Если хочется — можно дописать пару строк одним сообщением.',
        'А “пауза/поддержка” — в любой момент после.'
      ].join('\n'),
      reviewKeyboard()
    );
    return;
  }

  const seed = dayReturnSeed(ctx);
  const t = dayReturnText(kind, seed);

  if (!t) {
    await ctx.reply('Можно вернуться сюда позже. Я рядом.', mainKeyboard(u));
    return;
  }

  await ctx.reply(t, mainKeyboard(u));
}

/* ============================================================================
   Texts
============================================================================ */

const SAFETY_INTRO = `Этот бот помогает мягко возвращать внимание к телу и немного замедляться.

Он не заменяет психологическую или медицинскую помощь.

Если тебе сейчас тяжело или появляются мысли о причинении себе вреда —
важно обратиться к живому человеку:
к близким, специалисту или на линию поддержки.

Здесь можно идти в своём темпе.
И можно остановиться в любой момент.`;

const SAFETY_SUPPORT_TEXT = `Я рядом.

Если сейчас тяжело — можно ничего не делать.
Даже просто прочитать — уже достаточно.

Можно сделать один мягкий выдох.
И почувствовать опору — например, стопы или спину.

Ты не обязана справляться с этим в одиночку.

Если есть возможность —
напиши кому-то из близких
или обратись к специалисту.

Если состояние острое —
лучше обратиться на линию помощи в твоей стране
или в экстренные службы.

Ты важна.
И помощь рядом.`;

const SAFETY_RESOURCES_TEXT = `Если состояние тяжёлое — лучше обратиться к живому человеку.

Варианты, которые обычно помогают быстро:
— написать близкому (даже коротко: “мне сейчас тяжело, побудь со мной”)
— обратиться к психологу/психотерапевту
— если есть риск причинить себе вред — экстренные службы

Если скажешь, в какой ты стране —
я подскажу, где искать линии помощи и поддержку.`;

function startText() {
  return [
    'Привет.',
    '',
    'Это «Точка опоры».',
    '',
    'Короткие утренние и вечерние сообщения,',
    'которые помогают возвращаться в тело',
    'и чувствовать больше устойчивости внутри.',
    '',
    'Утром — 1–2 минуты через дыхание и внимание.',
    'Вечером — мягкое завершение дня.',
    '',
    'Можно просто попробовать первую неделю.',
    '',
    'Важно: бот не заменяет психологическую или медицинскую помощь.',
    'Если тебе сейчас тяжело — нажми «Мне сейчас тяжело».'
  ].join('\n');
}

function howText(u) {
  const lineStop = isActiveProgram(u)
    ? 'Остановить можно в любой момент: нажми кнопку ниже или напиши «стоп» / /stop.'
    : 'Если захочешь остановить — это можно сделать в любой момент: «стоп» / /stop.';

  return [
    'Как это работает:',
    '',
    '— Утро (7:30 по Москве): 1–2 минуты через тело.',
    '— Вечер (20:30 по Москве): мягкое завершение дня.',
    '',
    'Сначала — первая неделя.',
    'Потом (если захочется) — 30 дней глубже.',
    'После — поддержка 3 раза в неделю.',
    '',
    'Маленький секрет: можно заходить сюда и днём —',
    'на “Пауза / Проверить себя / Поддержка”.',
    '',
    lineStop
  ].join('\n');
}

function afterStartText() {
  return [
    'Хорошо.',
    '',
    'Завтра в 7:30 придёт первое утреннее сообщение.',
    'Сегодня можно просто опустить плечи',
    'и сделать длинный выдох.',
    'Этого достаточно.'
  ].join('\n');
}

function stoppedText() {
  return [
    'Остановила отправку сообщений.',
    'Если захочешь вернуться — нажми «🌿 Вернуться».'
  ].join('\n');
}

function backText() {
  return [
    '🌿 Возвращаю.',
    '',
    'Завтра в 7:30 придёт следующее утреннее сообщение.',
    'Сегодня можно сделать один длинный выдох.',
    'Этого достаточно.'
  ].join('\n');
}

function subscriptionText(u) {
  const weekFinished = (u && u.programType === 'free' && Number(u.currentDay) >= 7);

  if (u && u.programType === 'paid') {
    return [
      '✅ У тебя активны 30 дней.',
      '',
      'Если захочешь продолжить потом — я предложу формат поддержки.'
    ].join('\n');
  }

  if (u && u.programType === 'support') {
    return [
      '✅ Сейчас включена поддержка.',
      '',
      'Это короткие возвращения к телу 3 раза в неделю.',
      'И плюс — можно пользоваться “Пауза/Проверить себя/Поддержка” в любой момент.'
    ].join('\n');
  }

  if (weekFinished) {
    return [
      'Эта неделя подходит к концу.',
      '',
      'Если внутри стало хоть немного спокойнее — это уже движение.',
      'Такой ритм можно продолжить ещё на 30 дней —',
      'чтобы состояние закрепилось и стало устойчивее.',
      '',
      'Можно пойти дальше.',
      'А можно просто сохранить то, что уже появилось.',
      '',
      'Я рядом в любом случае.'
    ].join('\n');
  }

  return [
    'Подписка понадобится, если захочешь продолжить после первой недели.',
    'Сейчас можно идти шаг за шагом — без спешки.'
  ].join('\n');
}

/* ============================================================================
   UI
============================================================================ */

function mainKeyboard(u) {
  if (!isActiveProgram(u)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🌿 Попробовать первую неделю', 'START_FREE')],
      [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
      [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
      [Markup.button.callback('ℹ️ Как это работает', 'HOW')],
      [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')]
    ]);
  }

  if (u && u.programType === 'free') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⛔️ Остановить', 'STOP')],
      [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
      [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
      [Markup.button.callback('ℹ️ Как это работает', 'HOW')],
      [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')],
      [Markup.button.callback('🔄 Начать заново', 'RESTART')]
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback('⛔️ Остановить', 'STOP')],
    [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
    [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
    [Markup.button.callback('ℹ️ Как это работает', 'HOW')],
    [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')]
  ]);
}

function howKeyboard(u) {
  if (isActiveProgram(u)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
      [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
      [Markup.button.callback('⛔️ Остановить', 'STOP')],
      [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
    [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
    [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')],
    [Markup.button.callback('⬅️ Назад', 'BACK')]
  ]);
}

function subscriptionKeyboard(u) {
  const weekFinished = (u && u.programType === 'free' && Number(u.currentDay) >= 7);
  if (weekFinished) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Продолжить на 30 дней', 'BUY_30')],
      [Markup.button.callback('Пока не сейчас', 'SUB_LATER')]
    ]);
  }
  return mainKeyboard(u);
}

function stoppedKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌿 Вернуться', 'RESUME')],
    [Markup.button.callback('🫧 Пауза', 'DAY_PAUSE'), Markup.button.callback('🧭 Проверить себя', 'DAY_CHECK')],
    [Markup.button.callback('🧺 Поддержка', 'DAY_SUPPORT')],
    [Markup.button.callback('ℹ️ Как это работает', 'HOW')],
    [Markup.button.callback('🫶 Мне сейчас тяжело', 'NEED_HELP')]
  ]);
}

function receiptEmailKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⬅️ Назад', 'BACK')]
  ]);
}

/* ============================================================================
   Crisis contacts by country (buttons + saved choice)
============================================================================ */

function countryKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Россия', 'COUNTRY_RU'), Markup.button.callback('🇺🇦 Украина', 'COUNTRY_UA')],
    [Markup.button.callback('🇪🇺 Европа (112)', 'COUNTRY_EU'), Markup.button.callback('🇺🇸 США', 'COUNTRY_US')],
    [Markup.button.callback('🇦🇺 Австралия', 'COUNTRY_AU')],
    [Markup.button.callback('🌍 Другая страна', 'COUNTRY_OTHER')],
    [Markup.button.callback('⬅️ Назад', 'BACK')]
  ]);
}

function emergencyContactsText(countryCode) {
  const code = String(countryCode || '').toUpperCase();

  if (code === 'RU') {
    return [
      '📞 Экстренные службы (Россия):',
      '— 112 (единый номер)',
      '',
      'Если ситуация угрожает жизни — лучше звонить сразу.'
    ].join('\n');
  }

  if (code === 'UA') {
    return [
      '📞 Экстренные службы (Украина):',
      '— 112 (единый номер)',
      '— 101 (пожарные/спасатели)',
      '— 102 (полиция)',
      '— 103 (скорая)',
      '',
      'Если ситуация угрожает жизни — лучше звонить сразу.'
    ].join('\n');
  }

  if (code === 'EU') {
    return [
      '📞 Экстренные службы (Европа):',
      '— 112 (единый номер)',
      '',
      'Если ситуация угрожает жизни — лучше звонить сразу.'
    ].join('\n');
  }

  if (code === 'US') {
    return [
      // ========================= bot.js (PART 2/4) =========================
/* ============================================================================
   Safety: self-harm / crisis trigger (soft routing)
============================================================================ */

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

// Базовые триггеры (на русском). Список короткий, чтобы меньше ложных срабатываний.
function looksLikeSelfHarmCrisis(text) {
  const t = normalizeText(text);
  if (!t) return false;

  const patterns = [
    /(?:не хочу|не могу) жить/,
    /хочу умереть/,
    /хочу покончить(?:\s+с\s+собой)?/,
    /покончить\s+с\s+собой/,
    /совершить\s+суицид/,
    /\bсуицид\b/,
    /убить\s+себя/,
    /умереть\s+сегодня/,
    /умереть\s+сейчас/,
    /причинить\s+себе\s+вред/,
    /самоповреждени/,
    /порезать\s+себя/,
    /режу\s+себя/,
    /я\s+порезал(?:а)?\s+себя/,
    /я\s+сделаю\s+с\s+собой\s+что-?то/
  ];

  const falsePositives = [
    /убиться\s+на\s+работе/,
    /убиваюсь\s+на\s+работе/,
    /умереть\s+со\s+смеху/,
    /смеял(?:ся|ась)\s+до\s+слез/
  ];

  if (falsePositives.some(r => r.test(t))) return false;
  return patterns.some(r => r.test(t));
}

async function replySafetySupport(ctx) {
  await ctx.reply(
    SAFETY_SUPPORT_TEXT,
    Markup.inlineKeyboard([
      [Markup.button.callback('📞 Где найти помощь', 'HELP_RESOURCES')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ])
  );
}

// Перехват текстовых сообщений: если кризис — показываем поддержку и НЕ идём дальше по цепочке.
bot.on('text', async (ctx, next) => {
  try {
    if (!ctx || !ctx.message || typeof ctx.message.text !== 'string') return next();

    const msg = ctx.message.text;
    if (!msg) return next();

    // Не трогаем команды
    if (msg.trim().startsWith('/')) return next();

    if (looksLikeSelfHarmCrisis(msg)) {
      // Если ждали отзыв — снимаем ожидание, чтобы не смешивать режимы
      try {
        const u = await store.getUser(ctx.chat.id);
        if (u && u.awaitingReview) {
          u.awaitingReview = false;
          u.reviewPostponed = true;
          await store.upsertUser(u);
        }
        // И если ждали email — тоже снимаем
        if (u && u.awaitingReceiptEmail) {
          u.awaitingReceiptEmail = false;
          await store.upsertUser(u);
        }
      } catch (_) {}

      await replySafetySupport(ctx);
      return;
    }

    return next();
  } catch (e) {
    console.error('[safety] text intercept error', e && e.message ? e.message : e);
    return next();
  }
});

/* ============================================================================
   Debug commands
============================================================================ */

function shortUserLine(u) {
  const cm = u && u.chatId != null ? String(u.chatId) : 'null';
  const active = u && u.isActive ? 'yes' : 'no';
  const type = u && u.programType ? String(u.programType) : 'none';
  const day = u && u.currentDay != null ? String(u.currentDay) : '-';
  const step = u && u.supportStep != null ? String(u.supportStep) : '-';
  const mk = u && u.lastMorningSentKey ? String(u.lastMorningSentKey) : '-';
  const ek = u && u.lastEveningSentKey ? String(u.lastEveningSentKey) : '-';
  return `• ${cm} | active=${active} | type=${type} | day=${day} | step=${step} | mKey=${mk} | eKey=${ek}`;
}

bot.command('myid', async (ctx) => {
  if (!ctx.chat) return ctx.reply('Не удалось определить chat.id');
  return ctx.reply(['Твой chat.id:', '', String(ctx.chat.id), '', `Тип чата: ${ctx.chat.type || 'unknown'}`].join('\n'));
});

bot.command('debug_users', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');
  const users = await store.listUsers();
  const header = `users=${users.length}`;
  if (!users.length) return ctx.reply(`${header}\n(пусто)`);
  await ctx.reply(header);
  const lines = users.map(shortUserLine);
  const chunkSize = 30;
  for (let i = 0; i < lines.length; i += chunkSize) {
    await ctx.reply(lines.slice(i, i + chunkSize).join('\n'));
  }
});

bot.command('dbtest', async (ctx) => {
  try {
    if (!ctx.chat) return ctx.reply('Не удалось определить chat.id');
    const chatId = ctx.chat.id;

    const before = (await store.getUser(chatId)) || (await store.ensureUser(chatId));
    before.dbTestCounter = Number(before.dbTestCounter || 0) + 1;
    before.dbTestLastAt = new Date().toISOString();
    await store.upsertUser(before);

    const after = await store.getUser(chatId);

    await ctx.reply(
      [
        '✅ DB test',
        '',
        `chatId: ${chatId}`,
        `before.counter: ${before ? before.dbTestCounter : 'null'}`,
        `after.counter: ${after ? after.dbTestCounter : 'null'}`,
        `after.lastAt: ${after ? after.dbTestLastAt : 'null'}`,
        '',
        after ? '✅ Пользователь читается из базы.' : '❌ Пользователь НЕ читается из базы.'
      ].join('\n')
    );
  } catch (e) {
    console.error('[dbtest] error', e && e.message ? e.message : e);
    await ctx.reply(`❌ DB test error: ${e && e.message ? e.message : String(e)}`);
  }
});

/* ============================================================================
   Reviews (A + текст + 1 мягкое напоминание)
============================================================================ */

function reviewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Написать отзыв', 'REVIEW_WRITE')],
    [Markup.button.callback('Позже', 'REVIEW_LATER')]
  ]);
}

bot.action('REVIEW_LATER', async (ctx) => {
  await safeAnswerCbQuery(ctx);

  const u = await store.ensureUser(ctx.chat.id);
  u.reviewPostponed = true;
  u.awaitingReview = false;
  await store.upsertUser(u);

  await ctx.reply('Хорошо. Я мягко напомню чуть позже. 🫶', mainKeyboard(u));
});

bot.action('REVIEW_WRITE', async (ctx) => {
  await safeAnswerCbQuery(ctx);

  const u = await store.ensureUser(ctx.chat.id);
  u.awaitingReview = true;
  await store.upsertUser(u);

  await ctx.reply(
    [
      'Напиши, пожалуйста, в нескольких словах:',
      'что ты заметила за эти дни?',
      '',
      'Можно одним сообщением.',
      'Без “правильно/неправильно”.'
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('Позже', 'REVIEW_LATER')]
    ])
  );
});

// Сбор текста отзыва
bot.on('text', async (ctx, next) => {
  try {
    if (!ctx.chat || !ctx.message || typeof ctx.message.text !== 'string') return next();

    const text = ctx.message.text.trim();
    if (!text) return next();

    if (text.startsWith('/')) return next();
    if (/^стоп$/i.test(text)) return next();

    const u = await store.getUser(ctx.chat.id);
    if (!u || !u.awaitingReview) return next();

    u.awaitingReview = false;
    u.reviewPostponed = false;
    await store.upsertUser(u);

    const id = await store.addReview({
      chatId: u.chatId,
      text,
      programType: u.programType,
      currentDay: u.currentDay
    });

    await ctx.reply('Спасибо. Я сохранила. 🫶', mainKeyboard(u));

    const ownerId = OWNER_CHAT_ID ? Number(OWNER_CHAT_ID) : NaN;
    if (Number.isFinite(ownerId)) {
      const msg = [
        '📝 Новый отзыв',
        `id: ${id != null ? id : 'null'}`,
        `chatId: ${u.chatId}`,
        `type: ${u.programType || 'none'}`,
        `day: ${u.currentDay != null ? u.currentDay : '-'}`,
        '',
        text
      ].join('\n');

      try { await bot.telegram.sendMessage(ownerId, msg); } catch (_) {}
    }

    return;
  } catch (e) {
    console.error('[review] handler error', e && e.message ? e.message : e);
    return next();
  }
});

bot.command('reviews_count', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');
  const n = await store.countReviews();
  return ctx.reply(`Отзывы в базе: ${n}`);
});

/* ============================================================================
   Receipt email capture (for 54-FZ receipts in YooKassa)
============================================================================ */

bot.on('text', async (ctx, next) => {
  try {
    if (!ctx.chat || !ctx.message || typeof ctx.message.text !== 'string') return next();

    const text = ctx.message.text.trim();
    if (!text) return next();

    if (text.startsWith('/')) return next();
    if (/^стоп$/i.test(text)) return next();

    const u = await store.getUser(ctx.chat.id);
    if (!u || !u.awaitingReceiptEmail) return next();

    // если вдруг человек в отзыве — не мешаем
    if (u.awaitingReview) return next();

    if (!isValidEmail(text)) {
      await ctx.reply(
        [
          'Похоже, это не email.',
          'Попробуй ещё раз, пожалуйста.',
          'Например: name@gmail.com'
        ].join('\n'),
        receiptEmailKeyboard()
      );
      return;
    }

    u.receiptEmail = text;
    u.awaitingReceiptEmail = false;
    await store.upsertUser(u);

    try {
      const { url, paymentId } = await createPayment30Days(ctx.chat.id, u.receiptEmail);

      u.pendingPlan = 'paid_30';
      u.pendingPaymentId = paymentId;
      await store.upsertUser(u);

      await ctx.reply(
        [
          'Спасибо. Email для чека сохранён.',
          '',
          'Открываю оплату.'
        ].join('\n'),
        Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить 30 дней', url)],
          [Markup.button.callback('⬅️ Назад', 'BACK')]
        ])
      );
    } catch (e) {
      console.error('[receiptEmail] create payment error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
      await ctx.reply(
        `❌ Не получилось создать платёж: ${e && e.message ? e.message : String(e)}`,
        mainKeyboard(u)
      );
    }

    return;
  } catch (e) {
    console.error('[receiptEmail] handler error', e && e.message ? e.message : e);
    return next();
  }
});

/* ============================================================================
   Country choice handlers (saved to DB)
============================================================================ */

bot.action('COUNTRY_RU', async (ctx) => setCountryAndShow(ctx, 'RU'));
bot.action('COUNTRY_UA', async (ctx) => setCountryAndShow(ctx, 'UA'));
bot.action('COUNTRY_EU', async (ctx) => setCountryAndShow(ctx, 'EU'));
bot.action('COUNTRY_US', async (ctx) => setCountryAndShow(ctx, 'US'));
bot.action('COUNTRY_AU', async (ctx) => setCountryAndShow(ctx, 'AU'));

bot.action('COUNTRY_OTHER', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  u.awaitingCountryCode = true;
  await store.upsertUser(u);
  await safeAnswerCbQuery(ctx);

  await ctx.reply(
    [
      'Напиши, пожалуйста, страну одним сообщением.',
      'Например: Казахстан / Израиль / Германия.',
      '',
      'Я подскажу экстренный номер и где искать линии помощи.'
    ].join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ])
  );
});

// Если пользователь написал страну текстом
bot.on('text', async (ctx, next) => {
  try {
    if (!ctx.chat || !ctx.message || typeof ctx.message.text !== 'string') return next();
    const text = ctx.message.text.trim();
    if (!text) return next();

    if (text.startsWith('/')) return next();
    if (/^стоп$/i.test(text)) return next();

    const u = await store.getUser(ctx.chat.id);
    if (!u || !u.awaitingCountryCode) return next();

    // не мешаем другим режимам
    if (u.awaitingReview || u.awaitingReceiptEmail) return next();

    u.awaitingCountryCode = false;
    u.countryName = text;
    await store.upsertUser(u);

    await ctx.reply(
      [
        'Спасибо.',
        '',
        `Страна: ${text}`,
        '',
        'Если угроза жизни — лучше набрать местный номер экстренных служб.',
        'Во многих странах это 112, но не везде.',
        '',
        'Если хочешь — напиши город/регион, и я уточню точный номер.'
      ].join('\n'),
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'BACK')]])
    );
    return;
  } catch (e) {
    console.error('[country] handler error', e && e.message ? e.message : e);
    return next();
  }
});
    function safetyContactsTextByCountryCode(countryCode) {
  // совместимость: у тебя выше уже есть emergencyContactsText(...)
  return emergencyContactsText(countryCode);
}

async function setCountryAndShow(ctx, code) {
  const u = await store.ensureUser(ctx.chat.id);
  u.countryCode = String(code || '').toUpperCase();
  u.awaitingCountryCode = false;
  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);

  const t = safetyContactsTextByCountryCode(u.countryCode);
  await ctx.reply(
    t,
    Markup.inlineKeyboard([
      [Markup.button.callback('🌍 Сменить страну', 'CHOOSE_COUNTRY')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ])
  );
}
// ========================= end PART 2/4 =========================
    // ========================= bot.js (PART 3/4) =========================
/* ============================================================================
   Admin stats / manual ticks
============================================================================ */

bot.command('stats', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');

  const users = await store.listUsers();

  const total = users.length;
  const active = users.filter(u => u && u.isActive).length;

  const byType = { free: 0, paid: 0, support: 0, none: 0, other: 0 };
  for (const u of users) {
    const t = (u && u.programType) ? String(u.programType) : 'none';
    if (t === 'free') byType.free += 1;
    else if (t === 'paid') byType.paid += 1;
    else if (t === 'support') byType.support += 1;
    else if (t === 'none') byType.none += 1;
    else byType.other += 1;
  }

  const msg = [
    '📊 Статистика',
    '',
    `Всего пользователей: ${total}`,
    `Активных: ${active}`,
    '',
    'По типам:',
    `— free: ${byType.free}`,
    `— paid: ${byType.paid}`,
    `— support: ${byType.support}`,
    `— none: ${byType.none}`,
    byType.other ? `— other: ${byType.other}` : null
  ].filter(Boolean).join('\n');

  return ctx.reply(msg);
});

bot.command('tick_morning', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');
  await ctx.reply('⏳ Запускаю runMorning(bot)...');
  try {
    await runMorning(bot);
    await ctx.reply('✅ Готово. Посмотри, пришло ли сообщение и что в логах.');
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e && e.message ? e.message : e}`);
  }
});

bot.command('tick_evening', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');
  await ctx.reply('⏳ Запускаю runEvening(bot)...');
  try {
    await runEvening(bot);
    await ctx.reply('✅ Готово. Посмотри, пришло ли сообщение и что в логах.');
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e && e.message ? e.message : e}`);
  }
});

bot.command('deliveries', async (ctx) => {
  if (!isOwnerStrict(ctx)) return ctx.reply('Эта команда доступна только владельцу бота.');

  const key = moscowDayKey();

  try {
    if (typeof store.getDeliveryStatsByDay !== 'function') {
      return ctx.reply('❌ store.getDeliveryStatsByDay не найден. Проверь store_pg.js');
    }

    const s = await store.getDeliveryStatsByDay(key);

    const m = s.byKind.morning || { total: 0, sent: 0, errors: 0 };
    const e = s.byKind.evening || { total: 0, sent: 0, errors: 0 };

    const msg = [
      '📦 Доставки за сегодня (Москва)',
      '',
      `День: ${s.sendKey}`,
      '',
      `🌅 morning: total=${m.total} | sent=${m.sent} | errors=${m.errors}`,
      `🌙 evening: total=${e.total} | sent=${e.sent} | errors=${e.errors}`,
      '',
      `Итого: total=${s.totalAll} | sent=${s.sentAll} | errors=${s.errorsAll}`
    ].join('\n');

    return ctx.reply(msg);
  } catch (e) {
    console.error('[deliveries] error', e);
    return ctx.reply(`❌ deliveries error: ${e && e.message ? e.message : String(e)}`);
  }
});

/* ============================================================================
   Handlers
============================================================================ */

// ================= SAFETY HANDLERS =================

bot.action('NEED_HELP', async (ctx) => {
  await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);

  await ctx.reply(
    SAFETY_SUPPORT_TEXT,
    Markup.inlineKeyboard([
      [Markup.button.callback('📞 Экстренные контакты', 'HELP_RESOURCES')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ])
  );
});

bot.action('HELP_RESOURCES', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);

  // Если страна уже сохранена — сразу показываем нужный блок
  const cc = (u && u.countryCode) ? String(u.countryCode) : '';
  if (cc) {
    const t = safetyContactsTextByCountryCode(cc);
    await ctx.reply(
      t,
      Markup.inlineKeyboard([
        [Markup.button.callback('🌍 Сменить страну', 'CHOOSE_COUNTRY')],
        [Markup.button.callback('⬅️ Назад', 'BACK')]
      ])
    );
    return;
  }

  // Иначе предлагаем выбрать страну
  await ctx.reply(
    [
      'Чтобы подсказать экстренные контакты — выбери страну:',
      '',
      'Если угроза жизни — лучше звонить в экстренные службы прямо сейчас.'
    ].join('\n'),
    countryKeyboard()
  );
});

bot.action('CHOOSE_COUNTRY', async (ctx) => {
  await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Выбери страну:', countryKeyboard());
});

// ================= DAY RETURN HANDLERS =================

bot.action('DAY_PAUSE', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await sendDayReturn(ctx, 'pause');
});

bot.action('DAY_CHECK', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await sendDayReturn(ctx, 'check');
});

bot.action('DAY_SUPPORT', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await sendDayReturn(ctx, 'support');
});

// ================= FIRST IMPRESSION HANDLERS =================

bot.action(['FI_MOOD_TENSE', 'FI_MOOD_TIRED', 'FI_MOOD_CALM', 'FI_MOOD_UNSURE'], async (ctx) => {
  try {
    const st = fiEnsure(ctx.chat.id);
    if (!st || st.step !== 'mood_asked')
    fiClearTimer(ctx.chat.id);
    {
      await safeAnswerCbQuery(ctx);
      return;
    }

    const map = {
      FI_MOOD_TENSE: 'tense',
      FI_MOOD_TIRED: 'tired',
      FI_MOOD_CALM: 'calm',
      FI_MOOD_UNSURE: 'unsure'
    };

    st.mood = map[String(ctx.callbackQuery && ctx.callbackQuery.data)] || 'unsure';
    st.step = 'palms_asked';

    await safeAnswerCbQuery(ctx);
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    await sendWithPace(ctx, fiMirrorMood(st.mood), 900);
    await sendWithPace(ctx, 'Почувствуй ладони.', 700);
    await ctx.reply('Они тёплые или прохладные?', fiPalmsKeyboard());
    fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
  } catch (e) {
    console.error('[first_impression] mood error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});

bot.action(['FI_PALMS_WARM', 'FI_PALMS_COOL', 'FI_PALMS_NEUTRAL', 'FI_PALMS_UNSURE'], async (ctx) => {
  try {
    const st = fiEnsure(ctx.chat.id);
    if (!st || st.step !== 'palms_asked')
    fiClearTimer(ctx.chat.id);
    {
      await safeAnswerCbQuery(ctx);
      return;
    }

    const map = {
      FI_PALMS_WARM: 'warm',
      FI_PALMS_COOL: 'cool',
      FI_PALMS_NEUTRAL: 'neutral',
      FI_PALMS_UNSURE: 'unsure'
    };

    st.palms = map[String(ctx.callbackQuery && ctx.callbackQuery.data)] || 'unsure';
    st.step = 'end_asked';

    await safeAnswerCbQuery(ctx);
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    await sendWithPace(ctx, fiHaiku(), 900);
    await sendWithPace(ctx, 'На сегодня достаточно.', 700);

    await ctx.reply('Как тебе сейчас?', fiEndKeyboard());
    fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
  } catch (e) {
    console.error('[first_impression] palms error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});

bot.action('FI_DONE', async (ctx) => {
  try {
    await safeAnswerCbQuery(ctx);
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    fiReset(ctx.chat.id);
    const u = await store.ensureUser(ctx.chat.id);

    // аккуратно выключаем режимы ввода
    if (u) {
      u.awaitingReceiptEmail = false;
      u.awaitingCountryCode = false;
      await store.upsertUser(u);
    }

    await sendWithPace(ctx, 'Хорошо. Можно просто посмотреть меню ниже и выбрать, что сейчас подходит.', 500);
    await ctx.reply(startText(), mainKeyboard(u));
  } catch (e) {
    console.error('[first_impression] done error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});

// ✨ хочу ещё -> сразу запускаем первую неделю (как “настоящий следующий шаг”)
bot.action('FI_MORE', async (ctx) => {
  try {
    await safeAnswerCbQuery(ctx);
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    fiReset(ctx.chat.id);

    const u = await store.ensureUser(ctx.chat.id);

    u.isActive = true;
    u.programType = 'free';
    u.currentDay = 1;
    u.supportStep = 1;
    u.lastMorningSentKey = null;
    u.lastEveningSentKey = null;

    u.awaitingReceiptEmail = false;
    u.awaitingCountryCode = false;

    await store.upsertUser(u);

    await ctx.reply(SAFETY_INTRO);
    await ctx.reply(afterStartText(), mainKeyboard(u));
  } catch (e) {
    console.error('[first_impression] more error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});
    bot.action('FI_CONTINUE', async (ctx) => {
  try {
    await safeAnswerCbQuery(ctx);

    const st = fiEnsure(ctx.chat.id);
    if (!st) return;

    // убираем клавиатуру у "подхвата", чтобы не копилось
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    if (st.step === 'mood_asked') {
      await ctx.reply('Как ты сейчас?', fiMoodKeyboard());
      fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
      return;
    }

    if (st.step === 'palms_asked') {
      await ctx.reply('Они тёплые или прохладные?', fiPalmsKeyboard());
      fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
      return;
    }

    if (st.step === 'end_asked') {
      await ctx.reply('Как тебе сейчас?', fiEndKeyboard());
      fiSetTimer(ctx.chat.id, () => { fiSendNudgeIfStill(ctx.chat.id); }, 90000);
      return;
    }

    // если шаг уже не онбординговый — просто меню
    fiReset(ctx.chat.id);
    const u = await store.ensureUser(ctx.chat.id);
    await ctx.reply(startText(), mainKeyboard(u));
  } catch (e) {
    console.error('[first_impression] continue error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});

bot.action('FI_MENU', async (ctx) => {
  try {
    await safeAnswerCbQuery(ctx);
    try { await ctx.editMessageReplyMarkup(null); } catch (_) {}

    fiReset(ctx.chat.id);
    const u = await store.ensureUser(ctx.chat.id);

    // сброс “залипаний” ввода, чтобы меню было чистым
    if (u) {
      u.awaitingReceiptEmail = false;
      u.awaitingCountryCode = false;
      await store.upsertUser(u);
    }
await sendWithPace(ctx, 'Ок. Вернёмся в меню — там можно выбрать следующий шаг.', 500);
    await ctx.reply(startText(), mainKeyboard(u));
  } catch (e) {
    console.error('[first_impression] menu error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await safeAnswerCbQuery(ctx);
  }
});

// ================= BASIC UI =================

bot.start(async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  // сброс “залипаний” ввода
  if (u) {
    u.awaitingReceiptEmail = false;
    u.awaitingCountryCode = false;
    await store.upsertUser(u);
  }

  // /start теперь = первое впечатление 10/10
  fiReset(ctx.chat.id);
  await runFirstImpression(ctx);
});

bot.action('HOW', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(howText(u), howKeyboard(u));
});

bot.action('BACK', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);

  // чтобы не “залипать” в режимах ввода
  if (u) {
    u.awaitingReceiptEmail = false;
    u.awaitingCountryCode = false;
    await store.upsertUser(u);
  }

  // если человек был в онбординге — сбросим и покажем обычный старт
  fiReset(ctx.chat.id);

  await ctx.reply(startText(), mainKeyboard(u));
});

bot.action('SUB_INFO', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(subscriptionText(u), subscriptionKeyboard(u));
});

bot.action('SUB_LATER', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Хорошо. Можно вернуться к этому позже.', mainKeyboard(u));
});

bot.action('START_FREE', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'free';
  u.currentDay = 1;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  // сброс режимов ввода
  u.awaitingReceiptEmail = false;
  u.awaitingCountryCode = false;

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);

  // один раз — мягкая рамка безопасности
  await ctx.reply(SAFETY_INTRO);

  await ctx.reply(afterStartText(), mainKeyboard(u));
});

// 🔄 RESTART: доступен только в free
bot.action('RESTART', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  if (!u || u.programType !== 'free') {
    await safeAnswerCbQuery(ctx);
    await ctx.reply('Перезапуск доступен только в первой неделе.', mainKeyboard(u));
    return;
  }

  u.isActive = true;
  u.programType = 'free';
  u.currentDay = 1;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  u.pendingPaymentId = null;
  u.pendingPlan = null;

  u.awaitingReceiptEmail = false;
  u.awaitingCountryCode = false;

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    ['Ок. Начинаем сначала — с первой недели 🌿', '', 'Завтра в 7:30 придёт утреннее сообщение.'].join('\n'),
    mainKeyboard(u)
  );
});

// 🌿 RESUME: вернуться после остановки — без сброса прогресса
bot.action('RESUME', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  if (!u || !u.programType || u.programType === 'none') {
    await safeAnswerCbQuery(ctx);
    await ctx.reply(startText(), mainKeyboard(u));
    return;
  }

  u.isActive = true;
  u.awaitingReceiptEmail = false;
  u.awaitingCountryCode = false;

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(backText(), mainKeyboard(u));
});

// ✅ BUY_30: создаём платёж и отдаём ссылку
bot.action('BUY_30', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);

  if (!havePaymentsEnabled()) {
    await ctx.reply(
      [
        'Оплата пока не настроена на сервере.',
        '',
        'Нужно добавить переменные окружения:',
        '— SHOP_ID (или YOOKASSA_SHOP_ID)',
        '— SECRET_KEY (или YOOKASSA_SECRET_KEY)',
        '— BASE_URL (или PUBLIC_URL) — домен Railway',
        '',
        'После этого кнопка оплаты заработает.'
      ].join('\n'),
      mainKeyboard(u)
    );
    return;
  }

  // Если email ещё не сохранён — попросим
  if (!u.receiptEmail) {
    u.awaitingReceiptEmail = true;
    await store.upsertUser(u);

    await ctx.reply(
      [
        'Перед оплатой нужен email для чека.',
        '',
        'Напиши, пожалуйста, свой email одним сообщением.',
        'Например: name@gmail.com',
        '',
        'Если передумала — нажми «⬅️ Назад».'
      ].join('\n'),
      receiptEmailKeyboard()
    );
    return;
  }

  try {
    const { url, paymentId } = await createPayment30Days(ctx.chat.id, u.receiptEmail);

    u.pendingPlan = 'paid_30';
    u.pendingPaymentId = paymentId;
    u.awaitingReceiptEmail = false;
    await store.upsertUser(u);

    await ctx.reply(
      [
        'Хорошо. Сейчас открою оплату.',
        '',
        'После успешной оплаты я сразу включу 30 дней и напишу тебе сюда.'
      ].join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.url('💳 Оплатить 30 дней', url)],
        [Markup.button.callback('⬅️ Назад', 'BACK')]
      ])
    );
  } catch (e) {
    console.error('[BUY_30] payment error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    await ctx.reply(
      `❌ Не получилось создать платёж: ${e && e.message ? e.message : String(e)}`,
      mainKeyboard(u)
    );
  }
});

bot.action('START_SUPPORT', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'support';
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  u.awaitingReceiptEmail = false;
  u.awaitingCountryCode = false;

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    ['Поддержка включена.', '', '3 раза в неделю — короткое возвращение к телу.', 'В 7:30 и 20:30 по Москве.'].join('\n'),
    mainKeyboard(u)
  );
});

async function stopProgram(ctx) {
  const u = await store.ensureUser(ctx.chat.id);
  u.isActive = false;
  u.awaitingReceiptEmail = false;
  u.awaitingCountryCode = false;
  await store.upsertUser(u);
  await ctx.reply(stoppedText(), stoppedKeyboard());
}

bot.action('STOP', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await stopProgram(ctx);
});

bot.command('stop', async (ctx) => stopProgram(ctx));
bot.hears(/^стоп$/i, async (ctx) => stopProgram(ctx));

/* ============================================================================
   Day Return commands + russian hears
============================================================================ */

bot.command('pause', async (ctx) => sendDayReturn(ctx, 'pause'));
bot.command('check', async (ctx) => sendDayReturn(ctx, 'check'));
bot.command('support', async (ctx) => sendDayReturn(ctx, 'support'));
bot.command('back', async (ctx) => sendDayReturn(ctx, 'back'));

// Русские варианты (удобны для пользователя)
bot.hears(/^(пауза|стоп ?на ?секунду)$/i, async (ctx) => sendDayReturn(ctx, 'pause'));
bot.hears(/^(проверить себя|проверка|чек|скан)$/i, async (ctx) => sendDayReturn(ctx, 'check'));
bot.hears(/^(поддержка)$/i, async (ctx) => sendDayReturn(ctx, 'support'));

// ========================= end PART 3/4 =========================
// ========================= bot.js (PART 4/4) =========================
/* ============================================================================
   HTTP server: healthcheck + telegraf webhook + yookassa webhook + success page
============================================================================ */

function writeText(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '/');

    // ✅ healthcheck (Railway)
    if (method === 'GET' && (url === '/' || url.startsWith('/health'))) {
      writeText(res, 200, 'ok');
      return;
    }

    // ✅ Telegram webhook (fix 409: no getUpdates / polling)
    if (USE_WEBHOOK && method === 'POST' && url.startsWith(TELEGRAM_WEBHOOK_PATH)) {
      let update = null;
      try {
        update = await readJsonBody(req);
      } catch (e) {
        console.error('[telegram-webhook] bad body', e && e.message ? e.message : e);
      }

      // Telegram ждёт быстрый 200
      writeText(res, 200, 'ok');

      if (update) {
        try {
          await bot.handleUpdate(update);
        } catch (e) {
          console.error('[telegram-webhook] handleUpdate error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
        }
      }
      return;
    }

    // YooKassa webhook endpoint
    if (method === 'POST' && url.startsWith('/yookassa-webhook')) {
      if (!checkWebhookAuth(req)) {
        writeText(res, 401, 'unauthorized');
        return;
      }

      // ✅ Всегда отвечаем 200 YooKassa, даже если body кривой (они ретраят)
      let event = null;
      try {
        event = await readJsonBody(req);
      } catch (e) {
        console.error('[yookassa-webhook] bad body', e && e.message ? e.message : e);
      }

      writeText(res, 200, 'ok');

      // Если не распарсили — выходим
      if (!event || !event.event || !event.object) return;

      // Обработка события после ответа
      try {
        if (event.event === 'payment.succeeded') {
          const payment = event.object;
          const meta = payment && payment.metadata ? payment.metadata : {};
          const chatIdRaw = meta.chatId != null ? String(meta.chatId) : null;
          const plan = meta.plan != null ? String(meta.plan) : '';

          if (!chatIdRaw) return;
          const chatId = Number(chatIdRaw);
          if (!Number.isFinite(chatId)) return;

          if (plan === 'paid_30') {
            const u = await store.ensureUser(chatId);

            // идемпотентность: если уже paid — не дёргаем
            if (u && u.programType !== 'paid') {
              u.isActive = true;
              u.programType = 'paid';
              u.currentDay = 8;
              u.supportStep = 1;
              u.lastMorningSentKey = null;
              u.lastEveningSentKey = null;

              // чистим ожидание оплаты
              u.pendingPaymentId = null;
              u.pendingPlan = null;

              // режимы ввода выключаем
              u.awaitingReceiptEmail = false;
              u.awaitingCountryCode = false;

              // сохраняем id платежа
              u.lastPaymentId = payment && payment.id ? String(payment.id) : (u.lastPaymentId || null);

              await store.upsertUser(u);

              try {
                await bot.telegram.sendMessage(
                  chatId,
                  [
                    '✅ Оплата прошла.',
                    '',
                    'Ты в 30 днях.',
                    'Завтра в 7:30 придёт день 8.',
                    'Идём глубже, но всё так же мягко — через тело.',
                    '',
                    'Если в течение дня захочется —',
                    'можно нажать «🫧 Пауза» или «🧺 Поддержка».'
                  ].join('\n'),
                  mainKeyboard(u)
                );
              } catch (_) {}
            } else if (u) {
              u.pendingPaymentId = null;
              u.pendingPlan = null;
              u.awaitingReceiptEmail = false;
              u.awaitingCountryCode = false;
              u.lastPaymentId = payment && payment.id ? String(payment.id) : (u.lastPaymentId || null);
              await store.upsertUser(u);
            }
          }
        }

        if (event.event === 'payment.canceled') {
          const payment = event.object;
          const meta = payment && payment.metadata ? payment.metadata : {};
          const chatIdRaw = meta.chatId != null ? String(meta.chatId) : null;
          const plan = meta.plan != null ? String(meta.plan) : '';

          if (!chatIdRaw) return;
          const chatId = Number(chatIdRaw);
          if (!Number.isFinite(chatId)) return;

          if (plan === 'paid_30') {
            const u = await store.ensureUser(chatId);
            if (u) {
              u.pendingPaymentId = null;
              u.pendingPlan = null;
              u.awaitingReceiptEmail = false;
              u.awaitingCountryCode = false;
              await store.upsertUser(u);
            }
          }
        }
      } catch (e) {
        console.error('[yookassa-webhook] handler error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
      }

      return;
    }

    // Return_url page (после оплаты YooKassa редиректит сюда)
    if (method === 'GET' && url.startsWith('/success')) {
      writeText(res, 200, 'Оплата принята. Можно вернуться в Telegram.');
      return;
    }

    // Остальное — 404
    writeText(res, 404, 'not found');
  } catch (e) {
    console.error('[http] error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
    try {
      writeText(res, 500, 'error');
    } catch (_) {}
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('HTTP listening on', PORT));

/* ============================================================================
   Scheduler (cron + watchdog + catch-up)
============================================================================ */

let morningRunning = false;
let eveningRunning = false;

let lastMorningRunKey = null;
let lastEveningRunKey = null;

const MORNING_HOUR = 7;
const MORNING_MINUTE = 30;
const EVENING_HOUR = 20;
const EVENING_MINUTE = 30;

const WINDOW_MINUTES = 2;
const MORNING_CATCHUP_END_HOUR = 11;
const EVENING_CATCHUP_END_HOUR = 23;

async function safeRunMorning(source) {
  const p = moscowParts(new Date());
  const runKey = p.key;

  if (morningRunning) return;
  if (lastMorningRunKey === runKey) return;

  try {
    morningRunning = true;
    lastMorningRunKey = runKey;
    console.log(`[scheduler] MORNING fire (${source}) msk=${p.isoLike} key=${runKey}`);
    await runMorning(bot);
    console.log(`[scheduler] MORNING done (${source}) msk=${p.isoLike} key=${runKey}`);
  } catch (e) {
    lastMorningRunKey = null;
    console.error('[scheduler] MORNING error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
  } finally {
    morningRunning = false;
  }
}

async function safeRunEvening(source) {
  const p = moscowParts(new Date());
  const runKey = p.key;

  if (eveningRunning) return;
  if (lastEveningRunKey === runKey) return;

  try {
    eveningRunning = true;
    lastEveningRunKey = runKey;
    console.log(`[scheduler] EVENING fire (${source}) msk=${p.isoLike} key=${runKey}`);
    await runEvening(bot);
    console.log(`[scheduler] EVENING done (${source}) msk=${p.isoLike} key=${runKey}`);
  } catch (e) {
    lastEveningRunKey = null;
    console.error('[scheduler] EVENING error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
  } finally {
    eveningRunning = false;
  }
}

function isInWindow(p, targetHour, targetMinute) {
  if (p.hour !== targetHour) return false;
  return p.minute >= targetMinute && p.minute <= (targetMinute + WINDOW_MINUTES);
}

function isAfterTargetSameDay(p, targetHour, targetMinute) {
  if (p.hour > targetHour) return true;
  if (p.hour < targetHour) return false;
  return p.minute >= targetMinute;
}

function startWatchdogScheduler() {
  console.log('[scheduler] watchdog started (20s interval), tz=', MOSCOW_TZ);

  const tick = async () => {
    const p = moscowParts(new Date());

    const morningWindow = isInWindow(p, MORNING_HOUR, MORNING_MINUTE);
    const morningCatchup =
      isAfterTargetSameDay(p, MORNING_HOUR, MORNING_MINUTE) &&
      p.hour <= MORNING_CATCHUP_END_HOUR;

    if ((morningWindow || morningCatchup) && lastMorningRunKey !== p.key) {
      await safeRunMorning(morningWindow ? 'watchdog-window' : 'watchdog-catchup');
    }

    const eveningWindow = isInWindow(p, EVENING_HOUR, EVENING_MINUTE);
    const eveningCatchup =
      isAfterTargetSameDay(p, EVENING_HOUR, EVENING_MINUTE) &&
      p.hour <= EVENING_CATCHUP_END_HOUR;

    if ((eveningWindow || eveningCatchup) && lastEveningRunKey !== p.key) {
      await safeRunEvening(eveningWindow ? 'watchdog-window' : 'watchdog-catchup');
    }
  };

  const t = setInterval(() => {
    tick().catch((e) => console.error('[scheduler] watchdog tick error', e && e.message ? e.message : e));
  }, 20000);

  tick().catch((e) => console.error('[scheduler] watchdog first tick error', e && e.message ? e.message : e));

  return () => clearInterval(t);
}

/* ============================================================================
   Launch + Scheduler
============================================================================ */

let stopWatchdog = null;
let morningTask = null;
let eveningTask = null;

async function boot() {
  await store.init();

  // ✅ Telegraf: webhook в проде, polling — только для локальной отладки
  if (USE_WEBHOOK) {
    const base = String(BASE_URL || '').replace(/\/$/, '');
    if (!base) {
      throw new Error('USE_WEBHOOK enabled but BASE_URL/PUBLIC_URL is missing');
    }

    const fullUrl = `${base}${TELEGRAM_WEBHOOK_PATH}`;

    await bot.telegram.setWebhook(fullUrl, { drop_pending_updates: true });

    console.log('BOT: webhook enabled');
    console.log('[telegram] webhook url:', fullUrl);
  } else {
    await bot.launch({ dropPendingUpdates: true });
    console.log('BOT: polling enabled');
  }

  morningTask = cron.schedule(
    '30 7 * * *',
    async () => { await safeRunMorning('node-cron'); },
    { timezone: MOSCOW_TZ }
  );

  eveningTask = cron.schedule(
    '30 20 * * *',
    async () => { await safeRunEvening('node-cron'); },
    { timezone: MOSCOW_TZ }
  );

  console.log('[scheduler] node-cron scheduled: morning 07:30, evening 20:30 (MSK)');

  stopWatchdog = startWatchdogScheduler();

  const p = moscowParts(new Date());
  console.log('[scheduler] now MSK:', p.isoLike, 'dayKey=', p.key);

  console.log(
    '[payments] enabled=',
    havePaymentsEnabled(),
    'shopId=',
    YOOKASSA_SHOP_ID ? 'set' : 'missing',
    'baseUrl=',
    BASE_URL ? BASE_URL : 'missing'
  );
  console.log('[payments] webhook basic auth', (YOOKASSA_WEBHOOK_USER || YOOKASSA_WEBHOOK_PASS) ? 'enabled' : 'disabled');
  console.log('[payments] webhook path: /yookassa-webhook');
}

boot().catch((e) => {
  console.error('BOOT FAILED:', e && e.stack ? e.stack : (e && e.message ? e.message : e));
  process.exit(1);
});

function shutdown(signal) {
  try { if (morningTask) morningTask.stop(); } catch (_) {}
  try { if (eveningTask) eveningTask.stop(); } catch (_) {}
  try { if (stopWatchdog) stopWatchdog(); } catch (_) {}

  try { bot.stop(signal); } catch (_) {}
  try { if (server) server.close(() => {}); } catch (_) {}

  try { if (store && typeof store.close === 'function') store.close(); } catch (_) {}
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// ========================= end PART 4/4 =========================
