import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
import FolderSidebar from "./FolderSidebar"

/**
 * Standalone-by-default layout with conditional folder sidebar.
 *
 * Each page renders standalone (no graph, no backlinks, no search,
 * no breadcrumbs, no global explorer). The FolderSidebar component
 * is the ONE exception — it only renders content when the page's
 * slug contains `/`, i.e. it lives at a folder-scoped URL.
 *
 * Result:
 *   - /<file-slug>            → standalone, no sidebar
 *   - /<folder>/<file-slug>   → file content + sidebar of folder siblings
 *   - /<folder>               → folder index page + sidebar
 */

export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({ links: {} }),
}

export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ArticleTitle(),
    Component.ContentMeta(),
  ],
  left: [
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    FolderSidebar(),
  ],
  right: [
    Component.DesktopOnly(Component.TableOfContents()),
  ],
}

// Folder index pages use the same shape so the sidebar is shown on them too.
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.ArticleTitle()],
  left: [
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        { Component: Component.Darkmode() },
      ],
    }),
    FolderSidebar(),
  ],
  right: [],
}
