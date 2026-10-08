import { applySystemTheme } from './lib/theme.mjs';
import { resolveHighlightOffsets, isOverlappingHighlight, mergeOverlappingHighlights } from './lib/highlight-anchor.mjs';
import {
  groupPinnedBooks,
  toggleBookPin,
  toggleBookFinished,
  normalizeFolders,
  normalizeSort,
  addFolder,
  findFolder,
  flattenScannedBooks,
  syncFolderBooks,
  removeFolder,
  buildSidebarSections,
  DEFAULT_SORT,
} from './lib/book-order.mjs';
import {
  isPdfPath,
  normalizePdfView,
  pdfPageChapterId,
  samplePdfChapters,
  PDF_VIEW_STORAGE_KEY,
} from './lib/pdf-view.mjs';


const state = {
  openBooks: [],       // [{ filePath, title, pinned, finished, folderPath, position: { scrollTop, progress } }]
  folders: [],         // [{ path, name, createdAt, collapsed, folders }] — disk folder trees
  sort: { ...DEFAULT_SORT }, // sidebar ordering: key, direction, foldersFirst
  offlineBooks: [],    // transient missing books kept across sessions
  activeBookPath: null,
  bookContent: {},     // filePath -> { chapters, toc }
  bookSearchIndex: {}, // filePath -> [{ id, href, title, text, textLower }]
  sidebarMode: 'toc',
  searchQuery: '',
  highlights: {},      // filePath -> [{ id, chapterId, start, end, text, createdAt }]
};

const STORAGE_KEY = 'gull-sidebar-widths';
const STORAGE_KEY_BOOKS = 'gull-open-books';
const isStandaloneReader = new URLSearchParams(window.location.search).get('standalone') === '1';

// DOM refs
const appLayout = document.getElementById('app-layout');
const getAppLayout = () => document.getElementById('app-layout') || appLayout;
const leftSidebar = document.getElementById('left-sidebar');
const tabBar = document.getElementById('tab-bar-tabs');
const contentArea = document.getElementById('content-area');
const emptyState = document.getElementById('empty-state');
const activeBookTitle = document.getElementById('active-book-title');
const sidebarTabToc = document.getElementById('sidebar-tab-toc');
const sidebarTabSearch = document.getElementById('sidebar-tab-search');
const sidebarTabHighlights = document.getElementById('sidebar-tab-highlights');
const sidebarSearchWrap = document.getElementById('sidebar-search-wrap');
const sidebarSearchInput = document.getElementById('sidebar-search-input');
const sidebarSearchClear = document.getElementById('sidebar-search-clear');
const outlinePanel = document.getElementById('outline-panel');
const searchPanel = document.getElementById('search-panel');
const highlightsPanel = document.getElementById('highlights-panel');
const selectionPopup = document.getElementById('selection-popup');

const SEARCH_DEBOUNCE_MS = 100;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_RESULTS = 120;
const HIGHLIGHT_CONTEXT_LENGTH = 32;
let sidebarSearchTimer = null;

function finishAppStartup() {
  getAppLayout()?.classList.remove('app-starting');
}

function throttle(func, limit) {
  let lastFunc;
  let lastRan;
  return function(...args) {
    const context = this;
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(function() {
        if ((Date.now() - lastRan) >= limit) {
          func.apply(context, args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
  };
}

// --- PDF support ---
// pdf.js is a large dependency, so it is only pulled in the first time a PDF is
// opened (or a PDF row asks for its cover).
let pdfModulePromise = null;
let pdfModule = null;
function getPdfModule() {
  if (!pdfModulePromise) {
    pdfModulePromise = import('./pdf-book.js')
      .then((module) => {
        pdfModule = module;
        return module;
      })
      .catch((error) => {
        pdfModulePromise = null;
        throw error;
      });
  }
  return pdfModulePromise;
}

let activePdfMount = null;
// Only the PDF on screen keeps its pdf.js document open: the worker holds the
// whole file, so a folder of large scans would otherwise pile up in memory.
let livePdfPath = null;
let pdfSearchIndexToken = 0;
let searchHighlightTimer = null;

function loadPdfView() {
  try {
    return normalizePdfView(JSON.parse(localStorage.getItem(PDF_VIEW_STORAGE_KEY)));
  } catch {
    return normalizePdfView(null);
  }
}

function destroyActivePdfMount() {
  activePdfMount?.destroy();
  activePdfMount = null;
}

/**
 * Hand the injected page placeholders to pdf.js. The module is already loaded
 * by the time a PDF renders — mounting synchronously matters because the page
 * boxes must have their final height before the saved scroll position is
 * restored.
 */
function mountPdfBook(filePath, container) {
  const mount = (pdf) => {
    if (state.activeBookPath !== filePath || !container.isConnected) return;
    destroyActivePdfMount();
    activePdfMount = pdf.mountPdfPages(filePath, container, {
      scrollRoot: contentArea,
      view: loadPdfView(),
      onPageRendered: (pageNumber, pageEl) => {
        const section = pageEl.closest('section.gull-chapter');
        // Highlights live in the text layer, which only exists once the page
        // has been rendered.
        if (section) applyHighlightsToChapter(pdfPageChapterId(pageNumber), section);
        scheduleSearchHighlightRefresh();
        contentArea.dispatchEvent(new Event('force-update-scrollbar'));
      },
    });
  };

  if (pdfModule) mount(pdfModule);
  else getPdfModule().then(mount).catch(error => console.warn('Failed to mount PDF pages', error));
}

/**
 * The settings menu offers page zoom for PDFs and typography for reflowable
 * books, so it has to know which kind is on screen.
 */
let currentBookKind = null;
function notifyBookKind(kind) {
  if (currentBookKind === kind) return;
  currentBookKind = kind;
  window.gullBookKind = kind;
  getAppLayout()?.classList.toggle('pdf-active', kind === 'pdf');
  window.dispatchEvent(new CustomEvent('gull:book-kind', { detail: { kind } }));
}

// Zoom is chosen in the settings menu, which owns no rendering of its own.
window.addEventListener('gull:pdf-view-changed', (event) => {
  if (!activePdfMount) return;
  const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
  const progress = maxScroll > 0 ? contentArea.scrollTop / maxScroll : 0;
  activePdfMount.setView(normalizePdfView(event.detail));
  requestAnimationFrame(() => {
    const nextMax = contentArea.scrollHeight - contentArea.clientHeight;
    contentArea.scrollTop = nextMax * progress;
    contentArea.dispatchEvent(new Event('force-update-scrollbar'));
  });
});

/** Closing a PDF has to hand its pages and its pdf.js document back. */
function releaseBookResources(filePath) {
  if (!isPdfPath(filePath)) return;
  if (filePath === state.activeBookPath) destroyActivePdfMount();
  if (filePath === livePdfPath) livePdfPath = null;
  pdfModulePromise?.then(pdf => pdf.releasePdfBook(filePath)).catch(() => {});
}

/**
 * Reading a different book releases the last PDF's document. Its payload goes
 * with it, so re-opening re-reads the file; the search index survives, because
 * page ids are stable and re-extracting the text of a long PDF is not cheap.
 */
function releaseInactivePdf() {
  if (!livePdfPath || livePdfPath === state.activeBookPath) return;
  const filePath = livePdfPath;
  delete state.bookContent[filePath];
  releaseBookResources(filePath);
}

/** Page text arrives asynchronously, so the search index is built once it has. */
async function indexPdfForSearch(filePath, data) {
  const token = ++pdfSearchIndexToken;
  const pdf = await getPdfModule();
  const extracted = await pdf.extractPdfText(filePath);
  if (!extracted || token !== pdfSearchIndexToken) return;
  indexBookForSearch(filePath, data.chapters, data.toc);
}

// Pages render one at a time; re-running the whole highlight pass per page
// would be wasteful, so coalesce them into one refresh.
function scheduleSearchHighlightRefresh() {
  if (!state.searchQuery || searchHighlightTimer) return;
  searchHighlightTimer = setTimeout(() => {
    searchHighlightTimer = null;
    refreshContentSearchHighlights();
  }, 150);
}

/**
 * Find the chapter whose href best matches a TOC/navigation href.
 *
 * Multi-book EPUB collections often reuse the same filenames (cover.xhtml,
 * titlepage.xhtml) across books, only differing by directory prefix. A naive
 * filename-only match with .find() would always return the first book's
 * chapter. This helper avoids that by:
 *
 * 1. Trying an exact match first.
 * 2. Falling back to suffix matching (href ends with the target) which
 *    handles varying path prefixes.
 * 3. Only using filename-only matching when there is exactly one candidate
 *    (no ambiguity).
 */
function findChapterByHref(chapters, baseHref) {
  if (!baseHref || !chapters) return null;

  // 1. Exact match
  const exact = chapters.find(c => c.href === baseHref);
  if (exact) return exact;

  // 2. Suffix match — handles varying path prefixes between TOC and spine.
  //    e.g. TOC href "book4/cover.xhtml" should match chapter href
  //    "OEBPS/book4/cover.xhtml" but NOT "OEBPS/book1/cover.xhtml".
  const suffixMatches = chapters.filter(c =>
    c.href.endsWith('/' + baseHref) || baseHref.endsWith('/' + c.href)
  );
  if (suffixMatches.length === 1) return suffixMatches[0];

  // 3. Filename-only fallback — safe only when unambiguous.
  const tocFile = baseHref.split('/').pop();
  const filenameMatches = chapters.filter(c =>
    c.href.split('/').pop() === tocFile
  );
  if (filenameMatches.length === 1) return filenameMatches[0];

  // 4. If multiple suffix matches exist, pick the one whose full href
  //    is most similar (longest common suffix) to the target.
  const candidates = suffixMatches.length > 0 ? suffixMatches : filenameMatches;
  if (candidates.length > 1) {
    let best = candidates[0];
    let bestLen = 0;
    for (const c of candidates) {
      const a = c.href;
      const b = baseHref;
      let len = 0;
      for (let i = 1; i <= Math.min(a.length, b.length); i++) {
        if (a[a.length - i] === b[b.length - i]) len++;
        else break;
      }
      if (len > bestLen) { bestLen = len; best = c; }
    }
    return best;
  }

  return candidates[0] || null;
}

// --- Book Tab Management ---
function openBook(filePath, title) {
  const existing = state.openBooks.find(b => b.filePath === filePath);
  if (!existing) {
    state.openBooks.push({ filePath, title });
  }
  setActiveBook(filePath);
  renderTabs();
  saveReaderState();
}

function closeBook(filePath) {
  const idx = state.openBooks.findIndex(b => b.filePath === filePath);
  if (idx === -1) return;

  state.openBooks.splice(idx, 1);
  releaseBookResources(filePath);
  delete state.bookContent[filePath];
  delete state.bookSearchIndex[filePath];

  if (state.activeBookPath === filePath) {
    if (state.openBooks.length > 0) {
      const newIdx = Math.min(idx, state.openBooks.length - 1);
      setActiveBook(state.openBooks[newIdx].filePath);
    } else {
      state.activeBookPath = null;
    }
  }
  renderTabs();
  renderContent();
  saveReaderState();
}

function setActiveBook(filePath) {
  state.activeBookPath = filePath;
  renderTabs();
  renderContent();
  saveReaderState();
}

function pinBook(filePath) {
  if (toggleBookPin(state.openBooks, filePath) === null) return;

  renderTabs();
  saveReaderState();
}

function toggleFinishedBook(filePath) {
  if (toggleBookFinished(state.openBooks, filePath) === null) return;

  renderTabs();
  saveReaderState();
}

const BOOK_TEXT_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-text-icon lucide-book-text"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><path d="M8 11h8"/><path d="M8 7h6"/></svg>`;
const FINISHED_MARK = `
  <span class="tab-finished" role="img" aria-label="Finished" title="Finished">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>
  </span>`;

// --- Sidebar Covers ---
// Cover art is fetched only once a row scrolls into view: a library can list
// hundreds of books and every miss costs main a read of the book file.
const COVER_THUMBNAIL_HEIGHT = 96; // matches the thumbnails main produces
const bookCovers = new Map(); // filePath -> data URI, or null when there is none
const pendingCovers = new Set();

const coverObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      loadBookCover(entry.target.dataset.coverFor);
    }
  }, { root: tabBar, rootMargin: '200px' })
  : null;

function bookIconHtml(filePath) {
  const cover = bookCovers.get(filePath);
  return cover ? `<img class="tab-cover" src="${escapeHtml(cover)}" alt="" />` : BOOK_TEXT_ICON;
}

// Main has no PDF rasterizer, so their thumbnails are rendered here. They are
// queued behind one another because each one reads a whole file.
let pdfCoverQueue = Promise.resolve();
function loadPdfCover(filePath) {
  pdfCoverQueue = pdfCoverQueue
    .then(async () => {
      const { key, cover } = await window.epub.getCachedPdfCover(filePath);
      if (cover) return cover;
      const pdf = await getPdfModule();
      const thumbnail = await pdf.renderPdfThumbnail(filePath, COVER_THUMBNAIL_HEIGHT);
      if (thumbnail) {
        try {
          await window.epub.cachePdfCover(filePath, key, thumbnail);
        } catch (error) {
          console.warn('Failed to cache PDF cover', filePath, error);
        }
      }
      return thumbnail;
    })
    .catch((error) => {
      console.warn('Failed to render PDF cover', filePath, error);
      return null;
    });
  return pdfCoverQueue;
}

async function loadBookCover(filePath) {
  if (!filePath || bookCovers.has(filePath) || pendingCovers.has(filePath)) return;
  pendingCovers.add(filePath);
  let cover = null;
  try {
    cover = isPdfPath(filePath)
      ? await loadPdfCover(filePath)
      : await window.epub.getBookCover(filePath);
  } catch (error) {
    console.error('Failed to load book cover', error);
  } finally {
    pendingCovers.delete(filePath);
  }
  bookCovers.set(filePath, cover || null);
  if (!cover) return;

  // Patch the row in place — re-rendering the sidebar would fight a scroll in
  // progress, and covers land one by one.
  for (const icon of tabBar.querySelectorAll('.tab-icon')) {
    if (icon.dataset.coverFor === filePath) icon.innerHTML = bookIconHtml(filePath);
  }
}

function observeBookCovers() {
  for (const icon of tabBar.querySelectorAll('.tab-icon')) {
    if (bookCovers.has(icon.dataset.coverFor)) continue;
    if (coverObserver) coverObserver.observe(icon);
    else loadBookCover(icon.dataset.coverFor);
  }
}

function createBookTab(book) {
  const tab = document.createElement('div');
  const isFinished = book.finished === true;
  tab.className = 'tab-item' + (book.filePath === state.activeBookPath ? ' active' : '');
  tab.setAttribute('role', 'presentation');
  tab.dataset.bookItem = book.filePath;
  const safeTitle = escapeHtml(book.title);
  const safePath = escapeHtml(book.filePath);
  const isActive = book.filePath === state.activeBookPath;

  // A folder row mirrors a file on disk, so it has nothing to close — the
  // folder itself is what gets removed. Only ad-hoc opened books close.
  const closeHtml = book.folderPath ? '' : `
    <button type="button" class="tab-close" data-close-book="${safePath}"
      aria-label="Close ${safeTitle}" title="Close ${safeTitle}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </button>`;
  tab.innerHTML = `
    <button type="button" class="tab-activate" role="tab"
      aria-selected="${isActive}" tabindex="${isActive ? '0' : '-1'}"
      data-book-path="${safePath}">
      <span class="tab-icon" data-cover-for="${safePath}" aria-hidden="true">
        ${bookIconHtml(book.filePath)}
      </span>
      <span class="tab-label">${safeTitle}</span>
      ${isFinished ? FINISHED_MARK : ''}
    </button>
    ${closeHtml}
  `;
  return tab;
}

const FOLDER_ICON_CLOSED = `
  <svg class="tab-section-folder-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
  </svg>`;
const FOLDER_ICON_OPEN = `
  <svg class="tab-section-folder-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
  </svg>`;

function createSectionHeader(section) {
  const header = document.createElement('div');
  header.className = 'tab-section-header';
  const safeId = escapeHtml(section.id);
  const safeTitle = escapeHtml(section.title);

  // Pinned books are not a folder: the group is a plain, always-visible heading.
  if (section.kind === 'pinned') {
    header.innerHTML = `
      <div class="tab-section-title" role="heading" aria-level="2">${safeTitle}</div>
    `;
    return header;
  }

  header.innerHTML = `
    <button type="button" class="tab-section-toggle" data-toggle-section="${safeId}"
      aria-expanded="${!section.collapsed}">
      ${section.collapsed ? FOLDER_ICON_CLOSED : FOLDER_ICON_OPEN}
      <span class="tab-section-title">${safeTitle}</span>
    </button>
  `;
  return header;
}

function createSection(section) {
  const element = document.createElement('div');
  element.className = 'tab-section' + (section.collapsed ? ' collapsed' : '');
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', section.title);
  element.dataset.sectionKind = section.kind;
  if (section.kind === 'folder') element.dataset.folderPath = section.id;
  element.appendChild(createSectionHeader(section));

  const list = document.createElement('div');
  list.className = 'tab-section-books';
  list.hidden = section.collapsed;
  if (!section.collapsed) {
    // Pinned keeps a plain book list; folders interleave rows and subfolders.
    const items = section.items
      || section.books.map(book => ({ type: 'book', book }));
    items.forEach(item => list.appendChild(
      item.type === 'folder' ? createSection(item.section) : createBookTab(item.book)
    ));
    if (items.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'tab-section-empty';
      hint.textContent = 'No books in this folder';
      list.appendChild(hint);
    }
  }
  element.appendChild(list);
  return element;
}

function renderTabs() {
  // Rebuilding the list would otherwise jump a scrolled sidebar back to the
  // top whenever a folder rescan lands while the user is reading.
  const scrollTop = tabBar.scrollTop;
  tabBar.innerHTML = '';
  if (isStandaloneReader) return;

  const { sections, unfiledBooks } = buildSidebarSections(
    state.openBooks, state.folders, state.sort
  );

  sections.forEach(section => tabBar.appendChild(createSection(section)));
  // Books opened from Finder or File > Open sit loose under the folders.
  unfiledBooks.forEach(book => tabBar.appendChild(createBookTab(book)));
  tabBar.scrollTop = scrollTop;
  observeBookCovers();
}

// --- Sidebar Folders ---
function setFolderTreeCollapsed(folderPath, collapsed) {
  const folder = findFolder(state.folders, folderPath);
  if (!folder) return;

  const apply = (node) => {
    node.collapsed = collapsed;
    (node.folders || []).forEach(apply);
  };
  apply(folder);
  renderTabs();
  saveReaderState();
}

function toggleFolder(folderPath) {
  const folder = findFolder(state.folders, folderPath);
  if (!folder) return;

  folder.collapsed = folder.collapsed !== true;
  renderTabs();
  saveReaderState();
}

/** Forget books that a folder no longer lists. Returns true if the active book went away. */
function forgetBooks(filePaths) {
  if (filePaths.length === 0) return false;

  for (const filePath of filePaths) {
    releaseBookResources(filePath);
    delete state.bookContent[filePath];
    delete state.bookSearchIndex[filePath];
  }
  if (!filePaths.includes(state.activeBookPath)) return false;

  state.activeBookPath = state.openBooks[0]?.filePath || null;
  return true;
}

/** Apply one folder tree from disk. Returns true if the active book went away. */
function applyFolderScan(scan) {
  addFolder(state.folders, scan);
  return forgetBooks(
    syncFolderBooks(state.openBooks, scan.path, flattenScannedBooks(scan))
  );
}

/** Ask main to watch exactly the folders the sidebar lists right now. */
function updateFolderWatchers() {
  if (isStandaloneReader) return;
  window.epub.watchBookFolders(state.folders.map(folder => folder.path));
}

// Rescans mutate shared state and await renderContent, so they run one at a
// time: a watcher event and a focus refresh can otherwise overlap.
const FOLDER_FOCUS_REFRESH_MS = 2000;
let lastFolderRefreshAt = 0;
let folderRefreshChain = Promise.resolve();
function queueFolderRefresh(task) {
  folderRefreshChain = folderRefreshChain.then(task, task);
  return folderRefreshChain;
}

async function addFolderFromDisk() {
  const scan = await window.epub.selectBookFolder();
  if (!scan) return;

  await addFolderScans([scan]);
}

async function addFolderScans(scans) {
  let activeLost = false;
  let added = false;
  for (const scan of scans) {
    if (!scan) continue;
    added = true;
    if (applyFolderScan(scan)) activeLost = true;
  }
  if (!added) return;

  renderTabs();
  if (activeLost) await renderContent();
  saveReaderState();
  updateFolderWatchers();
}

async function addDroppedFolders(files) {
  const scans = [];
  for (const file of files) {
    try {
      const scan = await window.epub.scanDroppedBookFolder(file);
      if (scan) scans.push(scan);
    } catch (err) {
      console.warn('Dropped folder scan failed', err);
    }
  }
  await addFolderScans(scans);
}

/** Re-read one folder after main reports the files under it changed. */
function refreshFolder(folderPath) {
  return queueFolderRefresh(async () => {
    lastFolderRefreshAt = Date.now();
    if (!findFolder(state.folders, folderPath)) return;

    // A null scan means the folder is gone or its drive is unmounted; keep the
    // saved listing rather than emptying the sidebar over a transient miss.
    const scan = await window.epub.scanBookFolder(folderPath);
    if (!scan) return;

    const activeLost = applyFolderScan(scan);
    renderTabs();
    if (activeLost) await renderContent();
    saveReaderState();
  });
}

/** Re-read every folder so the sidebar reflects what is on disk right now. */
function refreshFolders() {
  return queueFolderRefresh(async () => {
    lastFolderRefreshAt = Date.now();
    // Watchers are re-armed even with no folders, so removals reach main too.
    updateFolderWatchers();
    if (state.folders.length === 0) return;

    let activeLost = false;
    for (const folder of [...state.folders]) {
      // A null scan means the folder is gone or its drive is unmounted; keep the
      // saved listing rather than emptying the sidebar over a transient miss.
      const scan = await window.epub.scanBookFolder(folder.path);
      if (scan && applyFolderScan(scan)) activeLost = true;
    }
    // Root folders are shown in the order they were added; only their contents sort.

    renderTabs();
    if (activeLost) await renderContent();
    saveReaderState();
  });
}

function removeFolderFromSidebar(folderPath) {
  const activeLost = forgetBooks(removeFolder(state.folders, state.openBooks, folderPath));
  renderTabs();
  if (activeLost) renderContent();
  saveReaderState();
  updateFolderWatchers();
}

async function showSortMenu(anchor) {
  try {
    const chosen = await window.epub.showSortMenu({ ...state.sort, anchor });
    if (!chosen) return;
    state.sort = normalizeSort(chosen);
    renderTabs();
    saveReaderState();
  } catch (err) {
    console.warn('Sort menu failed', err);
  }
}

async function showSidebarMenu(type, targetPath, bookState = {}) {
  try {
    const action = await window.epub.showSidebarMenu({
      type,
      path: targetPath,
      pinned: bookState.pinned === true,
      finished: bookState.finished === true,
    });
    if (type === 'book') {
      if (action === 'toggle-pin') pinBook(targetPath);
      else if (action === 'toggle-finished') toggleFinishedBook(targetPath);
      return;
    }
    if (action === 'remove') removeFolderFromSidebar(targetPath);
    else if (action === 'expand') setFolderTreeCollapsed(targetPath, false);
    else if (action === 'collapse') setFolderTreeCollapsed(targetPath, true);
  } catch (err) {
    console.warn('Sidebar menu failed for ' + targetPath, err);
  }
}

function initSidebarFolders() {
  document.getElementById('btn-new-folder')?.addEventListener('click', () => {
    addFolderFromDisk();
  });

  if (!isStandaloneReader) {
    window.epub.onBookFolderChanged(folderPath => refreshFolder(folderPath));

    const isFileDrag = (event) =>
      Array.from(event.dataTransfer?.types || []).includes('Files');
    const clearFolderDropTarget = () => {
      leftSidebar?.classList.remove('folder-drop-active');
    };

    leftSidebar?.addEventListener('dragenter', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      leftSidebar.classList.add('folder-drop-active');
    });
    leftSidebar?.addEventListener('dragover', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      leftSidebar.classList.add('folder-drop-active');
    });
    leftSidebar?.addEventListener('dragleave', (event) => {
      if (!leftSidebar.contains(event.relatedTarget)) clearFolderDropTarget();
    });
    leftSidebar?.addEventListener('drop', (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearFolderDropTarget();
      addDroppedFolders(Array.from(event.dataTransfer.files));
    });
    window.addEventListener('dragend', clearFolderDropTarget);

    // Fallback for changes no watcher reported: a folder that was missing or
    // unmounted at startup has no watcher, and one deleted and recreated
    // outside Gull loses the watcher it had. Regaining focus re-arms both.
    window.addEventListener('focus', () => {
      if (Date.now() - lastFolderRefreshAt < FOLDER_FOCUS_REFRESH_MS) return;
      refreshFolders();
    });
  }

  document.getElementById('btn-sort-books')?.addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showSortMenu({ x: rect.left, y: rect.bottom + 2 });
  });

  tabBar.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-toggle-section]');
    if (toggle) toggleFolder(toggle.dataset.toggleSection);
  });

  tabBar.addEventListener('contextmenu', (e) => {
    const bookRow = e.target.closest('[data-book-item]');
    const folder = e.target.closest('[data-folder-path]');
    if (!bookRow && !folder) return;

    e.preventDefault();
    if (bookRow) {
      const bookPath = bookRow.dataset.bookItem;
      const book = state.openBooks.find(candidate => candidate.filePath === bookPath);
      showSidebarMenu('book', bookPath, {
        pinned: book?.pinned === true,
        finished: book?.finished === true,
      });
    } else {
      showSidebarMenu('folder', folder.dataset.folderPath);
    }
  });
}

function setSidebarMode(mode) {
  state.sidebarMode = mode || 'toc';

  const isSearch = state.sidebarMode === 'search';
  const isHighlights = state.sidebarMode === 'highlights';
  const isToc = state.sidebarMode === 'toc';

  sidebarTabToc.classList.toggle('active', isToc);
  sidebarTabSearch.classList.toggle('active', isSearch);
  sidebarTabHighlights.classList.toggle('active', isHighlights);

  sidebarTabToc.setAttribute('aria-selected', String(isToc));
  sidebarTabSearch.setAttribute('aria-selected', String(isSearch));
  sidebarTabHighlights.setAttribute('aria-selected', String(isHighlights));
  sidebarTabToc.tabIndex = isToc ? 0 : -1;
  sidebarTabSearch.tabIndex = isSearch ? 0 : -1;
  sidebarTabHighlights.tabIndex = isHighlights ? 0 : -1;

  sidebarSearchWrap.hidden = !isSearch;
  outlinePanel.hidden = !isToc;
  searchPanel.hidden = !isSearch;
  highlightsPanel.hidden = !isHighlights;

  if (isSearch) {
    sidebarSearchInput.focus({ preventScroll: true });
    renderSearchResults();
  } else if (isHighlights) {
    renderHighlights();
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHighlightStorageKey(filePath = state.activeBookPath) {
  const identifier = String(state.bookContent[filePath]?.identifier || '').trim();
  return identifier ? `publication:${identifier}` : filePath;
}

function migrateHighlightsToPublicationId(filePath) {
  const storageKey = getHighlightStorageKey(filePath);
  if (!filePath || !storageKey || storageKey === filePath || !state.highlights[filePath]) return;
  const existing = state.highlights[storageKey] || [];
  const knownIds = new Set(existing.map(highlight => highlight.id));
  state.highlights[storageKey] = [
    ...existing,
    ...state.highlights[filePath].filter(highlight => !knownIds.has(highlight.id)),
  ];
  delete state.highlights[filePath];
  saveHighlights();
}

function buildTocTitleMap(items, titleMap = {}) {
  if (!items) return titleMap;
  for (const item of items) {
    const baseHref = (item.href || '').split('#')[0];
    const file = baseHref.split('/').pop();
    if (file && item.title && !titleMap[file]) {
      titleMap[file] = item.title;
    }
    if (item.children) {
      buildTocTitleMap(item.children, titleMap);
    }
  }
  return titleMap;
}

function flattenToc(items, out = []) {
  if (!items) return out;
  for (const item of items) {
    if (item.href && item.title) out.push(item);
    if (item.children) flattenToc(item.children, out);
  }
  return out;
}

function normalizeText(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function indexBookForSearch(filePath, chapters, toc) {
  const titleMap = buildTocTitleMap(toc);
  const tocFiles = new Set(
    flattenToc(toc).map(t => (t.href || '').split('#')[0].split('/').pop()).filter(Boolean)
  );
  const index = [];
  const tempDiv = document.createElement('div');
  let i = 0;
  let inheritedTitle = '';

  function processChunk() {
    const start = performance.now();
    while (i < (chapters || []).length && performance.now() - start < 15) {
      const chapter = chapters[i];
      tempDiv.innerHTML = chapter.html || '';
      // PDF pages carry their text directly; their markup is an empty page box.
      const text = chapter.text
        ? normalizeText(chapter.text)
        : normalizeText(tempDiv.textContent || '');
      if (text) {
        const file = (chapter.href || '').split('/').pop();
        if (tocFiles.has(file) && titleMap[file]) {
          inheritedTitle = titleMap[file];
        }
        const heading = tempDiv.querySelector('h1, h2, h3, h4, h5, h6, title');
        const headingTitle = heading ? normalizeText(heading.textContent || '') : '';
        index.push({
          id: chapter.id,
          href: chapter.href || '',
          title: titleMap[file] || inheritedTitle || chapter.title || headingTitle || '',
          text,
          textLower: text.toLowerCase(),
        });
      }
      i++;
    }

    if (i < (chapters || []).length) {
      setTimeout(processChunk, 10);
    } else {
      state.bookSearchIndex[filePath] = index;
      if (state.activeBookPath === filePath) {
        renderSearchResults();
      }
    }
  }

  setTimeout(processChunk, 200);
}

function buildMatchSnippet(text, start, length = 46) {
  const left = Math.max(0, start - length);
  const right = Math.min(text.length, start + length);
  const prefix = left > 0 ? '…' : '';
  const suffix = right < text.length ? '…' : '';
  return prefix + text.slice(left, right) + suffix;
}

function buildHighlightedSnippet(snippet, terms) {
  let html = escapeHtml(snippet);
  for (const term of terms) {
    if (!term) continue;
    const regex = new RegExp(`(${escapeRegExp(term)})`, 'ig');
    html = html.replace(regex, '<mark>$1</mark>');
  }
  return html;
}

function findSearchMatches(filePath, query) {
  const index = state.bookSearchIndex[filePath] || [];
  const normalized = normalizeText(query).toLowerCase();
  if (normalized.length < SEARCH_MIN_QUERY_LENGTH) return [];

  const terms = normalized.split(' ').filter(Boolean);
  if (terms.length === 0) return [];

  const results = [];
  for (const entry of index) {
    if (!terms.every(term => entry.textLower.includes(term))) continue;

    let from = 0;
    let hits = 0;
    while (results.length < SEARCH_MAX_RESULTS && hits < 3) {
      const hitAt = entry.textLower.indexOf(terms[0], from);
      if (hitAt === -1) break;
      results.push({
        chapterId: entry.id,
        href: entry.href,
        title: entry.title,
        snippet: buildMatchSnippet(entry.text, hitAt),
        matchIndex: hits,
        term: terms[0],
      });
      from = hitAt + terms[0].length;
      hits += 1;
    }

    if (results.length >= SEARCH_MAX_RESULTS) break;
  }

  return results;
}

function renderSearchResults() {
  searchPanel.innerHTML = '';

  if (!state.activeBookPath) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Open a book to search.';
    searchPanel.appendChild(empty);
    return;
  }

  const query = state.searchQuery || '';
  const normalized = normalizeText(query);
  if (!normalized) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'Type to search in the current book.';
    searchPanel.appendChild(empty);
    return;
  }

  if (normalized.length < SEARCH_MIN_QUERY_LENGTH) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `Enter at least ${SEARCH_MIN_QUERY_LENGTH} characters.`;
    searchPanel.appendChild(empty);
    return;
  }

  const results = findSearchMatches(state.activeBookPath, normalized);
  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No matches for "${normalized}".`;
    searchPanel.appendChild(empty);
    return;
  }

  const terms = normalized.toLowerCase().split(' ').filter(Boolean);
  for (const result of results) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-result-item';
    row.dataset.chapterId = result.chapterId;
    row.dataset.href = result.href || '';
    row.dataset.matchIndex = String(result.matchIndex ?? 0);
    row.dataset.term = result.term || '';
    const titleHtml = result.title
      ? `<span class="search-result-title">${escapeHtml(result.title)}</span>`
      : '';
    row.innerHTML = `
      ${titleHtml}
      <span class="search-result-snippet">${buildHighlightedSnippet(result.snippet, terms)}</span>
    `;
    searchPanel.appendChild(row);
  }
}

function clearContentSearchHighlights() {
  contentArea.querySelectorAll('mark.search-match').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

function highlightTermsInContent(terms) {
  if (!terms || terms.length === 0) return;
  const pattern = new RegExp(terms.map(escapeRegExp).join('|'), 'ig');
  const walker = document.createTreeWalker(contentArea, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      let p = node.parentNode;
      while (p && p !== contentArea) {
        const tag = p.nodeName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('search-match')) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    let found = false;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) { pattern.lastIndex++; continue; }
      found = true;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = match[0];
      frag.appendChild(mark);
      last = match.index + match[0].length;
    }
    if (found) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
}

function refreshContentSearchHighlights() {
  clearContentSearchHighlights();
  const q = normalizeText(state.searchQuery || '').toLowerCase();
  if (q.length < SEARCH_MIN_QUERY_LENGTH) return;
  const terms = q.split(' ').filter(Boolean);
  if (terms.length === 0) return;
  highlightTermsInContent(terms);
}

function scrollToHref(href, chapters, fallbackChapterId = null) {
  const targetHref = href || '';
  const baseHref = targetHref.split('#')[0];
  const fragment = targetHref.includes('#') ? targetHref.split('#')[1] : null;

  let matchChapter = baseHref ? findChapterByHref(chapters, baseHref) : null;
  if (!matchChapter && fallbackChapterId) {
    matchChapter = (chapters || []).find(ch => ch.id === fallbackChapterId);
  }

  let scrolled = false;
  if (matchChapter) {
    const section = contentArea.querySelector('#chapter-' + CSS.escape(matchChapter.id));
    if (section) {
      if (fragment) {
        const target = section.querySelector('#' + CSS.escape(fragment));
        if (target) {
          target.scrollIntoView({ behavior: 'instant' });
          scrolled = true;
        }
      }
      if (!scrolled) {
        section.scrollIntoView({ behavior: 'instant' });
        scrolled = true;
      }
    }
  }

  if (!scrolled && fragment) {
    const target = contentArea.querySelector('#' + CSS.escape(fragment));
    if (target) {
      target.scrollIntoView({ behavior: 'instant' });
      scrolled = true;
    }
  }

  return scrolled;
}

/** The top bar names the book being read; empty when no book is open. */
function renderActiveBookTitle() {
  const book = state.openBooks.find(b => b.filePath === state.activeBookPath);
  activeBookTitle.textContent = book?.title || '';
}

async function renderContent() {
  destroyActivePdfMount();
  releaseInactivePdf();
  contentArea.querySelectorAll('.book-content').forEach(el => el.remove());
  renderActiveBookTitle();
  const isStartupRender = getAppLayout()?.classList.contains('app-starting');

  if (state.activeBookPath) {
    emptyState.style.display = 'none';
    const book = state.openBooks.find(b => b.filePath === state.activeBookPath);
    if (book) {
      // Load content if not cached
      if (!state.bookContent[book.filePath]) {
        const div = document.createElement('div');
        div.className = 'book-content active';
        div.textContent = 'Loading…';
        contentArea.appendChild(div);
        try {
          state.bookContent[book.filePath] = isPdfPath(book.filePath)
            ? await (await getPdfModule()).loadPdfBook(book.filePath)
            : await window.epub.parse(book.filePath);
          migrateHighlightsToPublicationId(book.filePath);
        } catch (err) {
          div.textContent = 'Failed to load book: ' + err.message;
          if (isStartupRender) finishAppStartup();
          return;
        }
        div.remove();
      }

      const data = state.bookContent[book.filePath];
      const isPdf = data.kind === 'pdf';
      if (isPdf) livePdfPath = book.filePath;
      notifyBookKind(isPdf ? 'pdf' : 'book');
      let needsTabsRefresh = false;
      // Update title from metadata if available
      if (data.title && book.title !== data.title) {
        book.title = data.title;
        if (isStandaloneReader) document.title = `${data.title} — Gull`;
        renderActiveBookTitle();
        needsTabsRefresh = true;
      }
      if (needsTabsRefresh) {
        renderTabs();
        saveReaderState();
      }

      const div = document.createElement('div');
      div.className = isPdf ? 'book-content active pdf-book' : 'book-content active';
      if (data.language) {
        div.setAttribute('lang', data.language);
      }
      div.style.opacity = '0';
      if (!isStartupRender) {
        div.style.transition = 'opacity 0.15s ease-in-out';
      }
      isRestoringBook = true;

      // Collect and deduplicate chapter CSS, scoped to .book-content
      const seenCss = new Set();
      const scopedStyles = [];
      data.chapters.forEach((ch) => {
        if (ch.css && ch.css.trim() && !seenCss.has(ch.css)) {
          seenCss.add(ch.css);
          scopedStyles.push(ch.css);
        }
      });
      if (scopedStyles.length > 0) {
        const styleEl = document.createElement('style');
        // Scope all selectors under .book-content so they don't leak
        const scoped = scopedStyles.join('\n').replace(
          /([^\s@{}][^{}]*?)\{/g,
          (match, selector) => {
            // Don't scope @-rules
            if (selector.trim().startsWith('@')) return match;
            const parts = selector.split(',').map(s =>
              `.book-content ${s.trim()}`
            ).join(', ');
            return `${parts} {`;
          }
        );
        styleEl.textContent = scoped;
        div.appendChild(styleEl);
      }

      // Batched chapter DOM insertion
      contentArea.appendChild(div);
      const searchToRun = !state.bookSearchIndex[book.filePath];
      renderOutline(data.toc, data.chapters);
      if (!searchToRun) {
        renderSearchResults();
      } else if (isPdf) {
        indexPdfForSearch(book.filePath, data);
      } else {
        indexBookForSearch(book.filePath, data.chapters, data.toc);
      }

      let chapterIdx = 0;
      function processChapterBatch() {
        if (state.activeBookPath !== book.filePath) {
          isRestoringBook = false;
          return;
        }

        const start = performance.now();
        while (chapterIdx < data.chapters.length && performance.now() - start < 15) {
          const ch = data.chapters[chapterIdx];
          const section = document.createElement('section');
          section.className = 'gull-chapter';
          section.id = 'chapter-' + ch.id;
          section.innerHTML = ch.html;
          if (!isPdf) {
            stripEpubFonts(section);
            bindImageFallback(section);
            hideFootnoteAsides(section);
            // A PDF page gets its highlights once its text layer exists.
            applyHighlightsToChapter(ch.id, section);
          }
          div.appendChild(section);
          if (!isPdf && chapterIdx < data.chapters.length - 1) {
            div.appendChild(document.createElement('hr'));
          }
          chapterIdx++;
        }

        if (chapterIdx < data.chapters.length) {
          requestAnimationFrame(processChapterBatch);
        } else {
          if (isPdf) mountPdfBook(book.filePath, div);
          initOutlineScrollTracking(data.chapters);
          initChapterScrollbar(
            isPdf && data.toc.length === 0 ? samplePdfChapters(data.chapters) : data.chapters,
            data.toc
          );

          // Restore position instantly before showing
          if (book.position) {
            if (book.position.progress !== undefined) {
              const maxScroll = contentArea.scrollHeight - contentArea.clientHeight;
              contentArea.scrollTop = maxScroll * book.position.progress;
            } else if (book.position.scrollTop !== undefined) {
              contentArea.scrollTop = book.position.scrollTop;
            }
          }

          div.style.opacity = '1';
          if (isStartupRender) finishAppStartup();
          refreshContentSearchHighlights();
          setTimeout(() => { isRestoringBook = false; }, 100);
        }
      }

      requestAnimationFrame(processChapterBatch);
    }
  } else {
    notifyBookKind(null);
    emptyState.style.display = '';
    renderOutline([], []);
    searchPanel.innerHTML = '';
    renderSearchResults();
    initChapterScrollbar([]);
    renderHighlights();
    if (isStartupRender) finishAppStartup();
  }
}

// --- Highlights ---
function getSelectionOffsets(root) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);

  // Ensure selection is within the root
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const preSelectionRange = range.cloneRange();
  preSelectionRange.selectNodeContents(root);
  preSelectionRange.setEnd(range.startContainer, range.startOffset);
  const start = preSelectionRange.toString().length;

  return {
    start,
    end: start + range.toString().length,
    text: range.toString()
  };
}

function applyHighlightsToChapter(chapterId, container) {
  if (!state.activeBookPath) return;
  const storageKey = getHighlightStorageKey();
  const bookHighlights = state.highlights[storageKey] || [];
  const chapterHighlights = bookHighlights.filter(h => h.chapterId === chapterId);

  const mergedChapter = mergeOverlappingHighlights(chapterHighlights, () => container.textContent);
  if (mergedChapter.length !== chapterHighlights.length) {
    state.highlights[storageKey] = [
      ...bookHighlights.filter(h => h.chapterId !== chapterId),
      ...mergedChapter
    ];
    saveHighlights();
  }

  let relocated = false;
  mergedChapter.forEach(h => {
    const resolved = resolveHighlightOffsets(container.textContent, h);
    if (!resolved) return;
    if (resolved.start !== h.start || resolved.end !== h.end) {
      h.start = resolved.start;
      h.end = resolved.end;
      relocated = true;
    }
    wrapHighlight(container, h.start, h.end, h.id);
  });
  if (relocated) saveHighlights();
}


function wrapHighlight(root, startOffset, endOffset, id) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  let currentOffset = 0;
  const nodesToWrap = [];

  let node;
  while ((node = walker.nextNode())) {
    const nodeLength = node.textContent.length;
    const nodeEndOffset = currentOffset + nodeLength;

    if (nodeEndOffset > startOffset && currentOffset < endOffset) {
      nodesToWrap.push({
        node,
        start: Math.max(0, startOffset - currentOffset),
        end: Math.min(nodeLength, endOffset - currentOffset)
      });
    }

    currentOffset = nodeEndOffset;
    if (currentOffset >= endOffset) break;
  }

  for (let i = nodesToWrap.length - 1; i >= 0; i--) {
    const { node, start, end } = nodesToWrap[i];
    try {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const mark = document.createElement('mark');
      mark.className = 'reader-highlight';
      mark.dataset.highlightId = id;
      range.surroundContents(mark);
    } catch (e) {
      console.warn('Failed to wrap highlight', e);
    }
  }
}

function renderHighlights() {
  highlightsPanel.innerHTML = '';
  if (!state.activeBookPath) {
    highlightsPanel.innerHTML = '<div class="search-empty">Open a book to see highlights.</div>';
    return;
  }

  const bookHighlights = state.highlights[getHighlightStorageKey()] || [];
  if (bookHighlights.length === 0) {
    highlightsPanel.innerHTML = '<div class="search-empty">No highlights yet. Select text to highlight.</div>';
    return;
  }

  // Sort by createdAt desc
  [...bookHighlights].sort((a, b) => b.createdAt - a.createdAt).forEach(h => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.dataset.id = h.id;
    item.innerHTML = `
      <button type="button" class="highlight-open" aria-label="Go to highlighted text">
        <span class="highlight-content">
          <span class="highlight-text">"${escapeHtml(h.text)}"</span>
          <span class="highlight-meta">${new Date(h.createdAt).toLocaleString()}</span>
        </span>
      </button>
      <button type="button" class="highlight-delete" title="Delete Highlight"
        aria-label="Delete highlight" data-delete-id="${h.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
        </svg>
      </button>
    `;

    item.querySelector('.highlight-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      removeHighlight(h.id);
    });

    item.querySelector('.highlight-open').addEventListener('click', () => {
      const data = state.bookContent[state.activeBookPath];
      if (data) {
        const scrolled = scrollToHref('', data.chapters, h.chapterId);
        if (scrolled) {
          // Precisely scroll to the mark if possible
          const mark = document.querySelector(`.reader-highlight[data-highlight-id="${h.id}"]`);
          if (mark) {
            mark.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Flash effect
            mark.style.transition = 'none';
            mark.style.backgroundColor = 'rgba(255, 230, 0, 0.8)';
            setTimeout(() => {
              mark.style.transition = 'background-color 0.5s';
              mark.style.backgroundColor = '';
            }, 500);
          }
        }
      }
    });
    highlightsPanel.appendChild(item);
  });
}

function addHighlight() {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return;

  const range = selection.getRangeAt(0);
  const chapterSection = range.startContainer.parentElement.closest('section.gull-chapter');
  if (!chapterSection) return;

  const chapterId = chapterSection.id.replace('chapter-', '');
  const offsets = getSelectionOffsets(chapterSection);
  if (!offsets || offsets.start === offsets.end) return;

  const storageKey = getHighlightStorageKey();
  const bookHighlights = state.highlights[storageKey] || [];
  const candidate = { chapterId, start: offsets.start, end: offsets.end };
  const overlapping = bookHighlights.filter(h => isOverlappingHighlight(h, candidate));

  let start = offsets.start;
  let end = offsets.end;
  let latestCreatedAt = Date.now();

  overlapping.forEach(h => {
    if (h.start < start) start = h.start;
    if (h.end > end) end = h.end;
    if (h.createdAt > latestCreatedAt) latestCreatedAt = h.createdAt;
  });

  overlapping.forEach(h => removeHighlight(h.id));

  const text = chapterSection.textContent.slice(start, end);
  const id = crypto.randomUUID();
  const highlight = {
    id,
    chapterId,
    start,
    end,
    text,
    prefix: chapterSection.textContent.slice(
      Math.max(0, start - HIGHLIGHT_CONTEXT_LENGTH),
      start
    ),
    suffix: chapterSection.textContent.slice(
      end,
      end + HIGHLIGHT_CONTEXT_LENGTH
    ),
    createdAt: latestCreatedAt
  };

  if (!state.highlights[storageKey]) {
    state.highlights[storageKey] = [];
  }
  state.highlights[storageKey].push(highlight);

  wrapHighlight(chapterSection, highlight.start, highlight.end, highlight.id);
  selection.removeAllRanges();
  hideSelectionPopup();
  saveHighlights();
  if (state.sidebarMode === 'highlights') renderHighlights();
}

function removeHighlight(id) {
  if (!state.activeBookPath) return;
  const bookHighlights = state.highlights[getHighlightStorageKey()] || [];
  const idx = bookHighlights.findIndex(h => h.id === id);
  if (idx === -1) return;

  const h = bookHighlights[idx];
  bookHighlights.splice(idx, 1);
  saveHighlights();

  // Remove the <mark> tags
  document.querySelectorAll(`.reader-highlight[data-highlight-id="${id}"]`).forEach(mark => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });

  if (state.sidebarMode === 'highlights') renderHighlights();
  hideSelectionPopup();
}

function saveHighlights() {
  localStorage.setItem('gull-highlights', JSON.stringify(state.highlights));
}

function loadHighlights() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-highlights'));
    if (saved) state.highlights = saved;
  } catch (e) {
    console.warn('Failed to load highlights', e);
  }
}

let selectionPopupAnchor = null;
let selectionPopupPositionFrame = null;

function hideSelectionPopup() {
  selectionPopup.hidden = true;
  selectionPopupAnchor = null;
  if (selectionPopupPositionFrame !== null) {
    cancelAnimationFrame(selectionPopupPositionFrame);
    selectionPopupPositionFrame = null;
  }
}

function getSelectionPopupAnchorRect() {
  if (!selectionPopupAnchor) return null;

  if (selectionPopupAnchor.type === 'element') {
    const { element } = selectionPopupAnchor;
    return element.isConnected ? element.getBoundingClientRect() : null;
  }

  const { range } = selectionPopupAnchor;
  const container = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  return container?.isConnected ? range.getBoundingClientRect() : null;
}

function positionSelectionPopup() {
  if (selectionPopup.hidden) return;

  const targetRect = getSelectionPopupAnchorRect();
  if (!targetRect || (targetRect.width === 0 && targetRect.height === 0)) {
    hideSelectionPopup();
    return;
  }

  selectionPopup.style.top = (targetRect.top - selectionPopup.offsetHeight - 8) + 'px';
  selectionPopup.style.left = (targetRect.left + targetRect.width / 2) + 'px';
}

function scheduleSelectionPopupPosition() {
  if (selectionPopup.hidden || selectionPopupPositionFrame !== null) return;

  selectionPopupPositionFrame = requestAnimationFrame(() => {
    selectionPopupPositionFrame = null;
    positionSelectionPopup();
  });
}

document.addEventListener('mouseup', (e) => {
  // Use a small timeout to ensure the selection is finalized
  setTimeout(() => handleSelectionChange(e.target), 20);
});

document.addEventListener('selectionchange', () => {
  // Hide popup while selecting or if selection is cleared
  selectionPopup.hidden = true;
});

function handleSelectionChange(targetEl) {
  const selection = window.getSelection();
  const isCollapsed = !selection.rangeCount || selection.isCollapsed;
  const markEl = targetEl?.closest?.('mark.reader-highlight');

  if (isCollapsed && !markEl) {
    hideSelectionPopup();
    return;
  }

  const range = selection.getRangeAt(0);
  const chapterSection = range.startContainer.parentElement?.closest('section.gull-chapter');
  if (!chapterSection) {
    hideSelectionPopup();
    return;
  }

  let existing = null;

  if (isCollapsed && markEl) {
    const id = markEl.dataset.highlightId;
    existing = (state.highlights[getHighlightStorageKey()] || []).find(h => h.id === id);
    selectionPopupAnchor = { type: 'element', element: markEl };
  } else {
    // Check if selection is already a highlight
    const offsets = getSelectionOffsets(chapterSection);
    if (!offsets || offsets.start === offsets.end) {
      hideSelectionPopup();
      return;
    }
    existing = (state.highlights[getHighlightStorageKey()] || []).find(h =>
      h.chapterId === chapterSection.id.replace('chapter-', '') &&
      Math.abs(h.start - offsets.start) < 2 &&
      Math.abs(h.end - offsets.end) < 2
    );
    selectionPopupAnchor = { type: 'range', range: range.cloneRange() };
  }


  const selectionPopupLabel = selectionPopup.querySelector('.selection-popup-label');
  if (existing) {
    selectionPopupLabel.textContent = 'Remove Highlight';
    selectionPopup.setAttribute('aria-label', 'Remove Highlight');
    selectionPopup.onclick = () => removeHighlight(existing.id);
  } else {
    selectionPopupLabel.textContent = 'Highlight';
    selectionPopup.setAttribute('aria-label', 'Highlight');
    selectionPopup.onclick = () => addHighlight();
  }

  selectionPopup.hidden = false;
  positionSelectionPopup();
}

contentArea.addEventListener('scroll', scheduleSelectionPopupPosition, { passive: true });
window.addEventListener('resize', scheduleSelectionPopupPosition);
new ResizeObserver(scheduleSelectionPopupPosition).observe(contentArea);

function stripEpubFonts(container) {
  // CSS is already filtered in main process; just ensure no font-family leaks through
  container.querySelectorAll('[style]').forEach(el => {
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const isDropCap = cls.includes('dropcap') || cls.includes('drop-cap');
    if (!isDropCap) {
      if (el.style.fontFamily) el.style.fontFamily = '';
      if (el.style.fontSize) el.style.fontSize = '';
    }
  });
}

function hideFootnoteAsides(container) {
  for (const aside of container.querySelectorAll('aside')) {
    const t = aside.getAttribute('epub:type');
    if (t === 'footnote' || t === 'rearnote' || t === 'endnote') {
      aside.style.display = 'none';
    }
  }
}

function bindImageFallback(container) {
  const svgImages = container.querySelectorAll('svg image');
  for (const svgImg of svgImages) {
    const svg = svgImg.closest('svg');
    // Previously we were hiding these, which prevented covers from showing.
    // Now we ensure they are visible and have reasonable defaults.
    if (svg) {
      svg.style.display = 'block';
      svg.style.maxWidth = '100%';
      svg.style.height = 'auto';
    }
  }

  const imgs = container.querySelectorAll('img');
  for (const img of imgs) {
    const markMissing = () => {
      img.classList.remove('image-loaded');
      img.classList.add('image-missing');
    };
    const markLoaded = () => {
      img.classList.remove('image-missing');
      img.classList.add('image-loaded');
    };

    img.classList.remove('image-loaded');
    img.classList.remove('image-missing');

    img.addEventListener('error', markMissing);
    img.addEventListener('load', markLoaded);

    const src = img.getAttribute('src');
    if (!src) {
      markMissing();
      continue;
    }

    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else markMissing();
    }
  }
}

// --- Chapter Progress Scrollbar ---
let chapterScrollCleanup = null;

function initChapterScrollbar(chapters, toc) {
  if (chapterScrollCleanup) {
    chapterScrollCleanup();
    chapterScrollCleanup = null;
  }

  const bar = document.getElementById('chapter-scrollbar');
  bar.innerHTML = '';

  if (!chapters || chapters.length === 0) return;

  // Build a chapter-href -> title map from ToC (top-level only)
  const titleMap = {};
  function flattenToc(items) {
    for (const item of items) {
      const baseHref = (item.href || '').split('#')[0];
      const file = baseHref.split('/').pop();
      if (file && !titleMap[file]) titleMap[file] = item.title;
      if (item.children) flattenToc(item.children);
    }
  }
  if (toc) flattenToc(toc);

  const chapterCache = new Map();
  const sectionCache = new Map();

  function resolveHrefTarget(href) {
    const targetHref = href || '';
    const baseHref = targetHref.split('#')[0];
    const fragment = targetHref.includes('#') ? targetHref.split('#')[1] : null;

    let ch = chapterCache.get(baseHref);
    if (ch === undefined) {
      ch = findChapterByHref(chapters, baseHref);
      chapterCache.set(baseHref, ch);
    }
    if (!ch) return null;

    let section = sectionCache.get(ch.id);
    if (section === undefined) {
      section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
      sectionCache.set(ch.id, section);
    }
    if (!section) return null;

    if (fragment) {
      const fragEl = section.querySelector('#' + CSS.escape(fragment));
      if (fragEl) {
        return { chapterId: ch.id, target: fragEl };
      }
    }

    return { chapterId: ch.id, target: section };
  }

  // Build entries from rendered ToC items so indicator count matches visible ToC count.
  const tocEntries = [];
  const outlineItems = document.querySelectorAll('.outline-item');
  for (const item of outlineItems) {
    const href = item.dataset.href || '';
    const resolved = resolveHrefTarget(href);
    if (!resolved) continue;
    tocEntries.push({
      chapterId: resolved.chapterId,
      target: resolved.target,
      title: item.textContent || '',
    });
  }

  // Fallback to chapter-level indicators if no ToC target could be resolved.
  const sourceEntries = tocEntries.length > 0
    ? tocEntries
    : chapters.map(ch => {
      const section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
      const chFile = ch.href.split('/').pop();
      return {
        chapterId: ch.id,
        target: section,
        title: titleMap[chFile] || '',
      };
    }).filter(entry => !!entry.target);

  if (sourceEntries.length === 0) return;

  // Build segment elements
  const segments = [];
  for (const entry of sourceEntries) {
    const seg = document.createElement('div');
    seg.className = 'ch-scroll-segment';
    const fill = document.createElement('div');
    fill.className = 'ch-scroll-fill';
    seg.appendChild(fill);
    bar.appendChild(seg);

    segments.push({
      chapterId: entry.chapterId,
      target: entry.target,
      seg,
      fill,
      title: entry.title,
    });
  }

  // Tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'ch-scroll-tooltip';
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  function computeMeasures() {
    const measures = [];
    const contentRect = contentArea.getBoundingClientRect();
    const contentScrollTop = contentArea.scrollTop;
    for (const s of segments) {
      if (!s.target) continue;
      const targetRect = s.target.getBoundingClientRect();
      measures.push({ ...s, top: targetRect.top - contentRect.top + contentScrollTop });
    }
    if (measures.length === 0) return [];

    // Sort by document position so heights are computed correctly even when
    // the TOC order doesn't match the physical chapter order (common in
    // multi-book EPUB collections).
    measures.sort((a, b) => a.top - b.top);

    for (let i = 0; i < measures.length; i++) {
      const start = measures[i].top;
      const end = i < measures.length - 1
        ? measures[i + 1].top
        : contentArea.scrollHeight;
      const height = Math.max(1, end - start);
      measures[i].height = height;
    }
    return measures;
  }

  let cachedMeasures = null;
  const invalidateScrollbar = () => {
    cachedMeasures = null;
    requestAnimationFrame(update);
  };
  const throttledInvalidateScrollbar = throttle(invalidateScrollbar, 100);
  const ro = new ResizeObserver(throttledInvalidateScrollbar);
  ro.observe(contentArea);
  contentArea.addEventListener('force-update-scrollbar', invalidateScrollbar);

  let updating = false;
  const MIN_SEGMENT_PX = 2;

  function update() {
    if (updating) return;
    updating = true;
    requestAnimationFrame(() => {
      updating = false;
      const scrollTop = contentArea.scrollTop;
      const viewportH = contentArea.clientHeight;

      let gap = 3;
      if (segments.length * 6 + segments.length * gap > bar.clientHeight) gap = 1;
      if (segments.length * 3 + segments.length * gap > bar.clientHeight) gap = 0;
      bar.style.gap = gap + 'px';

      const barH = bar.clientHeight - (segments.length - 1) * gap;

      if (!cachedMeasures) cachedMeasures = computeMeasures();
      const measures = cachedMeasures;
      if (measures.length === 0) return;

      const totalH = measures.reduce((sum, m) => sum + m.height, 0);

      // First pass: compute proportional heights and identify segments
      // that need to be bumped up to the minimum visible size.
      const rawHeights = measures.map(m => (m.height / totalH) * barH);
      let deficit = 0;
      let flexTotal = 0;
      for (let i = 0; i < rawHeights.length; i++) {
        if (rawHeights[i] < MIN_SEGMENT_PX) {
          deficit += MIN_SEGMENT_PX - rawHeights[i];
          rawHeights[i] = MIN_SEGMENT_PX;
        } else {
          flexTotal += rawHeights[i];
        }
      }
      // Shrink larger segments proportionally to pay for the deficit.
      if (deficit > 0 && flexTotal > 0) {
        const scale = (flexTotal - deficit) / flexTotal;
        for (let i = 0; i < rawHeights.length; i++) {
          if (rawHeights[i] > MIN_SEGMENT_PX) {
            rawHeights[i] *= scale;
          }
        }
      }

      const viewportEnd = scrollTop + viewportH;
      for (let i = 0; i < measures.length; i++) {
        const m = measures[i];
        const segH = rawHeights[i];
        m.seg.style.height = segH + 'px';

        let fillRatio = 0;
        if (viewportEnd >= m.top + m.height) {
          fillRatio = 1;
        } else if (viewportEnd > m.top) {
          fillRatio = (viewportEnd - m.top) / m.height;
        }

        fillRatio = Math.max(0, Math.min(1, fillRatio));
        // Use pixel height instead of percentage to avoid sub-pixel
        // rounding artifacts when the segment is very small.
        m.fill.style.height = (fillRatio * segH) + 'px';
      }
    });
  }

  // Hover tooltip
  bar.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.ch-scroll-segment');
    if (!target) { tooltip.style.display = 'none'; return; }

    const seg = segments.find(s => s.seg === target);
    if (!seg || !seg.title) { tooltip.style.display = 'none'; return; }

    tooltip.textContent = seg.title;
    tooltip.style.display = '';
    const barRect = bar.getBoundingClientRect();
    tooltip.style.right = (window.innerWidth - barRect.left + 8) + 'px';
    tooltip.style.top = e.clientY + 'px';
  });

  bar.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  // Click to jump
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = e.target.closest('.ch-scroll-segment');
    if (!target) return;

    if (!cachedMeasures) cachedMeasures = computeMeasures();
    const measures = cachedMeasures;
    const measure = measures.find(m => m.seg === target);
    if (!measure) return;

    const segRect = target.getBoundingClientRect();
    const within = Math.max(0, Math.min(1, (e.clientY - segRect.top) / segRect.height));
    const desiredTop = measure.top + measure.height * within;
    const maxTop = Math.max(0, contentArea.scrollHeight - contentArea.clientHeight);
    contentArea.scrollTop = Math.max(0, Math.min(maxTop, desiredTop));
  });

  contentArea.addEventListener('scroll', update);
  chapterScrollCleanup = () => {
    ro.disconnect();
    contentArea.removeEventListener('force-update-scrollbar', invalidateScrollbar);
    contentArea.removeEventListener('scroll', update);
    tooltip.remove();
  };

  requestAnimationFrame(() => requestAnimationFrame(update));
}

let activeOutlineItem = null;
function setActiveOutlineItem(el) {
  if (activeOutlineItem === el) return;
  if (activeOutlineItem) {
    activeOutlineItem.classList.remove('active');
  } else {
    document.querySelectorAll('.outline-item.active').forEach(item => item.classList.remove('active'));
  }
  if (el) el.classList.add('active');
  activeOutlineItem = el;
}

// Track scroll position to highlight current ToC item
let scrollTrackingCleanup = null;

function initOutlineScrollTracking(chapters) {
  // Clean up previous listener
  if (scrollTrackingCleanup) {
    scrollTrackingCleanup();
    scrollTrackingCleanup = null;
  }

  if (!chapters || chapters.length === 0) return;

  // Build a list of { outlineEl, scrollTarget } for each ToC item
  function buildTocTargets() {
    const targets = [];
    const items = document.querySelectorAll('.outline-item');
    const chapterCache = new Map();
    const sectionCache = new Map();
    for (const item of items) {
      const href = item.dataset.href || '';
      const baseHref = href.split('#')[0];
      const fragment = href.includes('#') ? href.split('#')[1] : null;

      // Find matching chapter
      let ch = chapterCache.get(baseHref);
      if (ch === undefined) {
        ch = findChapterByHref(chapters, baseHref);
        chapterCache.set(baseHref, ch);
      }

      if (ch) {
        let section = sectionCache.get(ch.id);
        if (section === undefined) {
          section = contentArea.querySelector('#chapter-' + CSS.escape(ch.id));
          sectionCache.set(ch.id, section);
        }
        if (section) {
          let target = section;
          if (fragment) {
            const fragEl = section.querySelector('#' + CSS.escape(fragment));
            if (fragEl) target = fragEl;
          }
          targets.push({ el: item, target });
        }
      }
    }
    return targets;
  }

  let cachedTargets = null;
  const invalidateOutline = () => {
    requestAnimationFrame(onScroll);
  };
  const throttledInvalidateOutline = throttle(invalidateOutline, 100);
  const ro = new ResizeObserver(throttledInvalidateOutline);
  ro.observe(contentArea);
  contentArea.addEventListener('force-update-scrollbar', invalidateOutline);

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!cachedTargets) cachedTargets = buildTocTargets();
      const targets = cachedTargets;
      if (targets.length === 0) return;

      const scrollTop = contentArea.scrollTop;
      const offset = 60;

      let active = targets[0].el;
      for (const { el, target } of targets) {
        if (target.offsetTop <= scrollTop + offset) {
          active = el;
        }
      }
      setActiveOutlineItem(active);
    });
  };

  contentArea.addEventListener('scroll', onScroll);
  scrollTrackingCleanup = () => {
    ro.disconnect();
    contentArea.removeEventListener('force-update-scrollbar', invalidateOutline);
    contentArea.removeEventListener('scroll', onScroll);
  };

  // Set initial highlight
  onScroll();
}

function renderOutline(toc, chapters) {
  outlinePanel.innerHTML = '';
  activeOutlineItem = null;
  if (!toc || toc.length === 0) return;

  function addItems(items, level) {
    for (const item of items) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'outline-item level-' + level;
      div.textContent = item.title;
      div.dataset.href = item.href || '';
      div.addEventListener('click', () => {
        const scrolled = scrollToHref(item.href || '', chapters);
        if (scrolled) setActiveOutlineItem(div);
      });
      outlinePanel.appendChild(div);
      if (item.children && item.children.length > 0) {
        addItems(item.children, Math.min(level + 1, 3));
      }
    }
  }

  addItems(toc, 1);
}

// --- Resize Handle ---
function initResize() {
  const saved = loadSidebarWidths();
  if (saved.left) document.documentElement.style.setProperty('--left-sidebar-width', saved.left + 'px');
  if (saved.right) document.documentElement.style.setProperty('--right-sidebar-width', saved.right + 'px');

  setupHandle('resize-left', '--left-sidebar-width', 'left');
  setupHandle('resize-right', '--right-sidebar-width', 'right');
}

function setupHandle(handleId, cssVar, side) {
  const handle = document.getElementById(handleId);
  let startX, startWidth;

  const applyWidth = (width) => {
    const nextWidth = Math.max(250, Math.min(500, width));
    document.documentElement.style.setProperty(cssVar, nextWidth + 'px');
    handle.setAttribute('aria-valuenow', String(nextWidth));
    contentArea.dispatchEvent(new CustomEvent('force-update-scrollbar'));
  };

  const initialWidth = parseInt(
    getComputedStyle(document.documentElement).getPropertyValue(cssVar),
    10
  );
  handle.setAttribute('aria-valuenow', String(initialWidth));

  handle.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(cssVar),
      10
    );
    const step = e.shiftKey ? 25 : 10;
    let next = current;
    if (e.key === 'Home') next = 250;
    if (e.key === 'End') next = 500;
    if (e.key === 'ArrowLeft') next += side === 'right' ? step : -step;
    if (e.key === 'ArrowRight') next += side === 'right' ? -step : step;
    applyWidth(next);
    saveSidebarWidths();
  });

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    const computed = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
    startWidth = parseInt(computed, 10);

    handle.classList.add('active');
    document.body.classList.add('no-select');
    getAppLayout()?.classList.add('resizing');

    // Lock onto the visible chapter to prevent scroll jumping
    const scrollTop = contentArea.scrollTop;
    const chapters = Array.from(contentArea.querySelectorAll('section.gull-chapter'));
    let targetCh = null;
    let targetRatio = 0;

    for (const ch of chapters) {
      if (ch.offsetTop + ch.offsetHeight > scrollTop) {
        targetCh = ch;
        targetRatio = Math.max(0, scrollTop - ch.offsetTop) / (ch.offsetHeight || 1);
        break;
      }
    }

    let isUpdating = false;
    let currentX = e.clientX;

    const updateWidth = () => {
      isUpdating = false;
      const delta = side === 'right' ? startX - currentX : currentX - startX;
      const maxWidth = 500;
      const newWidth = Math.max(250, Math.min(maxWidth, startWidth + delta));
      applyWidth(newWidth);

      if (targetCh) {
        contentArea.scrollTop = targetCh.offsetTop + (targetCh.offsetHeight * targetRatio);
      }

    };

    const onMouseMove = (e) => {
      currentX = e.clientX;
      if (!isUpdating) {
        isUpdating = true;
        requestAnimationFrame(updateWidth);
      }
    };

    const onMouseUp = () => {
      handle.classList.remove('active');
      document.body.classList.remove('no-select');
      getAppLayout()?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      saveSidebarWidths();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function saveSidebarWidths() {
  const left = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-sidebar-width'), 10);
  const right = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--right-sidebar-width'), 10);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ left, right }));
}

function loadSidebarWidths() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSidebarStates() {
  const layout = getAppLayout();
  if (!layout) return;
  const leftHidden = isStandaloneReader
    ? !!window.initialSettings?.sidebarStates?.leftHidden
    : layout.classList.contains('left-sidebar-hidden');
  const rightHidden = layout.classList.contains('right-sidebar-hidden');
  window.settings?.set('sidebarStates', { leftHidden, rightHidden });
}

function loadSidebarStates() {
  try {
    const saved = window.initialSettings?.sidebarStates;
    if (saved) {
      const layout = getAppLayout();
      if (layout) {
        layout.classList.toggle('left-sidebar-hidden', !!saved.leftHidden);
        layout.classList.toggle('right-sidebar-hidden', !!saved.rightHidden);
      }
    }
  } catch (e) {
    console.error("JS loadSidebarStates Error:", e);
  }
}

// --- Reader State Persistence ---
let isStateLoaded = false;

function saveReaderState() {
  if (!isStateLoaded || isStandaloneReader) return;
  const data = {
    openBooks: [
      ...state.openBooks.map(book => ({
        filePath: book.filePath,
        title: book.title,
        position: book.position,
        pinned: book.pinned === true,
        finished: book.finished === true,
        folderPath: book.folderPath || null,
        createdAt: book.createdAt || 0
      })),
      ...state.offlineBooks
    ],
    folders: state.folders,
    sort: state.sort,
    activeBookPath: state.activeBookPath
  };

  try {
    localStorage.setItem(STORAGE_KEY_BOOKS, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save reader state', e);
  }
}

async function loadReaderState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_BOOKS));
    if (!saved) {
      isStateLoaded = true;
      return;
    }

    // Folders outlive their books: restore them even when no book is left.
    state.folders = normalizeFolders(saved.folders);
    state.sort = normalizeSort(saved.sort);

    if (!saved.openBooks || saved.openBooks.length === 0) {
      isStateLoaded = true;
      renderTabs();
      return;
    }

    // Folder rows are reconciled against the disk by `refreshFolders`, so only
    // ad-hoc opened books need the per-file existence check (which is capped).
    const knownFolderPaths = new Set(state.folders.map(folder => folder.path));
    const isFolderBook = (book) => !!book.folderPath && knownFolderPaths.has(book.folderPath);

    const pathsToCheck = saved.openBooks.filter(b => !isFolderBook(b)).map(b => b.filePath);
    const existenceResults = await window.epub.checkPathsExistence(pathsToCheck);
    const existingFilePaths = new Set(
      existenceResults.filter(r => r.exists).map(r => r.path)
    );

    const validSavedBooks = saved.openBooks.filter(
      b => isFolderBook(b) || existingFilePaths.has(b.filePath)
    );
    state.offlineBooks = saved.openBooks.filter(
      b => !isFolderBook(b) && !existingFilePaths.has(b.filePath)
    );

    // Merge saved books into current state to avoid overwriting books
    // that might have been opened via IPC before loadReaderState ran.
    const currentPaths = new Set(state.openBooks.map(b => b.filePath));
    for (const b of validSavedBooks) {
      if (!currentPaths.has(b.filePath)) {
        state.openBooks.push(b);
      }
    }
    state.openBooks = groupPinnedBooks(state.openBooks);

    const hasCurrentActiveBook = state.openBooks.some(
      book => book.filePath === state.activeBookPath
    );
    if (!hasCurrentActiveBook) {
      const lastOpenedBook = validSavedBooks.find(
        book => book.filePath === saved.activeBookPath
      );
      const firstAvailableBook = validSavedBooks[0] || state.openBooks[0];
      state.activeBookPath = (lastOpenedBook || firstAvailableBook)?.filePath || null;
    }

    isStateLoaded = true;
    renderTabs();

    if (state.activeBookPath) {
      setActiveBook(state.activeBookPath); // Persists all offline books via saveReaderState()
    }
    } catch (e) {
    console.warn('Failed to load reader state', e);
    isStateLoaded = true;
  }
}

let positionSaveTimer = null;
let isRestoringBook = false;

contentArea.addEventListener('scroll', () => {
  if (!state.activeBookPath || isRestoringBook) return;
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    const book = state.openBooks.find(b => b.filePath === state.activeBookPath);
    if (!book) return;

    const scrollTop = contentArea.scrollTop;
    const scrollHeight = contentArea.scrollHeight;
    const clientHeight = contentArea.clientHeight;

    book.position = {
      scrollTop,
      progress: scrollHeight > clientHeight ? scrollTop / (scrollHeight - clientHeight) : 0
    };
    saveReaderState();
  }, 1000);
});

// --- Event Delegation ---
getAppLayout()?.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-book]');
  if (closeBtn) {
    closeBook(closeBtn.dataset.closeBook);
    return;
  }

  const tabItem = e.target.closest('.tab-activate[data-book-path]');
  if (tabItem) {
    setActiveBook(tabItem.dataset.bookPath);
    return;
  }
});

tabBar.addEventListener('keydown', (e) => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...tabBar.querySelectorAll('.tab-activate[data-book-path]')];
  if (tabs.length === 0) return;
  e.preventDefault();
  const current = Math.max(0, tabs.indexOf(document.activeElement));
  const nextIndex = e.key === 'Home' ? 0
    : e.key === 'End' ? tabs.length - 1
    : e.key === 'ArrowUp' ? (current - 1 + tabs.length) % tabs.length
    : (current + 1) % tabs.length;
  setActiveBook(tabs[nextIndex].dataset.bookPath);
  requestAnimationFrame(() => {
    tabBar.querySelector('.tab-activate[aria-selected="true"]')?.focus();
  });
});

document.querySelector('.sidebar-tabs')?.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [sidebarTabToc, sidebarTabHighlights, sidebarTabSearch];
  e.preventDefault();
  const current = Math.max(0, tabs.indexOf(document.activeElement));
  const nextIndex = e.key === 'Home' ? 0
    : e.key === 'End' ? tabs.length - 1
    : e.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
    : (current + 1) % tabs.length;
  const modes = ['toc', 'highlights', 'search'];
  setSidebarMode(modes[nextIndex]);
  tabs[nextIndex].focus();
});

document.getElementById('toggle-left-sidebar').addEventListener('click', () => {
  const layout = getAppLayout();
  if (layout) {
    layout.classList.toggle('left-sidebar-hidden');
    saveSidebarStates();
  }
});

sidebarTabToc.addEventListener('click', () => {
  setSidebarMode('toc');
});

sidebarTabSearch.addEventListener('click', () => {
  setSidebarMode('search');
});

sidebarTabHighlights.addEventListener('click', () => {
  setSidebarMode('highlights');
});

function updateSearchClearVisibility() {
  sidebarSearchClear.hidden = !sidebarSearchInput.value;
}

sidebarSearchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value || '';
  updateSearchClearVisibility();
  if (sidebarSearchTimer) {
    clearTimeout(sidebarSearchTimer);
  }
  sidebarSearchTimer = setTimeout(() => {
    renderSearchResults();
    refreshContentSearchHighlights();
  }, SEARCH_DEBOUNCE_MS);
});

sidebarSearchClear.addEventListener('click', () => {
  state.searchQuery = '';
  sidebarSearchInput.value = '';
  updateSearchClearVisibility();
  renderSearchResults();
  refreshContentSearchHighlights();
  sidebarSearchInput.focus({ preventScroll: true });
});

sidebarSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    state.searchQuery = '';
    sidebarSearchInput.value = '';
    updateSearchClearVisibility();
    renderSearchResults();
    refreshContentSearchHighlights();
    return;
  }

  if (e.key === 'Enter') {
    const first = searchPanel.querySelector('.search-result-item');
    if (first) first.click();
  }
});

searchPanel.addEventListener('click', (e) => {
  const item = e.target.closest('.search-result-item');
  if (!item || !state.activeBookPath) return;

  const data = state.bookContent[state.activeBookPath];
  if (!data) return;

  const chapterId = item.dataset.chapterId || null;
  const href = item.dataset.href || '';
  const matchIndex = parseInt(item.dataset.matchIndex || '0', 10);
  const term = (item.dataset.term || '').toLowerCase();
  const scrolled = scrollToHref(href, data.chapters, chapterId);
  if (!scrolled) return;

  if (chapterId && term) {
    const section = contentArea.querySelector('#chapter-' + CSS.escape(chapterId));
    if (section) {
      const marks = [...section.querySelectorAll('mark.search-match')]
        .filter(m => m.textContent.toLowerCase() === term);
      const target = marks[matchIndex] || marks[0];
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  }

  const targetOutline = [...outlinePanel.querySelectorAll('.outline-item')]
    .find(el => (el.dataset.href || '') === href);

  if (targetOutline) {
    setActiveOutlineItem(targetOutline);
  }
});


// --- Broken image handling ---
function initBrokenImageHandling() {
  contentArea.addEventListener('error', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    target.classList.add('image-missing');
  }, true);

  // Intercept link clicks to prevent navigation and handle internal jumps (footnotes, etc.)
  contentArea.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || !state.activeBookPath) return;

    const href = link.getAttribute('href');
    if (!href) return;

    e.preventDefault();

    if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
      window.epub.openExternal(href).catch((error) => {
        console.warn('Failed to open external link', error);
      });
      return;
    }

    // For epub:type="noteref" links, show footnote popover instead of scrolling
    const epubType = link.getAttribute('epub:type') || link.getAttributeNS('http://www.idpf.org/2007/ops', 'type');
    if (epubType === 'noteref') {
      const img = link.querySelector('img.epub-footnote');
      const footnoteText = img
        ? (img.getAttribute('zy-footnote') || img.getAttribute('alt') || '').trim()
        : '';
      const targetId = href.startsWith('#') ? href.slice(1) : null;
      const asideEl = targetId ? contentArea.querySelector(`#${CSS.escape(targetId)}`) : null;
      const asideText = asideEl ? asideEl.textContent.trim() : '';
      const text = footnoteText || asideText;
      if (text) {
        showFootnotePopover(text, link.closest('sup') || link);
        return;
      }
    }

    const data = state.bookContent[state.activeBookPath];
    if (data) {
      const chapterSection = link.closest('section.gull-chapter');
      const chapterId = chapterSection ? chapterSection.id.replace('chapter-', '') : null;
      scrollToHref(href, data.chapters, chapterId);
    }
  });
}

// --- Footnote Popover ---
const footnotePopover = document.getElementById('footnote-popover');

function showFootnotePopover(text, anchorEl) {
  footnotePopover.textContent = text;
  footnotePopover.hidden = false;

  const anchorRect = anchorEl.getBoundingClientRect();
  const popoverWidth = 360;
  const margin = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Start: centered above the anchor
  let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2;
  left = Math.max(margin, Math.min(left, viewportWidth - popoverWidth - margin));
  footnotePopover.style.left = left + 'px';
  footnotePopover.style.maxWidth = popoverWidth + 'px';

  // Measure height after layout
  const popoverHeight = footnotePopover.offsetHeight;
  let top = anchorRect.top - popoverHeight - 8;
  if (top < margin) top = anchorRect.bottom + 8;
  if (top + popoverHeight > viewportHeight - margin) top = viewportHeight - popoverHeight - margin;
  footnotePopover.style.top = top + 'px';
}

document.addEventListener('mousedown', (e) => {
  if (!footnotePopover.hidden && !footnotePopover.contains(e.target)) {
    footnotePopover.hidden = true;
  }
});

contentArea.addEventListener('scroll', () => {
  if (!footnotePopover.hidden) footnotePopover.hidden = true;
}, { passive: true });

// --- Reading style (initial CSS variable setup; SettingsMenu React component owns updates) ---
const readingStyle = {
  fontFamily: "'Charter', serif",
  fontSize: 16,
  lineHeight: 1.8,
  paraSpacing: 0.6,
};

function loadReadingStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-reading-style'));
    if (saved) Object.assign(readingStyle, saved);
  } catch {}
}

function applyReadingStyle() {
  const root = document.documentElement;
  root.style.setProperty('--book-font-family', readingStyle.fontFamily);
  root.style.setProperty('--book-font-size', readingStyle.fontSize + 'px');
  root.style.setProperty('--book-line-height', String(readingStyle.lineHeight));
  root.style.setProperty('--book-para-spacing', readingStyle.paraSpacing + 'em');
}

async function ensureReadingFontsLoaded() {
  if (!document.fonts?.load) return;

  const sizeAndFamily = `${readingStyle.fontSize}px ${readingStyle.fontFamily}`;
  const variants = [
    sizeAndFamily,
    `italic ${sizeAndFamily}`,
    `600 ${sizeAndFamily}`,
    `italic 600 ${sizeAndFamily}`,
    `700 ${sizeAndFamily}`,
    `italic 700 ${sizeAndFamily}`,
  ];

  try {
    await Promise.all(variants.map(font => document.fonts.load(font)));
    await document.fonts.ready;
  } catch (error) {
    console.warn('Failed to preload reading fonts', error);
  }
}

loadReadingStyle();
applyReadingStyle();

// --- Right Sidebar Toggle ---
document.getElementById('toggle-right-sidebar').addEventListener('click', () => {
  const layout = getAppLayout();
  if (layout) {
    layout.classList.toggle('right-sidebar-hidden');
    saveSidebarStates();
  }
});

// --- File open from main process (Finder double-click, File > Open) ---
let pendingOpenFiles = [];
let pendingOpenTimer = null;

window.epub.onOpenFile((filePath) => {
  const title = filePath.split('/').pop().replace(/\.(epub|mobi|azw3|azw|prc)$/i, '');
  if (isStandaloneReader) {
    state.openBooks = [{ filePath, title }];
    document.title = `${title} — Gull`;
  }
  if (!state.openBooks.find(b => b.filePath === filePath)) {
    state.openBooks.push({ filePath, title });
  }
  pendingOpenFiles.push(filePath);
  if (pendingOpenTimer) clearTimeout(pendingOpenTimer);
  pendingOpenTimer = setTimeout(() => {
    const lastFile = pendingOpenFiles[pendingOpenFiles.length - 1];
    pendingOpenFiles = [];
    pendingOpenTimer = null;
    setActiveBook(lastFile);
    }, 50);
});

// --- Theme ---
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

systemThemeQuery.addEventListener('change', () => {
  applySystemTheme(document.documentElement, systemThemeQuery.matches);
});

function setChapterScrollbar(enabled) {
  const isEnabled = enabled !== false;
  const layout = document.getElementById('app-layout');
  if (layout) {
    layout.classList.toggle('native-scrollbar', !isEnabled);
  }
  document.documentElement.classList.toggle('native-scrollbar', !isEnabled);
}

function setFullWidth(enabled) {
  const isEnabled = enabled === true;
  const layout = document.getElementById('app-layout');
  if (layout) {
    layout.classList.toggle('full-width', isEnabled);
  }
  const contentArea = document.getElementById('content-area');
  if (contentArea) {
    contentArea.dispatchEvent(new Event('force-update-scrollbar'));
  }
}

window.settings.onChapterScrollbarChanged((enabled) => {
  setChapterScrollbar(enabled);
});

window.settings.onSettingsChanged((settings) => {
  if (settings) {
    if (typeof settings.chapterScrollbar !== 'undefined') {
      setChapterScrollbar(settings.chapterScrollbar);
    }
    if (typeof settings.fullWidth !== 'undefined') {
      setFullWidth(settings.fullWidth);
    }
  }
});

function initUpdatePill() {
  const btn = document.getElementById('btn-update');
  if (!btn || !window.updater) return;
  window.updater.onUpdateReady(() => {
    btn.hidden = false;
  });
  btn.addEventListener('click', () => {
    btn.disabled = true;
    window.updater.apply();
  });
}

function initSidebarScrollbars() {
  const scrollableElements = [
    tabBar,
    outlinePanel,
    searchPanel,
    highlightsPanel
  ];

  scrollableElements.forEach(el => {
    if (!el) return;
    let timeoutId;
    el.addEventListener('scroll', () => {
      el.classList.add('is-scrolling');
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        el.classList.remove('is-scrolling');
      }, 800);
    }, { passive: true });
  });
}



// Init
async function initApp() {
  const settings = window.initialSettings || {};

  loadHighlights();
  setSidebarMode('toc');

  // Apply every layout input before restoring a book. renderContent measures
  // and restores scroll position against this final viewport.
  initResize();
  if (!isStandaloneReader) loadSidebarStates();
  setChapterScrollbar(settings.chapterScrollbar !== false);
  setFullWidth(settings.fullWidth === true);
  applySystemTheme(document.documentElement, systemThemeQuery.matches);

  initSidebarFolders();
  initBrokenImageHandling();
  initUpdatePill();
  initSidebarScrollbars();

  await ensureReadingFontsLoaded();
  if (isStandaloneReader) {
    window.epub.signalReady();
    return;
  }

  await loadReaderState();
  await refreshFolders();

  if (!state.activeBookPath) await renderContent();

  window.epub.signalReady();
}

initApp();
