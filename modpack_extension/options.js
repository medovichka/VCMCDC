/* Modpack Builder — страница настроек.
 *
 * Единственная настройка: адрес локального приложения. Он же используется
 * контент-скриптом, попапом и сервис-воркером (все читают chrome.storage.local).
 */
'use strict';

(() => {
  const DEFAULT_API = 'http://localhost:7842';
  const KEY = 'mpb.config';

  const els = {
    input: document.getElementById('apiInput'),
    save: document.getElementById('saveBtn'),
    test: document.getElementById('testBtn'),
    reset: document.getElementById('resetBtn'),
    keys: document.getElementById('keysBtn'),
    status: document.getElementById('statusLine'),
  };

  let statusTimer = null;

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
    if (statusTimer) clearTimeout(statusTimer);
    if (text) {
      statusTimer = setTimeout(() => {
        els.status.textContent = '';
        els.status.className = 'status';
      }, 6000);
    }
  }

  // Приводим ввод к виду «http://host:port» (без хвостового слэша)
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

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(KEY);
      const config = stored && stored[KEY];
      els.input.value = (config && config.api) || DEFAULT_API;
    } catch (_) {
      els.input.value = DEFAULT_API;
    }
  }

  async function save(api) {
    await chrome.storage.local.set({ [KEY]: { api } });
  }

  async function probe(api) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const response = await fetch(api + '/api/ping', { cache: 'no-store', signal: ctrl.signal });
      if (!response.ok) return null;
      const data = await response.json();
      return data && data.ok ? data : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  els.save.addEventListener('click', async () => {
    const api = normalizeApi(els.input.value);
    if (!api) {
      setStatus('Некорректный адрес. Пример: http://localhost:7842', 'err');
      return;
    }
    els.input.value = api;
    await save(api);
    const info = await probe(api);
    if (info) {
      setStatus(`Сохранено. Приложение отвечает, модов в коллекции: ${info.mods}`, 'ok');
    } else {
      setStatus('Сохранено, но приложение не отвечает по этому адресу', 'err');
    }
  });

  els.test.addEventListener('click', async () => {
    const api = normalizeApi(els.input.value);
    if (!api) {
      setStatus('Некорректный адрес. Пример: http://localhost:7842', 'err');
      return;
    }
    setStatus('Проверяю…');
    const started = performance.now();
    const info = await probe(api);
    const ms = Math.round(performance.now() - started);
    if (info) {
      setStatus(`Связь есть (${ms} мс). API v${info.api}, модов: ${info.mods}`, 'ok');
    } else {
      setStatus('Нет ответа. Запусти приложение: python app.py', 'err');
    }
  });

  els.reset.addEventListener('click', async () => {
    els.input.value = DEFAULT_API;
    await save(DEFAULT_API);
    setStatus('Адрес сброшен на ' + DEFAULT_API, 'ok');
  });

  els.keys.addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    } catch (_) {
      setStatus('Открой chrome://extensions/shortcuts вручную', 'err');
    }
  });

  loadConfig();
})();
