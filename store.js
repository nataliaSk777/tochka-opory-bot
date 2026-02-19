'use strict';

const fs = require('fs');
const path = require('path');

const STORE_DIR = process.env.STORE_DIR || __dirname;
const STORE_PATH = path.join(STORE_DIR, 'program_store.json');

function ensureDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch (_) {}
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(STORE_PATH)) return { users: {} };
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { users: {} };
    if (!data.users || typeof data.users !== 'object') data.users = {};
    return data;
  } catch {
    return { users: {} };
  }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getUser(chatId) {
  const s = load();
  return s.users[String(chatId)] || null;
}

function upsertUser(user) {
  const s = load();
  s.users[String(user.chatId)] = user;
  save(s);
  return user;
}

function listUsers() {
  const s = load();
  return Object.values(s.users);
}

function ensureUser(chatId) {
  const existing = getUser(chatId);
  if (existing) return existing;

  const u = {
    chatId,
    isActive: true,
    programType: 'none',
    currentDay: 1,
    supportStep: 1,
    lastMorningSentKey: null,
    lastEveningSentKey: null
  };

  upsertUser(u);
  return u;
}

module.exports = {
  getUser,
  upsertUser,
  listUsers,
  ensureUser
};
