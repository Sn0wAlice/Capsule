const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const pool = require('../config/database');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.flv', '.wmv']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);

// Detect language tag from subtitle filename (e.g. video.fr.srt → fr, video.en.vtt → en)
function parseSubtitleMeta(subFilename, videoBasename) {
  const noExt = path.basename(subFilename, path.extname(subFilename));
  const suffix = noExt.slice(videoBasename.length).replace(/^[._-]/, '');
  const lang = suffix || 'en';
  const labels = { fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic' };
  return { language: lang, label: labels[lang] || lang.toUpperCase() };
}

const MIME_MAP = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
};

const CAPSULE_DIR = '.capsule';

// Rows per multi-row statement. Large enough to make round trips negligible,
// small enough to stay well under max_allowed_packet.
const DB_BATCH = 500;

// Parent directory of a library-relative path ('' for the library root).
function folderOf(relativePath) {
  const i = relativePath.lastIndexOf('/');
  return i === -1 ? '' : relativePath.slice(0, i);
}

function* chunks(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

// ── Enqueue a media processing job for the worker ──

async function enqueueJob(videoId, libraryPath, videoPath) {
  try {
    await pool.execute(
      `INSERT IGNORE INTO jobs (video_id, library_path, video_path) VALUES (?, ?, ?)`,
      [videoId, libraryPath, videoPath]
    );
  } catch (err) {
    console.error(`Failed to enqueue job for video ${videoId}:`, err.message);
  }
}

// ── Directory scanning ──

function scanDirectory(dirPath, basePath, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === CAPSULE_DIR) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath, basePath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        const relativePath = path.relative(basePath, fullPath);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        results.push({
          filename: entry.name,
          filepath: relativePath,
          title: path.basename(entry.name, ext),
          size: stat.size,
          mime_type: MIME_MAP[ext] || 'video/mp4',
        });
      }
    }
  }
  return results;
}

// ── Main scan function ──

async function scanLibrary(libraryId) {
  const [libs] = await pool.execute('SELECT * FROM libraries WHERE id = ?', [libraryId]);
  if (libs.length === 0) throw new Error('Library not found');

  const library = libs[0];
  const files = scanDirectory(library.path, library.path);

  // What the database already knows about, so we can tell new files from known
  // ones without a SELECT per file.
  const [before] = await pool.execute(
    'SELECT id, filepath, size FROM videos WHERE library_id = ?',
    [libraryId]
  );
  const idByPath = new Map(before.map(r => [r.filepath, r.id]));
  const sizeByPath = new Map(before.map(r => [r.filepath, Number(r.size)]));
  const newFiles = files.filter(f => !idByPath.has(f.filepath));

  // Upsert in batches rather than one round trip per file.
  for (const chunk of chunks(files, DB_BATCH)) {
    await pool.query(
      `INSERT INTO videos (library_id, filename, filepath, folder, title, size, mime_type)
       VALUES ?
       ON DUPLICATE KEY UPDATE size = VALUES(size), mime_type = VALUES(mime_type),
                               folder = VALUES(folder), updated_at = NOW()`,
      [chunk.map(f => [libraryId, f.filename, f.filepath, folderOf(f.filepath),
                       f.title, f.size, f.mime_type])]
    );
  }

  // Resolve the ids of the rows we just created.
  for (const chunk of chunks(newFiles, DB_BATCH)) {
    const [rows] = await pool.query(
      'SELECT id, filepath FROM videos WHERE library_id = ? AND filepath IN (?)',
      [libraryId, chunk.map(f => f.filepath)]
    );
    for (const r of rows) idByPath.set(r.filepath, r.id);
  }

  // Queue only the work that is actually needed. `jobs` has no unique key on
  // video_id, so the previous INSERT IGNORE ignored nothing: every scan
  // re-queued the whole library and the worker re-ran ffmpeg over all of it.
  const needsWork = new Set();

  // Files whose bytes changed on disk have stale thumbnails and metadata.
  for (const f of files) {
    const known = sizeByPath.get(f.filepath);
    if (known !== undefined && known !== f.size) needsWork.add(f.filepath);
  }

  // Files that never produced a thumbnail and have nothing queued already.
  const [pending] = await pool.query(
    `SELECT v.filepath FROM videos v
     LEFT JOIN thumbnails t ON t.video_id = v.id
     LEFT JOIN jobs j ON j.video_id = v.id AND j.status IN ('pending', 'processing')
     WHERE v.library_id = ? AND t.video_id IS NULL AND j.id IS NULL`,
    [libraryId]
  );
  for (const row of pending) needsWork.add(row.filepath);

  const jobRows = [];
  for (const filepath of needsWork) {
    const id = idByPath.get(filepath);
    if (id) jobRows.push([id, library.path, path.join(library.path, filepath)]);
  }
  for (const chunk of chunks(jobRows, DB_BATCH)) {
    try {
      await pool.query('INSERT INTO jobs (video_id, library_path, video_path) VALUES ?', [chunk]);
    } catch (err) {
      console.error('[scanner] Failed to enqueue jobs:', err.message);
    }
  }

  await indexSubtitlesForFiles(files, idByPath, library.path);

  // Orphans: the scan already listed everything on disk, so this needs no
  // further stat() calls — just a set difference.
  const onDisk = new Set(files.map(f => f.filepath));
  const orphans = before.filter(r => !onDisk.has(r.filepath));
  if (orphans.length > 0) {
    await deleteVideos(orphans.map(r => r.id), library.path);
  }

  return { total: files.length, added: newFiles.length, queued: jobRows.length };
}

// ── Delete videos and their generated artefacts ──

async function deleteVideos(videoIds, libraryPath) {
  const capsuleDir = path.join(libraryPath, CAPSULE_DIR);
  for (const chunk of chunks(videoIds, DB_BATCH)) {
    const [thumbs] = await pool.query(
      'SELECT filename, sprite_filename FROM thumbnails WHERE video_id IN (?)',
      [chunk]
    );
    const artefacts = [];
    for (const t of thumbs) {
      if (t.filename) artefacts.push(path.join(capsuleDir, t.filename));
      if (t.sprite_filename) artefacts.push(path.join(capsuleDir, t.sprite_filename));
    }
    await Promise.all(artefacts.map(p => fsp.unlink(p).catch(() => {})));
    await pool.query('DELETE FROM videos WHERE id IN (?)', [chunk]);
  }
}

// ── Index subtitle files alongside videos ──

// Subtitle candidates in a directory, read once and reused for every video in it.
function subtitleEntries(dirAbs, cache) {
  let entries = cache.get(dirAbs);
  if (entries === undefined) {
    try {
      entries = fs.readdirSync(dirAbs)
        .filter(e => SUBTITLE_EXTENSIONS.has(path.extname(e).toLowerCase()));
    } catch {
      entries = [];
    }
    cache.set(dirAbs, entries);
  }
  return entries;
}

function matchSubtitles(entries, dirAbs, libraryPath, videoBasename, videoId, out) {
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    const entryBasename = path.basename(entry, ext);
    // Same basename, or basename plus a language suffix (video.fr.srt)
    if (entryBasename !== videoBasename &&
        !entryBasename.startsWith(videoBasename + '.') &&
        !entryBasename.startsWith(videoBasename + '_')) continue;
    const relPath = path.relative(libraryPath, path.join(dirAbs, entry));
    const { language, label } = parseSubtitleMeta(entry, videoBasename);
    out.push([videoId, label, language, relPath]);
  }
}

async function insertSubtitles(rows) {
  for (const chunk of chunks(rows, DB_BATCH)) {
    try {
      await pool.query(
        `INSERT INTO subtitles (video_id, label, language, filename) VALUES ?
         ON DUPLICATE KEY UPDATE label = VALUES(label), language = VALUES(language)`,
        [chunk]
      );
    } catch (err) {
      console.error('[scanner] Subtitle index error:', err.message);
    }
  }
}

// Whole-library pass: one readdir per directory instead of one per video.
async function indexSubtitlesForFiles(files, idByPath, libraryPath) {
  const dirCache = new Map();
  const rows = [];
  for (const f of files) {
    const videoId = idByPath.get(f.filepath);
    if (!videoId) continue;
    const dirRel = folderOf(f.filepath);
    const dirAbs = dirRel ? path.join(libraryPath, dirRel) : libraryPath;
    const entries = subtitleEntries(dirAbs, dirCache);
    if (entries.length === 0) continue;
    const base = path.basename(f.filename, path.extname(f.filename));
    matchSubtitles(entries, dirAbs, libraryPath, base, videoId, rows);
  }
  await insertSubtitles(rows);
}

// Single-video pass, used by the watcher.
async function indexSubtitlesForVideo(videoId, libraryPath, videoFilePath) {
  const dirAbs = path.dirname(videoFilePath);
  const base = path.basename(videoFilePath, path.extname(videoFilePath));
  const rows = [];
  matchSubtitles(subtitleEntries(dirAbs, new Map()), dirAbs, libraryPath, base, videoId, rows);
  await insertSubtitles(rows);
}

// ── Index a single new file (used by watcher) ──

async function indexSingleFile(libraryId, libraryPath, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return;

  const relativePath = path.relative(libraryPath, filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  const filename = path.basename(filePath);
  const title = path.basename(filename, ext);
  const mimeType = MIME_MAP[ext] || 'video/mp4';

  try {
    const [result] = await pool.execute(
      `INSERT INTO videos (library_id, filename, filepath, folder, title, size, mime_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE size = VALUES(size), mime_type = VALUES(mime_type),
                               folder = VALUES(folder), updated_at = NOW()`,
      [libraryId, filename, relativePath, folderOf(relativePath), title, stat.size, mimeType]
    );

    let videoId = result.insertId;
    if (!videoId) {
      const [rows] = await pool.execute(
        'SELECT id FROM videos WHERE library_id = ? AND filepath = ?',
        [libraryId, relativePath]
      );
      if (rows.length > 0) videoId = rows[0].id;
    }

    if (videoId) {
      await enqueueJob(videoId, libraryPath, filePath);
      await indexSubtitlesForVideo(videoId, libraryPath, filePath);
      console.log(`[watcher] Indexed: ${relativePath}`);
    }
  } catch (err) {
    console.error(`[watcher] Index error for ${relativePath}:`, err.message);
  }
}

// ── Remove a deleted file (used by watcher) ──

async function removeSingleFile(libraryId, libraryPath, filePath) {
  const relativePath = path.relative(libraryPath, filePath);
  try {
    const [rows] = await pool.execute(
      'SELECT id FROM videos WHERE library_id = ? AND filepath = ?',
      [libraryId, relativePath]
    );
    if (rows.length === 0) return;
    const videoId = rows[0].id;

    // Clean thumbnail files
    const [thumbs] = await pool.execute('SELECT filename, sprite_filename FROM thumbnails WHERE video_id = ?', [videoId]);
    for (const t of thumbs) {
      const thumbPath = path.join(libraryPath, CAPSULE_DIR, t.filename);
      try { fs.unlinkSync(thumbPath); } catch {}
      if (t.sprite_filename) {
        const spritePath = path.join(libraryPath, CAPSULE_DIR, t.sprite_filename);
        try { fs.unlinkSync(spritePath); } catch {}
      }
    }

    await pool.execute('DELETE FROM videos WHERE id = ?', [videoId]);
    console.log(`[watcher] Removed: ${relativePath}`);
  } catch (err) {
    console.error(`[watcher] Remove error for ${relativePath}:`, err.message);
  }
}

module.exports = {
  scanLibrary,
  parseSubtitleMeta,
  indexSingleFile,
  removeSingleFile,
  indexSubtitlesForVideo,
  CAPSULE_DIR,
  VIDEO_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
};
