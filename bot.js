'use strict';

require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { ensureUser, getUser, upsertUser } = require('./store');

/* ============================================================================
   ✅ Boot safety (Railway-friendly)
============================================================================ */

process.on('unhandledRejection', (e) => console.error('UNHANDLED_REJECTION:', e));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION:', e));

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

// Мини-HTTP (health). Railway перестаёт прибивать контейнер SIGTERM.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}).listen(PORT, () => console.log('HTTP listening on', PORT));

console.log('BOOT', new Date().toISOString());

const bot = new Telegraf(BOT_TOKEN);

async function safeAnswerCbQuery(ctx) {
  try { await ctx.answerCbQuery(); } catch (_) {}
}

/* ============================================================================
   UI
============================================================================ */

function mainKeyboard(u) {
  const buttons = [];

  if (!u || u.programType === 'none') {
    buttons.push([Markup.button.callback('Начать первую неделю', 'START_FREE')]);
  } else if (u.programType === 'free') {
    buttons.push([Markup.button.callback('Остановить программу', 'STOP')]);
  } else if (u.programType === 'paid') {
    buttons.push([Markup.button.callback('Остановить программу', 'STOP')]);
  } else if (u.programType === 'support') {
    buttons.push([Markup.button.callback('Остановить поддержку', 'STOP')]);
  }

  // Важно: переход/продление только через «Подписка»
  buttons.push([Markup.button.callback('🔒 Подписка', 'SUB_INFO')]);
  buttons.push([Markup.button.callback('Что это?', 'ABOUT')]);

  return Markup.inlineKeyboard(buttons);
}

function startText() {
  return [
    'Привет.',
    'Это «Точка опоры».',
    '',
    'Если хочется, чтобы внутри стало чуть легче — можем начать с первой недели.',
    'Утром — короткая опора, вечером — мягкое завершение дня.',
    'Сообщения приходят в 7:30 и 20:30 по московскому времени.',
    '',
    'Можно просто попробовать и посмотреть, подходит ли тебе такой формат.'
  ].join('\n');
}

function aboutText() {
  return [
    '«Точка опоры» — это мягкая телесная регуляция.',
    '',
    'Утром в 7:30 (по Москве) — 1–2 минуты через тело.',
    'Вечером в 20:30 — короткий вопрос-якорь.',
    '',
    'Сначала — первая неделя.',
    'Потом — 30 дней глубже.',
    'После — поддержка 3 раза в неделю.'
  ].join('\n');
}

function subscriptionText(u) {
  // Здесь мы соблюдаем твой выбор: показываем “переход” только через кнопку «Подписка».
  // Если неделя закончилась, даём мягкое приглашение продолжить.
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

function subscriptionKeyboard(u) {
  const weekFinished = (u && u.programType === 'free' && Number(u.currentDay) >= 7);

  if (weekFinished) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Продолжить на 30 дней', 'BUY_30')],
      [Markup.button.callback('Пока не сейчас', 'SUB_LATER')]
    ]);
  }

  // Если неделя ещё идёт — не продаём.
  return mainKeyboard(u);
}

/* ============================================================================
   Handlers
============================================================================ */

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const u = ensureUser(chatId);
  await ctx.reply(startText(), mainKeyboard(u));
});

bot.action('ABOUT', async (ctx) => {
  const u = getUser(ctx.chat.id) || ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(aboutText(), mainKeyboard(u));
});

bot.action('SUB_INFO', async (ctx) => {
  const u = getUser(ctx.chat.id) || ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(subscriptionText(u), subscriptionKeyboard(u));
});

bot.action('SUB_LATER', async (ctx) => {
  const u = getUser(ctx.chat.id) || ensureUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Хорошо. Можно вернуться к этому в любой момент через «🔒 Подписка».', mainKeyboard(u));
});

bot.action('START_FREE', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getUser(chatId) || ensureUser(chatId);

  u.isActive = true;
  u.programType = 'free';
  u.currentDay = 1;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    'Хорошо.\n\nЗавтра в 7:30 придёт первое утреннее сообщение.\nСегодня можно просто опустить плечи и сделать длинный выдох.\nЭтого достаточно.',
    mainKeyboard(u)
  );
});

bot.action('BUY_30', async (ctx) => {
  // MVP: “покупка” кнопкой. Реальную оплату подключим отдельно.
  const chatId = ctx.chat.id;
  const u = getUser(chatId) || ensureUser(chatId);

  u.isActive = true;
  u.programType = 'paid';
  u.currentDay = 8; // старт платной части
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    'Хорошо.\n\nТы в 30 днях.\nЗавтра в 7:30 придёт день 8.\nИдём глубже, но всё так же мягко — через тело.',
    mainKeyboard(u)
  );
});

bot.action('START_SUPPORT', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getUser(chatId) || ensureUser(chatId);

  u.isActive = true;
  u.programType = 'support';
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    'Поддержка включена.\n\n3 раза в неделю — короткое возвращение к телу.\nВ 7:30 и 20:30 по Москве.',
    mainKeyboard(u)
  );
});

bot.action('STOP', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getUser(chatId) || ensureUser(chatId);

  u.isActive = false;
  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    'Остановила отправку сообщений.\nЕсли захочешь вернуться — нажми «Начать первую неделю».',
    mainKeyboard(u)
  );
});

/* ============================================================================
   Launch
============================================================================ */

bot.launch()
  .then(() => console.log('BOT: launched'))
  .catch((e) => {
    console.error('BOT: launch failed:', e);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
