# ⛏ Modpack Builder

A local Minecraft modpack builder: pulls mods, datapacks, shaders, and resource packs
from [Modrinth](https://modrinth.com) into a single modpack and exports it as `.mrpack`.

It runs entirely on your machine: no data is sent anywhere — the only outbound traffic
is requests to the official Modrinth API.

---

## Quick start

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # Windows
python app.py
```

Or just double-click **`start.bat`**.

The browser opens by itself at <http://localhost:7842> — only once the server is already
accepting connections (no "site can't be reached" on startup).

Useful flags:

| Flag | What it does |
|---|---|
| `--port 8080` | use a different port (default is 7842) |
| `--no-browser` | don't open the browser automatically |
| `--host 0.0.0.0` | listen on more than just localhost |

If the app is already running, starting it again doesn't fail — it simply opens a tab
with the running instance.

---

## Features

* Add by Modrinth link or slug (`sodium`, `https://modrinth.com/mod/sodium`).
* Automatic selection of a compatible Minecraft version based on most of the mods.
* Filter by loader (Fabric / Forge / NeoForge / Quilt), search within the collection.
* `.mrpack` export — files are placed in their own folders:

  | Project type | Folder in the modpack |
  |---|---|
  | mod | `mods/` |
  | plugin | `plugins/` |
  | datapack | `datapacks/` |
  | shader | `shaderpacks/` |
  | resource pack | `resourcepacks/` |

* Export / import the collection as a JSON list.
* The **⟳ Metadata** button — re-fetches MC versions and loaders for every mod.
* Live sync: a mod added from the extension shows up immediately in the open app tab
  (and vice versa) — via Server-Sent Events.

### Why it's fast

* Modrinth API responses are cached in memory (project — 6 hours, version list — 10 minutes).
* All requests go through a single `requests.Session` with keep-alive, retries, and
  de-duplication of identical concurrent requests.
* Bulk operations run in parallel: exporting a 30-mod pack is 30 concurrent requests
  rather than 30 sequential ones; a repeat export is served from the cache.
* The collection lives in memory and is written to disk atomically (temp file +
  `os.replace`), so concurrent requests lose nothing and the file is never half-written.
* `/api/collection` sends an `ETag`: the UI and the extension get a `304` with no body
  on repeat requests, and responses are gzip-compressed.
* The UI doesn't redraw the whole list — cards are updated in place, so icons aren't
  reloaded and nothing flickers.

---

## Chrome extension

The `modpack_extension/` folder is an unpacked extension (Manifest V3).

Install: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select
the `modpack_extension` folder.
After updating the files, click **↻ Reload** on the extension card. Version 2.1 adds the
`contextMenus` permission (the right-click menu item) — Chrome may ask you to re-enable
the extension, which is normal.

What it does:

* **a `+ ⛏` badge on cards** in Modrinth search results and listings (and `✓` if the mod
  is already in the modpack);
* **an "Add" button** in the bottom-right corner of a project page;
* **right-click** on a link or on the page → "Add to Modpack Builder";
* **hotkey** `Alt+Shift+M` — add the open project page;
* **a mod counter** on the extension icon;
* **removal** right from the page, with an **"Undo"** button in the notification;
* **⚙ settings** — if the app runs on a different port, set it there
  (default is `http://localhost:7842`);
* when the app is closed, the extension shows an offline widget and reconnects on its own
  once you start `app.py` — no page reload needed.

---

## Where the data lives

`%USERPROFILE%\.modpack_builder\collection.json`

If the file is corrupted, it isn't deleted but renamed to `collection.json.bak`, and the
app keeps working with an empty collection.

You can override the location with an environment variable:

```bat
set MPB_DATA_FILE=D:\modpacks\my_collection.json
python app.py
```

---

## Project structure

| File | Purpose |
|---|---|
| `app.py` | backend: Flask + Modrinth API, cache, export, SSE |
| `templates/index.html` | web UI markup |
| `static/app.css` | UI styles |
| `static/app.js` | UI logic (targeted DOM updates, SSE) |
| `modpack_extension/` | browser extension |
| `start.bat` | double-click launcher |
| `modpack.json` | sample collection export (can be loaded with the "Import JSON" button) |

> `modpack_extension.crx` — the same code packed into a single file (rebuilt for
> version 2.1). Installing a `.crx` in Chrome on Windows usually requires an enterprise
> policy, so the reliable way is to load the unpacked `modpack_extension/` folder.
> `modpack_extension.pem` is the private key the `.crx` is signed with; keep it if you
> plan to repackage.

---

## API (for the extension and your own scripts)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ping` | instant liveness check: `{ok, api, revision, mods}` |
| `GET` | `/api/collection?loader=&version=` | collection + compatible versions + stats; supports `If-None-Match` |
| `GET` | `/api/events` | SSE stream of collection changes |
| `POST` | `/api/add` | `{"url": "link or slug"}` |
| `POST` | `/api/remove` | `{"slug": "..."}` |
| `POST` | `/api/clear` | clear the collection |
| `POST` | `/api/refresh` | re-read metadata for all projects |
| `POST` | `/api/export/mrpack` | `{"version": "1.21.1", "loader": "fabric"}` |
| `GET` | `/api/export/json` | download the list |
| `POST` | `/api/import/json` | upload the list |

---

## Troubleshooting

* **"Port 7842 is in use by another program"** — run `python app.py --port 8080` and enter
  that address in the extension settings (⚙).
* **"Modrinth is unavailable"** — the app will show cached data; check your internet
  connection.
* **Mod icons don't load** — they come from `cdn.modrinth.com`; without internet a 🧩
  placeholder is shown instead.
* **The extension can't see the app** — make sure `app.py` is running, then click
  "Check connection" in the extension's ⚙ settings.
