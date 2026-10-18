'use strict';
/* Modpack Builder — веб-интерфейс.
 *
 * Главный принцип: DOM не перерисовывается целиком. Карточки модов создаются
 * один раз и потом только «дообновляются», поэтому иконки не перезагружаются,
 * ничего не мигает и интерфейс остаётся мгновенным даже на большой коллекции.
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    modInput: $('modInput'),
    addBtn: $('addBtn'),
    searchInput: $('searchInput'),
    refreshBtn: $('refreshBtn'),
    modList: $('modList'),
    logBox: $('logBox'),
    statTotal: $('statTotal'),
    statCompat: $('statCompat'),
    loaderChips: $('loaderChips'),
    loaderSelect: $('loaderSelect'),
    compatGrid: $('compatGrid'),
    compatHint: $('compatHint'),
    collectionCount: $('collectionCount'),
    headerBadge: $('headerBadge'),
    progressBar: $('progressBar'),
    clearBtn: $('clearBtn'),
    exportMrpack: $('exportMrpack'),
    exportJson: $('exportJson'),
    importFile: $('importFile'),
    importBtn: $('importBtn'),
    connIndicator: $('connIndicator'),
    connText: $('connText'),
  };

  const state = {
    mods: {},                 // slug -> данные мода (с сервера)
    order: [],                // порядок отображения
    compat: [],               // [{version, count}]
    counts: { total: 0, filtered: 0, compatible: 0, loaders: {} },
    manualVersion: localStorage.getItem('mpb.version') || null,
    effectiveVersion: null,   // версия, по которой считаем совместимость
    revision: 0,
    etag: null,
    filter: '',
    inflight: 0,
    connected: false,
    sawServer: false,
  };

  const cards = new Map();     // slug -> ref карточки
  const pending = new Set();   // slug модов, которые ещё добавляются
  let lastCompatSig = '';
  let refreshToken = 0;
  let eventSource = null;

  const emptyState = els.modList.querySelector('.empty-state');
  const EMPTY_TEXT = emptyState.querySelector('p').innerHTML;

  // Тип проекта Modrinth: и ссылка, и папка в сборке зависят от него.
  const TYPE_PATH = {
    mod: 'mod',
    plugin: 'plugin',
    datapack: 'datapack',
    shader: 'shader',
    resourcepack: 'resourcepack',
  };
  const TYPE_LABEL = {
    plugin: 'плагин',
    datapack: 'датапак',
    shader: 'шейдер',
    resourcepack: 'ресурспак',
  };

  // ---------------------------------------------------------------- утилиты

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function log(msg, type = 'info') {
    const box = els.logBox;
    if (box.firstElementChild && box.firstElementChild.classList.contains('log-empty')) box.textContent = '';
    const line = document.createElement('div');
    line.className = 'log-line' + (type === 'ok' ? ' ok' : type === 'error' ? ' err' : type === 'warn' ? ' warn' : '');
    const ts = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `[${ts}] ${msg}`;
    box.appendChild(line);
    while (box.childElementCount > 60) box.removeChild(box.firstElementChild);
    box.scrollTop = box.scrollHeight;
  }

  function setProgress(delta) {
    state.inflight = Math.max(0, state.inflight + delta);
    els.progressBar.classList.toggle('active', state.inflight > 0);
  }

  function setBusy(button, on) {
    button.classList.toggle('busy', on);
    button.disabled = on;
  }

  function setConnection(online) {
    if (state.connected === online) return;
    state.connected = online;
    els.connIndicator.classList.toggle('online', online);
    els.connIndicator.classList.toggle('offline', !online);
    els.connText.textContent = online ? 'на связи' : 'нет связи';
    if (online) {
      if (state.sawServer) log('Связь с приложением восстановлена', 'ok');
      state.sawServer = true;
    } else if (state.sawServer) {
      log('Приложение не отвечает. Запущено ли python app.py?', 'error');
    }
  }

  function guessSlug(value) {
    const m = String(value).match(/modrinth\.com\/(?:mod|plugin|datapack|shader|resourcepack|modpack)\/([^/?#]+)/i);
    return (m ? m[1] : String(value)).trim();
  }

  // Сравнение версий Minecraft на клиенте: нужно, чтобы показать «максимум 1.20.1»
  // у модов, которые не подходят к выбранной версии.
  function versionKey(value) {
    const m = /^(\d+(?:\.\d+)*)/.exec(String(value || ''));
    return {
      nums: m ? m[1].split('.').map(Number) : [],
      pre: /(rc|pre|snapshot|alpha|beta|dev)/i.test(String(value || '')) ? 1 : 0,
    };
  }

  function isNewer(a, b) {
    const ka = versionKey(a);
    const kb = versionKey(b);
    const length = Math.max(ka.nums.length, kb.nums.length);
    for (let i = 0; i < length; i += 1) {
      const x = ka.nums[i] || 0;
      const y = kb.nums[i] || 0;
      if (x !== y) return x > y;
    }
    if (ka.pre !== kb.pre) return ka.pre < kb.pre;   // релиз новее pre/rc
    return String(a) > String(b);
  }

  function newestVersion(list) {
    let best = null;
    for (const version of list || []) {
      if (best === null || isNewer(version, best)) best = version;
    }
    return best;
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // -------------------------------------------------------------- загрузка

  async function refresh(options = {}) {
    const token = ++refreshToken;
    const loader = els.loaderSelect.value;
    const version = state.manualVersion || '';
    const url = `/api/collection?loader=${encodeURIComponent(loader)}&version=${encodeURIComponent(version)}`;

    const headers = {};
    if (state.etag) headers['If-None-Match'] = state.etag;

    setProgress(1);
    try {
      const response = await fetch(url, { headers, cache: 'no-cache' });
      if (token !== refreshToken) return;             // ответ устарел — игнорируем
      if (response.status === 304) { setConnection(true); return; }  // изменений нет: DOM не трогаем

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (token !== refreshToken) return;

      state.etag = response.headers.get('ETag') || null;
      applyCollection(data);
      setConnection(true);
    } catch (error) {
      if (token === refreshToken) setConnection(false);
    } finally {
      setProgress(-1);
    }
  }

  function applyCollection(data) {
    state.mods = data.mods || {};
    state.order = Object.keys(state.mods);
    state.compat = data.compat_versions || [];
    state.counts = data.counts || { total: state.order.length, filtered: state.order.length, compatible: 0, loaders: {} };
    state.effectiveVersion = data.selected_version || null;
    state.revision = data.revision || 0;
    render();
  }

  // ------------------------------------------------------------ отрисовка

  function visibleSlugs() {
    const needle = state.filter.trim().toLowerCase();
    const result = [];
    const seen = new Set();

    for (const slug of pending) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      result.push(slug);
    }
    for (const slug of state.order) {
      if (seen.has(slug)) continue;
      if (needle) {
        const mod = state.mods[slug] || {};
        if (!`${slug} ${mod.title || ''}`.toLowerCase().includes(needle)) continue;
      }
      seen.add(slug);
      result.push(slug);
    }
    return result;
  }

  function makeIcon(ref, url) {
    const img = document.createElement('img');
    img.className = 'mod-icon';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      ref.iconFailed = img.src;
      const placeholder = document.createElement('div');
      placeholder.className = 'mod-icon-placeholder';
      placeholder.textContent = '🧩';
      if (img.parentNode) img.replaceWith(placeholder);
      ref.icon = placeholder;
      ref.iconSrc = null;
    });
    img.src = url;
    return img;
  }

  function applyIcon(ref, url) {
    if (!url) {
      if (ref.icon.tagName === 'IMG') {
        const placeholder = document.createElement('div');
        placeholder.className = 'mod-icon-placeholder';
        placeholder.textContent = '🧩';
        ref.icon.replaceWith(placeholder);
        ref.icon = placeholder;
        ref.iconSrc = null;
      }
      return;
    }

    if (ref.icon.tagName === 'IMG') {
      if (ref.iconSrc !== url) {          // src меняем только если он реально другой
        ref.iconSrc = url;
        ref.icon.src = url;
      }
      return;
    }

    if (ref.iconFailed === url) return;   // эту ссылку уже пробовали — не мигаем повторно
    const img = makeIcon(ref, url);
    ref.icon.replaceWith(img);
    ref.icon = img;
    ref.iconSrc = url;
  }

  function createCard(slug) {
    const el = document.createElement('div');
    el.className = 'mod-card';
    el.dataset.slug = slug;

    const ref = { el, icon: null, iconSrc: null, iconFailed: null, name: null, meta: null, tags: null, sig: null, del: null };

    // До получения данных показываем заглушку (никаких запросов «в пустоту»).
    const placeholder = document.createElement('div');
    placeholder.className = 'mod-icon-placeholder';
    placeholder.textContent = '🧩';
    ref.icon = placeholder;

    const info = document.createElement('div');
    info.className = 'mod-info';
    ref.name = document.createElement('div');
    ref.name.className = 'mod-name';
    ref.meta = document.createElement('div');
    ref.meta.className = 'mod-meta';
    ref.tags = document.createElement('div');
    ref.tags.className = 'mod-tags';
    ref.name.textContent = slug;
    info.append(ref.name, ref.meta, ref.tags);

    const actions = document.createElement('div');
    actions.className = 'mod-actions';
    const open = document.createElement('button');
    open.textContent = '↗';
    open.title = 'Открыть на Modrinth';
    open.addEventListener('click', () => {
      const type = (state.mods[slug] || {}).project_type || 'mod';
      const path = TYPE_PATH[type] || 'mod';
      window.open(`https://modrinth.com/${path}/${encodeURIComponent(slug)}`, '_blank', 'noopener');
    });
    ref.del = document.createElement('button');
    ref.del.className = 'danger';
    ref.del.textContent = '✕';
    ref.del.title = 'Удалить из коллекции';
    ref.del.addEventListener('click', () => removeMod(slug));
    actions.append(open, ref.del);

    el.append(placeholder, info, actions);
    return ref;
  }

  function updateCard(ref, slug) {
    const mod = state.mods[slug];
    const isPending = !mod || pending.has(slug);
    const version = state.effectiveVersion;
    const compatible = !isPending && version && (mod.game_versions || []).includes(version);

    ref.el.classList.toggle('pending', isPending);
    ref.el.classList.toggle('incompatible', Boolean(!isPending && version && !compatible));

    const title = mod ? (mod.title || slug) : slug;
    if (ref.name.textContent !== title) ref.name.textContent = title;

    const versionsCount = mod && mod.game_versions ? mod.game_versions.length : 0;
    let meta = 'получаю данные с Modrinth…';
    if (!isPending) {
      meta = `${mod.slug || slug} · ${versionsCount} ${plural(versionsCount, 'версия', 'версии', 'версий')} MC`;
      // Для несовместимых модов сразу видно, насколько они отстали.
      if (version && !compatible) {
        const newest = newestVersion(mod.game_versions);
        if (newest) meta += ` · максимум ${newest}`;
      }
    }
    if (ref.meta.textContent !== meta) ref.meta.textContent = meta;

    const type = isPending ? 'mod' : ((mod.project_type || 'mod').toLowerCase());
    const sig = isPending
      ? 'pending'
      : `${type}|${(mod.loaders || []).join(',')}|${version || ''}|${compatible ? 1 : 0}`;
    if (ref.sig !== sig) {
      ref.sig = sig;
      ref.tags.textContent = '';
      if (isPending) {
        const tag = document.createElement('span');
        tag.className = 'tag pending-tag';
        tag.textContent = 'загрузка…';
        ref.tags.appendChild(tag);
      } else {
        if (type !== 'mod') {
          const tag = document.createElement('span');
          tag.className = `tag type-${type}`;
          tag.textContent = TYPE_LABEL[type] || type;
          ref.tags.appendChild(tag);
        }
        for (const loader of mod.loaders || []) {
          const tag = document.createElement('span');
          tag.className = `tag loader-${loader}`;
          tag.textContent = loader;
          ref.tags.appendChild(tag);
        }
        if (version) {
          const tag = document.createElement('span');
          tag.className = compatible ? 'tag status-ok' : 'tag status-err';
          tag.textContent = compatible ? `✓ ${version}` : `✗ нет ${version}`;
          ref.tags.appendChild(tag);
        }
      }
    }

    applyIcon(ref, isPending ? null : mod.icon_url);
    if (ref.del) ref.del.disabled = isPending;
  }

  // ─── Группы списка: несовместимые сверху, совместимые ниже ──────────────

  const groups = {
    bad: null,
    good: null,
  };
  const collapsed = {
    bad: localStorage.getItem('mpb.collapse.bad') === '1',
    good: localStorage.getItem('mpb.collapse.good') === '1',
  };

  // Заголовок группы можно свернуть — состояние запоминается между запусками.
  function createGroupRow(key) {
    const el = document.createElement('div');
    el.className = `group-title group-${key}`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const dot = document.createElement('span');
    dot.className = 'group-dot';
    const name = document.createElement('span');
    name.className = 'group-name';
    const count = document.createElement('span');
    count.className = 'group-count';
    const toggle = document.createElement('span');
    toggle.className = 'group-toggle';
    el.append(dot, name, count, toggle);

    const toggleGroup = () => {
      collapsed[key] = !collapsed[key];
      localStorage.setItem(`mpb.collapse.${key}`, collapsed[key] ? '1' : '0');
      renderMods();
    };
    el.addEventListener('click', toggleGroup);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleGroup();
      }
    });

    return { el, name, count, toggle, key };
  }

  function updateGroupHeader(group, title, total) {
    if (group.name.textContent !== title) group.name.textContent = title;
    const countText = String(total);
    if (group.count.textContent !== countText) group.count.textContent = countText;
    const arrow = collapsed[group.key] ? '▸' : '▾';
    if (group.toggle.textContent !== arrow) group.toggle.textContent = arrow;
    group.el.classList.toggle('is-collapsed', collapsed[group.key]);
    const hint = collapsed[group.key] ? 'Развернуть список' : 'Свернуть список';
    if (group.el.title !== hint) group.el.title = hint;
  }

  function isIncompatible(slug) {
    const mod = state.mods[slug];
    if (!mod || pending.has(slug)) return false;
    const version = state.effectiveVersion;
    if (!version) return false;
    return !(mod.game_versions || []).includes(version);
  }

  function renderMods() {
    const list = els.modList;
    const slugs = visibleSlugs();
    const seen = new Set(slugs);

    // Карточки обновляем всегда, даже если группа свёрнута: данные должны быть свежими.
    const bad = [];
    const good = [];
    for (const slug of slugs) {
      let ref = cards.get(slug);
      if (!ref) {
        ref = createCard(slug);
        cards.set(slug, ref);
      }
      updateCard(ref, slug);
      (isIncompatible(slug) ? bad : good).push(ref.el);
    }

    const version = state.effectiveVersion;
    const nodes = [];

    if (bad.length) {
      if (!groups.bad) groups.bad = createGroupRow('bad');
      updateGroupHeader(groups.bad, `✗ Не совместимы${version ? ` с ${version}` : ''}`, bad.length);
      nodes.push(groups.bad.el);
      if (!collapsed.bad) nodes.push(...bad);
    } else if (groups.bad && groups.bad.el.parentNode) {
      groups.bad.el.remove();
    }

    if (good.length) {
      if (!groups.good) groups.good = createGroupRow('good');
      updateGroupHeader(groups.good, `✓ Совместимы${version ? ` с ${version}` : ''}`, good.length);
      nodes.push(groups.good.el);
      if (!collapsed.good) nodes.push(...good);
    } else if (groups.good && groups.good.el.parentNode) {
      groups.good.el.remove();
    }

    // Раскладываем узлы, не трогая те, что уже стоят на своих местах:
    // иконки и анимации не перезапускаются.
    let previous = null;
    for (const node of nodes) {
      const anchor = previous ? previous.nextSibling : list.firstChild;
      if (node !== anchor) list.insertBefore(node, anchor);
      previous = node;
    }

    const wanted = new Set(nodes);
    for (const [slug, ref] of Array.from(cards)) {
      if (!seen.has(slug)) {
        ref.el.remove();
        cards.delete(slug);
        continue;
      }
      // Карточка свёрнутой группы убирается из DOM, но остаётся в памяти.
      if (!wanted.has(ref.el) && ref.el.parentNode) ref.el.remove();
    }

    if (emptyState) {
      const isEmpty = slugs.length === 0;
      emptyState.classList.toggle('hidden', !isEmpty);
      if (isEmpty) {
        const paragraph = emptyState.querySelector('p');
        if (state.filter) {
          // Пользовательский текст всегда идёт через textContent — без вставки HTML.
          const wanted_text = `Ничего не найдено по фильтру «${state.filter}».`;
          if (paragraph.textContent !== wanted_text) paragraph.textContent = wanted_text;
        } else if (paragraph.innerHTML !== EMPTY_TEXT) {
          paragraph.innerHTML = EMPTY_TEXT;
        }
      }
      if (list.lastElementChild !== emptyState) list.appendChild(emptyState);
    }
  }

  function renderCompat() {
    const signature = JSON.stringify([state.compat, state.effectiveVersion, state.manualVersion, state.counts.filtered]);
    if (signature === lastCompatSig) return;
    lastCompatSig = signature;

    const grid = els.compatGrid;
    grid.textContent = '';

    if (!state.compat.length) {
      els.compatHint.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'compat-hint';
      hint.textContent = state.order.length
        ? 'Для выбранного загрузчика нет модов — смени фильтр.'
        : 'Добавь моды, чтобы увидеть совместимые версии';
      grid.appendChild(hint);
      return;
    }

    const max = state.compat[0].count || 1;
    const total = state.counts.filtered || state.order.length || 1;
    const fragment = document.createDocumentFragment();

    for (const item of state.compat.slice(0, 40)) {
      const row = document.createElement('div');
      row.className = 'compat-row' + (item.version === state.effectiveVersion ? ' selected' : '');
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = `Совместимо ${item.count} из ${total} модов`;
      if (item.version === state.manualVersion) row.title += ' (выбрано вручную)';

      const version = document.createElement('span');
      version.className = 'compat-ver';
      version.textContent = item.version;

      const bar = document.createElement('div');
      bar.className = 'compat-bar';
      const fill = document.createElement('div');
      fill.className = 'compat-bar-fill';
      fill.style.width = `${Math.round((item.count / max) * 100)}%`;
      bar.appendChild(fill);

      const count = document.createElement('span');
      count.className = 'compat-count';
      count.textContent = `${item.count}/${total}`;

      row.append(version, bar, count);
      row.addEventListener('click', () => selectVersion(item.version));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectVersion(item.version);
        }
      });
      fragment.appendChild(row);
    }

    grid.appendChild(fragment);
    els.compatHint.textContent = state.manualVersion
      ? 'Версия выбрана вручную — нажми на неё ещё раз, чтобы вернуться к авто-выбору.'
      : 'Версия выбрана автоматически по большинству модов.';
  }

  function renderStats() {
    const counts = state.counts;
    els.statTotal.textContent = counts.total || 0;
    els.statCompat.textContent = counts.compatible || 0;

    const total = counts.total || state.order.length;
    els.headerBadge.textContent = `${total} ${plural(total, 'МОД', 'МОДА', 'МОДОВ')}`;
    document.title = total ? `(${total}) Modpack Builder` : 'Modpack Builder';

    els.collectionCount.textContent = state.filter
      ? `${state.order.length} из ${total}`
      : (total ? String(total) : '');

    els.loaderChips.textContent = '';
    const loaders = Object.entries(counts.loaders || {});
    for (const [name, amount] of loaders) {
      const chip = document.createElement('span');
      chip.className = `tag loader-${name}`;
      chip.textContent = `${name} · ${amount}`;
      els.loaderChips.appendChild(chip);
    }
    for (const [type, amount] of Object.entries(counts.types || {})) {
      if (type === 'mod') continue;   // обычные моды — это норма, не засоряем панель
      const chip = document.createElement('span');
      chip.className = `tag type-${type}`;
      chip.textContent = `${TYPE_LABEL[type] || type} · ${amount}`;
      els.loaderChips.appendChild(chip);
    }
    els.exportMrpack.disabled = !state.effectiveVersion || total === 0;
  }

  function render() {
    renderMods();
    renderCompat();
    renderStats();
  }

  // -------------------------------------------------------------- действия

  async function addMod() {
    const raw = els.modInput.value.trim();
    if (!raw) return;

    const slug = guessSlug(raw);
    if (!slug) { log('Не удалось распознать мод в строке', 'error'); return; }
    if (state.mods[slug] || pending.has(slug)) {
      log(`«${slug}» уже в коллекции`, 'warn');
      return;
    }

    // Оптимистично: карточка появляется мгновенно, сеть догоняет.
    pending.add(slug);
    // Чтобы добавленный мод не «потерялся» в свёрнутой группе — разворачиваем её.
    if (collapsed.good) {
      collapsed.good = false;
      localStorage.setItem('mpb.collapse.good', '0');
    }
    renderMods();
    els.modInput.value = '';
    setBusy(els.addBtn, true);
    setProgress(1);

    try {
      const response = await fetch('/api/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        log(data.error || `Ошибка добавления (${response.status})`, 'error');
      } else {
        log(`Добавлен: ${data.mod.title}`, 'ok');
      }
    } catch (error) {
      log('Нет связи с приложением: ' + error.message, 'error');
    } finally {
      pending.delete(slug);
      setBusy(els.addBtn, false);
      setProgress(-1);
      await refresh();   // revision изменился → сервер отдаст свежие данные
      els.modInput.focus();
    }
  }

  async function removeMod(slug) {
    const ref = cards.get(slug);
    if (ref) ref.el.classList.add('leaving');
    log(`Удаляю ${slug}…`, 'warn');
    try {
      const response = await fetch('/api/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      log(`Удалён: ${slug}`, 'warn');
    } catch (error) {
      log(`Не удалось удалить ${slug}: ${error.message}`, 'error');
      if (ref) ref.el.classList.remove('leaving');
    }
    await refresh();
  }

  async function clearAll() {
    if (!confirm('Очистить всю коллекцию?')) return;
    setBusy(els.clearBtn, true);
    try {
      await fetch('/api/clear', { method: 'POST' });
      log('Коллекция очищена', 'warn');
    } catch (error) {
      log('Ошибка очистки: ' + error.message, 'error');
    } finally {
      setBusy(els.clearBtn, false);
      await refresh();
    }
  }

  async function refreshMetadata() {
    if (!state.order.length) { log('Коллекция пуста', 'warn'); return; }
    setBusy(els.refreshBtn, true);
    setProgress(1);
    const started = performance.now();
    log('Обновляю метаданные модов…');
    try {
      const response = await fetch('/api/refresh', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        log(data.error || `Ошибка обновления (${response.status})`, 'error');
      } else {
        const ms = Math.round(performance.now() - started);
        log(`Метаданные обновлены: ${data.updated} шт. за ${ms} мс`, 'ok');
        if (data.failed && data.failed.length) log(`Не удалось обновить: ${data.failed.join(', ')}`, 'warn');
      }
    } catch (error) {
      log('Ошибка обновления: ' + error.message, 'error');
    } finally {
      setBusy(els.refreshBtn, false);
      setProgress(-1);
      await refresh();
    }
  }

  function selectVersion(version) {
    state.manualVersion = state.manualVersion === version ? null : version;
    if (state.manualVersion) localStorage.setItem('mpb.version', state.manualVersion);
    else localStorage.removeItem('mpb.version');
    refresh();
  }

  async function exportMrpack() {
    const version = state.effectiveVersion;
    if (!version) { log('Выбери версию MC для экспорта', 'warn'); return; }
    const loader = els.loaderSelect.value || 'fabric';

    setBusy(els.exportMrpack, true);
    setProgress(1);
    const started = performance.now();
    try {
      const response = await fetch('/api/export/mrpack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, loader }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        log(data.error || `Ошибка экспорта (${response.status})`, 'error');
        return;
      }
      const count = response.headers.get('X-Mod-Count');
      const blob = await response.blob();
      download(blob, `modpack-${version}-${loader}.mrpack`);
      log(`Экспорт .mrpack ${version}/${loader}: ${count || '?'} файлов за ${Math.round(performance.now() - started)} мс`, 'ok');
    } catch (error) {
      log('Ошибка экспорта: ' + error.message, 'error');
    } finally {
      setBusy(els.exportMrpack, false);
      setProgress(-1);
    }
  }

  async function exportJson() {
    try {
      const response = await fetch('/api/export/json');
      const blob = await response.blob();
      download(blob, 'modpack.json');
      log('Экспорт JSON-списка завершён', 'ok');
    } catch (error) {
      log('Ошибка экспорта: ' + error.message, 'error');
    }
  }

  async function importJson(file) {
    setProgress(1);
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        log('Файл не является корректным JSON', 'error');
        return;
      }
      const response = await fetch('/api/import/json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        log(data.error || `Ошибка импорта (${response.status})`, 'error');
      } else {
        if (data.added.length) log(`Импортировано: ${data.added.join(', ')}`, 'ok');
        if (data.skipped.length) log(`Пропущено: ${data.skipped.join(', ')}`, 'warn');
        if (!data.added.length && !data.skipped.length) log('В файле не нашлось модов', 'warn');
      }
    } catch (error) {
      log('Ошибка чтения файла: ' + error.message, 'error');
    } finally {
      setProgress(-1);
      els.importFile.value = '';
      await refresh();
    }
  }

  // ------------------------------------------------------- живое обновление

  function connectEvents() {
    if (!('EventSource' in window)) return;
    try {
      eventSource = new EventSource('/api/events');
    } catch {
      return;
    }

    eventSource.onopen = () => setConnection(true);
    eventSource.onerror = () => setConnection(false);
    eventSource.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      setConnection(true);
      if (data.action === 'init') {
        state.revision = data.revision;
        return;
      }
      if (data.revision !== state.revision) {
        // Коллекцию изменили где-то ещё (расширение, вторая вкладка) — обновляемся.
        refresh();
      }
    };
  }

  // ------------------------------------------------------------- обработчики

  function bindEvents() {
    els.addBtn.addEventListener('click', addMod);
    els.modInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addMod();
    });

    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter = els.searchInput.value;
        renderMods();
        renderStats();
      }, 120);
    });

    let loaderTimer = null;
    els.loaderSelect.addEventListener('change', () => {
      localStorage.setItem('mpb.loader', els.loaderSelect.value);
      clearTimeout(loaderTimer);
      loaderTimer = setTimeout(() => refresh(), 150);
    });

    els.refreshBtn.addEventListener('click', refreshMetadata);
    els.clearBtn.addEventListener('click', clearAll);
    els.exportMrpack.addEventListener('click', exportMrpack);
    els.exportJson.addEventListener('click', exportJson);
    els.importBtn.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', () => {
      const file = els.importFile.files[0];
      if (file) importJson(file);
    });

    // Подстраховка на случай, если SSE недоступен: редкий опрос.
    setInterval(() => {
      if (!state.connected) refresh();
    }, 15000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !state.connected) refresh();
    });
  }

  function init() {
    els.loaderSelect.value = localStorage.getItem('mpb.loader') || '';
    bindEvents();
    refresh();
    connectEvents();
    els.modInput.focus();
  }

  init();
})();
