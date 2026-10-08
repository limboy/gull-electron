---
summary: "How PDFs are opened, laid out, and zoomed — pdf.js in the renderer, pages disguised as chapters, and what the format does not support."
read_when:
  - A PDF renders blank, at the wrong size, or with missing glyphs
  - Changing page zoom, the page cache, or PDF thumbnails
  - Adding a reader feature and wondering how it behaves on a fixed-layout book
title: "PDF Rendering"
---

PDFs are fixed-layout, so none of the EPUB reflow pipeline applies to them: the
main process never parses a PDF, and none of the typography settings change how
one looks. Everything happens in the renderer with
[pdf.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`).

## Pages disguised as chapters

`src/pdf-book.js` returns the *same* payload shape `window.epub.parse` returns:

```js
{
  kind: 'pdf',
  title,                                  // PDF metadata title, when it looks intentional
  chapters: [{ id: 'page-1', href: 'page-1', pageNumber: 1, html, css: '', text }],
  toc: [{ title, href: 'page-4', children }],   // from the PDF's bookmarks
  pageCount,
  pageSize,                               // page 1, in PDF points
}
```

Each chapter's `html` is an empty page box (`.pdf-page` + `.pdf-page-canvas` +
`.pdf-text-layer`). Because the shape matches, `renderContent`, the ToC panel,
search, highlights, the chapter scrollbar, and saved scroll positions all work
on a PDF without special cases beyond skipping the EPUB-only passes
(`stripEpubFonts`, image fallbacks, footnote asides).

The pure parts — zoom math, ToC mapping, page chapters, title cleanup — live in
`src/lib/pdf-view.mjs` and are unit tested in `test/pdf-view.test.js`.

## Rendering a page

`mountPdfPages` attaches to the placeholders `renderContent` already injected:

- Every placeholder is sized from `pageSize` first, so the scroll height is
  correct before anything is rasterized and the saved position restores onto a
  stable document. A page corrects its own box when it renders.
- An `IntersectionObserver` rooted on `#content-area` (`rootMargin: 150%`)
  renders a page shortly before it scrolls into view. At most
  `MAX_LIVE_PAGES` (8) pages keep a canvas and text layer; the rest fall back to
  an empty white box, which is what keeps a 900-page PDF from exhausting memory.
- Canvases are rasterized at up to 2× the CSS size for retina displays.
- The pdf.js text layer is what makes selection, copy, in-content search
  highlighting, and highlights possible. Highlights are (re)applied through the
  `onPageRendered` callback, since the text a highlight anchors to only exists
  once its page has been rendered.

## Zoom

`gull-pdf-view` local storage holds `{ zoom }`: `fit-width` (default),
`fit-page`, or a fixed factor (`1` = actual size at 96 dpi). `SettingsMenu.jsx`
writes it and dispatches `gull:pdf-view-changed`; the runtime hands the new view
to the mount, which re-renders the visible pages and re-sizes the rest. The
reader's scroll progress is preserved across the change.

Fit modes are recomputed on a `ResizeObserver`, so resizing the window or a
sidebar re-fits the pages.

## Which settings a PDF shows

`renderContent` announces the active book's kind (`notifyBookKind`) on
`window.gullBookKind` and a `gull:book-kind` event. `SettingsMenu.jsx` listens
and swaps its controls: a PDF gets the page-zoom choices directly in the main
menu, while a reflowable book gets Full width, Font, Font Size, Line Height, and
Paragraphs. The chapter-scrollbar toggle applies to both.

## Covers

The sidebar checks `get-cached-pdf-cover` before loading pdf.js or reading the
PDF. On a miss, it renders page 1 through `renderPdfThumbnail` and persists the
JPEG through `cache-pdf-cover` in `<userData>/covers/pdf-v1-<sha1>.uri`. The key
includes the file path, size, and mtime, so subsequent sessions reuse the icon
and changed files get a new thumbnail. Main checks the key again before saving
to avoid caching an old rendering for a changed file. Failed renders stay
uncached. Requests are queued one at a time because each miss reads a whole file.

## Getting the bytes

`window.epub.readBookFile` (IPC `read-book-file`) returns the file's bytes after
the same validation `parse-epub` uses, and refuses anything that is not a PDF.
The renderer has no filesystem access of its own.

Because the worker holds the whole file, only the PDF on screen keeps its
document open: the runtime's `releaseInactivePdf` closes the previous one when
another book is opened. Re-opening re-reads the file; the search index is kept,
so its text is not extracted twice.

## Runtime assets — the part that is easy to get wrong

pdf.js does not bundle its image decoders, font data, CMaps, or ICC profiles; it
fetches them from URLs given to `getDocument`. Skipping them does not fail
loudly — a JPEG 2000 or JBIG2 scan simply renders as a blank page while its text
still draws, and non-embedded fonts render with the wrong metrics.

Three pieces make it work:

1. **The files ship with the renderer.** The `gull-pdfjs-assets` plugin in
   `vite.config.mjs` serves `pdfjs-dist`'s `wasm/`, `standard_fonts/`, `cmaps/`,
   and `iccs/` under `/pdfjs/` in dev and copies them into `dist/pdfjs/` for the
   packaged app (also listed in `build.files`). `pdf-book.js` resolves them
   against `document.baseURI`, so one relative URL covers both.
2. **`useWorkerFetch: false`.** The renderer's own origin can read those URLs;
   the blob worker's can not, so the fetches are proxied through the main frame.
3. **`'wasm-unsafe-eval'` in the CSP** (`index.html`). Without it Chromium
   refuses to compile the decoders and pdf.js silently falls back to its slower
   JS path — which exists for OpenJPEG but not for JBIG2. This does *not* allow
   `eval`; `isEvalSupported: false` is still passed to pdf.js.

## The worker

pdf.js runs its parser in a Web Worker. The production renderer is loaded from
`file://`, where a worker can not be created from a URL, so Vite is configured
(`worker: { format: 'es' }` plus a `?worker&inline` import) to inline it as a
blob — which the CSP allows via `worker-src 'self' blob:`. pdf.js itself is
dynamically imported, so a session that never opens a PDF never loads it.

The worker entry is `src/pdf-worker-entry.js` rather than pdf.js' worker
directly, because it first installs the `Math.sumPrecise` polyfill
(`src/lib/math-sum-precise.mjs`). pdf.js 6 calls that TC39 proposal while
building font tables and Chromium has not shipped it (146 at the time of
writing); pdf.js catches the resulting `TypeError` and reports it as "cannot
substitute the font", which is a confusing way to be told a book renders with
the wrong metrics.

**Each document gets its own worker.** pdf.js caches workers by port and
tearing a document down un-caches that port, so a shared worker would break
whichever book is still open in another tab. `closeDocument` destroys the
loading task, then the `PDFWorker`, then terminates the thread — note that
`PDFDocumentProxy.destroy()` no longer exists in pdf.js 6.

## Known limits

- **No annotation layer.** Link annotations and form fields are not interactive;
  bookmarks in the ToC panel are the way to navigate.
- **The whole file is read into memory** when a PDF is opened, so the 512 MB
  book limit applies to PDFs the same way it does to EPUBs.
- **Password-protected PDFs are refused** with a plain message; there is nowhere
  in the reader to ask for a password.
