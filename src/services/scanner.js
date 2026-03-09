const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
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

function generateThumbnail(videoPath, libraryPath) {
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });

  const thumbName = crypto.randomUUID() + '.jpg';
  const thumbPath = path.join(thumbDir, thumbName);

  try {
    // Grab frame at 10% of the video, scale to 320px wide, high compression
    execFileSync('ffmpeg', [
      '-ss', '3',            // seek to 3s (fast, avoids black intro frames)
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '8',           // quality 2-31, 8 = good balance size/quality
      '-y',
      thumbPath,
    ], { timeout: 15000, stdio: 'pipe' });

    return thumbName;
  } catch (err) {
    console.error(`Thumbnail failed for ${videoPath}:`, err.message);
    // Cleanup partial file
    try { fs.unlinkSync(thumbPath); } catch {}
    return null;
  }
}

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

      // Get the video id (insertId for new, query for existing)
      let videoId = result.insertId;
      if (!videoId) {
        const [rows] = await pool.execute(
          'SELECT id FROM videos WHERE library_id = ? AND filepath = ?',
          [libraryId, file.filepath]
        );
        if (rows.length > 0) videoId = rows[0].id;
      }

      // Generate thumbnail if missing
      if (videoId) {
        const [existing] = await pool.execute(
          'SELECT id FROM thumbnails WHERE video_id = ?', [videoId]
        );
        if (existing.length === 0) {
          const fullVideoPath = path.join(library.path, file.filepath);
          const thumbName = generateThumbnail(fullVideoPath, library.path);
          if (thumbName) {
            await pool.execute(
              'INSERT INTO thumbnails (video_id, filename) VALUES (?, ?)',
              [videoId, thumbName]
            );
          }
        }
      }

      added++;
    } catch (err) {
      console.error(`Error indexing ${file.filepath}:`, err.message);
    }
  }

  // Remove videos that no longer exist on disk (thumbnails cascade-deleted)
  const [existingVideos] = await pool.execute('SELECT id, filepath FROM videos WHERE library_id = ?', [libraryId]);
  for (const video of existingVideos) {
    const fullPath = path.join(library.path, video.filepath);
    if (!fs.existsSync(fullPath)) {
      // Clean up thumbnail file
      const [thumbs] = await pool.execute('SELECT filename FROM thumbnails WHERE video_id = ?', [video.id]);
      for (const t of thumbs) {
        const thumbPath = path.join(library.path, CAPSULE_DIR, t.filename);
        try { fs.unlinkSync(thumbPath); } catch {}
      }
      await pool.execute('DELETE FROM videos WHERE id = ?', [video.id]);
    }
  }

  return { total: files.length, added };
}

module.exports = { scanLibrary, CAPSULE_DIR };
