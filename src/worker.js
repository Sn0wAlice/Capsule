require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const pool = require('./config/database');
const migrate = require('./config/migrate');

const CAPSULE_DIR = '.capsule';
const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL, 10) || 3000;
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY, 10) || 1;

let running = 0;
let shuttingDown = false;

// ── ffprobe ──

function probeVideo(videoPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      videoPath,
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function extractMetadata(probeData) {
  if (!probeData) return {};
  const meta = {};
  if (probeData.format && probeData.format.duration) {
    meta.duration = parseFloat(probeData.format.duration) || null;
  }
  if (probeData.format && probeData.format.bit_rate) {
    meta.bitrate = parseInt(probeData.format.bit_rate, 10) || null;
  }
  const streams = probeData.streams || [];
  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');
  if (videoStream) {
    meta.width = videoStream.width || null;
    meta.height = videoStream.height || null;
    meta.codec = videoStream.codec_name || null;
    if (!meta.duration && videoStream.duration) {
      meta.duration = parseFloat(videoStream.duration) || null;
    }
  }
  if (audioStream) {
    meta.audio_codec = audioStream.codec_name || null;
  }
  return meta;
}

// ── Thumbnail ──

function generateThumbnail(videoPath, libraryPath, duration) {
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });
  const thumbName = crypto.randomUUID() + '.jpg';
  const thumbPath = path.join(thumbDir, thumbName);
  const seekTo = duration ? Math.max(1, Math.floor(duration * 0.1)) : 15;
  try {
    execFileSync('ffmpeg', [
      '-ss', String(seekTo), '-i', videoPath,
      '-vframes', '1', '-vf', 'scale=320:-2',
      '-q:v', '8', '-y', thumbPath,
    ], { timeout: 15000, stdio: 'pipe' });
    return thumbName;
  } catch (err) {
    console.error(`[worker] Thumbnail failed: ${err.message}`);
    try { fs.unlinkSync(thumbPath); } catch {}
    return null;
  }
}

// ── Sprite ──

const SPRITE_FRAMES = 8;

function generateSprite(videoPath, libraryPath, duration) {
  if (!duration || duration < 4) return null;
  const thumbDir = path.join(libraryPath, CAPSULE_DIR);
  fs.mkdirSync(thumbDir, { recursive: true });
  const spriteName = crypto.randomUUID() + '_sprite.jpg';
  const spritePath = path.join(thumbDir, spriteName);
  const interval = duration / (SPRITE_FRAMES + 1);
  const selectExpr = Array.from({ length: SPRITE_FRAMES }, (_, i) =>
    `eq(n\\,${Math.max(1, Math.floor((i + 1) * interval * 25))})`
  ).join('+');

  try {
    execFileSync('ffmpeg', [
      '-i', videoPath,
      '-vf', `fps=25,select='${selectExpr}',scale=160:-2,tile=${SPRITE_FRAMES}x1`,
      '-frames:v', '1', '-q:v', '10', '-y', spritePath,
    ], { timeout: 30000, stdio: 'pipe' });
    return spriteName;
  } catch {
    try {
      execFileSync('ffmpeg', [
        '-i', videoPath,
        '-vf', `fps=1/${Math.max(1, Math.floor(interval))},scale=160:-2,tile=${SPRITE_FRAMES}x1`,
        '-frames:v', '1', '-q:v', '10', '-y', spritePath,
      ], { timeout: 30000, stdio: 'pipe' });
      return spriteName;
    } catch (err) {
      console.error(`[worker] Sprite failed: ${err.message}`);
      try { fs.unlinkSync(spritePath); } catch {}
      return null;
    }
  }
}

// ── Process a single job ──

async function processJob(job) {
  const { id, video_id, library_path, video_path } = job;

  await pool.execute(
    "UPDATE jobs SET status = 'processing', started_at = NOW() WHERE id = ?",
    [id]
  );

  try {
    // Check video still exists in DB
    const [videoRows] = await pool.execute('SELECT id, duration FROM videos WHERE id = ?', [video_id]);
    if (videoRows.length === 0) {
      await pool.execute("UPDATE jobs SET status = 'done', finished_at = NOW() WHERE id = ?", [id]);
      return;
    }

    // Check file exists on disk
    if (!fs.existsSync(video_path)) {
      await pool.execute(
        "UPDATE jobs SET status = 'failed', error = 'file not found', finished_at = NOW() WHERE id = ?",
        [id]
      );
      return;
    }

    // 1. Metadata (probe first to get duration)
    let videoDuration = videoRows[0].duration;
    if (videoDuration === null) {
      const probeData = await probeVideo(video_path);
      const meta = extractMetadata(probeData);
      if (Object.keys(meta).length > 0) {
        videoDuration = meta.duration;
        await pool.execute(
          `UPDATE videos SET duration = ?, width = ?, height = ?,
           codec = ?, audio_codec = ?, bitrate = ? WHERE id = ?`,
          [meta.duration || null, meta.width || null, meta.height || null,
           meta.codec || null, meta.audio_codec || null, meta.bitrate || null, video_id]
        );
      }
    }

    // 2. Thumbnail (at 10% of duration)
    const [existingThumb] = await pool.execute('SELECT id FROM thumbnails WHERE video_id = ?', [video_id]);
    if (existingThumb.length === 0) {
      const thumbName = generateThumbnail(video_path, library_path, videoDuration);
      if (thumbName) {
        await pool.execute('INSERT INTO thumbnails (video_id, filename) VALUES (?, ?)', [video_id, thumbName]);
      }
    }

    // 3. Sprite
    const [spriteCheck] = await pool.execute(
      'SELECT sprite_filename FROM thumbnails WHERE video_id = ?', [video_id]
    );
    if (spriteCheck.length > 0 && !spriteCheck[0].sprite_filename && videoDuration) {
      const spriteName = generateSprite(video_path, library_path, videoDuration);
      if (spriteName) {
        await pool.execute('UPDATE thumbnails SET sprite_filename = ? WHERE video_id = ?', [spriteName, video_id]);
      }
    }

    await pool.execute("UPDATE jobs SET status = 'done', finished_at = NOW() WHERE id = ?", [id]);
    console.log(`[worker] Job #${id} done (video ${video_id})`);
  } catch (err) {
    console.error(`[worker] Job #${id} failed:`, err.message);
    await pool.execute(
      "UPDATE jobs SET status = 'failed', error = ?, finished_at = NOW() WHERE id = ?",
      [err.message.slice(0, 1000), id]
    );
  }
}

// ── Poll loop ──

async function poll() {
  if (shuttingDown) return;
  if (running >= CONCURRENCY) return;

  try {
    // Claim a pending job atomically
    const [rows] = await pool.execute(
      "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    );
    if (rows.length === 0) return;

    const job = rows[0];
    // Try to claim it (prevent double-pickup)
    const [result] = await pool.execute(
      "UPDATE jobs SET status = 'processing' WHERE id = ? AND status = 'pending'",
      [job.id]
    );
    if (result.affectedRows === 0) return; // someone else got it

    // Reset status so processJob sets started_at
    await pool.execute("UPDATE jobs SET status = 'pending' WHERE id = ?", [job.id]);

    running++;
    processJob(job)
      .catch(() => {})
      .finally(() => {
        running--;
        // Immediately try to pick up next job
        setImmediate(poll);
      });
  } catch (err) {
    console.error('[worker] Poll error:', err.message);
  }
}

// ── Startup ──

async function start() {
  await migrate();

  // Reset any stale 'processing' jobs from a previous crash
  const [stale] = await pool.execute(
    "UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'processing'"
  );
  if (stale.affectedRows > 0) {
    console.log(`[worker] Reset ${stale.affectedRows} stale job(s)`);
  }

  console.log(`[worker] Started (poll=${POLL_INTERVAL}ms, concurrency=${CONCURRENCY})`);
  setInterval(poll, POLL_INTERVAL);
  poll(); // initial poll
}

// Graceful shutdown
process.on('SIGTERM', () => { shuttingDown = true; console.log('[worker] Shutting down...'); });
process.on('SIGINT', () => { shuttingDown = true; console.log('[worker] Shutting down...'); });

start().catch(err => {
  console.error('[worker] Fatal:', err);
  process.exit(1);
});
