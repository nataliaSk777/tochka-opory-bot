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

async function main() {
  const parts = getPartsInTz(new Date());
  const key = dateKey(parts);

  if (!isTime(parts, 7, 30)) {
    console.log(
      `[morning] ${FIXED_TZ} now ${parts.hh}:${String(parts.mm).padStart(2, '0')} skip`
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

      const text = getMorningText(u.programType, u.currentDay, u.supportStep);
      if (!text) continue;

      await bot.telegram.sendMessage(u.chatId, text);

      u.lastMorningSentKey = key;

      // ВАЖНО: free на дне 7 не переводим автоматически в paid
      // ВАЖНО: paid на дне 35 не переводим автоматически в support
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

  console.log(`[morning] sent=${sent}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[morning] fatal', e && e.message ? e.message : e);
    process.exit(1);
  });
