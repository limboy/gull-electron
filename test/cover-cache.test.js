const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '../src/reader-runtime.js'), 'utf8');

function cacheContext(directory) {
  const context = vm.createContext({
    fs, path, crypto, process, console,
    app: { getPath: () => directory },
    MAX_BOOK_FILE_SIZE: 512 * 1024 * 1024,
    isSupportedFile: value => typeof value === 'string' && /\.(pdf|epub)$/i.test(value),
  });
  vm.runInContext(main.slice(main.indexOf('function validateBookPath('), main.indexOf('function validateFolderPath(')), context);
  vm.runInContext(main.slice(main.indexOf('function coverCacheKey('), main.indexOf('function getBookCover(')), context);
  return context;
}

test('PDF cover survives a new session and rejects stale or invalid writes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gull-cover-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'book.pdf');
  fs.writeFileSync(file, 'first version');
  const first = cacheContext(directory);
  const { key, cover } = first.getCachedPdfCover(file);
  assert.equal(cover, null);
  const thumbnail = 'data:image/jpeg;base64,/9j/2Q==';
  assert.equal(first.cachePdfCover(file, key, thumbnail), true);
  const restarted = cacheContext(directory);
  assert.equal(restarted.getCachedPdfCover(file).cover, thumbnail);
  assert.throws(() => restarted.cachePdfCover(file, key, 'data:text/html;base64,YQ=='), /Invalid PDF/);
  assert.throws(() => restarted.cachePdfCover(file, key, 'x'.repeat(1024 * 1024 + 1)), /Invalid PDF/);
  fs.writeFileSync(file, 'a changed version with a new size');
  assert.equal(restarted.getCachedPdfCover(file).cover, null);
  assert.equal(restarted.cachePdfCover(file, key, thumbnail), false);
  const epub = path.join(directory, 'book.epub');
  fs.writeFileSync(epub, 'epub');
  assert.throws(() => restarted.getCachedPdfCover(epub), /only serves PDF/);
});

test('PDF sidebar cache hit skips parsing; a miss renders and saves once', async () => {
  let cached = 'cached-thumbnail';
  let renders = 0;
  let moduleLoads = 0;
  const context = vm.createContext({
    console,
    COVER_THUMBNAIL_HEIGHT: 96,
    window: { epub: {
      getCachedPdfCover: async () => ({ key: 'version', cover: cached }),
      cachePdfCover: async (file, key, thumbnail) => {
        assert.equal(file, '/book.pdf');
        assert.equal(key, 'version');
        cached = thumbnail;
      },
    } },
    getPdfModule: async () => {
      moduleLoads++;
      return { renderPdfThumbnail: async () => { renders++; return 'new-thumbnail'; } };
    },
  });
  vm.runInContext(runtime.slice(runtime.indexOf('let pdfCoverQueue ='), runtime.indexOf('async function loadBookCover(')), context);
  assert.equal(await context.loadPdfCover('/book.pdf'), 'cached-thumbnail');
  assert.equal(moduleLoads, 0);
  cached = null;
  assert.equal(await context.loadPdfCover('/book.pdf'), 'new-thumbnail');
  assert.equal(await context.loadPdfCover('/book.pdf'), 'new-thumbnail');
  assert.equal(renders, 1);
  assert.equal(moduleLoads, 1);
});
