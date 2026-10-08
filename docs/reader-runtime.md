---
summary: "Map of `src/reader-runtime.js` — the imperative module that owns all renderer behavior: tabs, content rendering, TOC, search, highlights, scrollbar, and reading-style controls."
read_when:
  - Changing anything that happens after a book is opened
  - Adding a sidebar panel, keyboard shortcut, or persistence key
  - Debugging state desync between tabs, TOC, and the chapter scrollbar
title: "Renderer Runtime Module"
---

`reader-main.jsx` renders a static DOM skeleton (elements identified by id). On mount it dynamically imports `reader-runtime.js`, which does all the real work imperatively. Treat it as the renderer's single controller.

## Central state

```js
const state = {
  openBooks,        // [{ filePath, title, pinned, finished, folderPath, createdAt, position: { scrollTop, progress } }]
  folders,          // [{ path, name, createdAt, collapsed, folders }] — disk folder trees
  sort,             // { key: 'name'|'created', direction: 'asc'|'desc', foldersFirst }
  activeBookPath,
  bookContent,      // filePath -> { chapters, toc } (PDFs add kind:'pdf', pageCount, pageSize)
  bookSearchIndex,  // filePath -> [{ id, href, title, text, textLower }]
  sidebarMode,      // 'toc' | 'search' | 'highlights'
  searchQuery,
  highlights,       // filePath -> [{ id, chapterId, start, end, text, createdAt }]
};
```

Persisted via `window.settings.set`:
- `sidebarStates` — left/right sidebar visibility
- `chapterScrollbar`, `fullWidth` — viewport layout preferences

Persisted via `localStorage`:
- `gull-sidebar-widths` — left/right panel widths (`saveSidebarWidths`)
- `gull-open-books` — library-folder books + positions + folder trees + sort settings + active tab (`saveReaderState` / `loadReaderState`); standalone book windows never write this entry
- `gull-highlights` — per-book highlight lists
- `gull-reading-style` — font/size/line-height/paragraph spacing
- `gull-pdf-view` — PDF page zoom (`fit-width` | `fit-page` | a fixed factor)

`loadReaderState` filters out books whose files no longer exist for the current session but never re-writes the pruned list back to `gull-open-books`. Reason: a transient miss (iCloud-evicted files, unmounted drives) would otherwise permanently erase the user's tabs.

On startup, the saved `activeBookPath` is restored when that book is still available. If it is missing, the first available book in the saved tab order becomes active instead.

## Sidebar folders

The books sidebar lists folders that exist on disk. The **Add Book Folder** button in the sidebar header (`#btn-new-folder`) calls `window.epub.selectBookFolder()`, and the chosen directory becomes a sidebar folder listing the books main found inside it. A folder dragged from Finder onto the sidebar follows the same flow through `scanDroppedBookFolder`; the sidebar shows a drop-target overlay while the drag is active, and non-folder drops are ignored by main's existing folder validation. Subfolders come back as nested nodes and render as nested, collapsible groups, so a `Author/Title/book.epub` tree keeps its shape. Clicking a folder header collapses or expands it — the icon is an open folder when expanded and a closed one when collapsed — and that state is persisted per folder, including subfolders (`mergeFolderTree` carries collapsed flags across rescans). A folder header outranks the rows beneath it: 14px/600 in `--text-primary` against the 13px/500 book titles, with a heavier folder icon and extra space between sibling groups. Books opened individually through Finder, the command line, or `File > Open` use standalone windows with the library sidebar hidden and do not become sidebar rows. Those windows also hide the `#toggle-left-sidebar` button — there is no library to toggle back in — and the tab bar reserves only the traffic-light space.

Right-clicking opens a native menu built by main (`show-sidebar-menu`): a folder offers **Show in Finder**, **Expand All** / **Collapse All** (which apply to its whole subtree via `setFolderTreeCollapsed`), and **Remove**; a book row offers **Show in Finder** plus checkable **Pin** and **Mark as Finished** options. Main reveals the path itself via `shell.showItemInFolder` and returns the chosen action. The renderer handles folder removal and collapse changes plus the book's pin and finished toggles. Removing a folder unlists it and every row beneath it — nothing is deleted from disk. That menu is the only way to remove a folder; folder headers carry no button but the collapse toggle. Neither book rows nor folder headers have a hover tooltip: the row already shows its name.

`#btn-sort-books` opens the sidebar's native sort menu (`show-sort-menu`): **Name** or **Date Created**, **Ascending** or **Descending**, and a **Folders First** toggle. The setting is global — one ordering for every folder — and is persisted with the reader state. Sorting applies inside each folder and to the loose rows; the order of the root folders themselves is the order they were added. With *Folders First* on, subfolders are hoisted above the books at each level; with it off, subfolders and books share one ordering the way Finder interleaves them. *Date Created* uses the file's creation time from the scan, and rows without one (books opened outside a folder) fall back to their title.

The disk is the source of truth. `initApp` calls `refreshFolders` after `loadReaderState`, re-reading every saved folder so files added or deleted outside Gull show up; `syncFolderBooks` adopts already-open books into the folder, appends new files, and drops rows anywhere under the folder whose file is gone (`forgetBooks` then picks a new active book if that was the one being read). A folder whose scan fails — deleted, or on an unmounted drive — keeps its saved listing instead of emptying. Standalone readers skip library-state restoration and folder refresh entirely.

The sidebar also tracks the disk while the app runs. `updateFolderWatchers` hands main the current root folder paths (`watch-book-folders`) after every change to the folder list, and main answers with `book-folder-changed` when files under one of them move; `refreshFolder` rescans just that folder. Focus is the fallback for changes no watcher could report — a folder that was missing or unmounted at startup never got a watcher, and one deleted and recreated outside Gull loses the one it had — so regaining window focus reruns `refreshFolders` at most once every `FOLDER_FOCUS_REFRESH_MS` (2s), which re-arms both. Rescans go through `queueFolderRefresh` so a watcher event and a focus refresh never mutate `state` at the same time, and `renderTabs` restores the sidebar's scroll position, so a rescan landing mid-read does not jump the list.

Groups are derived, never stored: `buildSidebarSections` (in `src/lib/book-order.mjs`) returns a `pinned` section plus one section per root folder — each carrying an `items` list that mixes book rows and nested folder sections in sorted order. Grouped rows are indented per nesting level so the boundaries read clearly. Pinned books are lifted out of their folder so they always render above every folder — they keep `folderPath`, so unpinning drops them back where they were. The helper still returns unfiled rows for compatibility with older saved state, but new individual opens are standalone and never enter library state.

Folder rows have no close button: a row mirrors a file on disk, so removing the folder is the only way to unlist it. Legacy ad-hoc rows keep their close buttons. A book marked as finished shows a checkmark at the end of its row, after the title and before the hover-only close action.

Each row leads with the book's own cover art, sized to the same 15px slot the placeholder `book-text` icon occupies so rows stay aligned either way. Covers are requested one row at a time through `loadBookCover` → `window.epub.getBookCover`, driven by an `IntersectionObserver` rooted on the tab bar (200px margin), so a folder of hundreds of books only costs reads for what the user actually scrolls past. Results — including "no cover", stored as `null` — are memoized in the module-level `bookCovers` map, and a cover that arrives patches its row's icon in place rather than re-rendering the sidebar, which would fight an in-progress scroll. Books without art keep the placeholder icon. Nothing image-sized is written to `localStorage`; main owns the on-disk thumbnail cache. PDF rows check that cache before loading pdf.js and persist newly rendered first-page thumbnails, so restarting the app does not reparse unchanged PDFs for their sidebar icons.

Pinned and finished states are stored in the same `gull-open-books` records. Pinning moves a book to the first sidebar slot; unpinning moves it directly after the remaining pinned group. Startup also groups saved pinned books ahead of unpinned books while preserving the relative order within each group. Pinning is only reachable from the row's context menu — no button sits in the row. Pinned rows use the same styling and hover-only actions as regular book rows. The hidden close action collapses out of the row layout so the title uses the full width, then expands on hover or keyboard focus.

## Feature map (by function)

| Concern | Key functions |
|---|---|
| Tabs | `openBook`, `closeBook`, `setActiveBook`, `pinBook`, `renderTabs`, `renderActiveBookTitle` |
| Folders | `addFolderFromDisk`, `addDroppedFolders`, `addFolderScans`, `refreshFolders`, `refreshFolder`, `applyFolderScan`, `updateFolderWatchers`, `queueFolderRefresh`, `removeFolderFromSidebar`, `toggleFolder`, `setFolderTreeCollapsed`, `forgetBooks`, `createSection`, `showSidebarMenu`, `showSortMenu`, `initSidebarFolders` |
| Chapter render | `renderContent`, `stripEpubFonts`, `bindImageFallback` |
| PDF pages | `getPdfModule`, `mountPdfBook`, `destroyActivePdfMount`, `releaseBookResources`, `indexPdfForSearch`, `loadPdfCover`, `notifyBookKind` (details in `pdf-rendering.md`) |
| TOC | `renderOutline`, `initOutlineScrollTracking`, `setActiveOutlineItem`, `scrollToHref`, `findChapterByHref` |
| Search | `indexBookForSearch`, `findSearchMatches`, `renderSearchResults`, `highlightTermsInContent`, `clearContentSearchHighlights` |
| Highlights | `addHighlight`, `removeHighlight`, `applyHighlightsToChapter`, `wrapHighlight`, `getSelectionOffsets`, `handleSelectionChange`, `renderHighlights`, `saveHighlights`, `loadHighlights` |
| Chapter scrollbar | `initChapterScrollbar` (segmented bar visualizing book structure) |
| Resize | `initResize`, `setupHandle`, `saveSidebarWidths`, `loadSidebarWidths` |
| Reading style | `loadReadingStyle`, `applyReadingStyle`, `ensureReadingFontsLoaded`, `updateStyleDisplay`, `stepValue`, `FONT_SIZE_STEPS`, `LINE_HEIGHT_STEPS`, `PARA_SPACING_STEPS` |
| Theme | `applySystemTheme` plus the `prefers-color-scheme` listener |
| Update pill | `initUpdatePill` |
| Broken images | `initBrokenImageHandling` |
| Bootstrap | `initApp` (bottom of file) |

Book tabs, folder headers, TOC entries, search results, highlights, sidebar tabs, and resize separators are keyboard accessible. Vertical book tabs use Up/Down, sidebar panels use Left/Right, and resize separators use arrow keys (Shift for larger steps).

## Top bar

The bar above the content (`#tab-bar`) centers the active book's title in `#active-book-title`, inside the draggable region between the sidebar toggles. `renderActiveBookTitle` fills it from `state.openBooks` on every `renderContent`, and again when EPUB metadata replaces a book's title mid-render; it is empty when no book is open. Standalone windows show it too. The top-right Settings menu owns the typography controls plus the chapter-scrollbar and full-width toggles. The chapter-scrollbar toggle is always shown; **Full width** sits with the typography controls because it only applies to a reflowable book. `notifyBookKind` tells it which kind of book is open (`window.gullBookKind` and the `gull:book-kind` event), and it replaces that whole group with page-zoom choices directly in the main menu while a PDF is active — none of the reflow settings do anything to a fixed-layout page.

## Rendering model

Chapters are injected as HTML strings into `#content-area`. Scroll position + progress per book is captured in `state.openBooks[i].position` and restored on tab switch. The chapter scrollbar is redrawn whenever content or viewport changes.

A PDF goes through the same path: `src/pdf-book.js` returns one chapter per page, whose markup is an empty page box that pdf.js fills with a canvas and a text layer as it scrolls into view (`pdf-rendering.md`). Only the PDF on screen keeps its pdf.js document open — `releaseInactivePdf` closes the previous one and drops its cached payload when another book is opened, because the worker holds the entire file. Its search index is kept, so returning to it re-reads the file but does not re-extract its text. The EPUB-only passes — font stripping, broken-image fallbacks, footnote asides, and the initial highlight pass — are skipped for those pages, and a PDF without bookmarks feeds the chapter scrollbar a sampled subset of its pages so a long document does not draw hundreds of segments.

At startup, `reader-main.jsx` synchronously seeds sidebar visibility, sidebar widths, chapter-scrollbar mode, full-width mode, and the saved reading-style CSS variables before creating the layout. When saved books are queued for restoration, the first content placeholder is `Loading…`; the empty state is rendered only when no books are saved. `initApp` applies the same layout snapshot and awaits the selected reading-font faces before restoring the active book, so its scroll position is measured against the final viewport and final font metrics. The initial book is revealed without the normal content/sidebar transitions; later tab and sidebar interactions retain their transitions.

## Multi-book EPUB collections

`findChapterByHref` resolves TOC hrefs to spine chapters. Multi-book collections (e.g. "Hunger Games 4-Book Collection") reuse filenames like `cover.xhtml` across books in different directories. The helper disambiguates via: exact match → suffix match → filename-only (only when unambiguous) → longest common suffix. Used by `scrollToHref`, `resolveHrefTarget` (inside `initChapterScrollbar`), and `initOutlineScrollTracking`.

## Search

Built on a flat text index per book (chapter id, href, title, normalized text). Query is debounced `SEARCH_DEBOUNCE_MS=100`, min length `SEARCH_MIN_QUERY_LENGTH=2`, capped at `SEARCH_MAX_RESULTS=120`. Matches are highlighted in the sidebar snippet and in the live content via `highlightTermsInContent`; clearing or switching books calls `clearContentSearchHighlights`.

## Highlights

Selection offsets are captured relative to the chapter container (`getSelectionOffsets`), together with short prefix/suffix quote context. `wrapHighlight` walks text nodes between `startOffset` and `endOffset` and wraps them in `<mark class="reader-highlight">`. Creating a highlight that overlaps or touches existing highlights merges them into a single continuous highlight (`mergeOverlappingHighlights`), avoiding double-highlighting. If later parsing changes invalidate the raw offsets, `resolveHighlightOffsets` relocates the quote using its context and persists the repaired location. Highlights use the publication identifier when the book provides one, falling back to the absolute file path, and are stored in the `gull-highlights` local-storage entry.



The selection action popup keeps a live anchor to either the selected `Range` or an existing highlight element. Its fixed viewport position is recalculated when the content area scrolls or resizes, so the action follows the selected text instead of remaining at its original screen coordinates.

## Why imperative?

The DOM structure is stable and defined once by React. Keeping dynamic behavior in plain JS avoids a full React state model for what is largely one long document and a few panels. If you add a feature, follow the existing pattern: grab elements by id at the top of the module, add an `init…` function, and call it from `initApp`.
