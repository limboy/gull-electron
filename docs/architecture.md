---
summary: "How the Electron main process, preload bridge, and renderer cooperate — windows, IPC channels, and lifecycle."
read_when:
  - Adding a new IPC channel or changing an existing one
  - Debugging window / file-open / second-instance behavior
  - Working on settings persistence or auto-update
title: "Process Architecture & IPC"
---

Gull runs a single main process that owns the filesystem, one library window, and any standalone book windows. The preload script is the only bridge; renderers have no Node integration.

## Processes

- **Main** (`main.js`): window lifecycle, file associations, validated IPC, settings persistence, book-folder scanning, native sidebar menus, and auto-update.
- **EPUB worker** (`lib/epub-parser-worker.js`): serializes CPU-heavy EPUB work away from the Electron main thread; the message's `task` selects a full `parse` (default) or a cover-only read.
- **Preload** (`preload.js`): exposes three namespaces via `contextBridge`:
  - `window.epub` — `parse`, `readBookFile`, `getBookCover`, `getCachedPdfCover`, `cachePdfCover`, `onOpenFile`, `signalReady`, `checkPathsExistence`, `selectBookFolder`, `scanDroppedBookFolder`, `scanBookFolder`, `watchBookFolders`, `onBookFolderChanged`, `showSidebarMenu`, `showSortMenu`, `openExternal`
  - `window.settings` — `getAll`, `set`, `onSettingsChanged`, `onChapterScrollbarChanged`
  - `window.updater` — `onUpdateReady`, `apply`
- **Renderer** (`src/reader-main.jsx` + `src/reader-runtime.js`): pure DOM work, no Node access.

## IPC channels

| Channel | Dir | Purpose |
|---|---|---|
| `parse-epub` | R→M (invoke) | Parse a file path, return `{title, chapters, toc}` |
| `read-book-file` | R→M (invoke) | Return a PDF's raw bytes for pdf.js; refuses every other format |
| `get-book-cover` | R→M (invoke) | Return a book's cover as a thumbnail data URI, or `null` when it has none |
| `get-cached-pdf-cover` | R→M (invoke) | Return a cached PDF thumbnail and its file-version key |
| `cache-pdf-cover` | R→M (invoke) | Persist a renderer-generated JPEG (up to 1 MB) if the PDF still matches the key |
| `get-settings` | R→M (invoke) | Read `settings.json` |
| `set-setting` | R→M (invoke) | Persist one validated key and broadcast the resulting `settings-changed` snapshot |
| `select-book-folder` | R→M (invoke) | Show a folder picker, then return `{path, name, books}` for the chosen directory (`null` if canceled) |
| `scan-book-folder` | R→M (invoke) | Re-read a folder the sidebar already lists; `null` when it is gone or unmounted |
| `watch-book-folders` | R→M (send) | Replace the window's watched folder list with the roots the sidebar shows |
| `show-sort-menu` | R→M (invoke) | Pop the sidebar's native sort menu (Name / Date Created, Ascending / Descending, Folders First) and return the updated settings, or `null` if dismissed |
| `show-sidebar-menu` | R→M (invoke) | Pop the native right-click menu for a sidebar folder (Show in Finder / Expand All / Collapse All / Remove) or book row (Show in Finder / Pin / Mark as Finished); reveals the path itself and returns the chosen action |
| `check-paths-existence` | R→M (invoke) | Batch check whether paths still exist; treats iCloud `.<name>.icloud` placeholders as "exists" so temporarily evicted books stay in tabs |
| `open-external` | R→M (invoke) | Open a validated `http`, `https`, `mailto`, or `tel` URL after an explicit reader link click |
| `apply-update` | R→M (invoke) | Calls `autoUpdater.quitAndInstall()` |
| `renderer-ready` | R→M (send) | Signals a renderer has wired `open-file`; main then flushes that window's pending file queue |
| `open-file` | M→R | Deliver a file path to its standalone book window |
| `settings-changed` | M→R (broadcast) | Full settings object after any write |
| `update-ready` | M→R (broadcast) | `electron-updater` finished downloading |
| `chapter-scrollbar-changed` | M→R (broadcast) | Settings-menu toggle: `true` (chapter scrollbar) or `false` (native scrollbar) |
| `book-folder-changed` | M→R | A watched library folder changed on disk; carries the root folder path to rescan |

## File-open pipeline

Files can arrive from: macOS `open-file` event, `second-instance` CLI args, first-launch CLI args, Finder double-click, or `File > Open`. Each file opens in its own standalone reader window and is not added to the library sidebar. Main keeps a pending-file queue per window until that renderer sends `renderer-ready`, which avoids the race where a file is requested before listeners are attached. Opening the same file again focuses its existing standalone window. Individual book-file drops are ignored; persistent library rows come from folders added with the sidebar button or dragged from Finder onto the sidebar.

## Book folders

`select-book-folder` and `scan-book-folder` both answer with `readBookFolder`, which walks the directory into a tree: each node carries `path`, `name`, `createdAt`, its own `books` (`filePath`, `title`, `createdAt`), and its `folders`. Finder drops use preload's `webUtils.getPathForFile` through the narrow `scanDroppedBookFolder` bridge and then invoke the same validated `scan-book-folder` channel, so dropped files and invalid paths cannot bypass main's directory check. `readFolderTree` descends `MAX_FOLDER_SCAN_DEPTH` (4) levels with a shared budget of `MAX_FOLDER_BOOKS` (500) files, so both flat folders and Calibre-style `Author/Title/book.epub` trees list correctly. Branches holding no books at any depth are pruned, dotfiles are skipped, and symlinks are ignored (readdir reports them as neither file nor directory), which also rules out symlink cycles. `createdAt` comes from `birthtimeMs`, falling back to `mtimeMs`, and is what the sidebar's *Date Created* sort orders by. Main only ever reports supported book extensions, and the renderer owns the list of folders — main keeps no library state.

`watch-book-folders` carries the root folders the sidebar currently lists (up to `MAX_WATCHED_FOLDERS`, 50); main diffs that list against the window's live `fs.watch` handles, opening and closing watchers so the two match. Watching is recursive where the platform supports it (macOS, Windows) and falls back to the folder's own level on Linux. Events are filtered to names that can change the listing — supported book files and extension-less names, which are the folders — so Calibre metadata, cover art, and dotfiles cost nothing, then debounced by `FOLDER_CHANGE_DEBOUNCE_MS` (400ms) into one `book-folder-changed` per folder, because a Finder copy or a sync client fires a burst per file. Watchers are per window and closed with it; a watcher whose folder disappears drops itself and the sidebar keeps its listing.

## Book covers

Sidebar rows show real cover art, so `get-book-cover` has to produce artwork for books nobody has opened. EPUBs go back through the parser worker with `task: 'cover'`, which reads only the container, the OPF, and the one image entry; MOBI/AZW3 files initialize the same reader `parse-epub` uses and ask it for the cover resource. PDFs use separate cache read/write channels: main has no rasterizer, so on a cache miss the renderer draws their first page and sends the JPEG back for persistence (see `pdf-rendering.md`). The image is resized to `COVER_THUMBNAIL_HEIGHT` (96px) and re-encoded as JPEG — SVG covers pass through untouched, since `nativeImage` cannot rasterize them.

Results are cached at `<userData>/covers/<sha1>.uri`, keyed by path, size, and mtime, so replacing a book on disk invalidates its thumbnail with no bookkeeping. An empty cache file records "this book has no cover" and stops the re-extraction; extraction *failures* are left uncached so a book that was mid-sync retries later. Concurrent requests for the same book share one promise, and at most `MAX_CONCURRENT_COVER_JOBS` (3) extractions run at a time — the renderer only asks for rows that scroll into view, but a fast scroll through a large folder would otherwise queue hundreds of file reads at once.

## Single instance

`app.requestSingleInstanceLock()` ensures one Gull process. A second launch fires `second-instance` with the CLI args of the new invocation; main opens supported book arguments in standalone windows, or focuses the library window when no book was supplied.

## Settings

Stored atomically at `path.join(app.getPath('userData'), 'settings.json')`. Renderer writes are restricted to known keys and validated value shapes. Known keys:
- `mainWindowBounds`, `mainWindowMaximized` — window state, saved debounced (200ms) on move/resize/close
- `sidebarStates` — persisted left/right sidebar visibility
- `chapterScrollbar` — `true` (default) | `false`; toggled via the top-bar Settings menu
- `fullWidth` — `true` | `false` (default); toggled via the top-bar Settings menu while a reflowable book is open

## Navigation hardening

Renderer navigation and popup creation are always denied. External links open only through the validated `open-external` IPC channel after an explicit content click.

All renderer IPC must originate from the trusted main frame. Book parsing and `read-book-file` additionally require an absolute supported file path, a regular file, and a size under 512 MB.
