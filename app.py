#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Modpack Builder — локальный конструктор сборок модов с Modrinth.

Запуск:
    python app.py

Веб-интерфейс поднимается на http://localhost:7842
Расширение для браузера общается с этим же адресом.

Что важно для скорости:
  * ответы Modrinth API кэшируются в памяти (повторные операции почти мгновенные);
  * все сетевые запросы идут через один requests.Session с keep-alive и ретраями;
  * запросы к Modrinth распараллеливаются (добавление мода, экспорт .mrpack);
  * коллекция живёт в памяти и пишется на диск атомарно (без гонок и потери данных);
  * /api/collection отдаёт ETag → повторный запрос получает 304 без тела;
  * изменения коллекции мгновенно рассылаются по SSE (/api/events).
"""

import argparse
import gzip
import io
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import webbrowser
import zipfile
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, render_template, request, send_file
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# --------------------------------------------------------------------------
# Константы
# --------------------------------------------------------------------------

DEFAULT_PORT = 7842
DEFAULT_HOST = "127.0.0.1"

BASE_DIR = Path(__file__).resolve().parent
# Куда складывать коллекцию. Можно переопределить переменной окружения
# MPB_DATA_FILE (например, для «портативной» установки рядом с программой).
DATA_FILE = Path(
    os.environ.get("MPB_DATA_FILE")
    or (Path.home() / ".modpack_builder" / "collection.json")
).expanduser()

MODRINTH_API = "https://api.modrinth.com/v2"
API_VERSION = 2

# TTL кэша ответов Modrinth API (в секундах)
TTL_PROJECT = 6 * 3600      # карточка проекта: название, иконка — меняются редко
TTL_VERSIONS = 10 * 60      # список версий: обновляется чаще
TTL_LOADER_META = 6 * 3600  # версии загрузчиков (fabric/quilt meta)

UA = f"ModpackBuilder/{API_VERSION}.0 (local tool; +https://localhost)"

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # статика: всегда ревалидируется по ETag
app.json.ensure_ascii = False                # русский текст в JSON без \uXXXX
app.json.sort_keys = False

_LOG_LOCK = threading.Lock()


def log(msg: str) -> None:
    """Печать в консоль, устойчивая к закрытому stdout (закрыли окно терминала)."""
    try:
        with _LOG_LOCK:
            print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)
    except Exception:
        pass


# --------------------------------------------------------------------------
# HTTP-клиент к Modrinth: пул соединений + ретраи
# --------------------------------------------------------------------------

def _build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "application/json"})
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        backoff_factor=0.25,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(pool_connections=16, pool_maxsize=32, max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


SESSION = _build_session()
# Пул для параллельных запросов к Modrinth (добавление мода, экспорт сборки)
EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="mpb-net")


class ModrinthError(Exception):
    """Базовая ошибка обращения к Modrinth."""


class ModrinthNotFound(ModrinthError):
    """Проект не найден (404)."""


class ModrinthUnavailable(ModrinthError):
    """Modrinth недоступен: таймаут, сеть, 5xx."""


# --------------------------------------------------------------------------
# TTL-кэш + single-flight (одинаковые запросы не дублируются)
# --------------------------------------------------------------------------

class TTLCache:
    """Небольшой потокобезопасный кэш с «просроченным» слоем.

    Просроченные значения ещё какое-то время хранятся: если Modrinth недоступен,
    мы отдаём их вместо ошибки — интерфейс продолжает работать.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict = {}

    def get(self, key: str):
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            expires_at, value, stale_until = item
            if expires_at < time.monotonic():
                return None
            return value

    def get_stale(self, key: str):
        with self._lock:
            item = self._data.get(key)
            if not item:
                return None
            _expires_at, value, stale_until = item
            if stale_until < time.monotonic():
                self._data.pop(key, None)
                return None
            return value

    def set(self, key: str, value, ttl: float) -> None:
        now = time.monotonic()
        stale_ttl = max(ttl * 12, 3600)
        with self._lock:
            self._data[key] = (now + ttl, value, now + stale_ttl)

    def drop(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)


CACHE = TTLCache()

_FLIGHT_LOCK = threading.Lock()
_FLIGHTS: dict = {}


class _Flight:
    __slots__ = ("_event", "_data", "_error")

    def __init__(self) -> None:
        self._event = threading.Event()
        self._data = None
        self._error = None

    def finish(self, data, error) -> None:
        self._data = data
        self._error = error
        self._event.set()

    def wait(self, timeout: float):
        """(data, error); (None, None) — не дождались."""
        if not self._event.wait(timeout):
            return None, None
        return self._data, self._error


def api_get_json(path: str, ttl: float):
    """GET к Modrinth API с кэшем и склейкой одновременных одинаковых запросов."""
    cached = CACHE.get(path)
    if cached is not None:
        return cached

    with _FLIGHT_LOCK:
        flight = _FLIGHTS.get(path)
        owner = flight is None
        if owner:
            flight = _FLIGHTS[path] = _Flight()

    if not owner:
        data, error = flight.wait(25)
        if data is not None:
            return data
        if error is not None:
            stale = CACHE.get_stale(path)
            if stale is not None:
                return stale
            raise error
        # Ждали слишком долго — идём запрашивать сами.

    try:
        data = _fetch_json(path)
    except Exception as exc:
        stale = CACHE.get_stale(path)
        if stale is not None:
            log(f"Modrinth недоступен ({type(exc).__name__}), отдаю кэш: {path}")
            if owner:
                flight.finish(stale, None)
            return stale
        if owner:
            flight.finish(None, exc)
        raise
    else:
        CACHE.set(path, data, ttl)
        if owner:
            flight.finish(data, None)
        return data
    finally:
        if owner:
            with _FLIGHT_LOCK:
                _FLIGHTS.pop(path, None)


def _fetch_json(path: str):
    # Путь может быть и относительным (Modrinth API), и полным URL (meta-API загрузчиков).
    url = path if path.startswith(("http://", "https://")) else f"{MODRINTH_API}{path}"
    try:
        r = SESSION.get(url, timeout=(3.05, 12))
    except requests.RequestException as exc:
        raise ModrinthUnavailable(f"Нет связи с Modrinth: {exc.__class__.__name__}") from exc

    if r.status_code == 404:
        raise ModrinthNotFound(f"{path} не найден")
    if r.status_code == 429:
        raise ModrinthUnavailable("Modrinth просит подождать (слишком много запросов)")
    if r.status_code >= 400:
        raise ModrinthUnavailable(f"Modrinth вернул ошибку {r.status_code}")
    try:
        return r.json()
    except ValueError as exc:
        raise ModrinthUnavailable("Modrinth вернул некорректный ответ") from exc


def fetch_project(slug: str) -> dict:
    return api_get_json(f"/project/{slug}", TTL_PROJECT)


def fetch_versions(slug: str) -> list:
    data = api_get_json(f"/project/{slug}/version", TTL_VERSIONS)
    return data if isinstance(data, list) else []


# --------------------------------------------------------------------------
# Хранилище коллекции: память + атомарная запись на диск
# --------------------------------------------------------------------------

EMPTY_DATA = {"mods": {}, "modpacks": []}


class Store:
    """Коллекция модов.

    Держит данные в памяти (чтение — без диска), пишет файл атомарно
    (через временный файл + os.replace), любые изменения сериализуются lock'ом —
    поэтому параллельные запросы из браузера и расширения ничего не теряют.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._data = None
        self._revision = 0
        self._save_warned = False

    # --- чтение -----------------------------------------------------------
    @property
    def revision(self) -> int:
        with self._lock:
            self._ensure_loaded()
            return self._revision

    def read(self) -> dict:
        """Снимок данных (копия верхнего уровня — безопасно отдавать наружу)."""
        with self._lock:
            self._ensure_loaded()
            return {"mods": dict(self._data["mods"]), "modpacks": list(self._data.get("modpacks", []))}

    # --- запись -----------------------------------------------------------
    def mutate(self, fn):
        """fn(data) -> любое значение. Изменения сохраняются, revision растёт."""
        with self._lock:
            self._ensure_loaded()
            result = fn(self._data)
            self._revision += 1
            self._save_locked()
            return result

    # --- внутреннее -------------------------------------------------------
    def _ensure_loaded(self) -> None:
        if self._data is not None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        except Exception as exc:
            # Папка недоступна для записи — продолжаем работать в памяти,
            # чтобы приложение не падало на каждом запросе.
            log(f"[!] Папка данных недоступна ({exc}). Коллекция будет храниться только в памяти.")
        self._data = self._load()
        self._revision = 1

        # Однократная подсказка: рядом лежит экспорт, а коллекция пуста.
        if not self._data["mods"]:
            export = BASE_DIR / "modpack.json"
            if export.exists():
                log("Коллекция пуста, но рядом найден modpack.json — его можно загрузить кнопкой «Импорт JSON».")

    def _load(self) -> dict:
        if not self.path.exists():
            return {"mods": {}, "modpacks": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("ожидался объект JSON")
        except Exception as exc:
            log(f"[!] Не удалось прочитать файл данных: {exc}")
            backup = self.path.with_name(self.path.name + ".bak")
            try:
                self.path.replace(backup)
                log(f"[i] Повреждённый файл сохранён как: {backup}")
            except Exception as backup_exc:
                log(f"[!] Не удалось создать резервную копию: {backup_exc}")
            return {"mods": {}, "modpacks": []}

        if not isinstance(data.get("mods"), dict):
            data["mods"] = {}
        if not isinstance(data.get("modpacks"), list):
            data["modpacks"] = []
        return data

    def _save_locked(self) -> None:
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)  # атомарная замена: файл не бывает «полузаписанным»
        except Exception as exc:
            if not self._save_warned:
                self._save_warned = True
                log(f"[!] Не удалось сохранить файл данных: {exc}")
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass


STORE = Store(DATA_FILE)


# --------------------------------------------------------------------------
# Шина событий для SSE (/api/events)
# --------------------------------------------------------------------------

class EventHub:
    """Рассылляет подписчикам (вкладки браузера, расширение) факт изменения коллекции."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: set = set()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    @property
    def subscribers(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, event: dict) -> None:
        payload = {
            "revision": event.get("revision", 0),
            "action": event.get("action", "update"),
            "slug": event.get("slug"),
        }
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                # Медленный клиент: выбрасываем самое старое событие, свежее важнее.
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except Exception:
                    pass


HUB = EventHub()


def publish(action: str, slug=None) -> None:
    """Опубликовать событие об изменении коллекции всем подписчикам."""
    HUB.publish({"revision": STORE.revision, "action": action, "slug": slug})


# --------------------------------------------------------------------------
# Вспомогательное
# --------------------------------------------------------------------------

SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
URL_RE = re.compile(
    r"modrinth\.com/(?:mod|plugin|datapack|shader|resourcepack|modpack)/([^/?#]+)"
)


def extract_slug(url_or_slug: str) -> str:
    """Достаёт slug из ссылки Modrinth; если передали просто slug — возвращает его."""
    value = (url_or_slug or "").strip()
    m = URL_RE.search(value)
    if m:
        return m.group(1)
    return value


MC_VER_RE = re.compile(r"^(\d+(?:\.\d+)*)")
PRERELEASE_RE = re.compile(r"(rc|pre|snapshot|alpha|beta|dev|experimental)", re.I)


def mc_sort_key(version: str):
    """Ключ сортировки версий Minecraft: 1.21.11 > 1.21.9, релизы выше pre/rc."""
    v = (version or "").lower()
    m = MC_VER_RE.match(v)
    numbers = tuple(int(p) for p in m.group(1).split(".")[:4]) if m else ()
    prerelease = 1 if PRERELEASE_RE.search(v) else 0
    return (numbers, prerelease, v)


def collect_meta(versions: list) -> tuple:
    """Из списка версий проекта собирает (game_versions, loaders)."""
    game_versions, loaders = set(), set()
    for item in versions:
        if not isinstance(item, dict):
            continue
        game_versions.update(item.get("game_versions") or [])
        loaders.update(item.get("loaders") or [])
    return sorted(game_versions, key=mc_sort_key, reverse=True), sorted(loaders)


def build_mod_record(info: dict, versions: list) -> dict:
    game_versions, loaders = collect_meta(versions)
    return {
        "slug": info.get("slug"),
        "title": info.get("title") or info.get("slug"),
        "description": info.get("description", ""),
        "icon_url": info.get("icon_url"),
        "project_id": info.get("id"),
        # mod / plugin / datapack / shader / resourcepack — от этого зависит,
        # в какую папку сборки попадёт файл при экспорте .mrpack
        "project_type": (info.get("project_type") or "mod").lower(),
        "game_versions": game_versions,
        "loaders": loaders,
        "added_at": datetime.now().isoformat(timespec="seconds"),
    }


# Куда класть файлы проекта внутри сборки (путь относительно папки инстанса)
TYPE_FOLDER = {
    "mod": "mods",
    "plugin": "plugins",
    "datapack": "datapacks",
    "shader": "shaderpacks",
    "resourcepack": "resourcepacks",
}


def project_folder(mod: dict) -> str:
    return TYPE_FOLDER.get((mod.get("project_type") or "mod").lower(), "mods")


# --------------------------------------------------------------------------
# Сборка ответа /api/collection
# --------------------------------------------------------------------------

_COLLECTION_CACHE: dict = {}
_COLLECTION_CACHE_LOCK = threading.Lock()


def build_collection(mods: dict, loader: str, selected: str, revision: int) -> dict:
    """Считает отфильтрованный список, совместимые версии и статистику."""
    cache_key = (revision, loader, selected or "")
    with _COLLECTION_CACHE_LOCK:
        cached = _COLLECTION_CACHE.get(cache_key)
    if cached is not None:
        return cached

    filtered = {
        slug: mod
        for slug, mod in mods.items()
        if not loader or loader in (mod.get("loaders") or [])
    }

    version_counts: Counter = Counter()
    loader_counts: Counter = Counter()
    type_counts: Counter = Counter()
    for mod in filtered.values():
        for v in mod.get("game_versions") or []:
            version_counts[v] += 1
        for l in mod.get("loaders") or []:
            loader_counts[l] += 1
        type_counts[mod.get("project_type") or "mod"] += 1

    compat = sorted(
        ({"version": v, "count": c} for v, c in version_counts.items()),
        key=lambda item: (item["count"], mc_sort_key(item["version"])),
        reverse=True,
    )

    best = selected if selected and selected in version_counts else (compat[0]["version"] if compat else None)
    compatible = version_counts.get(best, 0) if best else 0

    payload = {
        "revision": revision,
        "mods": filtered,
        "compat_versions": compat,
        "selected_version": best,
        "counts": {
            "total": len(mods),
            "filtered": len(filtered),
            "compatible": compatible,
            "loaders": dict(loader_counts.most_common()),
            "types": dict(type_counts.most_common()),
        },
    }

    with _COLLECTION_CACHE_LOCK:
        _COLLECTION_CACHE.clear()  # держим только последний вариант — памяти нужно мало
        _COLLECTION_CACHE[cache_key] = payload
    return payload


# --------------------------------------------------------------------------
# Flask: заголовки, CORS, gzip
# --------------------------------------------------------------------------

COMPRESSIBLE = ("application/json", "text/html", "text/css", "text/plain",
                "application/javascript", "text/javascript", "image/svg+xml")


@app.after_request
def finalize(response: Response) -> Response:
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, If-None-Match"
    response.headers["Access-Control-Expose-Headers"] = "ETag, X-Mod-Count"

    if _should_gzip(response):
        raw = response.get_data()
        if len(raw) >= 512:
            packed = gzip.compress(raw, 6)
            if len(packed) < len(raw):
                response.set_data(packed)
                response.headers["Content-Encoding"] = "gzip"
                response.headers["Content-Length"] = str(len(packed))
                response.headers.add("Vary", "Accept-Encoding")
    return response


def _should_gzip(response: Response) -> bool:
    if response.direct_passthrough or response.status_code >= 300:
        return False
    if request.method == "HEAD" or "gzip" not in (request.headers.get("Accept-Encoding") or ""):
        return False
    if response.headers.get("Content-Encoding"):
        return False
    mimetype = (response.mimetype or "").lower()
    if not any(mimetype.startswith(t) for t in COMPRESSIBLE):
        return False
    if response.mimetype == "text/event-stream":
        return False
    return True


@app.route("/api/<path:_p>", methods=["OPTIONS"])
def options_handler(_p):
    return "", 204


# --------------------------------------------------------------------------
# Страницы
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html", api_version=API_VERSION)


# --------------------------------------------------------------------------
# API: состояние
# --------------------------------------------------------------------------

@app.route("/api/ping")
def api_ping():
    """Мгновенный отклик «приложение живо» — расширение проверяет его первым делом."""
    response = jsonify({
        "ok": True,
        "app": "modpack-builder",
        "api": API_VERSION,
        "revision": STORE.revision,
        "mods": len(STORE.read()["mods"]),
    })
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/collection")
def api_collection():
    loader = (request.args.get("loader") or "").strip().lower()
    selected = (request.args.get("version") or "").strip()
    revision = STORE.revision
    etag = f'W/"{API_VERSION}-{revision}-{loader}-{selected}"'

    if request.headers.get("If-None-Match", "").strip() == etag:
        return Response(status=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

    payload = build_collection(STORE.read()["mods"], loader, selected, revision)
    response = jsonify(payload)
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/api/events")
def api_events():
    """SSE-поток: любое изменение коллекции мгновенно доходит до всех вкладок."""
    q = HUB.subscribe()

    def stream():
        try:
            yield "retry: 3000\n\n"
            yield _sse({"revision": STORE.revision, "action": "init", "slug": None})
            while True:
                try:
                    event = q.get(timeout=15)
                except queue.Empty:
                    yield ": hb\n\n"  # keep-alive, чтобы прокси/браузер не рвали соединение
                    continue
                yield _sse(event)
        except GeneratorExit:
            return
        finally:
            HUB.unsubscribe(q)

    response = Response(stream(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache, no-transform"
    response.headers["X-Accel-Buffering"] = "no"
    response.headers["Connection"] = "keep-alive"
    return response


def _sse(payload: dict) -> str:
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


# --------------------------------------------------------------------------
# API: изменение коллекции
# --------------------------------------------------------------------------

@app.route("/api/add", methods=["POST"])
def api_add():
    started = time.perf_counter()
    body = request.get_json(silent=True) or {}
    raw = (body.get("url") or "").strip()
    slug = extract_slug(raw)

    if not slug:
        return jsonify({"error": "Не удалось распознать мод: вставь ссылку с Modrinth или slug"}), 400
    if not SLUG_RE.match(slug):
        return jsonify({"error": f"«{slug[:40]}» не похоже на ссылку или slug мода"}), 400

    data = STORE.read()
    if slug in data["mods"]:
        return jsonify({"error": f"Мод «{slug}» уже в коллекции", "slug": slug}), 409

    try:
        # Карточка проекта и список версий запрашиваются параллельно.
        info_future = EXECUTOR.submit(fetch_project, slug)
        versions_future = EXECUTOR.submit(fetch_versions, slug)
        info = info_future.result(timeout=30)
        versions = versions_future.result(timeout=30)
    except ModrinthNotFound:
        return jsonify({"error": f"Мод «{slug}» не найден на Modrinth"}), 404
    except ModrinthError as exc:
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        log(f"[!] add {slug}: {exc}")
        return jsonify({"error": f"Не удалось получить данные: {exc}"}), 500

    mod = build_mod_record(info, versions)

    def apply(d):
        d["mods"][mod["slug"]] = mod

    STORE.mutate(apply)
    publish("add", mod["slug"])
    log(f"+ {mod['slug']} ({len(mod['game_versions'])} версий MC, "
        f"{len(mod['loaders'])} загрузчиков) за {int((time.perf_counter() - started) * 1000)} мс")
    return jsonify({"mod": mod, "revision": STORE.revision})


@app.route("/api/remove", methods=["POST"])
def api_remove():
    body = request.get_json(silent=True) or {}
    slug = (body.get("slug") or "").strip()
    if not slug:
        return jsonify({"error": "Не указан slug"}), 400

    existed = slug in STORE.read()["mods"]
    if existed:
        STORE.mutate(lambda d: d["mods"].pop(slug, None))
        publish("remove", slug)
        log(f"- {slug}")
    return jsonify({"ok": True, "removed": existed, "revision": STORE.revision})


@app.route("/api/clear", methods=["POST"])
def api_clear():
    STORE.mutate(lambda d: d.update(mods={}, modpacks=[]))
    publish("clear")
    log("Коллекция очищена")
    return jsonify({"ok": True, "revision": STORE.revision})


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """Перечитывает метаданные всех модов (версии MC и загрузчики) — параллельно."""
    data = STORE.read()
    slugs = list(data["mods"])
    if not slugs:
        return jsonify({"ok": True, "updated": 0, "failed": [], "revision": STORE.revision})

    started = time.perf_counter()

    def worker(slug: str):
        # Внутри воркера запросы идут последовательно: пул уже занят самими модами,
        # вложенные задачи в тот же пул привели бы к взаимной блокировке.
        try:
            return slug, build_mod_record(fetch_project(slug), fetch_versions(slug)), None
        except Exception as exc:
            return slug, None, str(exc)

    updated, failed = {}, []
    for slug, record, error in EXECUTOR.map(worker, slugs):
        if record is None:
            failed.append(slug)
        else:
            updated[slug] = record

    if updated:
        STORE.mutate(lambda d: d["mods"].update(updated))
        publish("refresh")
    log(f"Обновление метаданных: {len(updated)} ок, {len(failed)} с ошибкой "
        f"за {int((time.perf_counter() - started) * 1000)} мс")
    return jsonify({
        "ok": True,
        "updated": len(updated),
        "failed": failed,
        "revision": STORE.revision,
    })


# --------------------------------------------------------------------------
# API: экспорт / импорт
# --------------------------------------------------------------------------

LOADER_DEP_KEY = {
    "fabric": "fabric-loader",
    "forge": "forge",
    "neoforge": "neoforge",
    "quilt": "quilt-loader",
}

LOADER_META_URLS = {
    "fabric": "https://meta.fabricmc.net/v2/versions/loader",
    "quilt": "https://meta.quiltmc.org/v3/versions/loader",
}


def fetch_loader_version(loader: str):
    """Версия загрузчика из официального meta-API (кэшируется на 6 часов)."""
    url = LOADER_META_URLS.get(loader)
    if not url:
        return None
    try:
        entries = api_get_json(url, TTL_LOADER_META)
    except Exception:
        return None
    if not isinstance(entries, list) or not entries:
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("stable", True):
            version = entry.get("version") or (entry.get("loader") or {}).get("version")
            if version:
                return version
    entry = entries[0]
    return entry.get("version") or (entry.get("loader") or {}).get("version")


def pick_file(versions: list, game_version: str, loader: str, folder: str = "mods"):
    """Выбирает подходящую версию проекта и её основной файл."""
    def matches(v, need_loader):
        return game_version in (v.get("game_versions") or []) and (
            not need_loader or loader in (v.get("loaders") or [])
        )

    best = next((v for v in versions if matches(v, True)), None)
    if best is None:
        best = next((v for v in versions if matches(v, False)), None)
    if best is None or not best.get("files"):
        return None

    files = best["files"]
    file = next((f for f in files if f.get("primary")), files[0])
    return {
        "path": f"{folder}/{file['filename']}",
        "hashes": file.get("hashes", {}),
        "downloads": [file["url"]],
        "fileSize": file.get("size", 0),
        "env": {"client": "required", "server": "optional"},
    }


@app.route("/api/export/mrpack", methods=["POST"])
def api_export_mrpack():
    started = time.perf_counter()
    body = request.get_json(silent=True) or {}
    version = (body.get("version") or "").strip()
    loader = (body.get("loader") or "fabric").strip().lower()

    if not version:
        return jsonify({"error": "Выбери версию Minecraft для экспорта"}), 400

    mods = STORE.read()["mods"]
    compatible = {s: m for s, m in mods.items() if version in (m.get("game_versions") or [])}
    if not compatible:
        return jsonify({"error": f"Нет модов, совместимых с {version}"}), 400

    # Все версии и файлы запрашиваются параллельно (раньше — последовательно, по одному моду).
    def worker(item):
        slug, mod = item
        try:
            return pick_file(fetch_versions(slug), version, loader, project_folder(mod))
        except Exception as exc:
            log(f"[!] экспорт: {slug} — {exc}")
            return None

    loader_future = EXECUTOR.submit(fetch_loader_version, loader)
    files = [f for f in EXECUTOR.map(worker, compatible.items()) if f]
    loader_version = None
    try:
        loader_version = loader_future.result(timeout=10)
    except Exception:
        pass

    dependencies = {"minecraft": version}
    if loader_version:
        dependencies[LOADER_DEP_KEY.get(loader, loader)] = loader_version

    index = {
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": "1.0.0",
        "name": f"My Modpack {version}",
        "summary": f"Generated by Modpack Builder for MC {version}",
        "files": files,
        "dependencies": dependencies,
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("modrinth.index.json", json.dumps(index, indent=2, ensure_ascii=False))
        zf.writestr("overrides/.gitkeep", "")
    buf.seek(0)

    folders = ", ".join(sorted({project_folder(m) for m in compatible.values()}))
    log(f"Экспорт .mrpack {version}/{loader}: {len(files)} файлов в [{folders}] "
        f"за {int((time.perf_counter() - started) * 1000)} мс")

    response = send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"modpack-{version}-{loader}.mrpack",
    )
    response.headers["X-Mod-Count"] = str(len(files))
    return response


@app.route("/api/export/json")
def api_export_json():
    data = STORE.read()
    buf = io.BytesIO(json.dumps(data["mods"], indent=2, ensure_ascii=False).encode("utf-8"))
    buf.seek(0)
    return send_file(buf, mimetype="application/json", as_attachment=True, download_name="modpack.json")


@app.route("/api/import/json", methods=["POST"])
def api_import_json():
    imported = request.get_json(silent=True)
    if not isinstance(imported, dict):
        return jsonify({"error": "Неверный формат JSON"}), 400

    # Поддерживаем и «сырой» список модов, и полный файл данных {"mods": {...}, ...}.
    if "mods" in imported and isinstance(imported["mods"], dict) and set(imported) <= {"mods", "modpacks"}:
        imported = imported["mods"]

    added, skipped = [], []
    fresh = {}
    for slug, mod in imported.items():
        if not isinstance(mod, dict) or not mod.get("title"):
            skipped.append(str(slug))
            continue
        mod.setdefault("slug", slug)
        mod.setdefault("loaders", [])
        mod.setdefault("game_versions", [])
        fresh[slug] = mod

    def apply(d):
        for slug, mod in fresh.items():
            if slug in d["mods"]:
                skipped.append(slug)
            else:
                d["mods"][slug] = mod
                added.append(slug)

    STORE.mutate(apply)
    if added:
        publish("import")
    log(f"Импорт JSON: добавлено {len(added)}, пропущено {len(skipped)}")
    return jsonify({"added": added, "skipped": skipped, "revision": STORE.revision})


# --------------------------------------------------------------------------
# Запуск
# --------------------------------------------------------------------------

def port_busy(host: str, port: int, timeout: float = 0.4) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex((host, port)) == 0


def wait_until_ready(host: str, port: int, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_busy(host, port):
            return True
        time.sleep(0.05)
    return False


def open_browser_when_ready(host: str, port: int) -> None:
    """Открывает браузер только когда сервер реально принимает соединения."""
    if wait_until_ready(host, port):
        webbrowser.open(f"http://localhost:{port}")


def main() -> int:
    # Русский текст в консоли Windows без «кракозябр».
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Modpack Builder — локальный конструктор сборок Modrinth")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"порт (по умолчанию {DEFAULT_PORT})")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"адрес (по умолчанию {DEFAULT_HOST})")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    args = parser.parse_args()

    url = f"http://localhost:{args.port}"

    if port_busy(args.host, args.port):
        if _looks_like_us(args.port):
            log(f"Modpack Builder уже запущен → {url} (открываю вкладку)")
            webbrowser.open(url)
            return 0
        log(f"[!] Порт {args.port} занят другой программой.")
        log(f"    Запусти с другим портом: python app.py --port {args.port + 1}")
        return 1

    log(f"Modpack Builder v{API_VERSION} → {url}")
    log(f"Данные коллекции: {DATA_FILE}")

    if not args.no_browser:
        threading.Thread(target=open_browser_when_ready, args=(args.host, args.port), daemon=True).start()

    try:
        # threaded=True обязателен: SSE-подключения держат соединение открытым.
        app.run(host=args.host, port=args.port, debug=False, threaded=True, use_reloader=False)
    except KeyboardInterrupt:
        log("Остановлено пользователем")
    return 0


def _looks_like_us(port: int) -> bool:
    try:
        r = requests.get(f"http://127.0.0.1:{port}/api/ping", timeout=1.5)
        return r.ok and r.json().get("app") == "modpack-builder"
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())
