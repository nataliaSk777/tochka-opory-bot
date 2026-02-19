'use strict';

const { listUsers, upsertUser } = require('./store');
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

async function runMorning(bot) {
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

      const text = getMorningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      u.lastMorningSentKey = key;

      const isBoundary =
        (u.programType === 'free' && Number(u.currentDay) === 7) ||
        (u.programType === 'paid' && Number(u.currentDay) === 35);

      if (!isBoundary) {
        advanceAfterMorning(u);
      }

      upsertUser(u);
      sent += 1;
    } catch (e) {
      console.error('[morning] send error', u && u.chatId, e && e.message ? e.message : e);
    }
  }

  console.log(`[morning] ${FIXED_TZ} sent=${sent}`);
  return sent;
}

module.exports = { runMorning };
