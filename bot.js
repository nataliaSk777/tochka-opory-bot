'use strict';

require('dotenv').config();
const http = require('http');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const { ensureUser, getUser, upsertUser } = require('./store');
const { runMorning } = require('./jobs_morning');
const { runEvening } = require('./jobs_evening');

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
  try {
    await ctx.answerCbQuery();
  } catch (_) {}
}

/* ============================================================================
   Helpers
============================================================================ */

function getOrCreateUser(chatId) {
  return getUser(chatId) || ensureUser(chatId);
}

function isActiveProgram(u) {
  return !!(u && u.isActive && u.programType && u.programType !== 'none');
}

function isOwner(ctx) {
  const ownerIdRaw = process.env.OWNER_CHAT_ID;
  if (!ownerIdRaw) return null; // owner check disabled
  const ownerId = Number(ownerIdRaw);
  if (!Number.isFinite(ownerId)) return null; // invalid var => disable
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

// Главное правило: после старта НЕ показываем “Остановить” в основном меню.
// Остановка — через “Как это работает” (там кнопка) + /stop + “стоп”.
function mainKeyboard(u) {
  // если программа не активна — показываем старт + как это работает
  if (!isActiveProgram(u)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🌿 Попробовать первую неделю', 'START_FREE')],
      [Markup.button.callback('ℹ️ Как это работает', 'HOW')]
    ]);
  }

  // если активна — только “как это работает”
  return Markup.inlineKeyboard([[Markup.button.callback('ℹ️ Как это работает', 'HOW')]]);
}

function howKeyboard(u) {
  // тут даём “Остановить”, но только если активна программа
  if (isActiveProgram(u)) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('⛔️ Остановить', 'STOP')],
      [Markup.button.callback('⬅️ Назад', 'BACK')]
    ]);
  }

  return Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'BACK')]]);
}

function subscriptionKeyboard(u) {
  const weekFinished = u && u.programType === 'free' && Number(u.currentDay) >= 7;

  if (weekFinished) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('Продолжить на 30 дней', 'BUY_30')],
      [Markup.button.callback('Пока не сейчас', 'SUB_LATER')]
    ]);
  }

  return mainKeyboard(u);
}

/* ============================================================================
   Debug (private)
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
  try {
    if (!ctx.chat) {
      await ctx.reply('Не удалось определить chat.id');
      return;
    }
    const id = ctx.chat.id;
    const type = ctx.chat.type || 'unknown';
    await ctx.reply(['Твой chat.id:', '', String(id), '', `Тип чата: ${type}`].join('\n'));
  } catch (e) {
    console.error('myid error', e);
    await ctx.reply('Ошибка при получении chat.id');
  }
});

bot.command('debug_users', async (ctx) => {
  try {
    const ownerFlag = isOwner(ctx);
    if (ownerFlag === false) {
      await ctx.reply('Эта команда доступна только владельцу бота.');
      return;
    }

    // Если OWNER_CHAT_ID не задан — ограничим личкой, чтобы не утекло в группах
    if (ownerFlag === null) {
      if (!ctx.chat || ctx.chat.type !== 'private') {
        await ctx.reply('Эта команда работает только в личном чате с ботом.');
        return;
      }
    }

    const { listUsers } = require('./store');
    const users = listUsers();

    const header = `users=${users.length}`;
    if (!users.length) {
      await ctx.reply(`${header}\n(пусто)`);
      return;
    }

    await ctx.reply(header);

    const lines = users.map(shortUserLine);
    const chunkSize = 30;
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunk = lines.slice(i, i + chunkSize).join('\n');
      await ctx.reply(chunk);
    }
  } catch (e) {
    console.error('debug_users error', e);
    await ctx.reply('Не получилось прочитать базу пользователей. Посмотри логи.');
  }
});

/* ============================================================================
   Handlers
============================================================================ */

bot.start(async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await ctx.reply(startText(), mainKeyboard(u));
});

// “Как это работает”
bot.action('HOW', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(howText(u), howKeyboard(u));
});

// “Назад” — вернуться к главному экрану (без лишних кнопок)
bot.action('BACK', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Ок.', mainKeyboard(u));
});

// Подписка (ветка-описание)
bot.action('SUB_INFO', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply(subscriptionText(u), subscriptionKeyboard(u));
});

bot.action('SUB_LATER', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);
  await safeAnswerCbQuery(ctx);
  await ctx.reply('Хорошо. Можно вернуться к этому позже.', mainKeyboard(u));
});

// Старт первой недели
bot.action('START_FREE', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'free';
  u.currentDay = 1;
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(afterStartText(), mainKeyboard(u));
});

// Переход на 30 дней (MVP-кнопка)
bot.action('BUY_30', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'paid';
  u.currentDay = 8; // старт платной части (после 7 дней)
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    [
      'Хорошо.',
      '',
      'Ты в 30 днях.',
      'Завтра в 7:30 придёт день 8.',
      'Идём глубже, но всё так же мягко — через тело.'
    ].join('\n'),
    mainKeyboard(u)
  );
});

bot.action('START_SUPPORT', async (ctx) => {
  const u = getOrCreateUser(ctx.chat.id);

  u.isActive = true;
  u.programType = 'support';
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await safeAnswerCbQuery(ctx);
  await ctx.reply(
    [
      'Поддержка включена.',
      '',
      '3 раза в неделю — короткое возвращение к телу.',
      'В 7:30 и 20:30 по Москве.'
    ].join('\n'),
    mainKeyboard(u)
  );
});

// Остановка — через “Как это работает” или /stop или “стоп”
async function stopProgram(ctx) {
  const u = getOrCreateUser(ctx.chat.id);

  u.isActive = false;
  // programType оставляем как историю, выключаем только активность
  upsertUser(u);

  await ctx.reply(stoppedText(), mainKeyboard(u));
}

bot.action('STOP', async (ctx) => {
  await safeAnswerCbQuery(ctx);
  await stopProgram(ctx);
});

bot.command('stop', async (ctx) => {
  await stopProgram(ctx);
});

bot.hears(/^стоп$/i, async (ctx) => {
  await stopProgram(ctx);
});

/* ============================================================================
   Launch + Scheduler (ONE SERVICE!)
============================================================================ */

bot
  .launch()
  .then(() => console.log('BOT: launched'))
  .catch((e) => {
    console.error('BOT: launch failed:', e);
    process.exit(1);
  });

// ✅ Утро: каждый день в 07:30 по Москве
cron.schedule(
  '30 7 * * *',
  async () => {
    try {
      console.log('[scheduler] morning tick');
      await runMorning(bot);
    } catch (e) {
      console.error('[scheduler] morning error', e && e.message ? e.message : e);
    }
  },
  { timezone: 'Europe/Moscow' }
);

// ✅ Вечер: каждый день в 20:30 по Москве
cron.schedule(
  '30 20 * * *',
  async () => {
    try {
      console.log('[scheduler] evening tick');
      await runEvening(bot);
    } catch (e) {
      console.error('[scheduler] evening error', e && e.message ? e.message : e);
    }
  },
  { timezone: 'Europe/Moscow' }
);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
