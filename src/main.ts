/*
 * Private Quartz Publish — Obsidian plugin.
 *
 * Lets you opt-in publish individual notes or whole folders from your
 * Obsidian vault to a self-hosted Quartz site. Each published item gets
 * an unguessable random-slug URL so the public surface cannot be
 * enumerated.
 *
 * The plugin itself does NOT publish anything — it only edits
 * frontmatter and its own data.json. The server-side "stager" service
 * (see server-example/ in the repo) does the actual mirroring into the
 * Quartz build directory, and only mirrors files that explicitly have
 * `publish: true` in frontmatter.
 */

import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
} from "obsidian"

interface QuartzPublishSettings {
  /** Base URL of the published site, no trailing slash. */
  baseUrl: string
  /** Random slug length (characters). */
  slugLength: number
  /** Frontmatter key used to mark a note as published. */
  publishProperty: string
  /** Frontmatter key used to store the per-note random slug. */
  slugProperty: string
  /** Frontmatter key used on each note that lives in a published folder bundle. */
  folderSlugProperty: string
  /** Frontmatter key used to override the displayed folder name. */
  folderNameProperty: string
  /** Show a confirmation dialog before bulk folder operations. */
  confirmFolderActions: boolean
  /** Copy the URL to the clipboard after Publish / Rotate / Folder publish. */
  copyUrlOnPublish: boolean
}

const DEFAULT_SETTINGS: QuartzPublishSettings = {
  baseUrl: "https://notes.example.com",
  slugLength: 10,
  publishProperty: "publish",
  slugProperty: "slug",
  folderSlugProperty: "folder_slug",
  folderNameProperty: "folder_name",
  confirmFolderActions: true,
  copyUrlOnPublish: true,
}

interface StoredData {
  settings: QuartzPublishSettings
  /** Map of vault-folder-path → folder slug for published folders. */
  folders: Record<string, string>
}

const SLUG_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

export default class PrivateQuartzPublishPlugin extends Plugin {
  settings: QuartzPublishSettings = { ...DEFAULT_SETTINGS }
  folders: Record<string, string> = {}

  async onload() {
    await this.loadStored()

    this.addSettingTab(new QuartzPublishSettingTab(this.app, this))

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => {
        if (target instanceof TFolder) {
          this.addFolderMenu(menu, target)
          return
        }
        if (target instanceof TFile && target.extension === "md") {
          this.addFileMenu(menu, target)
        }
      }),
    )

    this.addCommand({
      id: "toggle-publish",
      name: "Toggle publish on active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension !== "md") return false
        if (!checking) this.toggleFile(file, this.isFilePublished(file))
        return true
      },
    })

    this.addCommand({
      id: "copy-public-url",
      name: "Copy public URL of active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension !== "md") return false
        if (!this.isFilePublished(file)) return false
        if (!checking) this.copyFileUrl(file, "Copied")
        return true
      },
    })

    this.addCommand({
      id: "rotate-public-url",
      name: "Rotate public URL of active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension !== "md") return false
        if (!this.isFilePublished(file)) return false
        if (!checking) this.rotateFile(file)
        return true
      },
    })
  }

  // ─── Persistence ────────────────────────────────────────────────────────

  async loadStored() {
    const raw = ((await this.loadData()) as Partial<StoredData> | null) ?? {}
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
    this.folders = raw.folders ?? {}
  }

  async saveStored() {
    const data: StoredData = {
      settings: this.settings,
      folders: this.folders,
    }
    await this.saveData(data)
  }

  // ─── File-menu items ────────────────────────────────────────────────────

  addFileMenu(menu: any, file: TFile) {
    const published = this.isFilePublished(file)
    menu.addItem((item: any) => {
      item
        .setTitle(published ? "Unpublish from web" : "Publish to web")
        .setIcon(published ? "eye-off" : "globe")
        .onClick(() => this.toggleFile(file, published))
    })
    if (published) {
      menu.addItem((item: any) => {
        item
          .setTitle("Copy public URL")
          .setIcon("link")
          .onClick(() => this.copyFileUrl(file, "Copied"))
      })
      menu.addItem((item: any) => {
        item
          .setTitle("Rotate public URL")
          .setIcon("refresh-cw")
          .onClick(() => this.rotateFile(file))
      })
    }
  }

  addFolderMenu(menu: any, folder: TFolder) {
    const slug = this.getFolderSlug(folder)
    if (slug) {
      menu.addItem((item: any) => {
        item
          .setTitle("Unpublish folder")
          .setIcon("folder-x")
          .onClick(() => this.unpublishFolder(folder))
      })
      menu.addItem((item: any) => {
        item
          .setTitle("Copy folder URL")
          .setIcon("link")
          .onClick(() => this.copyFolderUrl(folder))
      })
    } else {
      menu.addItem((item: any) => {
        item
          .setTitle("Publish folder")
          .setIcon("folder-plus")
          .onClick(() => this.publishFolder(folder))
      })
    }
  }

  // ─── Slug + URL helpers ─────────────────────────────────────────────────

  generateSlug(): string {
    const len = Math.max(4, Math.min(64, Math.floor(this.settings.slugLength)))
    const bytes = new Uint8Array(len)
    crypto.getRandomValues(bytes)
    let out = ""
    for (let i = 0; i < len; i++) {
      out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length]
    }
    return out
  }

  buildUrl(slug: string): string {
    const base = this.settings.baseUrl.replace(/\/+$/, "")
    return `${base}/${encodeURIComponent(slug)}`
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  async announce(url: string, prefix: string) {
    if (!this.settings.copyUrlOnPublish) {
      new Notice(`${prefix}: ${url}`)
      return
    }
    const ok = await this.writeClipboard(url)
    new Notice(ok ? `${prefix} (URL copied): ${url}` : `${prefix}. URL: ${url}`)
  }

  // ─── File operations ────────────────────────────────────────────────────

  isFilePublished(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file)
    return cache?.frontmatter?.[this.settings.publishProperty] === true
  }

  getFileSlug(file: TFile): string | null {
    const cache = this.app.metadataCache.getFileCache(file)
    const slug = cache?.frontmatter?.[this.settings.slugProperty]
    return typeof slug === "string" && slug.length > 0 ? slug : null
  }

  async copyFileUrl(file: TFile, prefix: string) {
    const slug = this.getFileSlug(file)
    if (!slug) {
      new Notice("This note has no public URL yet — publish it first.")
      return
    }
    const url = this.buildUrl(slug)
    const ok = await this.writeClipboard(url)
    new Notice(ok ? `${prefix}: ${url}` : `Could not copy. URL: ${url}`)
  }

  async toggleFile(file: TFile, wasPublished: boolean) {
    let assignedSlug: string | null = null
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (wasPublished) {
        delete fm[this.settings.publishProperty]
        return
      }
      fm[this.settings.publishProperty] = true
      if (
        typeof fm[this.settings.slugProperty] !== "string" ||
        !fm[this.settings.slugProperty]
      ) {
        fm[this.settings.slugProperty] = this.generateSlug()
      }
      assignedSlug = fm[this.settings.slugProperty] as string
    })
    if (wasPublished) {
      new Notice(`Unpublished: ${file.basename}`)
      return
    }
    if (assignedSlug) {
      await this.announce(this.buildUrl(assignedSlug), "Published (live in ~5s)")
    }
  }

  async rotateFile(file: TFile) {
    let newSlug = ""
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[this.settings.slugProperty] = this.generateSlug()
      newSlug = fm[this.settings.slugProperty] as string
    })
    if (newSlug) {
      await this.announce(this.buildUrl(newSlug), "Rotated — old URL 404s in ~5s")
    }
  }

  // ─── Folder operations ──────────────────────────────────────────────────

  childMdFiles(folder: TFolder): TFile[] {
    return folder.children.filter(
      (c): c is TFile => c instanceof TFile && c.extension === "md",
    )
  }

  /**
   * Look up the folder slug. Source of truth: any child note's frontmatter
   * `folder_slug` value. Fallback to the locally-cached data.json map for
   * backward compat.
   *
   * Storing the slug in each child note (rather than only in data.json)
   * means the server-side stager sees it via normal vault file sync —
   * surviving sync setups that exclude plugin data files from replication.
   */
  getFolderSlug(folder: TFolder): string | null {
    const files = this.childMdFiles(folder)
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file)
      const slug = cache?.frontmatter?.[this.settings.folderSlugProperty]
      if (typeof slug === "string" && slug.length > 0) return slug
    }
    const cached = this.folders[folder.path]
    return typeof cached === "string" && cached.length > 0 ? cached : null
  }

  async publishFolder(folder: TFolder) {
    const files = this.childMdFiles(folder)
    if (files.length === 0) {
      new Notice(`No .md files directly in "${folder.name}".`)
      return
    }
    if (this.settings.confirmFolderActions) {
      const proceed = window.confirm(
        `Publish folder "${folder.name}" and ALL ${files.length} note(s) directly inside it?\n\n` +
          `Each note gets its own random URL.\n` +
          `The folder gets a separate URL that shows a sidebar of the notes.\n` +
          `Subfolders are NOT included — publish them separately.`,
      )
      if (!proceed) return
    }
    const folderSlug = this.generateSlug()
    for (const file of files) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[this.settings.publishProperty] = true
        if (
          typeof fm[this.settings.slugProperty] !== "string" ||
          !fm[this.settings.slugProperty]
        ) {
          fm[this.settings.slugProperty] = this.generateSlug()
        }
        fm[this.settings.folderSlugProperty] = folderSlug
        fm[this.settings.folderNameProperty] = folder.name
      })
    }
    // Also cache in data.json for fast right-click responsiveness on this
    // device. The frontmatter copy is the durable source of truth.
    this.folders[folder.path] = folderSlug
    await this.saveStored()
    await this.announce(
      this.buildUrl(folderSlug),
      `Folder published (${files.length} notes, live in ~10s)`,
    )
  }

  async unpublishFolder(folder: TFolder) {
    const files = this.childMdFiles(folder)
    if (this.settings.confirmFolderActions) {
      const proceed = window.confirm(
        `Unpublish folder "${folder.name}" AND all ${files.length} note(s) directly inside it?`,
      )
      if (!proceed) return
    }
    for (const file of files) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[this.settings.publishProperty]
        delete fm[this.settings.folderSlugProperty]
        delete fm[this.settings.folderNameProperty]
      })
    }
    delete this.folders[folder.path]
    await this.saveStored()
    new Notice(`Folder unpublished: ${folder.name}`)
  }

  async copyFolderUrl(folder: TFolder) {
    const slug = this.getFolderSlug(folder)
    if (!slug) {
      new Notice("Folder is not published.")
      return
    }
    const url = this.buildUrl(slug)
    const ok = await this.writeClipboard(url)
    new Notice(ok ? `Copied: ${url}` : `URL: ${url}`)
  }
}

// ─── Settings tab ─────────────────────────────────────────────────────────

class QuartzPublishSettingTab extends PluginSettingTab {
  plugin: PrivateQuartzPublishPlugin

  constructor(app: App, plugin: PrivateQuartzPublishPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl("h2", { text: "Private Quartz Publish" })

    const intro = containerEl.createEl("p")
    intro.appendText(
      "This plugin is the Obsidian-side of a self-hosted publishing pipeline. " +
        "It edits frontmatter; the server-side stager (in your VPS) does the actual mirroring. " +
        "See the project README for the server setup.",
    )

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        "Your Quartz site's URL, no trailing slash. Example: https://notes.example.com",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://notes.example.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "")
            await this.plugin.saveStored()
          }),
      )

    new Setting(containerEl)
      .setName("Slug length")
      .setDesc(
        "Number of characters in the random slug. Higher = harder to guess. " +
          "10 ≈ 60 bits of entropy, more than enough for unguessability.",
      )
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.slugLength))
          .onChange(async (value) => {
            const n = parseInt(value, 10)
            if (Number.isFinite(n) && n >= 4 && n <= 64) {
              this.plugin.settings.slugLength = n
              await this.plugin.saveStored()
            }
          }),
      )

    new Setting(containerEl)
      .setName("Copy URL on publish / rotate")
      .setDesc(
        "Copy the resulting public URL to the clipboard whenever you publish or rotate a note or folder.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.copyUrlOnPublish)
          .onChange(async (value) => {
            this.plugin.settings.copyUrlOnPublish = value
            await this.plugin.saveStored()
          }),
      )

    new Setting(containerEl)
      .setName("Confirm folder operations")
      .setDesc(
        "Show a confirmation dialog before bulk-publishing or bulk-unpublishing a folder.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.confirmFolderActions)
          .onChange(async (value) => {
            this.plugin.settings.confirmFolderActions = value
            await this.plugin.saveStored()
          }),
      )

    containerEl.createEl("h3", { text: "Advanced — frontmatter keys" })
    containerEl.createEl("p", {
      text:
        "Change these only if you have an existing convention. The server-side stager must use the same key names.",
    })

    new Setting(containerEl)
      .setName("Publish flag key")
      .setDesc("Frontmatter key that marks a note as published.")
      .addText((text) =>
        text
          .setPlaceholder("publish")
          .setValue(this.plugin.settings.publishProperty)
          .onChange(async (value) => {
            const v = value.trim()
            if (v) {
              this.plugin.settings.publishProperty = v
              await this.plugin.saveStored()
            }
          }),
      )

    new Setting(containerEl)
      .setName("Slug key")
      .setDesc("Frontmatter key that stores the per-note random slug.")
      .addText((text) =>
        text
          .setPlaceholder("slug")
          .setValue(this.plugin.settings.slugProperty)
          .onChange(async (value) => {
            const v = value.trim()
            if (v) {
              this.plugin.settings.slugProperty = v
              await this.plugin.saveStored()
            }
          }),
      )
  }
}
