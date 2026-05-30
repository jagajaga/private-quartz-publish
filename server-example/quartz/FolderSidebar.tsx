// FolderSidebar — custom Quartz v4 component.
//
// Renders a sidebar listing every page in the current page's "folder
// scope". A page is in a folder scope iff its slug contains a `/`, in
// which case the prefix before the first `/` is the folder slug.
//
// Pages at the root (slug has no `/`) do not get a sidebar — they are
// standalone, and we want a visitor with a direct file URL to see
// nothing about other published notes.
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./quartz/components/types"
// @ts-ignore — Quartz components are jsxFactory'd by Preact at build time.
import { h } from "preact"

const FolderSidebar: QuartzComponent = (props: QuartzComponentProps) => {
  const { fileData, allFiles } = props
  const slug = fileData.slug ?? ""

  // Two cases:
  //   1. We're at a folder-scoped page like `<folderSlug>/<fileSlug>`.
  //   2. We're at a folder index page at `<folderSlug>` (no slash, but
  //      other files exist with slug `<folderSlug>/*`).
  let folderSlug = ""
  const firstSlash = slug.indexOf("/")
  if (firstSlash >= 0) {
    folderSlug = slug.slice(0, firstSlash)
  } else {
    // Detect folder-index pages: any other file starts with `<slug>/`.
    const isFolderIndex = allFiles.some(
      (f: any) => typeof f.slug === "string" && f.slug.startsWith(slug + "/"),
    )
    if (isFolderIndex) folderSlug = slug
  }

  if (!folderSlug) return null

  const prefix = folderSlug + "/"
  const siblings = allFiles
    .filter((f: any) => {
      const s: string = f.slug ?? ""
      return s.startsWith(prefix)
    })
    .map((f: any) => ({
      slug: f.slug as string,
      title: (f.frontmatter?.title ?? f.slug.split("/").pop()) as string,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))

  const indexPage = allFiles.find((f: any) => f.slug === folderSlug)
  const folderTitle = (indexPage?.frontmatter?.title ?? folderSlug) as string

  return (
    <aside class="folder-sidebar">
      <a class="folder-sidebar-title" href={`/${folderSlug}`}>{folderTitle}</a>
      <ul>
        {siblings.map((s) => {
          const isCurrent = s.slug === slug
          return (
            <li class={isCurrent ? "current" : ""}>
              <a href={`/${s.slug}`}>{s.title}</a>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

FolderSidebar.css = `
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
.folder-sidebar li {
  padding: 0.2em 0;
}
.folder-sidebar li.current a {
  font-weight: 600;
  color: var(--secondary);
}
.folder-sidebar a {
  color: var(--darkgray);
  text-decoration: none;
}
.folder-sidebar a:hover {
  color: var(--secondary);
}
`

export default ((opts?: Record<string, never>) => FolderSidebar) satisfies QuartzComponentConstructor
