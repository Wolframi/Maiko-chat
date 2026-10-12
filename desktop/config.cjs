const fs = require('node:fs');
const path = require('node:path');
const { MIN_WIDTH, MIN_HEIGHT } = require('./window-geometry.cjs');

function normalizeUrl(value) {
  const url = new URL(String(value).trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Укажите HTTPS-адрес сайта. HTTP разрешён только для localhost.');
  }
  if (url.username || url.password) throw new Error('Адрес не должен содержать логин или пароль.');
  url.hash = '';
  return url.href;
}

function isSameOrigin(value, trustedUrl) {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol)
      && new URL(value).origin === new URL(trustedUrl).origin;
  } catch { return false; }
}

function readJson(filename, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return fallback; }
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const site = path.join(dir, 'site');
    if (fs.existsSync(path.join(site, 'server.ts')) && fs.existsSync(path.join(site, 'package.json'))) return site;
    if (fs.existsSync(path.join(dir, 'server.ts')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Локальный запуск требует папку проекта с server.ts. Используйте Запустить Майко.cmd в корне проекта или подключитесь к сайту.');
}

function visibleBounds(saved, displays) {
  const bounds = { width: 1280, height: 820 };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return bounds;
  bounds.width = Math.min(3840, Math.max(MIN_WIDTH, Math.round(saved.width)));
  bounds.height = Math.min(2160, Math.max(MIN_HEIGHT, Math.round(saved.height)));
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && displays.some(({ workArea: a }) => (
    saved.x + bounds.width > a.x + 80 && saved.x < a.x + a.width - 80
    && saved.y >= a.y && saved.y < a.y + a.height - 80
  ))) {
    bounds.x = Math.round(saved.x);
    bounds.y = Math.round(saved.y);
  }
  return bounds;
}

module.exports = { normalizeUrl, isSameOrigin, readJson, findProjectRoot, visibleBounds };
