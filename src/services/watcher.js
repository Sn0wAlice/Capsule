const path = require('path');
const pool = require('../config/database');
const { indexSingleFile, removeSingleFile, CAPSULE_DIR, VIDEO_EXTENSIONS } = require('./scanner');

let chokidar;
try {
  chokidar = require('chokidar');
} catch {
  chokidar = null;
}

const watchers = new Map(); // libraryId -> FSWatcher

function isVideoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function watchLibrary(libraryId, libraryPath) {
  if (!chokidar) {
    console.warn('[watcher] chokidar not installed, file watching disabled');
    return;
  }

  // Already watching
  if (watchers.has(libraryId)) return;

  const watcher = chokidar.watch(libraryPath, {
    ignored: [
      /(^|[/\\])\./,              // dotfiles (.capsule, .DS_Store, etc.)
      '**/node_modules/**',
    ],
    persistent: true,
    ignoreInitial: true,          // don't fire for existing files
    awaitWriteFinish: {
      stabilityThreshold: 2000,   // wait 2s after last write to consider file stable
      pollInterval: 500,
    },
    depth: 20,
  });

  watcher
    .on('add', (filePath) => {
      if (isVideoFile(filePath)) {
        indexSingleFile(libraryId, libraryPath, filePath);
      }
    })
    .on('unlink', (filePath) => {
      if (isVideoFile(filePath)) {
        removeSingleFile(libraryId, libraryPath, filePath);
      }
    })
    .on('error', (err) => {
      console.error(`[watcher] Error on library ${libraryId}:`, err.message);
    });

  watchers.set(libraryId, watcher);
  console.log(`[watcher] Watching library ${libraryId}: ${libraryPath}`);
}

function unwatchLibrary(libraryId) {
  const watcher = watchers.get(libraryId);
  if (watcher) {
    watcher.close();
    watchers.delete(libraryId);
    console.log(`[watcher] Stopped watching library ${libraryId}`);
  }
}

// Start watching all libraries for all users
async function startAllWatchers() {
  if (!chokidar) {
    console.warn('[watcher] chokidar not installed — skipping file watchers. Run: npm install chokidar');
    return;
  }

  try {
    const [libs] = await pool.execute('SELECT id, path FROM libraries');
    for (const lib of libs) {
      watchLibrary(lib.id, lib.path);
    }
    console.log(`[watcher] Started ${libs.length} file watcher(s)`);
  } catch (err) {
    console.error('[watcher] Failed to start watchers:', err.message);
  }
}

function stopAllWatchers() {
  for (const [id] of watchers) {
    unwatchLibrary(id);
  }
}

module.exports = {
  watchLibrary,
  unwatchLibrary,
  startAllWatchers,
  stopAllWatchers,
};
