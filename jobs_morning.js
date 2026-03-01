'use strict';

const { Markup } = require('telegraf');
const store = require('./store_pg');
const { getMorningText } = require('./content');
const { getPartsInTz, dateKey, isSupportDay, FIXED_TZ } = require('./time');

function shouldSend(u, key) {
  return Boolean(u && u.isActive && u.lastMorningSentKey !== key);
}

function normInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Двигаем программу ПОСЛЕ успешной отправки утреннего сообщения.
 * ВАЖНО: на границах (free day 7, paid day 35) утром не двигаем day,
 * чтобы не было сдвигов и чтобы переход/оплата/переключение делались в своих местах.
 */
function advanceAfterMorning(u) {
  if (!u) return;

  if (u.programType === 'free') {
    const d = normInt(u.currentDay, 1);

    // защита от мусора
    if (d <= 0) {
      u.currentDay = 1;
      return;
    }
    if (d > 7) {
      u.currentDay = 7;
      return;
    }

    // граница: день 7 не двигаем утром
    if (d === 7) {
      u.currentDay = 7;
      return;
    }

    u.currentDay = d + 1;
    return;
  }

  if (u.programType === 'paid') {
    const d = normInt(u.currentDay, 8);

    // защита от мусора
    if (d < 8) {
      u.currentDay = 8;
      return;
    }
    if (d > 35) {
      // если вдруг “улетели” — фиксируем на 35, дальше перевод в support должен сделать вечерний джоб
      u.currentDay = 35;
      return;
    }

    // граница: день 35 не двигаем утром
    if (d === 35) {
      u.currentDay = 35;
      return;
    }

    u.currentDay = d + 1;
    return;
  }

  if (u.programType === 'support') {
    const st = normInt(u.supportStep, 1);
    u.supportStep = Math.max(1, st + 1);
  }
}

function reviewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Написать отзыв', 'REVIEW_WRITE')],
    [Markup.button.callback('Позже', 'REVIEW_LATER')]
  ]);
}

async function maybeAskReview(bot, u, key) {
  if (!u || !u.isActive) return;
  if (u.programType !== 'free') return;
  if (Number(u.currentDay) !== 4) return;

  const ok = await store.claimDelivery(u.chatId, 'review_ask', key);
  if (!ok) return;

  // ✅ ВАЖНО: теперь отзыв точно ловится
  u.awaitingReview = true;
  u.reviewPostponed = false;
  await store.upsertUser(u);

  const text = [
    'Можно я попрошу пару слов?',
    '',
    'Если за эти дни стало хоть чуть спокойнее,',
    'или внимание стало чаще возвращаться в тело —',
    'напиши, пожалуйста, коротко, что ты заметила.',
    '',
    'Мне это очень ценно.'
  ].join('\n');

  await bot.telegram.sendMessage(u.chatId, text, reviewKeyboard());
}

async function maybeRemindReview(bot, u, key) {
  if (!u || !u.isActive) return;
  if (u.programType !== 'free') return;
  if (!u.reviewPostponed) return;
  if (Number(u.currentDay) !== 6) return;

  const ok = await store.claimDelivery(u.chatId, 'review_ask_remind', key);
  if (!ok) return;

  // ✅ тоже включаем ожидание
  u.awaitingReview = true;
  await store.upsertUser(u);

  const text = [
    'Я обещала напомнить мягко — напоминаю.',
    '',
    'Если за эти дни стало хоть чуть спокойнее',
    'или ты стала лучше слышать себя —',
    'напиши пару слов, пожалуйста.',
    '',
    'Это помогает мне делать «Точку опоры» точнее.'
  ].join('\n');

  await bot.telegram.sendMessage(u.chatId, text, reviewKeyboard());

  u.reviewPostponed = false;
  await store.upsertUser(u);
}

async function runMorning(bot) {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

  const users = await store.listUsers();
  let sent = 0;

  for (const u of users) {
    try {
      if (!u || !u.isActive) continue;
      if (!shouldSend(u, key)) continue;

      if (u.programType === 'support' && !isSupportDay(parts)) continue;
      if (u.programType === 'none') continue;

      if (typeof store.claimDelivery === 'function') {
        const ok = await store.claimDelivery(u.chatId, 'morning', key);
        if (!ok) continue;
      }

      // небольшая нормализация перед выбором текста (чтобы не было NaN/undefined)
      if (u.programType === 'free') u.currentDay = normInt(u.currentDay, 1);
      if (u.programType === 'paid') u.currentDay = normInt(u.currentDay, 8);
      if (u.programType === 'support') u.supportStep = Math.max(1, normInt(u.supportStep, 1));

      const text = getMorningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      // ✅ переносим сюда — теперь надёжно
      u.lastMorningSentKey = key;

      if (typeof store.markDeliverySent === 'function') {
        await store.markDeliverySent(u.chatId, 'morning', key);
      }

      await maybeAskReview(bot, u, key);
      await maybeRemindReview(bot, u, key);

      // ✅ единое место правды: advanceAfterMorning сам знает, когда НЕ двигать дни на границах
      advanceAfterMorning(u);

      await store.upsertUser(u);
      sent += 1;

      await new Promise((r) => setTimeout(r, 40));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('[morning] send error', u && u.chatId, msg);

      if (typeof store.markDeliveryError === 'function') {
        try { await store.markDeliveryError(u && u.chatId, 'morning', key, msg); } catch (_) {}
      }

      if (u && (msg.includes('blocked by the user') || msg.includes('chat not found'))) {
        u.isActive = false;
        await store.upsertUser(u);
      }
    }
  }

  console.log(`[morning] ${FIXED_TZ} sent=${sent}`);
  return sent;
}

module.exports = { runMorning };
