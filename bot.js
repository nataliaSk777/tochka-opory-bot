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
// Ты сейчас на Railway используешь SHOP_ID и SECRET_KEY — поэтому делаем fallback.
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

// В проде на Railway лучше webhook (убирает 409 Conflict из-за polling/getUpdates).
// Включаем webhook автоматически, если задан BASE_URL/PUBLIC_URL,
// либо можно форсировать через USE_WEBHOOK=true/false.
const USE_WEBHOOK = (process.env.USE_WEBHOOK != null)
  ? /^(1|true|yes)$/i.test(String(process.env.USE_WEBHOOK))
  : Boolean(BASE_URL);

// Чтобы не светить BOT_TOKEN в URL — делаем стабильный секретный путь из sha256(token).
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
  // Если логин/пароль не заданы — не требуем auth (удобно на старте)
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

async function createPayment30Days(chatId) {
  if (!havePaymentsEnabled()) {
    throw new Error('Payments not configured: set (SHOP_ID|YOOKASSA_SHOP_ID), (SECRET_KEY|YOOKASSA_SECRET_KEY), (BASE_URL|PUBLIC_URL)');
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
   Bot instance (ВАЖНО: объявляем ДО любых bot.launch / bot.telegram)
============================================================================ */

const bot = new Telegraf(BOT_TOKEN);

// ✅ глобальный перехват ошибок Telegraf (чтобы не терять апдейты в тишине)
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
   Texts
============================================================================ */

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
    'Можно просто попробовать первую неделю.'
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
    'Если захочешь вернуться — нажми «🌿 Попробовать первую неделю».'
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
      'Это короткие возвращения к телу 3 раза в неделю.'
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
      [Markup.button.callback('ℹ️ Как это работает', 'HOW')]
    ]);
  }
  return Markup.inlineKeyboard([[Markup.button.callback('ℹ️ Как это работает', 'HOW')]]);
}

function howKeyboard(u) {
  if (isActiveProgram(u)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⛔️ Остановить', 'STOP')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ]);
  }
  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'BACK')]]);
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

/* ============================================================================
   Debug
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
    reviewKeyboard()
  );
});

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

    await ctx.reply('Спасибо. Я сохранила. 🫶');

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

bot.start(async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await ctx.reply(startText(), mainKeyboard(u));
});

bot.action('HOW', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(howText(u), howKeyboard(u));
});

bot.action('BACK', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Ок.', mainKeyboard(u));
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

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(afterStartText(), mainKeyboard(u));
});

// ✅ BUY_30: создаём платёж и отдаём пользователю ссылку (лучший UX)
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

  try {
    const { url, paymentId } = await createPayment30Days(ctx.chat.id);

    u.pendingPlan = 'paid_30';
    u.pendingPaymentId = paymentId;
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
  await store.upsertUser(u);
  await ctx.reply(stoppedText(), mainKeyboard(u));
}

bot.action('STOP', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await stopProgram(ctx);
});

bot.command('stop', async (ctx) => stopProgram(ctx));
bot.hears(/^стоп$/i, async (ctx) => stopProgram(ctx));

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

    // ✅ Явный healthcheck (для Railway)
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

      // ✅ Всегда отвечаем 200 ЮKassa, даже если body кривой (они ретраят)
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

            // идемпотентность: если уже paid/support — не дёргаем
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

              await store.upsertUser(u);

              try {
                await bot.telegram.sendMessage(
                  chatId,
                  [
                    '✅ Оплата прошла.',
                    '',
                    'Ты в 30 днях.',
                    'Завтра в 7:30 придёт день 8.',
                    'Идём глубже, но всё так же мягко — через тело.'
                  ].join('\n'),
                  mainKeyboard(u)
                );
              } catch (_) {}
            } else if (u) {
              u.pendingPaymentId = null;
              u.pendingPlan = null;
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
              await store.upsertUser(u);
            }
          }
        }
      } catch (e) {
        console.error('[yookassa-webhook] handler error', e && e.stack ? e.stack : (e && e.message ? e.message : e));
      }

      return;
    }

    // Return_url page
    if (method === 'GET' && url.startsWith('/success')) {
      writeText(res, 200, 'Оплата принята. Можно вернуться в Telegram.');
      return;
    }

    // ✅ Остальное — 404 (лучше для диагностики)
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

  // ✅ Запуск Telegraf: webhook в проде (убирает 409), polling оставляем только для локальной отладки
  if (USE_WEBHOOK) {
    const base = String(BASE_URL || '').replace(/\/$/, '');
    if (!base) {
      throw new Error('USE_WEBHOOK enabled but BASE_URL/PUBLIC_URL is missing');
    }

    const fullUrl = `${base}${TELEGRAM_WEBHOOK_PATH}`;

    // Убедимся, что polling не будет мешать: ставим webhook (Telegram сам отключает getUpdates сценарий).
    await bot.telegram.setWebhook(fullUrl, { drop_pending_updates: true });

    console.log('BOT: webhook enabled');
    console.log('[telegram] webhook url:', fullUrl);
  } else {
    // Локальный режим (если очень нужно): polling
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

  console.log('[payments] enabled=', havePaymentsEnabled(), 'shopId=', YOOKASSA_SHOP_ID ? 'set' : 'missing', 'baseUrl=', BASE_URL ? BASE_URL : 'missing');
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

  // ✅ В webhook-режиме bot.stop просто завершает middleware/пулы Telegraf
  try { bot.stop(signal); } catch (_) {}

  // ✅ аккуратно закрываем HTTP server
  try { if (server) server.close(() => {}); } catch (_) {}

  // ✅ если в store есть метод закрытия пула — используем (не ломаем, если нет)
  try { if (store && typeof store.close === 'function') store.close(); } catch (_) {}
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
