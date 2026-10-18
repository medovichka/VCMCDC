/* Modpack Builder — логика попапа (MV3, без сборки).
 *
 * Порядок работы:
 *   1) читаем настройки (адрес приложения — по умолчанию localhost:7842);
 *   2) мгновенно рисуем данные из снапшота chrome.storage.session (без спиннера);
 *   3) параллельно проверяем живость приложения через /api/ping и обновляем
 *      коллекцию через /api/collection (учитываем 304 и не-200);
 *   4) после изменений просим бэкграунд разослать «обновись» вкладкам Modrinth.
 */
'use strict';

(() => {
  const DEFAULT_API = 'http://localhost:7842';
  const CONFIG_KEY = 'mpb.config';
  const SNAPSHOT_KEY = 'mpb.collection';
  const SNAPSHOT_TTL = 15 * 60 * 1000;

  const PING_TIMEOUT = 1200;
  const COLLECTION_TIMEOUT = 3500;
  const MUTATION_TIMEOUT = 8000;

  let API = DEFAULT_API;
  const url = (path) => API + path;

  const state = {
    mods: null, // null = данных ещё нет
    revision: -1,
    compat: [],
    selected: null,
    phase: 'loading', // loading | online | offline
  };
  let etag = null;

  const els = {
    dot: document.getElementById('statusDot'),
    text: document.getElementById('statusText'),
    offline: document.getElementById('offlineMsg'),
    msg: document.getElementById('msgLine'),
    content: document.getElementById('onlineContent'),
    statMods: document.getElementById('statMods'),
    statVersions: document.getElementById('statVersions'),
    statLoaders: document.getElementById('statLoaders'),
    versionLine: document.getElementById('versionLine'),
    versionValue: document.getElementById('versionValue'),
    list: document.getElementById('modList'),
    open: document.getElementById('btnOpen'),
    clear: document.getElementById('btnClear'),
    options: document.getElementById('btnOptions'),
    quickInput: document.getElementById('quickInput'),
    quickAdd: document.getElementById('quickAdd'),
  };

  // ─── Утилиты ──────────────────────────────────────────────────────────────

  function fetchWithTimeout(target, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const opts = Object.assign({ cache: 'no-store' }, options || {});
    opts.signal = ctrl.signal;
    return fetch(target, opts).finally(() => clearTimeout(timer));
  }

  function extAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  }

  function normalizeApi(value) {
    if (!value || typeof value !== 'string') return null;
    let raw = value.trim().replace(/\/+$/, '');
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const path = parsed.pathname.replace(/\/+$/, '');
      return parsed.origin + (path === '/' ? '' : path);
    } catch (_) {
      return null;
    }
  }

  async function loadConfig() {
    if (!extAlive() || !chrome.storage || !chrome.storage.local) return;
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const config = stored && stored[CONFIG_KEY];
      API = normalizeApi(config && config.api) || DEFAULT_API;
    } catch (_) {
      API = DEFAULT_API;
    }
  }

  // Slug из ссылки Modrinth либо из простого slug
  function guessSlug(value) {
    const text = String(value || '').trim();
    const m = text.match(/modrinth\.com\/(?:mod|plugin|datapack|shader|resourcepack|modpack)\/([^/?#]+)/i);
    return m ? m[1] : text;
  }

  let msgToken = 0;
  function showMsg(text, kind) {
    els.msg.textContent = text;
    els.msg.className = 'msg-line' + (kind ? ' ' + kind : '');
    els.msg.style.display = 'block';
    msgToken += 1;
    const token = msgToken;
    setTimeout(() => {
      if (token === msgToken) els.msg.style.display = 'none';
    }, 4000);
  }

  // ─── Снимок состояния ─────────────────────────────────────────────────────

  async function readSnapshot() {
    if (!extAlive() || !chrome.storage || !chrome.storage.session) return null;
    try {
      const res = await chrome.storage.session.get(SNAPSHOT_KEY);
      const snap = res && res[SNAPSHOT_KEY];
      if (!snap || typeof snap !== 'object' || !snap.mods) return null;
      if (Date.now() - (snap.ts || 0) > SNAPSHOT_TTL) return null;
      return snap;
    } catch (_) {
      return null;
    }
  }

  async function saveSnapshot() {
    if (!extAlive() || !chrome.storage || !chrome.storage.session || !state.mods) return;
    try {
      await chrome.storage.session.set({
        [SNAPSHOT_KEY]: { revision: state.revision, mods: state.mods, ts: Date.now() },
      });
    } catch (_) {}
  }

  // ─── Сеть ─────────────────────────────────────────────────────────────────

  // Живость приложения: /api/ping — быстрый, без чтения диска
  async function probe() {
    try {
      const r = await fetchWithTimeout(url('/api/ping'), {}, PING_TIMEOUT);
      if (!r.ok) return false;
      const d = await r.json();
      return !!d && d.ok === true;
    } catch (_) {
      return false;
    }
  }

  // Коллекция: 200 — обновляем, 304 — оставляем текущее состояние, иначе ошибка
  async function loadCollection() {
    try {
      const headers = {};
      if (etag) headers['If-None-Match'] = etag;
      const r = await fetchWithTimeout(url('/api/collection'), { headers }, COLLECTION_TIMEOUT);

      if (r.status === 304) return true; // ничего не изменилось
      if (!r.ok) return false;

      const d = await r.json();
      const newEtag = r.headers.get('ETag');
      if (newEtag) etag = newEtag;

      state.mods = (d && d.mods) || {};
      if (d && typeof d.revision === 'number') state.revision = d.revision;
      state.compat = (d && d.compat_versions) || [];
      state.selected = (d && d.selected_version) || null;
      saveSnapshot();
      render();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function apiPost(target, body) {
    const r = await fetchWithTimeout(
      target,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      MUTATION_TIMEOUT
    );
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || 'HTTP ' + r.status);
    return data || {};
  }

  // Просим бэкграунд разослать обновление во все вкладки Modrinth
  function notifyRefresh() {
    if (!extAlive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'mpb:refresh' }, () => {
        void chrome.runtime.lastError; // получателя может не быть — это норма
      });
    } catch (_) {}
  }

  // ─── Отрисовка ────────────────────────────────────────────────────────────

  function setPhase(phase) {
    state.phase = phase;

    if (phase === 'online') {
      els.dot.classList.add('online');
      els.text.classList.add('online');
      els.text.textContent = 'онлайн';
      els.offline.style.display = 'none';
      els.content.style.display = 'block';
    } else if (phase === 'offline') {
      els.dot.classList.remove('online');
      els.text.classList.remove('online');
      els.text.textContent = 'офлайн';
      els.offline.style.display = 'block';
      els.content.style.display = 'none';
      return;
    } else {
      els.dot.classList.remove('online');
      els.text.classList.remove('online');
      els.text.textContent = 'проверка…';
      els.offline.style.display = 'none';
      els.content.style.display = 'block';
    }

    if (state.mods === null) render();
  }

  function dominantLoader(mods, slugs) {
    const counts = {};
    for (const slug of slugs) {
      const loaders = (mods[slug] && mods[slug].loaders) || [];
      for (const l of loaders) counts[l] = (counts[l] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0].slice(0, 3).toUpperCase() : '—';
  }

  // Короткая метка типа проекта (у обычных модов её нет)
  const TYPE_LABEL = {
    plugin: 'плагин',
    datapack: 'датапак',
    shader: 'шейдер',
    resourcepack: 'ресурспак',
  };

  // Строка списка: всё через createElement/textContent, никакой HTML-интерполяции
  function modRow(slug, mod) {
    const row = document.createElement('div');
    row.className = 'mod-row';

    const title = (mod && mod.title) || slug;

    if (mod && mod.icon_url) {
      const img = document.createElement('img');
      img.src = mod.icon_url;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.style.display = 'none'; // битая иконка не должна ломать строку
      });
      row.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'mod-icon-fallback';
      ph.textContent = '🧩';
      row.appendChild(ph);
    }

    const name = document.createElement('span');
    name.className = 'mod-row-name';
    name.textContent = title;
    name.title = title;
    row.appendChild(name);

    const type = mod && mod.project_type;
    if (type && type !== 'mod') {
      const badge = document.createElement('span');
      badge.className = 'mod-row-type';
      badge.textContent = TYPE_LABEL[type] || type;
      row.appendChild(badge);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mod-row-remove';
    btn.textContent = '✕';
    btn.title = 'Удалить из коллекции';
    btn.setAttribute('aria-label', 'Удалить ' + title);
    btn.addEventListener('click', () => removeMod(slug, btn));
    row.appendChild(btn);

    return row;
  }

  function renderList(mods, slugs) {
    els.list.textContent = '';

    if (!slugs.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        state.phase === 'loading' && state.mods === null
          ? 'Загрузка…'
          : 'Коллекция пуста. Открой мод на Modrinth!';
      els.list.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const slug of slugs) frag.appendChild(modRow(slug, mods[slug]));
    els.list.appendChild(frag);
  }

  function render() {
    const mods = state.mods || {};
    const slugs = Object.keys(mods);

    els.statMods.textContent = String(slugs.length);
    els.statVersions.textContent = String(state.compat.length);
    els.statLoaders.textContent = dominantLoader(mods, slugs);
    renderList(mods, slugs);

    if (state.selected) {
      els.versionValue.textContent = state.selected;
      els.versionLine.style.display = 'flex';
    } else {
      els.versionLine.style.display = 'none';
    }
  }

  // ─── Действия ─────────────────────────────────────────────────────────────

  function openApp() {
    try {
      chrome.tabs.create({ url: API });
    } catch (_) {
      window.open(API, '_blank');
    }
  }

  function openOptions() {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        return;
      }
    } catch (_) {}
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    } catch (_) {}
  }

  async function quickAdd() {
    const slug = guessSlug(els.quickInput.value);
    if (!slug) return;
    if (state.mods && Object.prototype.hasOwnProperty.call(state.mods, slug)) {
      showMsg(`«${slug}» уже в коллекции`, 'warn');
      return;
    }

    els.quickAdd.disabled = true;
    try {
      const d = await apiPost(url('/api/add'), { url: slug });
      const title = (d.mod && d.mod.title) || slug;
      state.mods = Object.assign({}, state.mods || {}, { [slug]: d.mod });
      if (typeof d.revision === 'number') state.revision = d.revision;
      els.quickInput.value = '';
      showMsg('✓ ' + title + ' добавлен!', 'ok');
      saveSnapshot();
      render();
      notifyRefresh();
      await loadCollection();
      setPhase('online');
    } catch (err) {
      showMsg((err && err.message) || 'Не удалось добавить', 'err');
    } finally {
      els.quickAdd.disabled = false;
    }
  }

  async function removeMod(slug, btn) {
    if (btn) btn.disabled = true;
    try {
      const d = await apiPost(url('/api/remove'), { slug });
      // сразу убираем строку локально, потом уточняем у сервера
      if (state.mods && Object.prototype.hasOwnProperty.call(state.mods, slug)) {
        const next = Object.assign({}, state.mods);
        delete next[slug];
        state.mods = next;
        if (typeof d.revision === 'number') state.revision = d.revision;
        saveSnapshot();
        render();
      }
      notifyRefresh();
      await loadCollection();
      setPhase('online');
    } catch (err) {
      showMsg((err && err.message) || 'Ошибка удаления', 'err');
      if (btn) btn.disabled = false;
    }
  }

  async function clearAll() {
    if (!window.confirm('Очистить всю коллекцию?')) return;
    els.clear.disabled = true;
    try {
      const d = await apiPost(url('/api/clear'), {});
      state.mods = {};
      if (typeof d.revision === 'number') state.revision = d.revision;
      state.compat = [];
      state.selected = null;
      saveSnapshot();
      render();
      notifyRefresh();
      await loadCollection();
      setPhase('online');
    } catch (err) {
      showMsg((err && err.message) || 'Ошибка очистки', 'err');
    } finally {
      els.clear.disabled = false;
    }
  }

  // ─── Старт ────────────────────────────────────────────────────────────────

  async function init() {
    els.open.addEventListener('click', openApp);
    els.clear.addEventListener('click', clearAll);
    els.options.addEventListener('click', openOptions);
    els.quickAdd.addEventListener('click', quickAdd);
    els.quickInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') quickAdd();
    });

    await loadConfig();

    // 1) мгновенная отрисовка из снапшота — попап не мигает спиннером
    const snap = await readSnapshot();
    if (snap) {
      state.mods = snap.mods || {};
      if (typeof snap.revision === 'number') state.revision = snap.revision;
      render();
    }
    setPhase('loading');

    // 2) сеть: ping и коллекция параллельно, решение об онлайне — по обоим
    const [pingOk, collectionOk] = await Promise.all([probe(), loadCollection()]);
    if (pingOk || collectionOk) {
      setPhase('online');
    } else {
      setPhase('offline');
    }

    els.quickInput.focus();
  }

  init();
})();
