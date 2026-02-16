'use strict';

require('dotenv').config();
const { Telegraf } = require('telegraf');

const { listUsers, upsertUser } = require('./store');
const { getMorningText } = require('./content');
const { getPartsInTz, dateKey, isTime, isSupportDay, FIXED_TZ } = require('./time');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

function shouldSend(u, key) {
  return u.isActive && u.lastMorningSentKey !== key;
}

function advanceAfterMorning(u) {
  if (u.programType === 'free') {
    if (u.currentDay < 7) u.currentDay += 1;
  }
  if (u.programType === 'paid') {
    if (u.currentDay < 35) u.currentDay += 1;
  }
  if (u.programType === 'support') {
    u.supportStep = Math.max(1, (u.supportStep || 1) + 1);
  }
}

async function main() {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

  if (!isTime(parts, 7, 30)) {
    console.log(`[morning] ${FIXED_TZ} now ${parts.hh}:${String(parts.mm).padStart(2,'0')} skip`);
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

      const text = getMorningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      u.lastMorningSentKey = key;

      // ВАЖНО: в free на дне 7 не продвигаем автоматически в paid
      // В paid на дне 35 не переводим автоматически в support — это отдельное приглашение вечером.
      if (!((u.programType === 'free' && u.currentDay === 7) || (u.programType === 'paid' && u.currentDay === 35))) {
        advanceAfterMorning(u);
      }

      upsertUser(u);
      sent += 1;
    } catch (e) {
      console.error('[morning] send error', u && u.chatId, e && e.message ? e.message : e);
    }
  }

  console.log(`[morning] sent=${sent}`);
}

main().then(() => process.exit(0));
