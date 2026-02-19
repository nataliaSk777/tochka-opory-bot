'use strict';

const { Markup } = require('telegraf');

const { listUsers, upsertUser } = require('./store');
const { getEveningText } = require('./content');
const { getPartsInTz, dateKey, isSupportDay, FIXED_TZ } = require('./time');

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

async function sendOfferAfterFree7(bot, chatId) {
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

async function sendOfferAfterPaid35(bot, chatId) {
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
   Main job
============================================================================ */

async function runEvening(bot) {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

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
        await sendOfferAfterFree7(bot, u.chatId);
      }

      // Оффер после 35 дней paid: предложить поддержку
      if (u.programType === 'paid' && Number(u.currentDay) === 35) {
        await sendOfferAfterPaid35(bot, u.chatId);
      }
    } catch (e) {
      console.error('[evening] send error', u && u.chatId, e && e.message ? e.message : e);
    }
  }

  console.log(`[evening] ${FIXED_TZ} sent=${sent}`);
  return sent;
}

module.exports = { runEvening };
