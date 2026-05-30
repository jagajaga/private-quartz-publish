# Server example

Reference implementation of the server-side stack the plugin talks to. None of
this is required to be deployed exactly as shown — you can swap parts as long as
the **stager invariants** (below) are preserved.

## Components

| Folder | What it is |
|---|---|
| `stager/` | Deno service. Watches the vault and mirrors **only** notes with `publish: true` (plus their embeds) into a separate flat content directory. Reads folder publish state from the plugin's `data.json`. |
| `quartz/` | Dockerized [Quartz v4.5.2](https://github.com/jackyzha0/quartz). Builds the staged content into static HTML. Includes a custom `FolderSidebar` component and a layout config that strips everything that could leak other notes (no explorer, no graph, no backlinks, no search, no sitemap, no RSS, no tag pages). |
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

## Quartz config invariants

In `quartz/quartz.config.ts`:

- `Plugin.ExplicitPublish()` is enabled as belt-and-suspenders.
- `Plugin.FolderPage`, `Plugin.TagPage`, `Plugin.ContentIndex` are **NOT** in the emitter list — these would emit pages listing other notes, sitemap, RSS.

In `quartz/quartz.layout.ts`:

- No `Component.Explorer`, `Graph`, `Backlinks`, `Search`, `Breadcrumbs`, `TagList`, `PageTitle`.
- A custom `FolderSidebar` is the only component that lists other notes, and it conditionally renders only on folder-scoped URLs.

If you re-enable any of those components or emitters, you weaken the privacy properties documented in the top-level README.

## Quick start

Assuming you have your vault somewhere on the server and want to publish from it:

```bash
git clone https://github.com/jagajaga/private-quartz-publish.git
cd private-quartz-publish/server-example
cp .env.example .env
$EDITOR .env                          # set VAULT_DIR
$EDITOR quartz/quartz.config.ts       # set baseUrl + pageTitle
$EDITOR caddy/Caddyfile.example       # set domain + path
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Then wire `caddy/Caddyfile.example` into your existing Caddy config (or
adapt for nginx / Traefik / etc.), reload, and visit `https://<your-domain>` —
should be 404 until you publish your first note from Obsidian.

## Where the plugin meets the stager

- Per-note: the plugin writes `publish: true` and a `slug:` value into each note's frontmatter. The stager reads those.
- Per-folder: the plugin keeps a `folders` map in `<vault>/.obsidian/plugins/private-quartz-publish/data.json`. The stager reads that file specifically.

Both directions are filesystem-mediated. The plugin makes zero network calls.
