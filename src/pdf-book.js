// PDF support for the reader.
//
// PDFs are fixed-layout, so none of the EPUB reflow machinery applies to them.
// What this module does instead is present a PDF *as if* it were a book with
// one chapter per page: `loadPdfBook` returns the same `{title, chapters, toc}`
// payload `window.epub.parse` returns, with each chapter holding an empty page
// placeholder. `mountPdfPages` then fills the placeholders that scroll into
// view with a canvas plus a pdf.js text layer, so tabs, the ToC, search,
// highlights, and the chapter scrollbar keep working unchanged.
//
// pdf.js and its worker are only loaded once a PDF is actually opened.

// pdf.js 6 calls Math.sumPrecise, which Chromium has not shipped yet.
import './lib/math-sum-precise.mjs';
import {
  buildPdfChapters,
  buildPdfToc,
  cleanPdfTitle,
  computePageLayout,
  normalizePdfView,
} from './lib/pdf-view.mjs';

// How many pages keep a canvas + text layer. Everything else falls back to a
// sized placeholder, so scroll height stays stable while memory does not grow
// with the page count.
const MAX_LIVE_PAGES = 8;
// Render a screen ahead of the viewport so scrolling rarely lands on a blank page.
const PAGE_ROOT_MARGIN = '150%';
const MAX_OUTLINE_ITEMS = 2000;

const books = new Map(); // filePath -> { session, payload, mount }
let pdfjsPromise = null;

async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist/build/pdf.min.mjs');
      // The renderer is loaded from file:// in production, where a worker can
      // not be fetched by URL; Vite inlines this one as a blob instead.
      const { default: PdfWorker } = await import('./pdf-worker-entry.js?worker&inline');
      return { pdfjs, PdfWorker };
    })().catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

// pdf.js fetches its image decoders (wasm), standard fonts, CMaps, and ICC
// profiles at runtime. Vite serves them from `/pdfjs/` in dev and copies them
// next to the bundle for the packaged app, so this resolves in both.
const pdfjsAssetUrl = name => new URL(`./pdfjs/${name}/`, document.baseURI).href;

/**
 * Every document gets its own worker. pdf.js caches workers by port, and
 * tearing one document down un-caches that port — with a shared worker that
 * would break whichever book is still open in another tab.
 */
async function openDocument(filePath) {
  const { pdfjs, PdfWorker } = await getPdfjs();
  const bytes = await window.epub.readBookFile(filePath);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const thread = new PdfWorker();
  const worker = new pdfjs.PDFWorker({ port: thread });
  const session = { thread, worker, loadingTask: null, doc: null };
  try {
    const loadingTask = pdfjs.getDocument({
      data,
      worker,
      // Without these a JPEG 2000 or JBIG2 scan renders as a blank page, and a
      // book relying on non-embedded fonts renders with the wrong metrics.
      wasmUrl: pdfjsAssetUrl('wasm'),
      standardFontDataUrl: pdfjsAssetUrl('standard_fonts'),
      cMapUrl: pdfjsAssetUrl('cmaps'),
      cMapPacked: true,
      iccUrl: pdfjsAssetUrl('iccs'),
      // The renderer's own origin can read these; the worker's can not.
      useWorkerFetch: false,
      isEvalSupported: false,
      enableXfa: false,
    });
    session.loadingTask = loadingTask;
    session.doc = await loadingTask.promise;
    return session;
  } catch (error) {
    closeDocument(session);
    // The reader has nowhere to ask for a password, so say so plainly.
    if (error?.name === 'PasswordException') throw new Error('This PDF is password protected');
    throw error;
  }
}

function closeDocument(session) {
  if (!session) return;
  const finish = () => {
    try { session.worker.destroy(); } catch {}
    session.thread.terminate();
  };
  // `PDFDocumentProxy` has no `destroy` in pdf.js 6; the loading task owns it.
  if (session.loadingTask) session.loadingTask.destroy().then(finish, finish);
  else finish();
}

async function destinationPageNumber(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : null;
    if (ref === null || ref === undefined) return null;
    const index = typeof ref === 'object' ? await doc.getPageIndex(ref) : Number(ref);
    return Number.isInteger(index) ? index + 1 : null;
  } catch {
    return null;
  }
}

async function readOutline(doc) {
  let outline = null;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(outline) || outline.length === 0) return [];

  const pageByItem = new Map();
  let budget = MAX_OUTLINE_ITEMS;
  const resolve = async (items) => {
    for (const item of items) {
      if (budget-- <= 0) return;
      const pageNumber = await destinationPageNumber(doc, item?.dest);
      if (pageNumber) pageByItem.set(item, pageNumber);
      if (Array.isArray(item?.items) && item.items.length) await resolve(item.items);
    }
  };
  await resolve(outline);

  return buildPdfToc(outline, item => pageByItem.get(item) ?? null);
}

async function readTitle(doc) {
  try {
    const { info } = await doc.getMetadata();
    return cleanPdfTitle(info?.Title);
  } catch {
    return '';
  }
}

/**
 * Open a PDF and describe it the way `window.epub.parse` describes a book.
 * The document stays open until `releasePdfBook` closes it.
 */
export async function loadPdfBook(filePath) {
  const existing = books.get(filePath);
  if (existing) return existing.payload;

  const session = await openDocument(filePath);
  const { doc } = session;
  try {
    const firstPage = await doc.getPage(1);
    const base = firstPage.getViewport({ scale: 1 });
    const payload = {
      kind: 'pdf',
      title: await readTitle(doc),
      chapters: buildPdfChapters(doc.numPages),
      toc: await readOutline(doc),
      pageCount: doc.numPages,
      pageSize: { width: base.width, height: base.height },
    };
    books.set(filePath, { session, doc, payload, mount: null });
    return payload;
  } catch (error) {
    closeDocument(session);
    throw error;
  }
}

export function releasePdfBook(filePath) {
  const entry = books.get(filePath);
  if (!entry) return;
  books.delete(filePath);
  entry.mount?.destroy();
  closeDocument(entry.session);
}

/**
 * Fill in each chapter's `text` from the PDF's text content, in page order, so
 * the sidebar search index can be built the same way it is for EPUBs. Resolves
 * once every page has been read.
 */
export async function extractPdfText(filePath, { signal } = {}) {
  const entry = books.get(filePath);
  if (!entry) return false;
  const { doc, payload } = entry;

  for (const chapter of payload.chapters) {
    if (signal?.aborted || !books.has(filePath)) return false;
    if (chapter.text) continue;
    try {
      const page = await doc.getPage(chapter.pageNumber);
      const content = await page.getTextContent();
      chapter.text = content.items
        .map(item => (item.str || '') + (item.hasEOL ? '\n' : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      page.cleanup();
    } catch {
      chapter.text = '';
    }
  }
  return true;
}

/**
 * Render page 1 as a cover thumbnail. The main process caches EPUB and MOBI
 * covers on disk, but it has no rasterizer for PDF page content, so these are
 * produced here and persisted through main by the caller.
 */
export async function renderPdfThumbnail(filePath, maxHeight = 96) {
  const opened = books.get(filePath);
  const session = opened ? opened.session : await openDocument(filePath);
  const { doc } = session;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxHeight / base.height);
    const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    page.cleanup();
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    if (!opened) closeDocument(session);
  }
}

/**
 * Attach page rendering to the placeholders already injected into `container`.
 *
 * Returns a handle the reader keeps for the life of the rendered book:
 * `setView` re-lays out after a zoom change and `destroy` releases every
 * canvas, text layer, and observer.
 */
export function mountPdfPages(filePath, container, options = {}) {
  const entry = books.get(filePath);
  if (!entry) return null;
  entry.mount?.destroy();

  const { doc, payload } = entry;
  const scrollRoot = options.scrollRoot || null;
  const onPageRendered = typeof options.onPageRendered === 'function' ? options.onPageRendered : null;
  const pages = new Map(); // pageNumber -> page state
  const live = []; // page numbers holding a canvas, oldest first
  let view = normalizePdfView(options.view);
  let destroyed = false;

  for (const el of container.querySelectorAll('.pdf-page')) {
    const pageNumber = Number(el.dataset.pdfPage);
    if (!Number.isInteger(pageNumber)) continue;
    pages.set(pageNumber, {
      pageNumber,
      el,
      size: { ...payload.pageSize },
      visible: false,
      scale: 0,
      renderTask: null,
      textLayer: null,
      rendering: false,
      cancelled: false,
    });
  }

  function availableBox() {
    const width = container.clientWidth || scrollRoot?.clientWidth || 0;
    const height = scrollRoot?.clientHeight || window.innerHeight;
    return { width, height };
  }

  function layoutFor(state) {
    return computePageLayout(view.zoom, state.size, availableBox());
  }

  /** Size every placeholder so the scroll height is right before anything renders. */
  function applyLayout() {
    const box = availableBox();
    for (const state of pages.values()) {
      const layout = computePageLayout(view.zoom, state.size, box);
      state.el.style.width = `${layout.width}px`;
      state.el.style.height = `${layout.height}px`;
      state.el.style.setProperty('--scale-factor', String(layout.scale));
    }
  }

  function teardownPage(state, { keepSize = true } = {}) {
    state.renderTask?.cancel();
    state.renderTask = null;
    try { state.textLayer?.cancel(); } catch {}
    state.textLayer = null;
    state.scale = 0;
    state.rendering = false;
    const canvasHost = state.el.querySelector('.pdf-page-canvas');
    if (canvasHost) canvasHost.replaceChildren();
    const textHost = state.el.querySelector('.pdf-text-layer');
    if (textHost) textHost.replaceChildren();
    if (!keepSize) {
      state.el.style.width = '';
      state.el.style.height = '';
    }
  }

  function trimLivePages() {
    while (live.length > MAX_LIVE_PAGES) {
      const index = live.findIndex(pageNumber => !pages.get(pageNumber)?.visible);
      if (index === -1) break;
      const [pageNumber] = live.splice(index, 1);
      const state = pages.get(pageNumber);
      if (state) teardownPage(state);
    }
  }

  async function renderPage(state) {
    const layout = layoutFor(state);
    if (state.rendering || (state.scale === layout.scale && layout.scale > 0)) return;
    state.rendering = true;
    state.cancelled = false;

    try {
      const page = await doc.getPage(state.pageNumber);
      if (destroyed || !state.visible) return;

      const base = page.getViewport({ scale: 1 });
      state.size = { width: base.width, height: base.height };
      const target = layoutFor(state);
      const viewport = page.getViewport({ scale: target.scale });

      state.el.style.width = `${Math.round(viewport.width)}px`;
      state.el.style.height = `${Math.round(viewport.height)}px`;
      state.el.style.setProperty('--scale-factor', String(target.scale));
      state.el.style.setProperty('--user-unit', String(page.userUnit || 1));

      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
      });
      state.renderTask = renderTask;
      await renderTask.promise;
      if (destroyed) return;

      state.el.querySelector('.pdf-page-canvas')?.replaceChildren(canvas);
      state.scale = target.scale;
      if (!live.includes(state.pageNumber)) live.push(state.pageNumber);

      const textHost = state.el.querySelector('.pdf-text-layer');
      if (textHost) {
        textHost.replaceChildren();
        const { pdfjs: { TextLayer } } = await getPdfjs();
        if (destroyed) return;
        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textHost,
          viewport,
        });
        state.textLayer = textLayer;
        await textLayer.render();
      }
      if (destroyed) return;
      onPageRendered?.(state.pageNumber, state.el);
      trimLivePages();
    } catch (error) {
      if (error?.name === 'RenderingCancelledException' || error?.name === 'AbortException') {
        state.cancelled = true;
      } else {
        console.warn('Failed to render PDF page', state.pageNumber, error);
      }
    } finally {
      state.rendering = false;
      // A zoom change lands mid-render as a cancellation; a page the reader is
      // still looking at has to be drawn again at the new scale.
      if (state.cancelled && !destroyed && state.visible) {
        requestAnimationFrame(() => renderPage(state));
      }
    }
  }

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const item of entries) {
        const pageNumber = Number(item.target.dataset.pdfPage);
        const state = pages.get(pageNumber);
        if (!state) continue;
        state.visible = item.isIntersecting;
        if (item.isIntersecting) renderPage(state);
      }
      trimLivePages();
    }, { root: scrollRoot, rootMargin: PAGE_ROOT_MARGIN })
    : null;

  applyLayout();
  if (observer) {
    for (const state of pages.values()) observer.observe(state.el);
  } else {
    for (const state of pages.values()) {
      state.visible = true;
      renderPage(state);
    }
  }

  // Fit modes depend on the content column, which changes with the window and
  // with either sidebar being resized or toggled.
  let resizeTimer = null;
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (view.zoom !== 'fit-width' && view.zoom !== 'fit-page') return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => refresh(), 120);
    })
    : null;
  resizeObserver?.observe(container);

  function refresh() {
    if (destroyed) return;
    applyLayout();
    for (const state of pages.values()) {
      const layout = layoutFor(state);
      if (state.scale === layout.scale) continue;
      teardownPage(state);
      if (state.visible) renderPage(state);
    }
  }

  const mount = {
    setView(nextView) {
      view = normalizePdfView(nextView);
      refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(resizeTimer);
      observer?.disconnect();
      resizeObserver?.disconnect();
      for (const state of pages.values()) teardownPage(state, { keepSize: false });
      pages.clear();
      live.length = 0;
      if (entry.mount === mount) entry.mount = null;
    },
  };
  entry.mount = mount;
  return mount;
}
