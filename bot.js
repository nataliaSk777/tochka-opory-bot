'use strict';

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { ensureUser, getUser, upsertUser } = require('./store');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function mainKeyboard(u) {
  const buttons = [];

  if (!u || u.programType === 'none') {
    buttons.push([Markup.button.callback('Начать бесплатные 7 дней', 'START_FREE')]);
  } else if (u.programType === 'free') {
    buttons.push([Markup.button.callback('Перейти на 30 дней', 'BUY_30')]);
    buttons.push([Markup.button.callback('Остановить программу', 'STOP')]);
  } else if (u.programType === 'paid') {
    buttons.push([Markup.button.callback('Остановить программу', 'STOP')]);
  } else if (u.programType === 'support') {
    buttons.push([Markup.button.callback('Остановить поддержку', 'STOP')]);
  }

  buttons.push([Markup.button.callback('Что это?', 'ABOUT')]);

  return Markup.inlineKeyboard(buttons);
}

function aboutText() {
  return [
    '«Точка опоры» — это мягкая телесная регуляция.',
    '',
    'Утром в 7:30 (по Москве) — 1–2 минуты через тело.',
    'Вечером в 20:30 — короткий вопрос-якорь.',
    '',
    'Сначала — бесплатные 7 дней.',
    'Потом — 30 дней глубже.',
    'После — поддержка 3 раза в неделю.'
  ].join('\n');
}

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const u = ensureUser(chatId);

  const text = [
    'Привет.',
    'Это «Точка опоры».',
    '',
    'Если хочется, чтобы внутри стало чуть легче — можем начать с первой недели.
Утром — короткая опора, вечером — мягкое завершение дня.
Сообщения приходят в 7:30 и 20:30 по московскому времени.

Можно просто попробовать и посмотреть, подходит ли тебе такой формат.',
    'Сообщения приходят в 7:30 и 20:30 по московскому времени.'
  ].join('\n');

  await ctx.reply(text, mainKeyboard(u));
});

bot.action('ABOUT', async (ctx) => {
  const u = getUser(ctx.chat.id) || ensureUser(ctx.chat.id);
  await ctx.answerCbQuery();
  await ctx.reply(aboutText(), mainKeyboard(u));
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

  await ctx.answerCbQuery();
  await ctx.reply(
    'Отлично.\n\nЗавтра в 7:30 придёт первое утреннее сообщение.\nСегодня можно просто опустить плечи и сделать длинный выдох.\nЭтого достаточно.',
    mainKeyboard(u)
  );
});

bot.action('BUY_30', async (ctx) => {
  // MVP: “покупка” кнопкой. Реальную оплату подключим отдельно.
  const chatId = ctx.chat.id;
  const u = getUser(chatId) || ensureUser(chatId);

  u.isActive = true;
  u.programType = 'paid';
  u.currentDay = 8;        // старт платной части
  u.supportStep = 1;
  u.lastMorningSentKey = null;
  u.lastEveningSentKey = null;

  upsertUser(u);

  await ctx.answerCbQuery();
  await ctx.reply(
    'Ты в 30 днях.\n\nЗавтра в 7:30 придёт день 8.\nИдём глубже, но всё так же мягко — через тело.',
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

  await ctx.answerCbQuery();
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

  await ctx.answerCbQuery();
  await ctx.reply('Остановила отправку сообщений. Если захочешь вернуться — нажми «Начать бесплатные 7 дней».', mainKeyboard(u));
});

bot.launch().then(() => console.log('bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
