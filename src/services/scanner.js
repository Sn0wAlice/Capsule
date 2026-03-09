const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v', '.flv', '.wmv']);

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

  let added = 0;
  for (const file of files) {
    try {
      const [result] = await pool.execute(
        `INSERT INTO videos (library_id, filename, filepath, title, size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE size = VALUES(size), mime_type = VALUES(mime_type), updated_at = NOW()`,
        [libraryId, file.filename, file.filepath, file.title, file.size, file.mime_type]
      );

      let videoId = result.insertId;
      if (!videoId) {
        const [rows] = await pool.execute(
          'SELECT id FROM videos WHERE library_id = ? AND filepath = ?',
          [libraryId, file.filepath]
        );
        if (rows.length > 0) videoId = rows[0].id;
      }

      if (videoId) {
        const fullVideoPath = path.join(library.path, file.filepath);
        await enqueueJob(videoId, library.path, fullVideoPath);
      }

      added++;
    } catch (err) {
      console.error(`Error indexing ${file.filepath}:`, err.message);
    }
  }

  // Remove videos that no longer exist on disk
  const [existingVideos] = await pool.execute('SELECT id, filepath FROM videos WHERE library_id = ?', [libraryId]);
  for (const video of existingVideos) {
    const fullPath = path.join(library.path, video.filepath);
    if (!fs.existsSync(fullPath)) {
      const [thumbs] = await pool.execute('SELECT filename, sprite_filename FROM thumbnails WHERE video_id = ?', [video.id]);
      for (const t of thumbs) {
        const thumbPath = path.join(library.path, CAPSULE_DIR, t.filename);
        try { fs.unlinkSync(thumbPath); } catch {}
        if (t.sprite_filename) {
          const spritePath = path.join(library.path, CAPSULE_DIR, t.sprite_filename);
          try { fs.unlinkSync(spritePath); } catch {}
        }
      }
      await pool.execute('DELETE FROM videos WHERE id = ?', [video.id]);
    }
  }

  return { total: files.length, added };
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
      `INSERT INTO videos (library_id, filename, filepath, title, size, mime_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE size = VALUES(size), mime_type = VALUES(mime_type), updated_at = NOW()`,
      [libraryId, filename, relativePath, title, stat.size, mimeType]
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
  indexSingleFile,
  removeSingleFile,
  CAPSULE_DIR,
  VIDEO_EXTENSIONS,
};
