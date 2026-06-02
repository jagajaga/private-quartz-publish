#!/bin/bash
set -e

# Long-lived Quartz watcher.
#
# Each `npx quartz build` is a cold Node start — TS compile of Quartz's own
# source + plugin init costs ~30-60s before a single markdown file is parsed.
# With `--watch`, Quartz keeps that process alive and rebuilds incrementally
# (sub-second on small changes).
#
# Quartz v4 still wants to `rmdir` its output dir on each cycle, which fails
# on a bind mount, so we build into a scratch dir and a tiny rsync loop
# mirrors it to the real /site (the bind mount) whenever it changes.

SCRATCH=/tmp/quartz-out
mkdir -p /site "$SCRATCH"

# Post-process: enforce browser-side lazy behavior on media tags, and inject
# the in-page / folder-scoped find widget. Quartz's HTML pipeline strips these
# attributes even when emitted by the stager, so we re-inject here after Quartz
# writes and before the rsync to /site.
#
#   loading="lazy"  — defers fetch until the element is near the viewport
#                     (works on <img>; ignored on <video>/<audio> but harmless)
#   preload="none"  — video/audio: don't fetch the file until the user
#                     presses play. (Default would fetch metadata + a
#                     chunk; "none" suppresses that.)
#
# Also re-stages /pf-find.js into SCRATCH each pass (so a stale Quartz rebuild
# can't strand the asset) and injects a single <script src="/pf-find.js" defer>
# before </body> — idempotent, so re-runs over the same file are safe.
postprocess_lazy() {
  cp /pf-find.js "$SCRATCH/pf-find.js" 2>/dev/null || true
  node -e '
    const fs = require("fs");
    const path = require("path");
    const SCRATCH = "'"$SCRATCH"'";
    const CONTENT = "/quartz/content";
    const TAG = "<script src=\"/pf-find.js\" defer></script>";
    // Framework pages Quartz emits without a markdown counterpart. Everything
    // else MUST be backed by a live /quartz/content/<path>.md or get swept —
    // Quartz --watch does not delete output files when the source disappears
    // (slug rotation, unpublish, file delete), which would otherwise leak old
    // URLs forever. This sweep is the privacy guarantee.
    const KEEP_ORPHAN_HTML = new Set(["404.html"]);
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          // Prune empty dirs left behind by sweeps.
          try { fs.rmdirSync(p); } catch { /* not empty */ }
          continue;
        }
        if (!e.name.endsWith(".html")) continue;

        // Sweep stale HTML first — no point post-processing a doomed file.
        const rel = path.relative(SCRATCH, p);
        if (!KEEP_ORPHAN_HTML.has(rel)) {
          const mdPath = path.join(CONTENT, rel.replace(/\.html$/, ".md"));
          if (!fs.existsSync(mdPath)) {
            try { fs.unlinkSync(p); } catch {}
            continue;
          }
        }

        let s = fs.readFileSync(p, "utf8");
        const orig = s;
        s = s.replace(/<(img|video|audio)(?![^>]*\bloading=)/g, "<$1 loading=\"lazy\"");
        s = s.replace(/<(video|audio)(?![^>]*\bpreload=)/g, "<$1 preload=\"none\"");
        if (!s.includes("/pf-find.js")) {
          if (s.includes("</body>")) s = s.replace("</body>", TAG + "</body>");
          else s += TAG;
        }
        if (s !== orig) fs.writeFileSync(p, s);
      }
    }
    walk(SCRATCH);
  ' 2>/dev/null || true
}

# ── Background: rsync SCRATCH → /site whenever Quartz writes ──
# Also watch /quartz/content: a pure-delete in content (stager removing a
# rotated/unpublished slug) produces no SCRATCH event, but we still need the
# sweep + rsync to run promptly. Without this, an unpublish would linger up
# to the inotifywait timeout (120s) before /site catches up.
(
  while true; do
    inotifywait -r -q -e close_write,create,delete,moved_to \
      "$SCRATCH" /quartz/content --timeout 120 2>/dev/null || true
    # tiny debounce so a batch of writes becomes one rsync
    sleep 0.5
    postprocess_lazy
    rsync -a --delete "$SCRATCH"/ /site/ 2>/dev/null || true
  done
) &

clear_site_if_content_empty() {
  if [ -z "$(ls -A /quartz/content 2>/dev/null)" ]; then
    find /site -mindepth 1 -delete 2>/dev/null || true
    find "$SCRATCH" -mindepth 1 -delete 2>/dev/null || true
  fi
}

# ── Main supervisor: keep quartz --watch alive ──
while true; do
  if [ -z "$(ls -A /quartz/content 2>/dev/null)" ]; then
    clear_site_if_content_empty
    echo "[quartz] Content empty — waiting for first file to appear..."
    inotifywait -q -e create,moved_to /quartz/content --timeout 300 2>/dev/null || true
    continue
  fi

  echo "[quartz] Starting in --watch mode (incremental rebuilds)"
  # --watch keeps the process alive; output goes to SCRATCH; rsync loop above
  # mirrors it to the bind-mounted /site. No --serve = no extra HTTP server.
  npx quartz build --watch --output "$SCRATCH" 2>&1 || true
  echo "[quartz] watch mode exited (likely a build error); restarting in 5s"
  sleep 5
done
