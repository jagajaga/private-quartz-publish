#!/bin/bash
set -e

# Quartz v4 tries to `rmdir` its --output dir before building, which
# fails when /site is a bind mount. We build to a scratch dir and then
# sync to the mounted /site.
SCRATCH=/tmp/quartz-out
mkdir -p /site

build_site() {
  if [ -z "$(ls -A /quartz/content 2>/dev/null)" ]; then
    echo "[quartz] Content directory empty — nothing published yet."
    # Mirror empty: wipe /site contents so unpublishing everything actually empties the site.
    find /site -mindepth 1 -delete 2>/dev/null || true
    return 0
  fi
  echo "[quartz] Building site..."
  rm -rf "$SCRATCH"
  if npx quartz build --output "$SCRATCH" 2>&1; then
    # Mirror SCRATCH → /site (with delete) without removing /site itself.
    rsync -a --delete "$SCRATCH"/ /site/
    echo "[quartz] Build complete at $(date -u +%FT%TZ)"
  else
    echo "[quartz] Build failed; previous output preserved."
  fi
}

build_site

while true; do
  inotifywait -r -q -e modify,create,delete,moved_to /quartz/content --timeout 300 2>/dev/null || true
  sleep 3
  build_site
done
