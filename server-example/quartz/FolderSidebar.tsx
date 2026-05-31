// FolderSidebar — custom Quartz v4 component with hierarchical rendering.
//
// Builds a tree from each sibling's `folder_path` frontmatter (relative path
// within the bundle, e.g. "2025/note-a") and renders subfolders as labeled
// groups with notes nested under them. Folders sort before files at every
// level; both alphabetical.
//
// Only renders when the current page is folder-scoped — either the page slug
// contains "/" (a folder-scoped file) or the slug is the prefix of another
// page's slug (the folder index page itself). Otherwise returns null so
// standalone file URLs stay sidebar-free.
import {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "./quartz/components/types"
// @ts-ignore — Quartz components are jsxFactory'd by Preact at build time.
import { h } from "preact"

interface SiblingInfo {
  fullSlug: string
  folderPath: string
  title: string
}

interface TreeNode {
  name: string
  isFolder: boolean
  fullSlug?: string
  title?: string
  children?: TreeNode[]
}

function buildBundleTree(siblings: SiblingInfo[]): TreeNode {
  const root: TreeNode = { name: "", isFolder: true, children: [] }
  for (const s of siblings) {
    const rawParts = s.folderPath.split("/").filter((p) => p.length > 0)
    const parts = rawParts.length > 0 ? rawParts : [s.title]
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i]
      let child = current.children!.find(
        (c) => c.isFolder && c.name === dirName,
      )
      if (!child) {
        child = { name: dirName, isFolder: true, children: [] }
        current.children!.push(child)
      }
      current = child
    }
    current.children!.push({
      name: parts[parts.length - 1],
      isFolder: false,
      fullSlug: s.fullSlug,
      title: s.title,
    })
  }
  const cmp = new Intl.Collator(undefined, { numeric: true })
  function sortRec(node: TreeNode) {
    if (!node.children) return
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
      return cmp.compare(a.name, b.name)
    })
    for (const c of node.children) sortRec(c)
  }
  sortRec(root)
  return root
}

function renderNodes(
  children: TreeNode[] | undefined,
  currentSlug: string,
): any[] {
  if (!children) return []
  return children.map((c) => {
    if (c.isFolder) {
      return (
        <li class="folder-group">
          <span class="folder-group-name">{c.name}</span>
          <ul>{renderNodes(c.children, currentSlug)}</ul>
        </li>
      )
    }
    const isCurrent = c.fullSlug === currentSlug
    return (
      <li class={isCurrent ? "current" : ""}>
        <a href={`/${c.fullSlug}`}>{c.title || c.name}</a>
      </li>
    )
  })
}

const FolderSidebar: QuartzComponent = (props: QuartzComponentProps) => {
  const { fileData, allFiles } = props
  const slug = fileData.slug ?? ""

  let folderSlug = ""
  const firstSlash = slug.indexOf("/")
  if (firstSlash >= 0) {
    folderSlug = slug.slice(0, firstSlash)
  } else {
    const isFolderIndex = allFiles.some(
      (f: any) => typeof f.slug === "string" && f.slug.startsWith(slug + "/"),
    )
    if (isFolderIndex) folderSlug = slug
  }
  if (!folderSlug) return null

  const prefix = folderSlug + "/"
  const siblings: SiblingInfo[] = allFiles
    .filter(
      (f: any) => typeof f.slug === "string" && f.slug.startsWith(prefix),
    )
    .map((f: any) => ({
      fullSlug: f.slug as string,
      folderPath: ((f.frontmatter?.folder_path as string) ?? "").trim(),
      title:
        (f.frontmatter?.title as string) ??
        (f.slug as string).split("/").pop()!,
    }))

  const tree = buildBundleTree(siblings)

  const indexPage = allFiles.find((f: any) => f.slug === folderSlug)
  const folderTitle =
    (indexPage?.frontmatter?.title as string) ?? folderSlug

  return (
    <aside class="folder-sidebar">
      <a class="folder-sidebar-title" href={`/${folderSlug}`}>
        {folderTitle}
      </a>
      <ul>{renderNodes(tree.children, slug)}</ul>
    </aside>
  )
}

FolderSidebar.css = `
/* Inline media (added by stager when converting [text](url.jpg) → <img>).
   Quartz's HTML sanitizer drops inline style attrs, so the constraint is
   here. Applies to images, video, audio inside article content. */
article .inline-media,
.center .inline-media {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0.5em 0;
}
article video.inline-media,
.center video.inline-media {
  background: #000;
}
article audio.inline-media,
.center audio.inline-media {
  width: 100%;
}

.folder-sidebar {
  font-size: 0.95em;
  padding: 0.5em 0;
}
.folder-sidebar .folder-sidebar-title {
  display: block;
  font-weight: 600;
  margin-bottom: 0.6em;
  color: var(--dark);
  text-decoration: none;
}
.folder-sidebar .folder-sidebar-title:hover {
  text-decoration: underline;
}
.folder-sidebar ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.folder-sidebar ul ul {
  padding-left: 0.9em;
  border-left: 1px solid var(--lightgray);
  margin-left: 0.3em;
  margin-top: 0.15em;
}
.folder-sidebar li {
  padding: 0.18em 0;
}
.folder-sidebar li.current > a {
  font-weight: 600;
  color: var(--secondary);
}
.folder-sidebar li.folder-group > .folder-group-name {
  display: block;
  font-weight: 600;
  color: var(--darkgray);
  padding: 0.3em 0 0.05em 0;
  letter-spacing: 0.01em;
}
.folder-sidebar a {
  color: var(--darkgray);
  text-decoration: none;
}
.folder-sidebar a:hover {
  color: var(--secondary);
}
`

export default ((opts?: Record<string, never>) =>
  FolderSidebar) satisfies QuartzComponentConstructor
