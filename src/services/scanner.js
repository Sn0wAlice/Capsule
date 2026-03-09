const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
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

// ── Background job queue (thumbnails + metadata) ──

const jobQueue = [];
let jobRunning = false;

function enqueueJob(fn) {
  jobQueue.push(fn);
  processQueue();
}

async function processQueue() {
  if (jobRunning) return;
  jobRunning = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    try {
      await job();
    } catch (err) {
      console.error('Background job error:', err.message);
    }
  }
  jobRunning = false;
}

// ── ffprobe metadata extraction ──

function probeVideo(videoPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function extractMetadata(probeData) {
  if (!probeData) return {};
  const meta = {};

  // Duration from format
  if (probeData.format && probeData.format.duration) {
    meta.duration = parseFloat(probeData.format.duration) || null;
  }
  // Bitrate from format
  if (probeData.format && probeData.format.bit_rate) {
    meta.bitrate = parseInt(probeData.format.bit_rate, 10) || null;
  }

  // Find video & audio streams
  const streams = probeData.streams || [];
  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');

  if (videoStream) {
    meta.width = videoStream.width || null;
    meta.height = videoStream.height || null;
    meta.codec = videoStream.codec_name || null;
    // Fallback duration from video stream
    if (!meta.duration && videoStream.duration) {
      meta.duration = parseFloat(videoStream.duration) || null;
    }
  }
  if (audioStream) {
    meta.audio_codec = audioStream.codec_name || null;
  }

  return meta;
}

// ── Thumbnail generation ──

function generateThumbnail(videoPath, libraryPath) {
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });

  const thumbName = crypto.randomUUID() + '.jpg';
  const thumbPath = path.join(thumbDir, thumbName);

  try {
    execFileSync('ffmpeg', [
      '-ss', '3',
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '8',
      '-y',
      thumbPath,
    ], { timeout: 15000, stdio: 'pipe' });

    return thumbName;
  } catch (err) {
    console.error(`Thumbnail failed for ${videoPath}:`, err.message);
    try { fs.unlinkSync(thumbPath); } catch {}
    return null;
  }
}

// ── Sprite preview (8 frames tiled horizontally) ──

const SPRITE_FRAMES = 8;

function generateSprite(videoPath, libraryPath, duration) {
  if (!duration || duration < 4) return null;

  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });

  const spriteName = crypto.randomUUID() + '_sprite.jpg';
  const spritePath = path.join(thumbDir, spriteName);

  // Grab 8 frames evenly spaced, tile them horizontally
  const interval = duration / (SPRITE_FRAMES + 1);
  const selectExpr = Array.from({ length: SPRITE_FRAMES }, (_, i) =>
    `eq(n\\,${Math.max(1, Math.floor((i + 1) * interval * 25))})`
  ).join('+');

  try {
    execFileSync('ffmpeg', [
      '-i', videoPath,
      '-vf', `fps=25,select='${selectExpr}',scale=160:-2,tile=${SPRITE_FRAMES}x1`,
      '-frames:v', '1',
      '-q:v', '10',
      '-y',
      spritePath,
    ], { timeout: 30000, stdio: 'pipe' });

    return spriteName;
  } catch {
    // Fallback: simpler approach with timestamp seeking
    try {
      execFileSync('ffmpeg', [
        '-i', videoPath,
        '-vf', `fps=1/${Math.max(1, Math.floor(interval))},scale=160:-2,tile=${SPRITE_FRAMES}x1`,
        '-frames:v', '1',
        '-q:v', '10',
        '-y',
        spritePath,
      ], { timeout: 30000, stdio: 'pipe' });
      return spriteName;
    } catch (err) {
      console.error(`Sprite failed for ${videoPath}:`, err.message);
      try { fs.unlinkSync(spritePath); } catch {}
      return null;
    }
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
        const vid = videoId; // capture for closure

        // Enqueue background: thumbnail + metadata
        enqueueJob(async () => {
          // Thumbnail
          const [existing] = await pool.execute(
            'SELECT id FROM thumbnails WHERE video_id = ?', [vid]
          );
          if (existing.length === 0) {
            const thumbName = generateThumbnail(fullVideoPath, library.path);
            if (thumbName) {
              await pool.execute(
                'INSERT INTO thumbnails (video_id, filename) VALUES (?, ?)',
                [vid, thumbName]
              );
            }
          }

          // Metadata (only if not already extracted)
          let videoDuration = null;
          const [metaCheck] = await pool.execute(
            'SELECT duration FROM videos WHERE id = ?', [vid]
          );
          if (metaCheck.length > 0 && metaCheck[0].duration === null) {
            const probeData = await probeVideo(fullVideoPath);
            const meta = extractMetadata(probeData);
            if (Object.keys(meta).length > 0) {
              videoDuration = meta.duration;
              await pool.execute(
                `UPDATE videos SET duration = ?, width = ?, height = ?,
                 codec = ?, audio_codec = ?, bitrate = ? WHERE id = ?`,
                [
                  meta.duration || null,
                  meta.width || null,
                  meta.height || null,
                  meta.codec || null,
                  meta.audio_codec || null,
                  meta.bitrate || null,
                  vid,
                ]
              );
            }
          } else if (metaCheck.length > 0) {
            videoDuration = metaCheck[0].duration;
          }

          // Sprite preview (only if not already generated)
          const [spriteCheck] = await pool.execute(
            'SELECT sprite_filename FROM thumbnails WHERE video_id = ?', [vid]
          );
          if (spriteCheck.length > 0 && !spriteCheck[0].sprite_filename && videoDuration) {
            const spriteName = generateSprite(fullVideoPath, library.path, videoDuration);
            if (spriteName) {
              await pool.execute(
                'UPDATE thumbnails SET sprite_filename = ? WHERE video_id = ?',
                [spriteName, vid]
              );
            }
          }
        });
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
      const vid = videoId;
      enqueueJob(async () => {
        // Thumbnail
        const [existing] = await pool.execute(
          'SELECT id FROM thumbnails WHERE video_id = ?', [vid]
        );
        if (existing.length === 0) {
          const thumbName = generateThumbnail(filePath, libraryPath);
          if (thumbName) {
            await pool.execute(
              'INSERT INTO thumbnails (video_id, filename) VALUES (?, ?)',
              [vid, thumbName]
            );
          }
        }
        // Metadata
        const probeData = await probeVideo(filePath);
        const meta = extractMetadata(probeData);
        if (Object.keys(meta).length > 0) {
          await pool.execute(
            `UPDATE videos SET duration = ?, width = ?, height = ?,
             codec = ?, audio_codec = ?, bitrate = ? WHERE id = ?`,
            [
              meta.duration || null, meta.width || null, meta.height || null,
              meta.codec || null, meta.audio_codec || null, meta.bitrate || null,
              vid,
            ]
          );
        }

        // Sprite preview
        if (meta.duration) {
          const [spriteCheck] = await pool.execute(
            'SELECT sprite_filename FROM thumbnails WHERE video_id = ?', [vid]
          );
          if (spriteCheck.length > 0 && !spriteCheck[0].sprite_filename) {
            const spriteName = generateSprite(filePath, libraryPath, meta.duration);
            if (spriteName) {
              await pool.execute(
                'UPDATE thumbnails SET sprite_filename = ? WHERE video_id = ?',
                [spriteName, vid]
              );
            }
          }
        }
      });
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

    // Clean thumbnail file
    const [thumbs] = await pool.execute('SELECT filename FROM thumbnails WHERE video_id = ?', [videoId]);
    for (const t of thumbs) {
      const thumbPath = path.join(libraryPath, CAPSULE_DIR, t.filename);
      try { fs.unlinkSync(thumbPath); } catch {}
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
