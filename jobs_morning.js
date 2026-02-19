'use strict';

const { Markup } = require('telegraf');
const store = require('./store_pg');
const { getMorningText } = require('./content');
const { getPartsInTz, dateKey, isSupportDay, FIXED_TZ } = require('./time');

function shouldSend(u, key) {
  return Boolean(u && u.isActive && u.lastMorningSentKey !== key);
}

function advanceAfterMorning(u) {
  if (!u) return;

  if (u.programType === 'free') {
    if (Number(u.currentDay || 1) < 7) u.currentDay = Number(u.currentDay || 1) + 1;
    return;
  }

  if (u.programType === 'paid') {
    if (Number(u.currentDay || 8) < 35) u.currentDay = Number(u.currentDay || 8) + 1;
    return;
  }

  if (u.programType === 'support') {
    u.supportStep = Math.max(1, Number(u.supportStep || 1) + 1);
  }
}

function reviewKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Написать отзыв', 'REVIEW_WRITE')],
    [Markup.button.callback('Позже', 'REVIEW_LATER')]
  ]);
}

async function maybeAskReview(bot, u, key) {
  // просим отзыв на 4-й день free (после отправки сообщения)
  if (!u || !u.isActive) return;
  if (u.programType !== 'free') return;
  if (Number(u.currentDay) !== 4) return;

  const ok = await store.claimDelivery(u.chatId, 'review_ask', key);
  if (!ok) return;

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
  // одно мягкое напоминание тем, кто нажал “Позже”
  if (!u || !u.isActive) return;
  if (u.programType !== 'free') return;
  if (!u.reviewPostponed) return;
  if (Number(u.currentDay) !== 6) return;

  const ok = await store.claimDelivery(u.chatId, 'review_ask_remind', key);
  if (!ok) return;

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

  // чтобы напоминание было только один раз
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

      // защита от дублей на уровне БД
      if (typeof store.claimDelivery === 'function') {
        const ok = await store.claimDelivery(u.chatId, 'morning', key);
        if (!ok) continue;
      }

      const text = getMorningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      if (typeof store.markDeliverySent === 'function') {
        await store.markDeliverySent(u.chatId, 'morning', key);
      }

      // после успешной отправки — можем попросить отзыв (один раз)
      await maybeAskReview(bot, u, key);

      // и можем один раз мягко напомнить на 6-й день (если откладывали)
      await maybeRemindReview(bot, u, key);

      u.lastMorningSentKey = key;

      const isBoundary =
        (u.programType === 'free' && Number(u.currentDay) === 7) ||
        (u.programType === 'paid' && Number(u.currentDay) === 35);

      if (!isBoundary) advanceAfterMorning(u);

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
