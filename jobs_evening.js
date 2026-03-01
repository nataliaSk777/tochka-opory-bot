'use strict';

const { Markup } = require('telegraf');
const store = require('./store_pg');
const { getEveningText } = require('./content');
const { getPartsInTz, dateKey, isSupportDay, FIXED_TZ } = require('./time');

function shouldSend(u, key) {
  return Boolean(u && u.isActive && u.lastEveningSentKey !== key);
}

function normInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function upgradeKeyboard() {
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

/**
 * Вечерняя логика:
 * - currentDay НЕ двигаем (чтобы утро+вечер были “одного дня”)
 * - но на границе paid day 35 делаем ПЕРЕВОД В SUPPORT (чтобы утром пришёл supportEntry)
 */
function advanceAfterEvening(u) {
  if (!u) return;

  if (u.programType === 'paid') {
    const d = normInt(u.currentDay, 8);

    // если дошли до финала — переводим в поддержку
    if (d >= 35) {
      u.programType = 'support';
      u.supportStep = 1;
      // currentDay можно оставить 35 (на историю), либо убрать — оставляем как есть
      u.currentDay = 35;

      // чтобы оффер не повторялся/не конфликтовал
      u.paid35OfferSent = true;
    }
  }
}

async function runEvening(bot) {
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
        const ok = await store.claimDelivery(u.chatId, 'evening', key);
        if (!ok) continue;
      }

      // нормализация перед выбором текста (чтобы не было NaN/undefined)
      if (u.programType === 'free') u.currentDay = normInt(u.currentDay, 1);
      if (u.programType === 'paid') u.currentDay = normInt(u.currentDay, 8);
      if (u.programType === 'support') u.supportStep = Math.max(1, normInt(u.supportStep, 1));

      const text = getEveningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      if (typeof store.markDeliverySent === 'function') {
        await store.markDeliverySent(u.chatId, 'evening', key);
      }

      u.lastEveningSentKey = key;
      await store.upsertUser(u);
      sent += 1;

      // ✅ фикс: больше не будет спама офферами
      // ВАЖНО: оффер после free day 7 — ок, но day не двигаем здесь
      if (u.programType === 'free' && Number(u.currentDay) === 7 && !u.free7OfferSent) {
        await sendOfferAfterFree7(bot, u.chatId);
        u.free7OfferSent = true;
        await store.upsertUser(u);
      }

      // оффер после paid 35 — показываем один раз, затем переводим в поддержку
      if (u.programType === 'paid' && Number(u.currentDay) === 35 && !u.paid35OfferSent) {
        await sendOfferAfterPaid35(bot, u.chatId);
        u.paid35OfferSent = true;
        await store.upsertUser(u);
      }

      // ✅ перевод в поддержку после вечера финального дня (даже если оффер уже был)
      advanceAfterEvening(u);
      await store.upsertUser(u);

      await new Promise((r) => setTimeout(r, 40));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('[evening] send error', u && u.chatId, msg);

      if (typeof store.markDeliveryError === 'function') {
        try { await store.markDeliveryError(u && u.chatId, 'evening', key, msg); } catch (_) {}
      }

      if (u && (msg.includes('blocked by the user') || msg.includes('chat not found'))) {
        u.isActive = false;
        await store.upsertUser(u);
      }
    }
  }

  console.log(`[evening] ${FIXED_TZ} sent=${sent}`);
  return sent;
}

module.exports = { runEvening };
