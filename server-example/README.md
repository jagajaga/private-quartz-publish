# Server example

Reference implementation of the server-side stack the plugin talks to. None of
this is required to be deployed exactly as shown — you can swap parts as long as
the **stager invariants** (below) are preserved.

## Components

| Folder | What it is |
|---|---|
| `stager/` | Deno service. Watches the vault and mirrors **only** notes with `publish: true` (plus their embeds) into a separate flat content directory. Reads folder publish state from the plugin's `data.json`. Emits a per-bundle `<folder-slug>/_search.json` for the find widget. |
| `quartz/` | Dockerized [Quartz v4.5.2](https://github.com/jackyzha0/quartz). Builds the staged content into static HTML. Includes a custom `FolderSidebar` component and a layout config that strips everything that could leak other notes (no explorer, no graph, no backlinks, no **site-wide** search, no sitemap, no RSS, no tag pages). |
| `quartz/pf-find.js` | Self-contained find widget injected into every page by `entrypoint.sh`. In-page text find + **folder-scoped** search. No dependencies, no telemetry, no network except fetching the current folder's `_search.json`. See [Search](#search). |
| `caddy/Caddyfile.example` | Reverse-proxy config snippet. Handles HTTPS + extensionless URLs via `try_files`. Any equivalent reverse proxy works (nginx, Traefik, etc.). |
| `docker-compose.example.yml` | Composes stager + quartz against your existing vault directory. |
| `.env.example` | Variables consumed by the compose file. |

## Stager invariants

These are the guarantees the plugin relies on. If you change the stager, keep them:

1. A file lands in the content directory **only if** its frontmatter contains `publish: true`. No flag, no copy. Ever.
2. The content directory is **flat** — no vault folder path ever leaks into the public URL — except for the dual-emission folder bundles under `/<folder-slug>/`.
3. Files inside `.obsidian/` and `.trash/` are skipped (except the plugin's `data.json`, which is read for folder slug state).
4. Wikilinks to **unpublished** notes are stripped to plain text in the staged copy — so the name of an unpublished note never appears in any published HTML.
5. Wikilinks to **published** notes are rewritten to the target's slug URL (folder-scoped when inside a folder copy).
6. Embeds (images, PDFs, etc.) are renamed to a SHA-256 content hash so they cannot be enumerated by original filename.
7. When the `publish` flag flips off or a note is deleted from the vault, its staged copy is removed on the next reconcile.
8. The Quartz build sweeps any output HTML whose source markdown no longer exists. Quartz `--watch` does **not** delete output when a source disappears, so without this an unpublished or slug-rotated page would keep serving forever. `entrypoint.sh` also watches the content dir so an unpublish propagates to the live site within ~0.5s.

## Quartz config invariants

In `quartz/quartz.config.ts`:

- `Plugin.ExplicitPublish()` is enabled as belt-and-suspenders.
- `Plugin.FolderPage`, `Plugin.TagPage`, `Plugin.ContentIndex` are **NOT** in the emitter list — these would emit pages listing other notes, sitemap, RSS.

In `quartz/quartz.layout.ts`:

- No `Component.Explorer`, `Graph`, `Backlinks`, `Search`, `Breadcrumbs`, `TagList`, `PageTitle`.
- A custom `FolderSidebar` is the only component that lists other notes, and it conditionally renders only on folder-scoped URLs.

> **Note on search:** Quartz's built-in `Component.Search` is deliberately excluded — it indexes the whole site and would expose every published slug. The custom `pf-find.js` widget is **not** the same thing: it only does in-page find (no index) and folder-scoped search that reads a single bundle's index. It never reveals a note outside what the current link already exposes. See [Search](#search).

If you re-enable any of those components or emitters, you weaken the privacy properties documented in the top-level README.

## Search

Every published page gets a small find widget (`quartz/pf-find.js`), styled with Quartz's own theme variables so it matches light/dark. It has two modes, scoped to **exactly what the current link already reveals**:

| Mode | When | What it searches | Index |
|---|---|---|---|
| **this page** | always | the current page's title + body text, highlighting matches and stepping through them | none — pure DOM walk |
| **this folder** | only when the URL is part of a folder bundle (`/<folder-slug>/...`) | every note in that one bundle, by file name and content | `GET /<folder-slug>/_search.json` |

Privacy properties:

- **No site-wide search.** There is no global index. A standalone file link (`/<slug>`) gets the page tab only; the folder tab appears solely when `/<slug>/_search.json` resolves (i.e. the link is a folder bundle).
- The folder index contains only files already listed in that bundle's sidebar, so it exposes nothing new.
- No telemetry, no third-party code, no network calls except fetching the current folder's index.

How it's wired:

- The **stager** emits `<folder-slug>/_search.json` (an array of `{slug, title, snippet}`) alongside each folder bundle; Quartz's asset emitter copies it through unchanged.
- `entrypoint.sh` re-stages `pf-find.js` into the output every build and injects `<script src="/pf-find.js" defer>` before `</body>`. Both are idempotent, so rebuilds are safe.
- Matching is whitespace-flexible: a space in the query matches any whitespace run, so a phrase still matches when Markdown joined the words with a newline. Folder search is word-order independent (all terms must appear).

## Quick start

Assuming Docker is installed and your vault is on the server already:

```bash
git clone https://github.com/jagajaga/private-quartz-publish.git
cd private-quartz-publish/server-example
./setup.sh
```

The wizard prompts for your vault directory and public domain, writes
`.env`, pulls pre-built images from GHCR, and brings the stack up. Caddy
inside the compose obtains a Let's Encrypt cert automatically as long
as port 80 + 443 are reachable from the internet.

**Manual setup** (skip the wizard):

```bash
cp .env.example .env
$EDITOR .env                          # set VAULT_DIR + PUBLISH_DOMAIN
$EDITOR quartz/quartz.config.ts       # set baseUrl + pageTitle
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

**Use your own reverse proxy** instead of the bundled Caddy: comment out
the `caddy:` service in `docker-compose.yml` and adapt `caddy/Caddyfile`
into your nginx / Traefik / etc. config. Point it at the `publish/site/`
directory on disk.

After the stack is up, visit `https://<your-domain>` — you should see
404 until you publish your first note from Obsidian.

## Where the plugin meets the stager

- Per-note: the plugin writes `publish: true` and a `slug:` value into each note's frontmatter. The stager reads those.
- Per-folder: the plugin keeps a `folders` map in `<vault>/.obsidian/plugins/private-quartz-publish/data.json`. The stager reads that file specifically.

Both directions are filesystem-mediated. The plugin makes zero network calls.
