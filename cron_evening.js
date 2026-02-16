'use strict';

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const { listUsers, upsertUser } = require('./store');
const { getEveningText } = require('./content');
const { getPartsInTz, dateKey, isTime, isSupportDay, FIXED_TZ } = require('./time');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

function shouldSend(u, key) {
  return u.isActive && u.lastEveningSentKey !== key;
}

function upgradeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Перейти на 30 дней', 'BUY_30')],
    [Markup.button.callback('Пока не сейчас', 'NO_THANKS')]
  ]);
}

function supportKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Перейти в поддержку', 'START_SUPPORT')],
    [Markup.button.callback('Закончить', 'NO_THANKS')]
  ]);
}

async function sendOfferAfterFree7(chatId) {
  const text = [
    'Если за эти дни стало чуть свободнее в теле — это только начало.',
    '',
    '30 дней помогут закрепить это состояние.',
    'Без перегруза. Всё так же мягко — через тело.',
    '',
    'Хочешь продолжить?'
  ].join('\n');
  await bot.telegram.sendMessage(chatId, text, upgradeKeyboard());
}

async function sendOfferAfterPaid35(chatId) {
  const text = [
    'За этот месяц тело стало спокойнее.',
    'И это можно сохранить.',
    '',
    'Поддержка — 3 раза в неделю.',
    'Короткое возвращение к телу в твоём ритме.',
    '',
    'Хочешь остаться в этом состоянии?'
  ].join('\n');
  await bot.telegram.sendMessage(chatId, text, supportKeyboard());
}

async function main() {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

  if (!isTime(parts, 20, 30)) {
    console.log(`[evening] ${FIXED_TZ} now ${parts.hh}:${String(parts.mm).padStart(2,'0')} skip`);
    return;
  }

  const users = listUsers();
  let sent = 0;

  for (const u of users) {
    try {
      if (!u || !u.isActive) continue;
      if (!shouldSend(u, key)) continue;

      if (u.programType === 'support' && !isSupportDay(parts)) continue;
      if (u.programType === 'none') continue;

      const text = getEveningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      u.lastEveningSentKey = key;
      upsertUser(u);
      sent += 1;

      // Офферы:
      if (u.programType === 'free' && u.currentDay === 7) {
        await sendOfferAfterFree7(u.chatId);
      }

      if (u.programType === 'paid' && u.currentDay === 35) {
        await sendOfferAfterPaid35(u.chatId);
      }
    } catch (e) {
      console.error('[evening] send error', u && u.chatId, e && e.message ? e.message : e);
    }
  }

  console.log(`[evening] sent=${sent}`);
}

main().then(() => process.exit(0));
