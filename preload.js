const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('epub', {
  parse: (filePath) => ipcRenderer.invoke('parse-epub', filePath),
  readBookFile: (filePath) => ipcRenderer.invoke('read-book-file', filePath),
  getBookCover: (filePath) => ipcRenderer.invoke('get-book-cover', filePath),
  getCachedPdfCover: (filePath) => ipcRenderer.invoke('get-cached-pdf-cover', filePath),
  cachePdfCover: (filePath, key, dataUri) => ipcRenderer.invoke('cache-pdf-cover', filePath, key, dataUri),
  onOpenFile: (cb) => subscribe('open-file', cb),
  signalReady: () => ipcRenderer.send('renderer-ready'),
  checkPathsExistence: (paths) => ipcRenderer.invoke('check-paths-existence', paths),
  selectBookFolder: () => ipcRenderer.invoke('select-book-folder'),
  scanDroppedBookFolder: (file) => {
    const folderPath = webUtils.getPathForFile(file);
    return folderPath
      ? ipcRenderer.invoke('scan-book-folder', folderPath)
      : Promise.resolve(null);
  },
  showSidebarMenu: (target) => ipcRenderer.invoke('show-sidebar-menu', target),
  showSortMenu: (current) => ipcRenderer.invoke('show-sort-menu', current),
  scanBookFolder: (folderPath) => ipcRenderer.invoke('scan-book-folder', folderPath),
  watchBookFolders: (folderPaths) => ipcRenderer.send('watch-book-folders', folderPaths),
  onBookFolderChanged: (cb) => subscribe('book-folder-changed', cb),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

contextBridge.exposeInMainWorld('updater', {
  onUpdateReady: (cb) => subscribe('update-ready', cb),
  apply: () => ipcRenderer.invoke('apply-update'),
});

contextBridge.exposeInMainWorld('settings', {
  getAll: () => ipcRenderer.invoke('get-settings'),
  set: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  onSettingsChanged: (cb) => subscribe('settings-changed', cb),
  onChapterScrollbarChanged: (cb) => subscribe('chapter-scrollbar-changed', cb),
});

contextBridge.exposeInMainWorld('initialSettings', ipcRenderer.sendSync('get-settings-sync'));
