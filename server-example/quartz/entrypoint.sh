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

# Post-process: add loading="lazy" to <img> / <video> / <audio> tags that
# don't already have it. Quartz's HTML pipeline strips the attribute even
# when the stager emits raw HTML with it set, so we re-add here.
postprocess_lazy() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith(".html")) continue;
        let s = fs.readFileSync(p, "utf8");
        const orig = s;
        s = s.replace(/<(img|video|audio)(?![^>]*\bloading=)/g, "<$1 loading=\"lazy\"");
        if (s !== orig) fs.writeFileSync(p, s);
      }
    }
    walk("'"$SCRATCH"'");
  ' 2>/dev/null || true
}

# ── Background: rsync SCRATCH → /site whenever Quartz writes ──
(
  while true; do
    inotifywait -r -q -e close_write,create,delete,moved_to "$SCRATCH" --timeout 120 2>/dev/null || true
    # tiny debounce so a batch of writes becomes one rsync
    sleep 0.3
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
