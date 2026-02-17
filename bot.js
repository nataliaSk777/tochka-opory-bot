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

// ✅ Мини-HTTP (health): Railway любит, когда порт слушается
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
    'которые помогают возвращаться к телу',
    'и чувствовать больше устойчивости внутри.',
    '',
    'Утром — 1–2 минуты через дыхание и внимание.',
    'Вечером — мягкое завершение дня.',
    '',
    'Можно просто попробовать первую неделю.'
  ].join('\n');
}

function howText() {
  return [
    'Каждый день приходят два коротких сообщения:',
    '',
    '7:30 — мягкий вход в день через тело.',
    '20:30 — спокойное завершение.',
    '',
    'Первая неделя — чтобы почувствовать формат.',
    'Потом можно продолжить, если откликнется.',
    '',
    'Без спешки.'
  ].join('\n');
}

function weekFinishText() {
  return [
    'Эта неделя подходит к концу.',
    '',
    'Если внутри стало хоть немного спокойнее — это уже движение.',
    'Можно продолжить ещё на 30 дней,',
    'чтобы состояние закрепилось и стало устойчивее.',
    '',
    'А можно не спешить — и просто сохранить то, что уже появилось.',
    '',
    'Я рядом в любом случае.'
  ].join('\n');
}

function startedText() {
  return [
    'Хорошо.',
    '',
    'Завтра в 7:30 придёт первое утреннее сообщение.',
    'Сегодня можно просто опустить плечи и сделать длинный выдох.',
    'Этого достаточно.'
  ].join('\n');
}

function bought30Text() {
  return [
    'Хорошо.',
    '',
    'Ты в 30 днях.',
    'Завтра в 7:30 придёт день 8.',
    'Идём глубже, но всё так же мягко — через тело.'
  ].join('\n');
}

function supportOnText() {
  return [
    'Поддержка включена.',
    '',
    '3 раза в неделю — короткое возвращение к телу.',
    'В 7:30 и 20:30 по Москве.'
  ].join('\n');
}

function stoppedText() {
  return [
    'Остановила отправку сообщений.',
    'Если захочешь вернуться — нажми «🌿 Попробовать первую неделю».'
  ].join('\n');
}

/* ============================================================================
   UI
============================================================================ */

function startKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌿 Попробовать первую неделю', 'START_FREE')],
    [Markup.button.callback('ℹ️ Как это работает', 'HOW')]
  ]);
}

function mainKeyboard(u) {
  const buttons = [];
  const programType = (u && u.programType) ? String(u.programType) : 'none';
  const currentDay = u && typeof u.currentDay !== 'undefined' ? Number(u.currentDay) : 0;
  const weekFinished = (programType === 'free' && currentDay >= 7);

  // 1) Главное действие зависит от состояния
  if (!u || programType === 'none') {
    buttons.push([Markup.button.callback('🌿 Попробовать первую неделю', 'START_FREE')]);
  } else if (weekFinished) {
    buttons.push([Markup.button.callback('✅ Продолжить на 30 дней', 'BUY_30')]);
    buttons.push([Markup.button.callback('Пока не сейчас', 'NO_THANKS')]);
  } else {
    // Во время программы — только “остановить”
    if (programType === 'support') {
      buttons.push([Markup.button.callback('Остановить поддержку', 'STOP')]);
    } else {
      buttons.push([Markup.button.callback('Остановить программу', 'STOP')]);
    }
  }

  // 2) Всегда можно посмотреть “как это работает”
  buttons.push([Markup.button.callback('ℹ️ Как это работает', 'HOW')]);

  return Markup.inlineKeyboard(buttons);
}

/* ============================================================================
   Helpers
============================================================================ */

function getOrCreateUser(chatId) {
  return getUser(chatId) || ensureUser(chatId);
}

/* ============================================================================
   Handlers
============================================================================ */

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  // Первый экран — без “остановить/подписка”, только попробовать + как работает
  if (!u || !u.programType || u.programType === 'none') {
    await ctx.reply(startText(), startKeyboard());
    return;
  }

  // Если пользователь уже в программе — показываем главное меню программы
  await ctx.reply('Я рядом.', mainKeyboard(u));
});

bot.action('HOW', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(howText(), mainKeyboard(u));
});

bot.action('START_FREE', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  u.isActive = true;
  u.programType = 'free';
  u.currentDay = 1;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(startedText(), mainKeyboard(u));
});

bot.action('BUY_30', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  u.isActive = true;
  u.programType = 'paid';
  u.currentDay = 8; // старт платной части после 7 дней
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(bought30Text(), mainKeyboard(u));
});

bot.action('START_SUPPORT', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  u.isActive = true;
  u.programType = 'support';
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(supportOnText(), mainKeyboard(u));
});

bot.action('NO_THANKS', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  await safeAnswerCbQuery(ctx);

  // Если неделя закончилась — отвечаем мягко и оставляем в текущем состоянии без “продаж”
  const programType = u && u.programType ? String(u.programType) : 'none';
  const currentDay = u && typeof u.currentDay !== 'undefined' ? Number(u.currentDay) : 0;
  const weekFinished = (programType === 'free' && currentDay >= 7);

  if (weekFinished) {
    await ctx.reply('Хорошо. Можно не спешить.\nЕсли захочешь — вернёшься к этому позже.', mainKeyboard(u));
    return;
  }

  await ctx.reply('Хорошо.', mainKeyboard(u));
});

bot.action('STOP', async (ctx) => {
  const chatId = ctx.chat.id;
  const u = getOrCreateUser(chatId);

  u.isActive = false;
  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(stoppedText(), startKeyboard());
});

// Если неделя уже завершена — можно показать мягкое пояснение по запросу “как это работает”
bot.hears(/что это|как это работает/i, async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await ctx.reply(howText(), mainKeyboard(u));
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

/* ============================================================================
   Notes for cron scripts (важно)
   - cron_evening.js / cron_morning.js могут слать офферы с кнопками BUY_30, NO_THANKS, START_SUPPORT
   - Эти action-хендлеры здесь есть, так что бот не упадёт из-за “Unknown callback data”
============================================================================ */
