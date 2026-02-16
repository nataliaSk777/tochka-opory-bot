'use strict';

const FIXED_TZ = process.env.FIXED_TZ || 'Europe/Moscow';

const WEEKDAY_MAP = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7
};

function getPartsInTz(date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: FIXED_TZ,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  const weekday = WEEKDAY_MAP[map.weekday];
  return {
    tz: FIXED_TZ,
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour),
    mm: Number(map.minute),
    wd: weekday // 1..7 (Mon..Sun)
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(parts) {
  return `${parts.y}-${pad2(parts.m)}-${pad2(parts.d)}`;
}

function isTime(parts, hh, mm) {
  return parts.hh === hh && parts.mm === mm;
}

function isSupportDay(parts) {
  // поддержка: Пн/Ср/Пт
  return parts.wd === 1 || parts.wd === 3 || parts.wd === 5;
}

module.exports = {
  FIXED_TZ,
  getPartsInTz,
  dateKey,
  isTime,
  isSupportDay
};
