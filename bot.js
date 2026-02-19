'use strict';

require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');

const store = require('./store_pg');
const { runMorning } = require('./jobs_morning');
const { runEvening } = require('./jobs_evening');

/* ============================================================================
   Boot safety
============================================================================ */

process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION:', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION:', e));

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  })
  .listen(PORT, () => console.log('HTTP listening on', PORT));

console.log('BOOT', new Date().toISOString());

const bot = new Telegraf(BOT_TOKEN);

async function safeAnswerCbQuery(ctx) {
  try { await ctx.answerCbQuery(); } catch (_) {}
}

function isActiveProgram(u) {
  return !!(u && u.isActive && u.programType && u.programType !== 'none');
}

function isOwnerStrict(ctx) {
  const ownerIdRaw = process.env.OWNER_CHAT_ID;
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

    // 1) создаём/получаем пользователя
    const before = (await store.getUser(chatId)) || (await store.ensureUser(chatId));

    // 2) пишем "маркер" в БД
    before.dbTestCounter = Number(before.dbTestCounter || 0) + 1;
    before.dbTestLastAt = new Date().toISOString();
    await store.upsertUser(before);

    // 3) читаем обратно из БД
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
function reviewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Написать отзыв', 'REVIEW_WRITE')],
    [Markup.button.callback('Позже', 'REVIEW_LATER')]
  ]);
}

bot.action('REVIEW_LATER', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Хорошо. Если захочешь — можно будет написать позже.');
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

// ловим текст отзыва
bot.on('text', async (ctx, next) => {
  try {
    if (!ctx.chat || !ctx.message || typeof ctx.message.text !== 'string') return next();

    const text = ctx.message.text.trim();
    if (!text) return next();

    // команды/стопы не считаем отзывом
    if (text.startsWith('/')) return next();
    if (/^стоп$/i.test(text)) return next();

    const u = await store.getUser(ctx.chat.id);
    if (!u || !u.awaitingReview) return next();

    // снимаем флаг ожидания
    u.awaitingReview = false;
    await store.upsertUser(u);

    // сохраняем отзыв
    const id = await store.addReview({
      chatId: u.chatId,
      text,
      programType: u.programType,
      currentDay: u.currentDay
    });

    await ctx.reply('Спасибо. Я сохранила. 🫶');

    // шлём тебе в личку (если OWNER_CHAT_ID задан)
    const ownerIdRaw = process.env.OWNER_CHAT_ID;
    const ownerId = ownerIdRaw ? Number(ownerIdRaw) : NaN;

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

function moscowDayKey(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

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

bot.action('BUY_30', async (ctx) => {
  const u = await store.ensureUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'paid';
  u.currentDay = 8;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  await store.upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    ['Хорошо.', '', 'Ты в 30 днях.', 'Завтра в 7:30 придёт день 8.', 'Идём глубже, но всё так же мягко — через тело.'].join('\n'),
    mainKeyboard(u)
  );
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
   Launch + Scheduler
============================================================================ */

async function boot() {
  await store.init();

  await bot.launch();
  console.log('BOT: launched');

  cron.schedule('30 7 * * *', async () => {
    try {
      console.log('[scheduler] morning tick');
      await runMorning(bot);
    } catch (e) {
      console.error('[scheduler] morning error', e && e.message ? e.message : e);
    }
  }, { timezone: 'Europe/Moscow' });

  cron.schedule('30 20 * * *', async () => {
    try {
      console.log('[scheduler] evening tick');
      await runEvening(bot);
    } catch (e) {
      console.error('[scheduler] evening error', e && e.message ? e.message : e);
    }
  }, { timezone: 'Europe/Moscow' });
}

boot().catch((e) => {
  console.error('BOOT FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
