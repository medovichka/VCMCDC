/* Modpack Builder — service worker (MV3).
 *
 * Здесь живёт всё, что не требует DOM:
 *   • счётчик модов на иконке расширения;
 *   • пункт контекстного меню «добавить в сборку» (правый клик по ссылке или странице);
 *   • горячая клавиша Alt+Shift+M для текущей открытой страницы проекта;
 *   • адрес приложения берётся из настроек (options.html), по умолчанию localhost:7842.
 */
'use strict';

const DEFAULT_API = 'http://localhost:7842';
const APP_GREEN = '#4ade80';
const SHORT_TIMEOUT = 1500;
const ADD_TIMEOUT = 15000;

const MENU_ADD_LINK = 'mpb-add-link';
const MENU_ADD_PAGE = 'mpb-add-page';
const MENU_OPEN_APP = 'mpb-open-app';

// ─── Настройки ───────────────────────────────────────────────────────────────

let cachedApi = null;

function normalizeApi(value) {
  if (!value || typeof value !== 'string') return null;
  let raw = value.trim().replace(/\/+$/, '');
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '');
    return url.origin + (path === '/' ? '' : path);
  } catch (_) {
    return null;
  }
}

async function getApi() {
  if (cachedApi) return cachedApi;
  try {
    const stored = await chrome.storage.local.get('mpb.config');
    const config = stored && stored['mpb.config'];
    cachedApi = normalizeApi(config && config.api) || DEFAULT_API;
  } catch (_) {
    cachedApi = DEFAULT_API;
  }
  return cachedApi;
}

// Настройки поменяли — забываем кэш, чтобы новый адрес подхватился сразу.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['mpb.config']) {
      cachedApi = null;
      refreshBadgeFromApi();
    }
  });
} catch (_) {}

// chrome.storage.session по умолчанию доступен только «доверенным» контекстам,
// а контент-скрипту он нужен для мгновенной отрисовки из снапшота.
// Уровень доступа сбрасывается при перезапуске воркера, поэтому ставим его
// на верхнем уровне файла — он выполняется каждый раз при пробуждении SW.
try {
  if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
    const p = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
} catch (_) {
  /* старый Chrome — просто не будет мгновенной отрисовки из снапшота */
}

// ─── Сеть ────────────────────────────────────────────────────────────────────

async function apiRequest(path, options, ms) {
  const api = await getApi();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const response = await fetch(api + path, Object.assign({ cache: 'no-store', signal: ctrl.signal }, options || {}));
    let data = null;
    try {
      data = await response.json();
    } catch (_) {}
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function readModCount() {
  try {
    const r = await apiRequest('/api/ping', {}, SHORT_TIMEOUT);
    if (r.ok && r.data && typeof r.data.mods === 'number') return r.data.mods;
  } catch (_) {}
  return null;
}

// ─── Значок на иконке ────────────────────────────────────────────────────────

function setBadge(count) {
  const text = count ? String(count) : '';
  try {
    chrome.action.setBadgeText({ text });
  } catch (_) {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: APP_GREEN });
  } catch (_) {}
  try {
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#000000' });
  } catch (_) {}
}

async function refreshBadgeFromApi() {
  const count = await readModCount();
  if (count !== null) setBadge(count);
}

// ─── Общение со вкладками ────────────────────────────────────────────────────

async function modrinthTabs() {
  try {
    return await chrome.tabs.query({ url: 'https://modrinth.com/*' });
  } catch (_) {
    return [];
  }
}

async function notifyTabs(message) {
  const tabs = await modrinthTabs();
  for (const tab of tabs) {
    if (!tab || typeof tab.id !== 'number') continue;
    try {
      chrome.tabs.sendMessage(tab.id, message, () => {
        // «Receiving end does not exist» — во вкладке нет контент-скрипта, это норма
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }
}

// ─── Разбор ссылок Modrinth ──────────────────────────────────────────────────

function slugFromUrl(value) {
  if (!value || typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)modrinth\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/(mod|plugin|datapack|shader|resourcepack)\/([^/?#]+)/);
  return m ? m[2] : null;
}

// ─── Добавление проекта ──────────────────────────────────────────────────────

async function addProject(slug, tabId) {
  let result;
  try {
    result = await apiRequest(
      '/api/add',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: slug }),
      },
      ADD_TIMEOUT
    );
  } catch (_) {
    await notifyTabs({ type: 'mpb:toast', kind: 'error', text: 'Modpack Builder не запущен' });
    if (typeof tabId === 'number') {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'mpb:toast', kind: 'error', text: 'Modpack Builder не запущен' }, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
    return { ok: false };
  }

  if (!result.ok) {
    const text = (result.data && result.data.error) || 'Не удалось добавить (' + result.status + ')';
    const kind = result.status === 409 ? 'warn' : 'error';
    await notifyTabs({ type: 'mpb:toast', kind, text });
    if (typeof tabId === 'number') {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'mpb:toast', kind, text }, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
    return { ok: false, text };
  }

  const title = (result.data && result.data.mod && result.data.mod.title) || slug;
  await notifyTabs({ type: 'mpb:refresh', toast: { kind: 'ok', text: '✓ ' + title + ' добавлен!' } });

  const count = await readModCount();
  if (count !== null) setBadge(count);
  return { ok: true, title };
}

// ─── Контекстное меню ────────────────────────────────────────────────────────

function buildMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      try {
        chrome.contextMenus.create({
          id: MENU_ADD_LINK,
          title: 'Добавить «%s» в Modpack Builder',
          contexts: ['link'],
          targetUrlPatterns: ['https://modrinth.com/*'],
        });
        chrome.contextMenus.create({
          id: MENU_ADD_PAGE,
          title: 'Добавить проект в Modpack Builder',
          contexts: ['page'],
          documentUrlPatterns: ['https://modrinth.com/*'],
        });
        chrome.contextMenus.create({
          id: MENU_OPEN_APP,
          title: 'Открыть Modpack Builder',
          contexts: ['action'],
        });
      } catch (_) {}
    });
  } catch (_) {}
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPEN_APP) {
    const api = await getApi();
    try {
      chrome.tabs.create({ url: api });
    } catch (_) {}
    return;
  }

  const source = info.menuItemId === MENU_ADD_LINK ? info.linkUrl : info.pageUrl;
  const slug = slugFromUrl(source);
  if (!slug) {
    await notifyTabs({ type: 'mpb:toast', kind: 'warn', text: 'Это не похоже на страницу проекта Modrinth' });
    return;
  }
  await addProject(slug, tab && tab.id);
});

// ─── Горячая клавиша ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'add-current') return;
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (_) {}
  const slug = slugFromUrl(tab && tab.url);
  if (!slug) {
    await notifyTabs({ type: 'mpb:toast', kind: 'warn', text: 'Открой страницу проекта на Modrinth' });
    return;
  }
  await addProject(slug, tab && tab.id);
});

// ─── Сообщения от попапа и контент-скрипта ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'mpb:state') {
    setBadge(typeof msg.count === 'number' && msg.count > 0 ? msg.count : 0);
    try {
      sendResponse({ ok: true });
    } catch (_) {}
    return;
  }

  if (msg.type === 'mpb:refresh') {
    notifyTabs({ type: 'mpb:refresh' }).then(() => {
      try {
        sendResponse({ ok: true });
      } catch (_) {}
    });
    return true; // ответим асинхронно
  }

  if (msg.type === 'mpb:count-now') {
    readModCount().then((count) => {
      if (count !== null) setBadge(count);
      try {
        sendResponse({ ok: true, count });
      } catch (_) {}
    });
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
  refreshBadgeFromApi();
});

chrome.runtime.onInstalled.addListener(() => {
  buildMenus();
  refreshBadgeFromApi();
});
