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
  return Boolean(u && u.isActive && u.lastEveningSentKey !== key);
}

/* ============================================================================
   Keyboards
============================================================================ */

function upgradeKeyboard() {
  // Важно: после 7 дней не ведём напрямую на BUY_30, а мягко отправляем в «Подписка»
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔒 Подписка', 'SUB_INFO')],
    [Markup.button.callback('Пока не сейчас', 'SUB_LATER')]
  ]);
}

function supportKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Перейти в поддержку', 'START_SUPPORT')],
    [Markup.button.callback('Пока не сейчас', 'SUB_LATER')]
  ]);
}

/* ============================================================================
   Offers
============================================================================ */

async function sendOfferAfterFree7(chatId) {
  const text = [
    'Если за эти дни стало чуть свободнее в теле — это важно.',
    '',
    'Продолжение на 30 дней помогает закрепить состояние: спокойно и устойчиво.',
    'Без перегруза. Всё так же мягко — через тело.',
    '',
    'Если захочешь — открой «🔒 Подписка».'
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

/* ============================================================================
   Main
============================================================================ */

async function main() {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

  if (!isTime(parts, 20, 30)) {
    console.log(
      `[evening] ${FIXED_TZ} now ${parts.hh}:${String(parts.mm).padStart(2, '0')} skip`
    );
    return;
  }

  const users = listUsers();
  let sent = 0;

  for (const u of users) {
    try {
      if (!u || !u.isActive) continue;
      if (!shouldSend(u, key)) continue;

      // support — только в “дни поддержки”
      if (u.programType === 'support' && !isSupportDay(parts)) continue;

      // programType none — ничего не отправляем
      if (u.programType === 'none') continue;

      const text = getEveningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      u.lastEveningSentKey = key;
      upsertUser(u);
      sent += 1;

      // Оффер после 7 дней free: мягко → «Подписка»
      if (u.programType === 'free' && Number(u.currentDay) === 7) {
        await sendOfferAfterFree7(u.chatId);
      }

      // Оффер после 35 дней paid: предложить поддержку
      if (u.programType === 'paid' && Number(u.currentDay) === 35) {
        await sendOfferAfterPaid35(u.chatId);
      }
    } catch (e) {
      console.error('[evening] send error', u && u.chatId, e && e.message ? e.message : e);
    }
  }

  console.log(`[evening] sent=${sent}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[evening] fatal', e && e.message ? e.message : e);
    process.exit(1);
  });
