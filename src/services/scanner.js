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

function scanDirectory(dirPath, basePath, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
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

async function scanLibrary(libraryId) {
  const [libs] = await pool.execute('SELECT * FROM libraries WHERE id = ?', [libraryId]);
  if (libs.length === 0) throw new Error('Library not found');

  const library = libs[0];
  const files = scanDirectory(library.path, library.path);

  let added = 0;
  for (const file of files) {
    try {
      await pool.execute(
        `INSERT INTO videos (library_id, filename, filepath, title, size, mime_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE size = VALUES(size), mime_type = VALUES(mime_type), updated_at = NOW()`,
        [libraryId, file.filename, file.filepath, file.title, file.size, file.mime_type]
      );
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
      await pool.execute('DELETE FROM videos WHERE id = ?', [video.id]);
    }
  }

  return { total: files.length, added };
}

module.exports = { scanLibrary };
