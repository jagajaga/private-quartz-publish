// Quartz publish stager (folder-aware).
//
// Mirrors only those vault notes that explicitly contain `publish: true`
// in frontmatter into a flat content directory that Quartz reads from.
// The vault itself is never exposed to Quartz.
//
// Output structure (all flat at the root of CONTENT, no vault folders):
//   /<slug>.md              standalone copy of a published note
//   /<folder>/<slug>.md     in-folder copy of a published note that lives
//                           in a published folder (sidebar UX)
//   /<folder>/index.md      folder landing page (auto-generated listing)
//   /<hash>.<ext>           embed (image / pdf) by content hash
//
// Folder publishing state is read from the Obsidian plugin's data.json:
//   .obsidian/plugins/quartz-publish-toggle/data.json
// Schema: { "folders": { "<vault-folder-path>": "<folder-slug>" } }
//
// Slug source for notes: frontmatter `slug:` (assigned by the plugin).
// Fallback for legacy publishes (no slug): basename with spaces → dashes.
//
// Markdown rewriting per copy:
//   ![[name.png]]   → ![[<hash>.png]]               embed by hash
//   ![alt](path)    → ![alt](/<hash>.png)           embed by hash
//   [[other-note]]  → [other](/<scope-prefix><slug>) if target is published
//                     (scope-prefix is the current copy's folder, if any,
//                      so navigation stays in-folder when in-folder)
//                   → plain text if target is NOT published (no leak)
//   slug:           → stripped from staged frontmatter

import { parse as parseYaml } from "https://deno.land/std@0.224.0/yaml/parse.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
} from "https://deno.land/std@0.224.0/path/mod.ts";
import { encodeHex } from "https://deno.land/std@0.224.0/encoding/hex.ts";

const VAULT = Deno.env.get("VAULT_DIR") ?? "/vault";
const CONTENT = Deno.env.get("CONTENT_DIR") ?? "/content";
const PLUGIN_DATA_PATH = join(
  VAULT,
  ".obsidian/plugins/quartz-publish-toggle/data.json",
);
const DEBOUNCE_MS = 1500;
const EMBED_HASH_LEN = 12;

// Skip everything under .obsidian/ EXCEPT the plugin data file we need.
const SKIP_DIRS = [/[\/\\]\.obsidian([\/\\]|$)/, /[\/\\]\.trash([\/\\]|$)/];

const EMBED_RE_WIKI = /!\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g;
const EMBED_RE_MD = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LINK_RE_WIKI = /(?<!!)\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g;

interface NoteInfo {
  /** Absolute vault path. */
  vaultPath: string;
  /** Vault path relative to VAULT (forward slashes). */
  relPath: string;
  /** Slug from frontmatter (or fallback). */
  slug: string;
  /** Title from frontmatter (or basename). */
  title: string;
  /** Raw file content. */
  raw: string;
  /** Offset where body starts (after frontmatter). */
  bodyStart: number;
  /** Vault folder this note lives in (relPath of parent, "" if at root). */
  parentFolder: string;
  /** `folder_slug` from frontmatter (if part of a published bundle). */
  folderSlug: string | null;
  /** `folder_name` from frontmatter (optional display name override). */
  folderName: string | null;
}

function extractFrontmatter(
  content: string,
): { fm: Record<string, unknown> | null; bodyStart: number } {
  if (!content.startsWith("---")) return { fm: null, bodyStart: 0 };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { fm: null, bodyStart: 0 };
  const yaml = content.slice(3, end).trim();
  try {
    const parsed = parseYaml(yaml);
    return {
      fm: (parsed && typeof parsed === "object")
        ? parsed as Record<string, unknown>
        : null,
      bodyStart: end + 4,
    };
  } catch {
    return { fm: null, bodyStart: 0 };
  }
}

async function hashFile(path: string, len = EMBED_HASH_LEN): Promise<string> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(digest)).slice(0, len);
}

function fallbackSlug(vaultPath: string): string {
  return basename(vaultPath).replace(/\.md$/i, "").replace(/\s+/g, "-");
}

function stripPrivateFrontmatter(fmText: string): string {
  // Strip values that should never leak to the public site.
  return fmText
    .replace(/^slug:[^\n]*\n?/m, "")
    .replace(/^folder_slug:[^\n]*\n?/m, "")
    .replace(/^folder_name:[^\n]*\n?/m, "")
    .replace(/\n{3,}/g, "\n\n");
}

function resolveByName(
  name: string,
  byName: Map<string, string>,
): string | null {
  const trimmed = name.trim();
  if (byName.has(trimmed)) return byName.get(trimmed)!;
  const tail = trimmed.split("/").pop()!;
  if (byName.has(tail)) return byName.get(tail)!;
  return null;
}

async function readFolderState(): Promise<Record<string, string>> {
  try {
    const raw = await Deno.readTextFile(PLUGIN_DATA_PATH);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.folders &&
      typeof parsed.folders === "object") {
      return parsed.folders as Record<string, string>;
    }
  } catch { /* file missing — ok */ }
  return {};
}

function rewriteBody(
  body: string,
  notes: Map<string, NoteInfo>,
  byName: Map<string, string>,
  embedSlugByPath: Map<string, string>,
  scopePrefix: string, // "" for standalone copies, "<folder-slug>/" for folder copies
): string {
  let out = body;

  out = out.replaceAll(EMBED_RE_WIKI, (full, name, alias) => {
    const target = resolveByName(name, byName);
    if (!target) return alias || name;
    if (target.endsWith(".md")) {
      const note = notes.get(target);
      return note ? `![[${note.slug}]]` : (alias || name);
    }
    const embedSlug = embedSlugByPath.get(target);
    const ext = extname(target);
    return embedSlug ? `![[${embedSlug}${ext}]]` : full;
  });

  out = out.replaceAll(EMBED_RE_MD, (full, alt, ref) => {
    if (/^https?:\/\//.test(ref)) return full;
    const cleaned = ref.split("#")[0].split("?")[0].trim();
    const target = resolveByName(cleaned, byName);
    if (!target) return full;
    const embedSlug = embedSlugByPath.get(target);
    const ext = extname(target);
    return embedSlug ? `![${alt}](/${embedSlug}${ext})` : full;
  });

  out = out.replaceAll(LINK_RE_WIKI, (_full, name, alias) => {
    const target = resolveByName(name, byName);
    if (!target) return alias || name;
    const note = notes.get(target);
    if (!note) return alias || name;
    const display = alias || name;
    return `[${display}](/${scopePrefix}${note.slug})`;
  });

  return out;
}

async function stageNoteCopy(
  note: NoteInfo,
  destRel: string,
  scopePrefix: string,
  notes: Map<string, NoteInfo>,
  byName: Map<string, string>,
  embedSlugByPath: Map<string, string>,
  wanted: Set<string>,
) {
  const fmText = note.raw.slice(0, note.bodyStart);
  const body = note.raw.slice(note.bodyStart);
  const rewritten = rewriteBody(body, notes, byName, embedSlugByPath, scopePrefix);
  const staged = stripPrivateFrontmatter(fmText) + rewritten;
  const dst = join(CONTENT, destRel);
  await ensureDir(dirname(dst));
  await Deno.writeTextFile(dst, staged);
  wanted.add(dst);
}

function generateFolderIndex(
  folderName: string,
  folderSlug: string,
  files: NoteInfo[],
): string {
  // List entries link into the folder-scoped versions so the sidebar persists
  // as the visitor clicks through.
  const list = files
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    .map((n) => `- [${n.title}](/${folderSlug}/${n.slug})`)
    .join("\n");
  // `publish: true` is required so the ExplicitPublish filter doesn't drop it.
  return `---\npublish: true\ntitle: ${folderName}\n---\n\n# ${folderName}\n\n${list}\n`;
}

async function reconcile() {
  await ensureDir(CONTENT);

  // ---- Pass 1: index every vault file by name ----
  const byName = new Map<string, string>();
  const mdFiles: string[] = [];
  for await (
    const entry of walk(VAULT, { includeDirs: false, skip: SKIP_DIRS })
  ) {
    byName.set(entry.name, entry.path);
    const stem = entry.name.replace(/\.[^/.]+$/, "");
    if (!byName.has(stem)) byName.set(stem, entry.path);
    if (entry.name.endsWith(".md")) mdFiles.push(entry.path);
  }

  // ---- Pass 2: load folder state from plugin data.json ----
  const folderSlugs = await readFolderState();
  // Sanitize: keep entries that reference real folder paths.
  for (const folderRel of Object.keys(folderSlugs)) {
    const abs = join(VAULT, folderRel);
    try {
      const st = await Deno.stat(abs);
      if (!st.isDirectory) delete folderSlugs[folderRel];
    } catch {
      delete folderSlugs[folderRel];
    }
  }

  // ---- Pass 3: identify published notes ----
  const notes = new Map<string, NoteInfo>();
  for (const path of mdFiles) {
    let raw: string;
    try { raw = await Deno.readTextFile(path); } catch { continue; }
    const { fm, bodyStart } = extractFrontmatter(raw);
    if (!fm || fm.publish !== true) continue;
    const slug = (typeof fm.slug === "string" && fm.slug.length > 0)
      ? fm.slug
      : fallbackSlug(path);
    const title = (typeof fm.title === "string" && fm.title.length > 0)
      ? fm.title
      : basename(path).replace(/\.md$/i, "");
    const relPath = relative(VAULT, path).split("\\").join("/");
    const parentFolder = dirname(relPath);
    const folderSlug =
      typeof fm.folder_slug === "string" && fm.folder_slug.length > 0
        ? fm.folder_slug
        : null;
    const folderName =
      typeof fm.folder_name === "string" && fm.folder_name.length > 0
        ? fm.folder_name
        : null;
    notes.set(path, {
      vaultPath: path,
      relPath,
      slug,
      title,
      raw,
      bodyStart,
      parentFolder: parentFolder === "." ? "" : parentFolder,
      folderSlug,
      folderName,
    });
  }

  // ---- Pass 4: discover embeds referenced by published notes ----
  const embedSlugByPath = new Map<string, string>();
  for (const [, note] of notes) {
    const body = note.raw.slice(note.bodyStart);
    const collect = async (name: string) => {
      const target = resolveByName(name, byName);
      if (!target || target.endsWith(".md")) return;
      if (embedSlugByPath.has(target)) return;
      embedSlugByPath.set(target, await hashFile(target));
    };
    for (const m of body.matchAll(EMBED_RE_WIKI)) await collect(m[1]);
    for (const m of body.matchAll(EMBED_RE_MD)) {
      const ref = m[2].trim();
      if (/^https?:\/\//.test(ref)) continue;
      const cleaned = ref.split("#")[0].split("?")[0];
      await collect(cleaned);
    }
  }

  // ---- Pass 5: build bundle map ----
  // Source of truth #1 (preferred): each published note's own `folder_slug`
  // frontmatter — set by the Obsidian plugin when the folder was published.
  // Source of truth #2 (legacy fallback): the plugin's data.json that maps
  // vault-folder-path → folder-slug. Kept so existing deployments still work.
  interface Bundle {
    slug: string;
    name: string;
    notes: NoteInfo[];
  }
  const bundles = new Map<string, Bundle>(); // folder-slug → bundle

  // Index notes by their parentFolder (used by the data.json fallback).
  const notesByFolder = new Map<string, NoteInfo[]>();
  for (const [, note] of notes) {
    const arr = notesByFolder.get(note.parentFolder) ?? [];
    arr.push(note);
    notesByFolder.set(note.parentFolder, arr);
  }

  // 5a. Frontmatter-derived bundles (source of truth #1).
  for (const [, note] of notes) {
    if (!note.folderSlug) continue;
    let bundle = bundles.get(note.folderSlug);
    if (!bundle) {
      const fallbackName = note.folderName ??
        (basename(note.parentFolder) || note.parentFolder || note.folderSlug);
      bundle = { slug: note.folderSlug, name: fallbackName, notes: [] };
      bundles.set(note.folderSlug, bundle);
    }
    if (!bundle.notes.some((n) => n.vaultPath === note.vaultPath)) {
      bundle.notes.push(note);
    }
  }

  // 5b. data.json-derived bundles (legacy fallback, dedup against 5a).
  for (const [folderPath, folderSlug] of Object.entries(folderSlugs)) {
    const folderNotes = notesByFolder.get(folderPath) ?? [];
    if (folderNotes.length === 0) continue;
    let bundle = bundles.get(folderSlug);
    if (!bundle) {
      const folderName = basename(folderPath) || folderPath;
      bundle = { slug: folderSlug, name: folderName, notes: [] };
      bundles.set(folderSlug, bundle);
    }
    for (const note of folderNotes) {
      if (!bundle.notes.some((n) => n.vaultPath === note.vaultPath)) {
        bundle.notes.push(note);
      }
    }
  }

  const wanted = new Set<string>();

  // Standalone copies for every published note.
  for (const [, note] of notes) {
    await stageNoteCopy(
      note,
      `${note.slug}.md`,
      "",
      notes,
      byName,
      embedSlugByPath,
      wanted,
    );
  }

  // Bundle copies (folder-scoped) + folder index page per bundle.
  for (const bundle of bundles.values()) {
    const scopePrefix = `${bundle.slug}/`;
    for (const note of bundle.notes) {
      await stageNoteCopy(
        note,
        `${bundle.slug}/${note.slug}.md`,
        scopePrefix,
        notes,
        byName,
        embedSlugByPath,
        wanted,
      );
    }
    // Folder index page — emitted at content root as `<folder-slug>.md` so
    // Quartz produces `<folder-slug>.html` that Caddy's try_files serves at
    // `/<folder-slug>`. Quartz v4 does not treat `<folder>/index.md` as a
    // folder root without the FolderPage emitter (which we intentionally
    // removed for privacy).
    const indexContent = generateFolderIndex(
      bundle.name,
      bundle.slug,
      bundle.notes,
    );
    const indexPath = join(CONTENT, `${bundle.slug}.md`);
    await Deno.writeTextFile(indexPath, indexContent);
    wanted.add(indexPath);
  }

  // ---- Pass 6: stage embeds (always at content root, flat) ----
  for (const [path, slug] of embedSlugByPath) {
    const ext = extname(path);
    const dst = join(CONTENT, `${slug}${ext}`);
    let needCopy = true;
    try {
      const a = await Deno.stat(path);
      const b = await Deno.stat(dst);
      if (
        a.size === b.size &&
        a.mtime && b.mtime &&
        a.mtime.getTime() === b.mtime.getTime()
      ) needCopy = false;
    } catch { /* dst missing */ }
    if (needCopy) await Deno.copyFile(path, dst);
    wanted.add(dst);
  }

  // ---- Pass 7: remove anything no longer wanted ----
  let removed = 0;
  const emptyDirCandidates = new Set<string>();
  try {
    for await (const entry of walk(CONTENT, { includeDirs: false })) {
      if (!wanted.has(entry.path)) {
        await Deno.remove(entry.path);
        emptyDirCandidates.add(dirname(entry.path));
        removed++;
      }
    }
  } catch { /* dir gone */ }
  // Best-effort empty-dir prune.
  for (const dir of emptyDirCandidates) {
    let current = dir;
    while (current.startsWith(CONTENT) && current !== CONTENT) {
      try {
        const empty = (await Array.fromAsync(Deno.readDir(current))).length === 0;
        if (!empty) break;
        await Deno.remove(current);
        current = dirname(current);
      } catch { break; }
    }
  }

  console.log(
    `[stager] reconciled: notes=${notes.size} bundles=${bundles.size} embeds=${embedSlugByPath.size} removed=${removed}`,
  );
}

let pending: number | null = null;
function debounced() {
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    reconcile().catch((e) => console.error("[stager] error:", e));
  }, DEBOUNCE_MS);
}

console.log(`[stager] starting; vault=${VAULT} content=${CONTENT}`);
await reconcile();

const watcher = Deno.watchFs(VAULT, { recursive: true });
for await (const ev of watcher) {
  // Skip irrelevant dirs but always react to plugin data changes.
  const interesting = ev.paths.some((p) => {
    if (p.includes("/.obsidian/plugins/quartz-publish-toggle/data.json")) return true;
    return !SKIP_DIRS.some((re) => re.test(p));
  });
  if (interesting) debounced();
}
