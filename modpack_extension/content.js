/* Modpack Builder — контент-скрипт для modrinth.com (MV3, без сборки, ES2020).
 *
 * Архитектура: маленькая машина состояний «сеть → состояние → отрисовка».
 * Скрипт стартует на document_start и сразу отправляет запросы, поэтому значки
 * появляются вместе с карточками, а не через секунду после гидрации страницы.
 *
 * Главное правило производительности: НИКОГДА не сканируем документ целиком.
 * Значки ставятся только на те узлы, которые реально были добавлены в DOM
 * (MutationRecord.addedNodes), пачками не больше ~200 узлов за один тик.
 */
(() => {
  'use strict';

  // ─── Константы ────────────────────────────────────────────────────────────
  // Адрес приложения: по умолчанию localhost:7842, меняется в настройках (⚙).
  const DEFAULT_API = 'http://localhost:7842';
  let API = DEFAULT_API;
  const apiUrl = (path) => API + path;

  const CONFIG_KEY = 'mpb.config';

  const SNAPSHOT_KEY = 'mpb.collection'; // снимок состояния для мгновенной отрисовки
  const SNAPSHOT_TTL = 15 * 60 * 1000;

  const PING_TIMEOUT = 1500;
  const COLLECTION_TIMEOUT = 3500;
  const MUTATION_TIMEOUT = 8000;

  const FLUSH_DELAY = 120; // склеиваем все мутации одного «кадра» в одну обработку
  const MAX_NODES_PER_FLUSH = 200; // больше не обрабатываем за раз — остаток в очередь
  const RETRY_STEPS = [400, 800, 1600, 3200, 5000]; // экспоненциальный backoff до 5 с
  const POLL_INTERVAL = 20000; // запасной опрос, если SSE недоступен
  const URL_POLL_INTERVAL = 1000; // SPA-навигация: дешёвое сравнение строки URL
  const TOAST_MS = 2500;
  const TOAST_UNDO_MS = 6000;

  // Страница проекта (хвост допускается: /mod/sodium/versions)
  const PAGE_RE = /^\/(mod|plugin|datapack|shader|resourcepack)\/([^/]+)(?:\/|$)/;
  // Карточка в списке: ровно /mod/<slug> (можно со слэшем на конце), глубже — уже не карточка
  const CARD_RE = /^\/(mod|plugin|datapack|shader|resourcepack)\/([^/]+)\/?$/;

  // ─── Состояние ────────────────────────────────────────────────────────────
  const state = {
    mods: null, // null = состояние ещё неизвестно (нет ни снапшота, ни ответа сети)
    revision: -1,
    etag: null,
    online: false,
    checked: false, // была ли хотя бы одна законченная проверка сервера
  };

  const busy = new Set(); // slug'и, по которым сейчас идёт запрос

  // slug -> набор кнопок-значков; обновляем только затронутые значки (O(значков))
  const badgeMap = new Map();
  // карточка -> slug, для которого в неё уже вставлен значок (защита от дублей)
  const cardSlug = new WeakMap();
  // узлы, которые мы уже просматривали на предмет ссылок
  const scanned = new WeakSet();

  // Очередь узлов на разбор: массив + голова, чтобы не дёргать shift()
  const cardQueue = [];
  let queueHead = 0;
  const queued = new WeakSet();
  let flushTimer = null;

  // Изменившиеся href тоже копим и разбираем в том же debounce-проходе
  const attrQueue = [];
  let attrQueued = new WeakSet();

  let retryTimer = null;
  let retryIndex = 0;

  let eventSource = null;
  let sseFailures = 0;
  let sseReopenTimer = null;
  let pollTimer = null;

  let toastTimer = null;

  let widgetEl = null;
  let widgetSig = '';
  let widgetEntered = false;

  let lastUrl = location.href;

  // ─── Мелкие помощники ─────────────────────────────────────────────────────

  // fetch с жёстким таймаутом через AbortController
  function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const opts = Object.assign({ cache: 'no-store' }, options || {});
    opts.signal = ctrl.signal;
    return fetch(url, opts).finally(() => clearTimeout(timer));
  }

  // Контекст расширения мог быть инвалидирован (перезагрузка расширения) — все
  // обращения к chrome.* заворачиваем в эту проверку + try/catch.
  function extAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (_) {
      return false;
    }
  }

  function makeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function hasMod(slug) {
    return !!state.mods && Object.prototype.hasOwnProperty.call(state.mods, slug);
  }

  function modCount() {
    return state.mods ? Object.keys(state.mods).length : 0;
  }

  // slug страницы проекта, на которой мы находимся
  function pageSlug() {
    const m = location.pathname.match(PAGE_RE);
    return m ? m[2] : null;
  }

  // slug из href карточки; ссылки на другие хосты и глубокие подпути отбрасываем
  function slugFromHref(href) {
    if (!href) return null;
    let path = href;
    try {
      const u = new URL(href, location.origin);
      if (u.hostname !== location.hostname) return null;
      path = u.pathname;
    } catch (_) {
      return null;
    }
    const m = path.match(CARD_RE);
    return m ? m[2] : null;
  }

  // ─── Настройки: адрес приложения ─────────────────────────────────────────
  // По умолчанию localhost:7842; пользователь может поменять его в ⚙ настройках.

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
      const api = normalizeApi(config && config.api);
      if (api && api !== API) {
        API = api;
        state.etag = null; // кэш относится к прежнему адресу
      }
    } catch (_) {
      // настройки недоступны — работаем по умолчанию
    }
  }

  // ─── Снимок состояния в chrome.storage.session ───────────────────────────
  // Даёт мгновенную отрисовку при повторном заходе: сначала рисуем старый
  // снапшот, потом перепроверяем по сети (stale-while-revalidate).

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
    } catch (_) {
      // контекст расширения умер или доступ к session не выдан — не страшно
    }
  }

  function broadcastState() {
    if (!extAlive() || state.mods === null) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'mpb:state', count: modCount(), revision: state.revision },
        () => {
          void chrome.runtime.lastError; // «no receiver» — норма, глушим
        }
      );
    } catch (_) {}
  }

  function snapshotPayload() {
    return {
      type: 'mpb:snapshot',
      count: modCount(),
      revision: state.revision,
      online: state.online,
      mods: state.mods,
      known: state.mods !== null,
    };
  }

  // ─── Сеть ─────────────────────────────────────────────────────────────────

  async function ping() {
    try {
      const r = await fetchWithTimeout(apiUrl('/api/ping'), {}, PING_TIMEOUT);
      if (!r.ok) return false;
      const d = await r.json();
      return !!d && d.ok === true;
    } catch (_) {
      return false;
    }
  }

  // Возвращает 'updated' | 'unchanged'; бросает исключение, если сервер недоступен
  async function fetchCollection() {
    const headers = {};
    if (state.etag) headers['If-None-Match'] = state.etag;
    const r = await fetchWithTimeout(apiUrl('/api/collection'), { headers }, COLLECTION_TIMEOUT);

    if (r.status === 304) {
      // «ничего не изменилось» — состояние НЕ трогаем
      return 'unchanged';
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const d = await r.json();
    const etag = r.headers.get('ETag');
    if (etag) state.etag = etag;
    applyCollection(d);
    return 'updated';
  }

  function applyCollection(d) {
    const mods = (d && d.mods) || {};
    state.mods = mods;
    if (d && typeof d.revision === 'number') state.revision = d.revision;
    state.online = true;
    state.checked = true;

    saveSnapshot();
    syncAllBadges();
    forceWidget();
    broadcastState();
  }

  // Ответ /api/add и /api/remove уже содержит новую ревизию — применяем сразу,
  // не дожидаясь SSE, чтобы UI не «моргал» старой иконкой.
  function applyAdded(slug, mod, revision) {
    if (!mod) return;
    state.mods = Object.assign({}, state.mods || {}, { [slug]: mod });
    if (typeof revision === 'number') state.revision = revision;
    saveSnapshot();
    syncBadge(slug);
    forceWidget();
    broadcastState();
  }

  function applyRemoved(slug, revision) {
    if (state.mods && Object.prototype.hasOwnProperty.call(state.mods, slug)) {
      const next = Object.assign({}, state.mods);
      delete next[slug];
      state.mods = next;
    }
    if (typeof revision === 'number') state.revision = revision;
    saveSnapshot();
    syncBadge(slug);
    forceWidget();
    broadcastState();
  }

  async function apiPost(url, body, ms) {
    const r = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      ms
    );
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok) {
      // сервер отдаёт {"error": "текст на русском"}
      throw new Error((data && data.error) || 'HTTP ' + r.status);
    }
    return data || {};
  }

  // ─── Онлайн / офлайн и backoff ────────────────────────────────────────────
  // Если приложение не запущено — показываем офлайн-виджет и сами стучимся
  // снова, чтобы значки появились без перезагрузки страницы пользователем.

  function markOnline() {
    retryIndex = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const changed = !state.online || !state.checked;
    state.online = true;
    state.checked = true;
    if (changed) forceWidget();
  }

  function markOffline() {
    const changed = state.online || !state.checked;
    state.online = false;
    state.checked = true;
    if (changed) forceWidget();
    scheduleRetry();
  }

  function scheduleRetry() {
    if (retryTimer) return;
    const step = Math.min(retryIndex, RETRY_STEPS.length - 1);
    let delay = RETRY_STEPS[step];
    retryIndex += 1;
    // navigator.onLine — только подсказка: если сети нет, не частим
    if (navigator.onLine === false && delay < 5000) delay = 5000;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      refreshAll();
    }, delay);
  }

  // ping и коллекция уходят параллельно: ping очень быстрый и без диска
  async function refreshAll() {
    const pingPromise = ping().catch(() => false);
    const collectionPromise = fetchCollection().then(
      () => true,
      () => false
    );
    const [pingOk, collectionOk] = await Promise.all([pingPromise, collectionPromise]);

    if (collectionOk) {
      markOnline();
      if (state.mods === null) forceWidget();
      return;
    }
    if (pingOk) {
      // сервер жив, но коллекция не ответила — быстрый повтор без ухода в офлайн
      markOnline();
      scheduleRetry();
      return;
    }
    markOffline();
  }

  // ─── SSE-синхронизация ────────────────────────────────────────────────────
  // Любая вкладка Modrinth и веб-интерфейс остаются в одном состоянии.

  function handleSsePayload(raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (!state.online) markOnline();

    const rev = typeof msg.revision === 'number' ? msg.revision : null;
    if (msg.action === 'init' || rev === null || rev !== state.revision) {
      // условный запрос дешёвый (gzip + ETag), 304 просто оставит состояние как есть
      fetchCollection().then(
        () => markOnline(),
        () => markOffline()
      );
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Запасной вариант: SSE нет или он стабильно падает
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (navigator.onLine === false) return;
      fetchCollection().then(
        () => markOnline(),
        () => {}
      );
    }, POLL_INTERVAL);
  }

  function connectSSE() {
    if (typeof EventSource !== 'function') {
      startPolling();
      return;
    }
    if (eventSource) return;
    try {
      eventSource = new EventSource(apiUrl('/api/events'));
    } catch (_) {
      startPolling();
      return;
    }

    eventSource.onopen = () => {
      sseFailures = 0;
      stopPolling(); // живой SSE — опрос не нужен
      if (!state.online) markOnline();
    };

    // сервер шлёт события по умолчанию (без event:), значит onmessage
    eventSource.onmessage = (ev) => handleSsePayload(ev.data);

    eventSource.onerror = () => {
      sseFailures += 1;
      try {
        eventSource.close();
      } catch (_) {}
      eventSource = null;
      if (sseFailures >= 2) startPolling();
      const delay = 3000 + Math.min(sseFailures, 5) * 400; // 3.4…5 с
      if (sseReopenTimer) clearTimeout(sseReopenTimer);
      sseReopenTimer = setTimeout(() => {
        sseReopenTimer = null;
        connectSSE();
      }, delay);
    };
  }

  // ─── Значки на карточках ──────────────────────────────────────────────────

  function registerBadge(slug, btn) {
    let set = badgeMap.get(slug);
    if (!set) {
      set = new Set();
      badgeMap.set(slug, set);
    }
    set.add(btn);
  }

  function unregisterBadge(slug, btn) {
    const set = badgeMap.get(slug);
    if (!set) return;
    set.delete(btn);
    if (!set.size) badgeMap.delete(slug);
  }

  function paintBadge(btn, slug) {
    const added = hasMod(slug);
    btn.dataset.slug = slug;
    btn.dataset.state = added ? 'added' : 'idle';
    btn.disabled = false;
    btn.classList.remove('mpb-loading');
    btn.classList.toggle('mpb-added', added);
    // textContent/title — никакой интерполяции HTML (в названиях модов бывают < и &)
    btn.textContent = added ? '✓' : '+ ⛏';
    btn.title = added ? 'В коллекции (нажми для удаления)' : 'Добавить в сборку';
    btn.setAttribute('aria-label', btn.title);
  }

  // Обновляем только значки конкретного мода — O(значков этого мода)
  function syncBadge(slug) {
    if (state.mods === null) return;
    const set = badgeMap.get(slug);
    if (!set) return;
    for (const btn of Array.from(set)) {
      if (!btn.isConnected) {
        set.delete(btn); // узел отвалился — не держим ссылку
        continue;
      }
      if (busy.has(slug)) continue;
      paintBadge(btn, slug);
    }
    if (!set.size) badgeMap.delete(slug);
  }

  function syncAllBadges() {
    if (state.mods === null) return;
    for (const [slug, set] of Array.from(badgeMap)) {
      for (const btn of Array.from(set)) {
        if (!btn.isConnected) {
          set.delete(btn);
          continue;
        }
        if (busy.has(slug)) continue;
        paintBadge(btn, slug);
      }
      if (!set.size) badgeMap.delete(slug);
    }
  }

  function setBadgeBusy(slug, on) {
    const set = badgeMap.get(slug);
    if (!set) return;
    for (const btn of set) {
      if (!btn.isConnected) continue;
      if (on) {
        btn.classList.add('mpb-loading');
        btn.textContent = '…';
        btn.disabled = true;
      } else {
        btn.classList.remove('mpb-loading');
        btn.disabled = false;
      }
    }
  }

  // Контейнер карточки: сначала классы Modrinth, потом любой позиционированный
  // предок, и только в крайнем случае — родитель ссылки.
  function resolveCard(link) {
    const byClass = link.closest(
      '.project-card, article, [class*="project-card"], [class*="card"]'
    );
    if (byClass) return byClass;

    let node = link.parentElement;
    let depth = 0;
    while (node && node !== document.body && depth < 6) {
      try {
        if (getComputedStyle(node).position !== 'static') return node;
      } catch (_) {}
      node = node.parentElement;
      depth += 1;
    }
    return link.parentElement;
  }

  // «Строка действий» карточки: в неё кнопку можно вставить в поток,
  // не прибегая к абсолютному позиционированию.
  function findActionHost(card) {
    let nodes;
    try {
      nodes = card.querySelectorAll(
        '[class*="actions"], [class*="action-row"], [class*="buttons"], [class*="footer"]'
      );
    } catch (_) {
      return null;
    }
    for (const n of nodes) {
      if (n.querySelector('.mpb-card-btn')) continue;
      if (n.querySelector('a[href]')) continue; // строка со ссылками — не наша
      let display = '';
      try {
        display = getComputedStyle(n).display;
      } catch (_) {}
      if (display === 'flex' || display === 'inline-flex' || n.children.length === 0) return n;
    }
    return null;
  }

  // Абсолютное позиционирование меняет computed position карточки — запоминаем
  // исходное значение, чтобы уметь вернуть как было.
  function rememberCardPosition(card) {
    if (card.dataset.mpbPos !== undefined) return;
    let pos = 'static';
    try {
      pos = getComputedStyle(card).position;
    } catch (_) {}
    if (pos === 'static') {
      card.dataset.mpbPos = card.style.position || '';
      card.style.position = 'relative';
    } else {
      card.dataset.mpbPos = '__keep__';
    }
  }

  function restoreCardPosition(card) {
    const saved = card.dataset.mpbPos;
    if (saved === undefined) return;
    if (saved !== '__keep__') card.style.position = saved;
    delete card.dataset.mpbPos;
  }

  function createBadge(card, slug) {
    const btn = makeEl('button', 'mpb-card-btn');
    btn.type = 'button';
    paintBadge(btn, slug);
    btn.addEventListener('click', onBadgeClick);

    const host = findActionHost(card);
    if (host) {
      btn.classList.add('mpb-card-btn-inline');
      host.appendChild(btn);
    } else {
      btn.classList.add('mpb-card-btn-abs');
      rememberCardPosition(card);
      card.appendChild(btn);
    }

    cardSlug.set(card, slug);
    registerBadge(slug, btn);
  }

  // Снимаем значок и возвращаем карточке исходное позиционирование
  function removeBadge(btn) {
    const slug = btn.dataset ? btn.dataset.slug : null;
    const card = btn.parentElement;
    if (slug) unregisterBadge(slug, btn);
    if (btn.isConnected) btn.remove();
    if (card) {
      cardSlug.delete(card);
      if (!card.querySelector('.mpb-card-btn')) restoreCardPosition(card);
    }
  }

  function onBadgeClick(ev) {
    // Иначе клик уйдёт по ссылке карточки
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    const slug = btn && btn.dataset ? btn.dataset.slug : null;
    if (!slug) return;
    toggleSlug(slug);
  }

  async function toggleSlug(slug) {
    if (busy.has(slug) || state.mods === null) return;
    const added = hasMod(slug);

    busy.add(slug);
    setBadgeBusy(slug, true);
    if (widgetSlug === slug) forceWidget();

    try {
      if (added) {
        const d = await apiPost(apiUrl('/api/remove'), { slug }, MUTATION_TIMEOUT);
        applyRemoved(slug, d.revision);
        // Удаление можно вернуть назад, пока тост на экране.
        showToast('Удалён из сборки: ' + slug, 'warn', {
          label: 'Отменить',
          onClick: () => restoreSlug(slug),
        });
      } else {
        const d = await apiPost(apiUrl('/api/add'), { url: slug }, MUTATION_TIMEOUT);
        applyAdded(slug, d.mod, d.revision);
        const title = d.mod && d.mod.title ? d.mod.title : slug;
        showToast('✓ ' + title + ' добавлен!', 'ok');
      }
    } catch (err) {
      const msg = err && err.message ? err.message : 'Modpack Builder не запущен';
      showToast(msg, 'error');
    } finally {
      busy.delete(slug);
      setBadgeBusy(slug, false);
      // ВСЕГДА перерисовываем из истинного состояния, а не из догадки
      syncBadge(slug);
      forceWidget();
    }
  }

  // Вернуть только что удалённый проект обратно («Отменить» в тосте)
  async function restoreSlug(slug) {
    if (busy.has(slug) || state.mods === null) return;
    busy.add(slug);
    setBadgeBusy(slug, true);
    forceWidget();
    try {
      const d = await apiPost(apiUrl('/api/add'), { url: slug }, MUTATION_TIMEOUT);
      applyAdded(slug, d.mod, d.revision);
      const title = d.mod && d.mod.title ? d.mod.title : slug;
      showToast('✓ ' + title + ' возвращён в сборку', 'ok');
    } catch (err) {
      showToast((err && err.message) || 'Не удалось вернуть проект', 'error');
    } finally {
      busy.delete(slug);
      setBadgeBusy(slug, false);
      syncBadge(slug);
      forceWidget();
    }
  }

  // Обработка одной ссылки: возможно, это карточка проекта
  function handleLink(link) {
    if (!link || link.nodeType !== 1) return;
    if (link.classList && link.classList.contains('mpb-card-btn')) return;
    if (link.closest && link.closest('#mpb-widget, #mpb-toast')) return;

    const slug = slugFromHref(link.getAttribute('href'));
    if (!slug) return;

    const card = resolveCard(link);
    if (!card || card.id === 'mpb-widget') return;

    const known = cardSlug.get(card);
    if (known !== undefined) {
      if (known !== slug) {
        // Modrinth переиспользовал узел карточки под другой мод —
        // обновляем slug вместо вставки второй кнопки
        const btn = card.querySelector('.mpb-card-btn');
        if (btn) {
          unregisterBadge(known, btn);
          paintBadge(btn, slug);
          registerBadge(slug, btn);
        }
        cardSlug.set(card, slug);
      }
      return;
    }

    const existing = card.querySelector('.mpb-card-btn');
    if (existing) {
      // кнопка уже есть (например, мы её только что вставили) — просто учитываем
      const s = existing.dataset.slug;
      if (s) {
        cardSlug.set(card, s);
        registerBadge(s, existing);
      }
      return;
    }

    createBadge(card, slug);
  }

  function enqueue(node) {
    if (!node || node.nodeType !== 1) return;
    if (scanned.has(node) || queued.has(node)) return;
    queued.add(node);
    cardQueue.push(node);
  }

  // Смотрим ТОЛЬКО на добавленный узел и его поддерево — не на весь документ
  function scanAddedNode(node) {
    if (scanned.has(node)) return;
    scanned.add(node);
    handleLink(node);
    if (!node.querySelectorAll) return;
    let links;
    try {
      links = node.querySelectorAll('a[href]');
    } catch (_) {
      return;
    }
    for (let i = 0; i < links.length; i += 1) handleLink(links[i]);
  }

  function flushQueue() {
    flushTimer = null;
    let processed = 0;

    while (queueHead < cardQueue.length && processed < MAX_NODES_PER_FLUSH) {
      const node = cardQueue[queueHead];
      queueHead += 1;
      processed += 1;
      if (!node.isConnected) continue;
      if (node.id === 'mpb-widget' || node.id === 'mpb-toast') continue;
      scanAddedNode(node);
    }

    if (queueHead >= cardQueue.length) {
      cardQueue.length = 0;
      queueHead = 0;
    } else if (queueHead > 400) {
      cardQueue.splice(0, queueHead); // компактим, чтобы массив не пух
      queueHead = 0;
    }

    if (queueHead < cardQueue.length) scheduleFlush(); // остаток — следующим тиком

    // Изменившиеся href разбираем один раз за проход
    if (attrQueue.length) {
      const targets = attrQueue.slice();
      attrQueue.length = 0;
      attrQueued = new WeakSet();
      for (let i = 0; i < targets.length; i += 1) handleLink(targets[i]);
    }

    checkUrl();
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    // Одна отложенная обработка на все накопившиеся мутации: сотни срабатываний
    // обсервера во время гидрации превращаются в один проход.
    flushTimer = setTimeout(flushQueue, FLUSH_DELAY);
  }

  // Отвалившиеся узлы выкидываем из карты: во время обычных обновлений это
  // происходит лениво (isConnected в syncBadge), а тут — при смене URL.
  function pruneBadges() {
    for (const [slug, set] of Array.from(badgeMap)) {
      for (const btn of Array.from(set)) {
        if (!btn.isConnected) removeBadge(btn);
      }
      if (!set.size) badgeMap.delete(slug);
    }
  }

  function onMutations(records) {
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];

      if (rec.type === 'attributes') {
        // href поменялся у существующего узла (SPA переиспользует карточки)
        const t = rec.target;
        if (t && !attrQueued.has(t)) {
          attrQueued.add(t);
          attrQueue.push(t);
        }
        continue;
      }

      const added = rec.addedNodes;
      if (!added || !added.length) continue;
      for (let j = 0; j < added.length; j += 1) {
        const node = added[j];
        if (node.nodeType !== 1) continue; // текстовые узлы игнорируем
        // Дешёвые проверки «своих» узлов: id виджета/тоста и класс значка.
        // Полный closest() тут не нужен и стоил бы прохода по предкам на каждом узле.
        if (node.id === 'mpb-widget' || node.id === 'mpb-toast') continue;
        if (node.classList && node.classList.contains('mpb-card-btn')) continue;
        enqueue(node);
      }
    }
    scheduleFlush();
  }

  // ─── Виджет на странице проекта ───────────────────────────────────────────

  let widgetSlug = null;

  function removeWidget() {
    const old = document.getElementById('mpb-widget');
    if (old) old.remove();
    widgetEl = null;
    widgetSig = '';
    widgetSlug = null;
  }

  function widgetSignature(slug) {
    // Пока сервер ни разу не ответил (и снапшота нет) — показываем «проверка»,
    // офлайн-виджет появляется только после реальной неудачной попытки.
    if (state.mods === null && !state.checked) return slug + '|loading';
    if (state.mods === null) return slug + '|offline';
    const mod = state.mods[slug];
    return slug + '|' + (mod ? 'added|' + (mod.title || '') : 'idle');
  }

  function buildWidget(slug) {
    const el = makeEl('div');
    el.id = 'mpb-widget';

    const icon = makeEl('div', 'mpb-icon', '⛏');
    const text = makeEl('div', 'mpb-text');
    const label = makeEl('span', 'mpb-label');
    const sub = makeEl('span', 'mpb-sub');

    if (state.mods === null && !state.checked) {
      // ответ ещё в пути
      el.classList.add('mpb-loading');
      label.textContent = 'Modpack Builder';
      sub.textContent = 'Проверка…';
    } else if (state.mods === null) {
      // сервер недоступен
      el.classList.add('mpb-offline');
      label.textContent = 'Modpack Builder';
      sub.textContent = 'Приложение не запущено';
    } else if (hasMod(slug)) {
      const mod = state.mods[slug];
      el.classList.add('mpb-added');
      label.textContent = 'В коллекции';
      sub.textContent = mod && mod.title ? mod.title : slug;

      const removeBtn = makeEl('button', 'mpb-btn mpb-btn-remove', '✕');
      removeBtn.type = 'button';
      removeBtn.title = 'Убрать из коллекции';
      removeBtn.addEventListener('click', () => toggleSlug(slug));

      const open = makeEl('a', 'mpb-btn mpb-btn-open', '↗');
      open.setAttribute('href', API + '/');
      open.setAttribute('target', '_blank');
      open.setAttribute('rel', 'noopener noreferrer');
      open.title = 'Открыть Modpack Builder';

      text.append(label, sub);
      el.append(icon, text, removeBtn, open);
      return el;
    } else {
      label.textContent = 'Modpack Builder';
      sub.textContent = 'Добавить этот мод?';

      const addBtn = makeEl('button', 'mpb-btn mpb-btn-add', '+ Добавить');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => toggleSlug(slug));

      text.append(label, sub);
      el.append(icon, text, addBtn);
      return el;
    }

    text.append(label, sub);
    el.append(icon, text);
    return el;
  }

  function renderWidget() {
    const slug = pageSlug();
    if (!slug || !document.body) {
      removeWidget();
      return;
    }

    const sig = widgetSignature(slug);
    if (widgetEl && widgetEl.isConnected && sig === widgetSig) return;

    widgetSig = sig;
    widgetSlug = slug;

    const old = document.getElementById('mpb-widget');
    if (old) old.remove();

    const el = buildWidget(slug);
    if (busy.has(slug)) {
      const b = el.querySelector('.mpb-btn-add');
      if (b) {
        b.textContent = '…';
        b.disabled = true;
      }
    }
    document.body.appendChild(el);
    widgetEl = el;

    if (widgetEntered) {
      el.classList.add('mpb-visible'); // при обновлении не проигрываем анимацию заново
    } else {
      requestAnimationFrame(() => {
        widgetEntered = true;
        el.classList.add('mpb-visible');
      });
    }
  }

  // Принудительная перерисовка (например, после ошибки — состояние могло не измениться)
  function forceWidget() {
    widgetSig = '';
    renderWidget();
  }

  // ─── Тост ─────────────────────────────────────────────────────────────────

  function hideToast(el) {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!el || !el.isConnected) return;
    el.classList.remove('mpb-toast-visible');
    setTimeout(() => el.remove(), 300);
  }

  // action — необязательная кнопка внутри тоста (например, «Отменить»)
  function showToast(msg, type, action) {
    if (!document.body) return;
    const old = document.getElementById('mpb-toast');
    if (old) hideToast(old);

    const t = makeEl('div', 'mpb-toast mpb-toast-' + (type || 'ok'));
    t.id = 'mpb-toast';
    // только textContent: в текстах модов бывают кавычки и <
    t.appendChild(makeEl('span', 'mpb-toast-text', msg));

    let lifetime = TOAST_MS;
    if (action && action.label && typeof action.onClick === 'function') {
      const btn = makeEl('button', 'mpb-toast-action', action.label);
      btn.type = 'button';
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideToast(t);
        try {
          action.onClick();
        } catch (_) {}
      });
      t.appendChild(btn);
      lifetime = TOAST_UNDO_MS;
    }

    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('mpb-toast-visible'));

    toastTimer = setTimeout(() => {
      toastTimer = null;
      t.classList.remove('mpb-toast-visible');
      setTimeout(() => t.remove(), 300);
    }, lifetime);
  }

  // ─── SPA-навигация ────────────────────────────────────────────────────────

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    pruneBadges();
    forceWidget();
  }

  // ─── Запуск ───────────────────────────────────────────────────────────────

  // Ждём появления document.body, не дожидаясь DOMContentLoaded и картинок
  function whenBodyReady(cb) {
    if (document.body) {
      cb();
      return;
    }
    let done = false;
    const run = () => {
      if (done || !document.body) return false;
      done = true;
      try {
        mo.disconnect();
      } catch (_) {}
      cb();
      return true;
    };
    const mo = new MutationObserver(run);
    try {
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (_) {}
    const tick = () => {
      if (!run()) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function start() {
    // 0) адрес приложения из настроек (по умолчанию localhost:7842)
    await loadConfig();

    // 1) мгновенная отрисовка из прошлого снапшота, пока сеть молчит
    readSnapshot().then((snap) => {
      if (!snap || state.mods !== null) return; // сеть уже ответила — снапшот не нужен
      state.mods = snap.mods || {};
      if (typeof snap.revision === 'number') state.revision = snap.revision;
      syncAllBadges();
      forceWidget();
      broadcastState();
    });

    // 2) сеть сразу, без setTimeout и без ожидания DOMContentLoaded
    refreshAll();

    // 3) живая синхронизация
    connectSSE();

    // 4) наблюдатели за DOM
    try {
      const mo = new MutationObserver(onMutations);
      mo.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href'], // ловим переиспользованные карточки SPA
      });
    } catch (_) {}

    whenBodyReady(() => {
      renderWidget();
      syncAllBadges();
    });

    // 5) SPA-навигация: popstate/hashchange мгновенно, интервал — страховка
    addEventListener('popstate', checkUrl, true);
    addEventListener('hashchange', checkUrl, true);
    setInterval(checkUrl, URL_POLL_INTERVAL);

    // 6) подсказки от браузера о сети
    addEventListener('online', () => {
      if (state.mods === null || !state.online) refreshAll();
    });
    addEventListener('offline', () => {
      state.online = false;
      forceWidget();
    });
  }

  // Запросы от попапа/бэкграунда
  if (extAlive()) {
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'mpb:query') {
          sendResponse(snapshotPayload());
          return;
        }
        if (msg.type === 'mpb:refresh') {
          if (msg.toast && msg.toast.text) showToast(msg.toast.text, msg.toast.kind || 'ok');
          refreshAll();
          return;
        }
        if (msg.type === 'mpb:toast') {
          // приходит от сервис-воркера (контекстное меню, горячая клавиша)
          showToast(msg.text || '', msg.kind || 'ok');
          return;
        }
      });
    } catch (_) {}
  }

  start();
})();
